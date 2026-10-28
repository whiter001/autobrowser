import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJsonFile } from '../../core/protocol.js'
import {
  collectItemKey,
  isCollectRecord,
  normalizeCollectSpec,
  readJsonPath,
  type CollectCheckpoint,
  type CollectItem,
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
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown
}

function outputPathFor(checkpointPath: string, checkpoint: CollectCheckpoint): string {
  const outputPath = path.resolve(path.dirname(checkpointPath), checkpoint.spec.output)
  if (outputPath === path.resolve(checkpointPath)) {
    throw commandError(
      'collect output must be different from the checkpoint file',
      'INVALID_COLLECT_SPEC',
    )
  }
  return outputPath
}

async function writeArtifacts(
  checkpointPath: string,
  checkpoint: CollectCheckpoint,
): Promise<void> {
  const outputPath = outputPathFor(checkpointPath, checkpoint)
  await mkdir(path.dirname(outputPath), { recursive: true })
  const content = checkpoint.items.map((item) => JSON.stringify(item)).join('\n')
  const tempPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(tempPath, content ? `${content}\n` : '', 'utf8')
  await rename(tempPath, outputPath)
  await writeJsonFile(checkpointPath, checkpoint)
}

function pageItems(
  checkpoint: CollectCheckpoint,
  values: unknown[],
  sourceUrl: string,
  requestId?: string,
  pageEpoch?: number,
): CollectItem[] {
  const known = new Set(checkpoint.items.map((item) => collectItemKey(item)))
  const items: CollectItem[] = []
  for (const value of values) {
    if (!isCollectRecord(value)) continue
    const item: CollectItem = {
      ...value,
      _meta: {
        task: checkpoint.spec.name,
        mode: checkpoint.spec.mode,
        page: checkpoint.nextPage,
        sourceUrl,
        ...(requestId ? { requestId } : {}),
        ...(typeof pageEpoch === 'number' ? { pageEpoch } : {}),
      },
    }
    const key = collectItemKey(item)
    if (known.has(key)) continue
    known.add(key)
    items.push(item)
  }
  return items
}

async function collectFeedPage(
  context: CommandContext,
  checkpoint: CollectCheckpoint,
): Promise<void> {
  const sourceUrl = checkpoint.nextUrl
  if (sourceUrl) await request(context, 'goto', { url: sourceUrl })
  const feed = checkpoint.spec.feed || {}
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
  checkpoint.items.push(...pageItems(checkpoint, values, sourceUrl, undefined, pageEpoch))
  checkpoint.nextPage += 1
  if (!feed.nextSelector || checkpoint.nextPage > (checkpoint.spec.maxPages || 1)) {
    checkpoint.status = 'completed'
    return
  }
  await request(context, 'click', { selector: feed.nextSelector })
  await request(context, 'wait', {
    type: 'selector',
    selector: feed.selector || 'article',
    state: 'new',
    timeout: feed.waitTimeoutMs ?? 30_000,
  })
  const current = await requestValue(context, 'get', { attr: 'url' })
  checkpoint.nextUrl = typeof current === 'string' ? current : sourceUrl
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

async function collectNetworkPage(
  context: CommandContext,
  checkpoint: CollectCheckpoint,
): Promise<void> {
  const network = checkpoint.spec.network!
  const sourceUrl = checkpoint.nextUrl
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
    const items = pageItems(checkpoint, values, sourceUrl, requestId || undefined, pageEpoch)
    checkpoint.items.push(...items)
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
  checkpoint.nextPage += 1
  checkpoint.nextUrl = nextUrl
  if (!nextUrl || checkpoint.nextPage > (checkpoint.spec.maxPages || 1)) {
    checkpoint.status = 'completed'
  }
}

function summary(checkpointPath: string, checkpoint: CollectCheckpoint): Record<string, unknown> {
  return {
    name: checkpoint.spec.name,
    mode: checkpoint.spec.mode,
    status: checkpoint.status,
    itemCount: checkpoint.items.length,
    pageCount: Math.max(0, checkpoint.nextPage - 1),
    failureCount: checkpoint.failures.length,
    output: outputPathFor(checkpointPath, checkpoint),
    checkpoint: path.resolve(checkpointPath),
  }
}

async function executeCollect(
  context: CommandContext,
  checkpointPath: string,
  checkpoint: CollectCheckpoint,
): Promise<Record<string, unknown>> {
  try {
    while (checkpoint.status !== 'completed') {
      if (checkpoint.spec.mode === 'feed') await collectFeedPage(context, checkpoint)
      else await collectNetworkPage(context, checkpoint)
      await writeArtifacts(checkpointPath, checkpoint)
    }
    return { ok: true, result: summary(checkpointPath, checkpoint) }
  } catch (error) {
    checkpoint.status = 'failed'
    checkpoint.failures.push({
      at: new Date().toISOString(),
      page: checkpoint.nextPage,
      sourceUrl: checkpoint.nextUrl,
      message: error instanceof Error ? error.message : String(error),
      code:
        typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'COLLECT_TASK_FAILED',
    })
    await writeArtifacts(checkpointPath, checkpoint)
    return {
      ok: false,
      error: {
        code: 'COLLECT_TASK_FAILED',
        message: error instanceof Error ? error.message : String(error),
        suggestedAction: `Fix the failing step, then run collect resume ${checkpointPath}`,
        details: summary(checkpointPath, checkpoint),
      },
    }
  }
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
    const checkpoint = (await readJsonFile(checkpointPath)) as CollectCheckpoint
    if (checkpoint.version !== 1 || !Array.isArray(checkpoint.items)) {
      throw commandError('invalid collect checkpoint', 'INVALID_COLLECT_CHECKPOINT')
    }
    checkpoint.spec = normalizeCollectSpec(checkpoint.spec)
    if (checkpoint.status === 'completed') {
      context.writeResult({ ok: true, result: summary(checkpointPath, checkpoint) })
      return 0
    }
    checkpoint.status = 'running'
    const payload = await executeCollect(context, checkpointPath, checkpoint)
    context.writeResult(payload)
    return payload.ok === false ? 1 : 0
  }

  const spec = normalizeCollectSpec(await readJsonFile(checkpointPath))
  const checkpoint: CollectCheckpoint = {
    version: 1,
    spec,
    status: 'running',
    nextUrl: spec.startUrl || '',
    nextPage: 1,
    items: [],
    failures: [],
  }
  const payload = await executeCollect(context, checkpointPath, checkpoint)
  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

export const collectCommandRegistry: CommandRegistry = {
  collect: handleCollect,
}
