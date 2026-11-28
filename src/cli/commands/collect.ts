import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, stat, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJsonFile } from '../../core/protocol.js'
import { stripBom } from '../../core/text.js'
import {
  collectItemHash,
  isCollectRecord,
  normalizeCollectSpec,
  readJsonPath,
  type CollectFailure,
  type CollectItem,
  type CollectSpec,
  type CollectStatus,
} from '../../core/collect.js'
import { isRecord } from '../client.js'
import { helpRequested } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

function commandError(message: string, code: string, suggestedAction?: string): Error {
  const error = new Error(message) as Error & { code?: string; suggestedAction?: string }
  error.code = code
  if (suggestedAction) error.suggestedAction = suggestedAction
  return error
}

async function requestValue(
  context: CommandContext,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const payload = await context.requestCommand(context.flags.server, command, args)
  if (payload.ok === false) {
    const error = commandError(
      payload.error?.message || `${command} failed`,
      payload.error?.code || 'COMMAND_FAILED',
      payload.error?.suggestedAction,
    )
    throw error
  }
  return payload.result
}

async function request(
  context: CommandContext,
  command: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await requestValue(context, command, args)
  if (!isRecord(result))
    throw commandError(`${command} returned no structured result`, 'INVALID_COMMAND_RESULT')
  return result
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(stripBom(await readFile(filePath, 'utf8'))) as unknown
}

function outputPathFor(checkpointPath: string, spec: CollectSpec): string {
  const outputPath = path.resolve(path.dirname(checkpointPath), spec.output)
  if (outputPath === path.resolve(checkpointPath)) {
    throw commandError(
      'collect output must be different from the checkpoint file',
      'INVALID_COLLECT_SPEC',
    )
  }
  return outputPath
}

/**
 * 一次 collect 任务的运行期状态。
 *
 * 条目本身不进这里：输出 JSONL 是唯一副本，这里只留去重指纹。
 * 指纹集合仍会随唯一条目数线性增长，只是每个键长度固定（64 位十六进制），
 * 比把条目对象留在内存里小得多；checkpoint 本身则始终只保存游标与计数。
 */
interface CollectSession {
  checkpointPath: string
  outputPath: string
  spec: CollectSpec
  status: 'running' | 'completed' | 'failed'
  nextUrl: string
  nextPage: number
  itemCount: number
  failures: CollectFailure[]
  warnings: string[]
  /** 已落盘条目的去重指纹 */
  keys: Set<string>
  /** 输出文件当前是否以换行结尾，追加前据此决定要不要先补一个换行 */
  outputEndsWithNewline: boolean
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath)
    return stats.isFile()
  } catch {
    return false
  }
}

interface OutputScan {
  /** 已落盘条目的去重指纹 */
  keys: Set<string>
  itemCount: number
  /** 有效前缀的字节数（末尾残片之前），用于只截掉残片而不是清空文件 */
  validBytes: number
  /** 文件是否以换行结尾 */
  endsWithNewline: boolean
  /** 是否发现末尾不完整记录 */
  droppedFragment: boolean
  /** 末尾残片的字节数，用于告警文案 */
  fragmentBytes: number
}

function parseJsonlRecord(
  text: string,
  outputPath: string,
  lineNumber: number,
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw commandError(
      `collect output ${outputPath} has a malformed JSON record on line ${lineNumber}: ${message}`,
      'COLLECT_OUTPUT_CORRUPT',
      'Repair or remove the corrupt record in the collect output file, then run collect resume again; the checkpoint was not advanced.',
    )
  }
  if (!isCollectRecord(parsed)) {
    throw commandError(
      `collect output ${outputPath} has a non-object JSON record on line ${lineNumber}`,
      'COLLECT_OUTPUT_CORRUPT',
      'Repair or remove the corrupt record in the collect output file, then run collect resume again; the checkpoint was not advanced.',
    )
  }
  return parsed
}

/**
 * 流式扫描输出 JSONL，一次读完重建去重指纹与条目计数。
 *
 * 只用 readline 风格的增量解析：文件按块读入，逐行处理，绝不把整个文件读进内存，
 * 否则大任务的 resume 会把内存吃满。空行忽略；中间损坏的记录直接报错；
 * 只有末尾那段没有换行、且解析不出 JSON 的残片才当作崩溃残留。
 */
async function scanCollectOutput(outputPath: string): Promise<OutputScan> {
  const keys = new Set<string>()
  let itemCount = 0
  let validBytes = 0
  let lineNumber = 0
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  const stream = createReadStream(outputPath)
  for await (const chunk of stream) {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer)
    let index = buffer.indexOf(0x0a)
    while (index !== -1) {
      const line = buffer.subarray(0, index)
      buffer = buffer.subarray(index + 1)
      lineNumber += 1
      validBytes += index + 1
      const text = stripBom(line.toString('utf8')).trim()
      if (text) {
        keys.add(collectItemHash(parseJsonlRecord(text, outputPath, lineNumber)))
        itemCount += 1
      }
      index = buffer.indexOf(0x0a)
    }
  }

  // 末尾没有换行的片段：能解析成 JSON 就是一条被截断换行的完整记录，
  // 解析不出来才是上次崩溃留下的残片。
  const fragment = buffer
  if (fragment.length === 0) {
    return {
      keys,
      itemCount,
      validBytes,
      endsWithNewline: true,
      droppedFragment: false,
      fragmentBytes: 0,
    }
  }
  const fragmentText = stripBom(fragment.toString('utf8')).trim()
  if (!fragmentText) {
    return {
      keys,
      itemCount,
      validBytes,
      endsWithNewline: false,
      droppedFragment: false,
      fragmentBytes: 0,
    }
  }
  try {
    const parsed = JSON.parse(fragmentText)
    if (!isCollectRecord(parsed)) throw new Error('not an object')
    keys.add(collectItemHash(parsed))
    return {
      keys,
      itemCount: itemCount + 1,
      validBytes: validBytes + fragment.length,
      endsWithNewline: false,
      droppedFragment: false,
      fragmentBytes: 0,
    }
  } catch {
    return {
      keys,
      itemCount,
      validBytes,
      endsWithNewline: true,
      droppedFragment: true,
      fragmentBytes: fragment.length,
    }
  }
}

/**
 * 把本页新增条目追加到输出 JSONL。
 *
 * 追加前先补换行：上一次运行可能正好断在一条没有换行结尾的记录后面，
 * 不补换行会把两条记录粘成一行。写完立刻 fsync，再由调用方更新 checkpoint，
 * 保证崩溃窗口里最多重抓一页、不会丢条目。
 */
async function appendCollectItems(session: CollectSession, items: CollectItem[]): Promise<void> {
  if (items.length === 0) return
  const prefix = session.outputEndsWithNewline ? '' : '\n'
  const body = `${prefix}${items.map((item) => JSON.stringify(item)).join('\n')}\n`
  const handle = await open(session.outputPath, 'a')
  try {
    await handle.write(Buffer.from(body, 'utf8'))
    await handle.sync()
  } finally {
    await handle.close()
  }
  session.outputEndsWithNewline = true
  session.itemCount += items.length
}

/** 写出 v2 checkpoint：只有游标、计数与失败记录，没有条目数组。 */
async function writeCollectCheckpoint(session: CollectSession): Promise<void> {
  await writeJsonFile(session.checkpointPath, {
    version: 2,
    spec: session.spec,
    status: session.status,
    nextUrl: session.nextUrl,
    nextPage: session.nextPage,
    itemCount: session.itemCount,
    failures: session.failures,
    ...(session.warnings.length > 0 ? { warnings: session.warnings } : {}),
  })
}

/**
 * 生成本页条目并就地更新去重指纹。
 * 已落盘的条目在这里被跳过，重复抓取同一页不会产生重复行。
 */
function pageItems(
  session: CollectSession,
  values: unknown[],
  sourceUrl: string,
  requestId?: string,
  pageEpoch?: number,
): CollectItem[] {
  const items: CollectItem[] = []
  for (const value of values) {
    if (!isCollectRecord(value)) continue
    const item: CollectItem = {
      ...value,
      _meta: {
        task: session.spec.name,
        mode: session.spec.mode,
        page: session.nextPage,
        sourceUrl,
        ...(requestId ? { requestId } : {}),
        ...(typeof pageEpoch === 'number' ? { pageEpoch } : {}),
      },
    }
    const key = collectItemHash(item)
    if (session.keys.has(key)) continue
    session.keys.add(key)
    items.push(item)
  }
  return items
}

/**
 * 可见列表签名的页面脚本片段（静态源码）。
 *
 * 与扩展 wait new 的签名思路一致：可见节点数 + 前 5 个节点的文本/href/几何信息。
 * 片段是纯函数，不挂全局变量、不装 MutationObserver，每次求值都是独立作用域。
 */
const FEED_SIGNATURE_HELPER_SOURCE = `
const __collectQueryAll = (root, selector, results, depth) => {
  if (!root || typeof root.querySelectorAll !== 'function' || depth > 20) {
    return;
  }
  let matched;
  try {
    matched = root.querySelectorAll(selector);
  } catch (error) {
    return;
  }
  for (const node of Array.from(matched)) {
    results.push(node);
  }
  for (const node of Array.from(root.querySelectorAll('*'))) {
    if (node.shadowRoot) {
      __collectQueryAll(node.shadowRoot, selector, results, depth + 1);
    }
  }
};
const __collectListSignature = (selector) => {
  const nodes = [];
  __collectQueryAll(document, selector, nodes, 0);
  const visibleNodes = nodes.filter((node) => {
    if (!node || typeof node.getBoundingClientRect !== 'function') {
      return false;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
  });
  if (visibleNodes.length === 0) {
    return null;
  }
  const fingerprint = visibleNodes.slice(0, 5).map((node) => {
    const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const rect = node.getBoundingClientRect();
    const href = typeof node.href === 'string' ? node.href : node.getAttribute('href') || '';
    return [text, href, Math.round(rect.top), Math.round(rect.left), Math.round(rect.width), Math.round(rect.height)].join('~');
  }).join('|');
  return String(visibleNodes.length) + ':' + fingerprint;
};
`

/** 点击前读取基线签名：selector 作为数据注入，页面里不执行任何用户代码。 */
export const FEED_SIGNATURE_EVAL_SCRIPT = `(() => {
${FEED_SIGNATURE_HELPER_SOURCE}
return { signature: __collectListSignature(args.selector) };
})()`

/**
 * 点击后等待列表签名与基线不同。
 *
 * 不能用 wait new：它的基线在第一次 poll 才建立，点击同步替换列表时基线已经是新列表，
 * 于是永远等不到变化。这里把点击前的基线内嵌进等待条件，同步替换立即可见，
 * 异步换节点但文本变化也能等到。
 */
export function feedSignatureWaitExpression(selector: string, baseline: string): string {
  return `(() => {
${FEED_SIGNATURE_HELPER_SOURCE}
const current = __collectListSignature(${JSON.stringify(selector)});
return current !== null && current !== ${JSON.stringify(baseline)};
})()`
}

/**
 * 读取当前 feed 列表的可见签名。
 *
 * 读不到（没有可见节点、eval 失败）必须抛错：签名缺失时无法判断翻页是否生效，
 * 让 collect 走失败恢复，而不是盲推进游标。
 */
async function readFeedListSignature(context: CommandContext, selector: string): Promise<string> {
  const result = await request(context, 'eval', {
    script: FEED_SIGNATURE_EVAL_SCRIPT,
    responseFormat: 'detailed',
    args: { selector },
  })
  const signature = result.signature
  if (typeof signature !== 'string' || !signature) {
    throw commandError(
      `cannot read the visible feed list signature for selector ${selector}`,
      'COLLECT_FEED_SIGNATURE_UNAVAILABLE',
      'Check the feed selector: it must match visible cards on the page before the next-page control is clicked.',
    )
  }
  return signature
}

async function collectFeedPage(context: CommandContext, session: CollectSession): Promise<void> {
  const sourceUrl = session.nextUrl
  if (sourceUrl) await request(context, 'goto', { url: sourceUrl })
  const feed = session.spec.feed || {}
  const result = await request(context, 'feed', {
    selector: feed.selector || 'article',
    limit: feed.limit ?? 30,
    dedupe: feed.dedupe || 'url',
    maxScrolls: feed.maxScrolls ?? 20,
    pauseMs: feed.pauseMs ?? 900,
    stallRounds: feed.stallRounds ?? 3,
  })
  const values = Array.isArray(result.items) ? result.items : []
  const pageEpoch = typeof result.pageEpoch === 'number' ? result.pageEpoch : undefined
  const items = pageItems(session, values, sourceUrl, undefined, pageEpoch)
  await appendCollectItems(session, items)

  // 翻页动作成功之后才推进游标：中途失败时 checkpoint 仍停在本页，
  // resume 会重抓这一页，并按已落盘内容跳过重复条目。
  const finished = !feed.nextSelector || session.nextPage + 1 > (session.spec.maxPages || 1)
  let nextUrl = sourceUrl
  if (!finished) {
    const feedSelector = feed.selector || 'article'
    // 点击前先取基线签名：wait new 的基线建立得太晚，同步替换列表会永远等不到变化。
    const baseline = await readFeedListSignature(context, feedSelector)
    await request(context, 'click', { selector: feed.nextSelector })
    await request(context, 'wait', {
      type: 'fn',
      fn: feedSignatureWaitExpression(feedSelector, baseline),
      timeout: feed.waitTimeoutMs ?? 30_000,
    })
    const current = await requestValue(context, 'get', { attr: 'url' })
    nextUrl = typeof current === 'string' ? current : sourceUrl
  }
  session.nextPage += 1
  session.nextUrl = nextUrl
  if (finished) session.status = 'completed'
}

function parseResponseBody(request: Record<string, unknown>): unknown {
  if (typeof request.responseBody !== 'string' || !request.responseBody) return undefined
  const text =
    request.responseBodyBase64 === true
      ? Buffer.from(request.responseBody, 'base64').toString('utf8')
      : request.responseBody
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function collectNetworkPage(context: CommandContext, session: CollectSession): Promise<void> {
  const network = session.spec.network!
  const sourceUrl = session.nextUrl
  if (sourceUrl) await request(context, 'goto', { url: sourceUrl })
  const listed = await request(context, 'network', {
    action: 'requests',
    filter: network.urlPattern,
    includeDetails: true,
    pageSize: 200,
  })
  const requests = Array.isArray(listed.requests) ? listed.requests.filter(isCollectRecord) : []
  let matchedResponses = 0
  let nextUrl = ''
  const items: CollectItem[] = []
  for (const summary of requests) {
    const requestId = typeof summary.id === 'string' ? summary.id : ''
    const detailResult = requestId
      ? await request(context, 'network', { action: 'request', requestId })
      : summary
    const detail = isCollectRecord(detailResult.request) ? detailResult.request : detailResult
    const body = parseResponseBody(detail)
    if (body === undefined) continue
    const values = readJsonPath(body, network.itemsPath)
    if (!Array.isArray(values)) continue
    const pageEpoch = typeof detail.pageEpoch === 'number' ? detail.pageEpoch : undefined
    matchedResponses += 1
    items.push(...pageItems(session, values, sourceUrl, requestId || undefined, pageEpoch))
    if (network.nextPath) {
      const next = readJsonPath(body, network.nextPath)
      if (typeof next === 'string' && next.trim()) {
        nextUrl = new URL(next, sourceUrl || undefined).toString()
      }
    }
  }
  if (!matchedResponses && !nextUrl) {
    throw commandError(
      `no JSON items matched ${network.urlPattern} at ${network.itemsPath}`,
      'NETWORK_DATA_NOT_FOUND',
      'Check the page request chain, urlPattern and itemsPath, or use feed mode for DOM collection.',
    )
  }
  await appendCollectItems(session, items)
  session.nextPage += 1
  session.nextUrl = nextUrl
  if (!nextUrl || session.nextPage > (session.spec.maxPages || 1)) {
    session.status = 'completed'
  }
}

function summary(session: CollectSession): Record<string, unknown> {
  return {
    name: session.spec.name,
    mode: session.spec.mode,
    status: session.status,
    itemCount: session.itemCount,
    pageCount: Math.max(0, session.nextPage - 1),
    failureCount: session.failures.length,
    output: session.outputPath,
    checkpoint: path.resolve(session.checkpointPath),
    warnings: session.warnings,
  }
}

async function executeCollect(
  context: CommandContext,
  session: CollectSession,
): Promise<Record<string, unknown>> {
  try {
    while (session.status !== 'completed') {
      if (session.spec.mode === 'feed') await collectFeedPage(context, session)
      else await collectNetworkPage(context, session)
      await writeCollectCheckpoint(session)
    }
    return { ok: true, result: summary(session) }
  } catch (error) {
    session.status = 'failed'
    session.failures.push({
      at: new Date().toISOString(),
      page: session.nextPage,
      sourceUrl: session.nextUrl,
      message: error instanceof Error ? error.message : String(error),
      code:
        typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'COLLECT_TASK_FAILED',
    })
    await writeCollectCheckpoint(session)
    return {
      ok: false,
      error: {
        code: 'COLLECT_TASK_FAILED',
        message: error instanceof Error ? error.message : String(error),
        suggestedAction: `Fix the failing step, then run collect resume ${session.checkpointPath}`,
        details: summary(session),
      },
    }
  }
}

function readCheckpointStatus(raw: Record<string, unknown>): CollectStatus {
  const value = raw.status
  return value === 'completed' || value === 'failed' || value === 'running' ? value : 'running'
}

function readCheckpointNextUrl(raw: Record<string, unknown>, fallback: string): string {
  return typeof raw.nextUrl === 'string' ? raw.nextUrl : fallback
}

function readCheckpointNextPage(raw: Record<string, unknown>): number {
  const value = raw.nextPage
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1
}

/**
 * 读取 v2 checkpoint 的 itemCount。
 *
 * 缺字段或不是非负安全整数都算损坏的 checkpoint：默认成 0 会让"输出缺失"的任务
 * 从空文件继续，等于悄悄丢掉了已采集条目的去重基线，必须显式拒绝而不是猜。
 */
function requireCheckpointItemCount(raw: Record<string, unknown>): number {
  const value = raw.itemCount
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw commandError(
      'invalid collect checkpoint: itemCount must be a non-negative integer',
      'INVALID_COLLECT_CHECKPOINT',
      'Fix the checkpoint JSON by restoring the itemCount field, or start a new collect run.',
    )
  }
  return value
}

function readCheckpointFailures(raw: Record<string, unknown>): CollectFailure[] {
  return Array.isArray(raw.failures)
    ? (raw.failures.filter(isCollectRecord) as unknown as CollectFailure[])
    : []
}

function readCheckpointWarnings(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.warnings)
    ? raw.warnings.filter((value): value is string => typeof value === 'string')
    : []
}

/**
 * 把 v1 checkpoint 迁移成 v2。
 *
 * v1 把全部条目塞在 checkpoint 里，输出文件只是它的副本；迁移时以 checkpoint.items
 * 为权威一次性重写 JSONL，之后只追加。这是唯一允许的全量重写。
 */
async function migrateV1Checkpoint(
  checkpointPath: string,
  raw: Record<string, unknown>,
  spec: CollectSpec,
): Promise<CollectSession> {
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isCollectRecord) as CollectItem[]
  const outputPath = outputPathFor(checkpointPath, spec)
  await mkdir(path.dirname(outputPath), { recursive: true })
  const body = items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join('\n')}\n` : ''
  await writeFile(outputPath, body, 'utf8')
  return {
    checkpointPath: path.resolve(checkpointPath),
    outputPath,
    spec,
    status: 'running',
    nextUrl: readCheckpointNextUrl(raw, spec.startUrl || ''),
    nextPage: readCheckpointNextPage(raw),
    itemCount: items.length,
    failures: readCheckpointFailures(raw),
    warnings: [
      ...readCheckpointWarnings(raw),
      'migrated a version 1 collect checkpoint to version 2: the output file was rewritten once from checkpoint.items and is only appended to from now on',
    ],
    keys: new Set(items.map((item) => collectItemHash(item))),
    outputEndsWithNewline: true,
  }
}

async function resumeCollect(
  context: CommandContext,
  checkpointPath: string,
): Promise<number | void> {
  const raw = await readJsonFile(checkpointPath)
  if (!isCollectRecord(raw)) {
    throw commandError('invalid collect checkpoint', 'INVALID_COLLECT_CHECKPOINT')
  }
  const spec = normalizeCollectSpec(raw.spec)
  const outputPath = outputPathFor(checkpointPath, spec)
  const status = readCheckpointStatus(raw)

  if (raw.version === 1) {
    if (!Array.isArray(raw.items)) {
      throw commandError('invalid collect checkpoint', 'INVALID_COLLECT_CHECKPOINT')
    }
    const items = raw.items.filter(isCollectRecord) as CollectItem[]
    if (status === 'completed') {
      context.writeResult({
        ok: true,
        result: {
          name: spec.name,
          mode: spec.mode,
          status,
          itemCount: items.length,
          pageCount: Math.max(0, readCheckpointNextPage(raw) - 1),
          failureCount: readCheckpointFailures(raw).length,
          output: outputPath,
          checkpoint: path.resolve(checkpointPath),
          warnings: [],
        },
      })
      return 0
    }
    const session = await migrateV1Checkpoint(checkpointPath, raw, spec)
    await writeCollectCheckpoint(session)
    const payload = await executeCollect(context, session)
    context.writeResult(payload)
    return payload.ok === false ? 1 : 0
  }

  if (raw.version !== 2) {
    throw commandError('invalid collect checkpoint', 'INVALID_COLLECT_CHECKPOINT')
  }

  const itemCount = requireCheckpointItemCount(raw)
  if (!(await fileExists(outputPath))) {
    if (itemCount > 0) {
      throw commandError(
        `collect output ${outputPath} is missing but the checkpoint records ${itemCount} item(s)`,
        'COLLECT_OUTPUT_MISSING',
        'Restore the collect output file, or start a new collect run; resuming without it would silently restart from zero and lose the deduplication baseline.',
      )
    }
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, '', 'utf8')
  }

  if (status === 'completed') {
    context.writeResult({
      ok: true,
      result: {
        name: spec.name,
        mode: spec.mode,
        status,
        itemCount,
        pageCount: Math.max(0, readCheckpointNextPage(raw) - 1),
        failureCount: readCheckpointFailures(raw).length,
        output: outputPath,
        checkpoint: path.resolve(checkpointPath),
        warnings: readCheckpointWarnings(raw),
      },
    })
    return 0
  }

  const scan = await scanCollectOutput(outputPath)
  // 输出比 checkpoint 记的条目少，说明文件被截短或丢了记录：
  // 正常崩溃窗口（条目已追加、checkpoint 未推进）只会让 scan 大于等于 checkpoint。
  // 必须在截断残片、采集、写 checkpoint 之前失败，否则去重基线会被悄悄缩小。
  if (scan.itemCount < itemCount) {
    throw commandError(
      `collect output ${outputPath} holds ${scan.itemCount} valid record(s) but the checkpoint records ${itemCount} item(s); the output looks truncated`,
      'COLLECT_OUTPUT_TRUNCATED',
      'Restore the collect output file from a backup, or start a new collect run; resuming with a shorter output would silently shrink the deduplication baseline.',
    )
  }
  const warnings = readCheckpointWarnings(raw)
  if (scan.droppedFragment) {
    // 只截掉末尾残片，有效前缀原样保留
    await truncate(outputPath, scan.validBytes)
    warnings.push(
      `dropped an incomplete trailing JSONL record (${scan.fragmentBytes} bytes) left by an interrupted run; the valid prefix was kept`,
    )
  }
  const session: CollectSession = {
    checkpointPath: path.resolve(checkpointPath),
    outputPath,
    spec,
    status: 'running',
    nextUrl: readCheckpointNextUrl(raw, spec.startUrl || ''),
    nextPage: readCheckpointNextPage(raw),
    itemCount: scan.itemCount,
    failures: readCheckpointFailures(raw),
    warnings,
    keys: scan.keys,
    outputEndsWithNewline: scan.endsWithNewline,
  }
  const payload = await executeCollect(context, session)
  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

async function handleCollect(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['collect'])) return 0
  const action = rest[0]
  const checkpointPath = rest[1]
  if ((action !== 'run' && action !== 'resume') || !checkpointPath || rest.length > 2) {
    context.writeResult({
      ok: false,
      error: {
        code: 'INVALID_COMMAND_ARGS',
        message: 'usage: autobrowser collect <run|resume> <spec-or-checkpoint.json>',
      },
    })
    return 1
  }
  if (context.flags.engine !== 'chromium') {
    context.writeResult({
      ok: false,
      error: {
        code: 'BROWSER_CAPABILITY_UNSUPPORTED',
        message: 'collect orchestration currently requires the Chromium extension',
      },
    })
    return 1
  }

  if (action === 'resume') {
    return await resumeCollect(context, checkpointPath)
  }

  const spec = normalizeCollectSpec(await readJsonFile(checkpointPath))
  const outputPath = outputPathFor(checkpointPath, spec)
  await mkdir(path.dirname(outputPath), { recursive: true })
  // 新 run 截断自己的输出，避免和上一次任务的条目混在一起
  await writeFile(outputPath, '', 'utf8')
  const session: CollectSession = {
    checkpointPath: path.resolve(checkpointPath),
    outputPath,
    spec,
    status: 'running',
    nextUrl: spec.startUrl || '',
    nextPage: 1,
    itemCount: 0,
    failures: [],
    warnings: [],
    keys: new Set(),
    outputEndsWithNewline: true,
  }
  await writeCollectCheckpoint(session)
  const payload = await executeCollect(context, session)
  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

export const collectCommandRegistry: CommandRegistry = {
  collect: handleCollect,
}
