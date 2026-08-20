import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isRecord } from '../client.js'
import {
  parseConsoleArgs,
  parseNumberArg,
  parseScreenshotArgs,
  parseSearchArgs,
  parseSnapshotArgs,
  parseWaitArgs,
} from '../parse.js'
import { buildSnapshotJsonl } from '../snapshot-export.js'
import { buildSnapshotFieldJsonl, type SnapshotFieldSelection } from '../snapshot-structure.js'
import {
  createActionCommand,
  createNoArgRequestCommand,
  createSingleArgRequestCommand,
  helpRequested,
  parseOrWriteError,
  readAllowedArg,
  requestAndWrite,
  writeCommandError,
} from './shared.js'
import type { CommandContext, CommandHandler, CommandRegistry } from './types.js'

const WINDOW_ACTIONS = ['new'] as const
const DIALOG_ACTIONS = ['accept', 'dismiss', 'status', 'auto'] as const
const FEED_DEDUPE_OPTIONS = ['url', 'text', 'none'] as const
const SCRIPT_ACTIONS = ['add', 'list', 'remove'] as const

function commandNeedsSelector(attr: string): boolean {
  return !['title', 'url', 'cdp-url'].includes(attr)
}

function parseFeedArgs(rest: string[]): {
  selector: string
  limit: number
  dedupe: (typeof FEED_DEDUPE_OPTIONS)[number]
  maxScrolls: number
  pauseMs: number
  stallRounds: number
} {
  let selector = 'article'
  let limit = 30
  let dedupe: (typeof FEED_DEDUPE_OPTIONS)[number] = 'url'
  let maxScrolls = 20
  let pauseMs = 900
  let stallRounds = 3

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--selector') {
      const rawSelector = rest[index + 1]
      if (rawSelector === undefined) {
        throw new Error('missing selector value')
      }

      selector = rawSelector.trim() || 'article'
      index += 1
      continue
    }

    if (value === '--limit') {
      const rawLimit = rest[index + 1]
      if (rawLimit === undefined) {
        throw new Error('missing limit value')
      }

      const parsedLimit = Number(rawLimit)
      if (!Number.isInteger(parsedLimit) || parsedLimit < 0) {
        throw new Error('limit must be a non-negative integer')
      }

      limit = parsedLimit
      index += 1
      continue
    }

    if (value === '--dedupe') {
      const rawDedupe = rest[index + 1]
      if (rawDedupe === undefined) {
        throw new Error('missing dedupe value')
      }

      if (!FEED_DEDUPE_OPTIONS.includes(rawDedupe as (typeof FEED_DEDUPE_OPTIONS)[number])) {
        throw new Error('dedupe must be url, text, or none')
      }

      dedupe = rawDedupe as (typeof FEED_DEDUPE_OPTIONS)[number]
      index += 1
      continue
    }

    if (value === '--max-scrolls') {
      const rawMaxScrolls = rest[index + 1]
      if (rawMaxScrolls === undefined) {
        throw new Error('missing max-scrolls value')
      }

      const parsedMaxScrolls = Number(rawMaxScrolls)
      if (!Number.isInteger(parsedMaxScrolls) || parsedMaxScrolls < 0) {
        throw new Error('max-scrolls must be a non-negative integer')
      }

      maxScrolls = parsedMaxScrolls
      index += 1
      continue
    }

    if (value === '--pause-ms') {
      const rawPauseMs = rest[index + 1]
      if (rawPauseMs === undefined) {
        throw new Error('missing pause-ms value')
      }

      const parsedPauseMs = Number(rawPauseMs)
      if (!Number.isInteger(parsedPauseMs) || parsedPauseMs < 0) {
        throw new Error('pause-ms must be a non-negative integer')
      }

      pauseMs = parsedPauseMs
      index += 1
      continue
    }

    if (value === '--stall-rounds') {
      const rawStallRounds = rest[index + 1]
      if (rawStallRounds === undefined) {
        throw new Error('missing stall-rounds value')
      }

      const parsedStallRounds = Number(rawStallRounds)
      if (!Number.isInteger(parsedStallRounds) || parsedStallRounds < 0) {
        throw new Error('stall-rounds must be a non-negative integer')
      }

      stallRounds = parsedStallRounds
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`unsupported feed option: ${value}`)
    }

    if (selector === 'article') {
      selector = value
      continue
    }

    throw new Error(`unexpected extra argument for feed: ${value}`)
  }

  return {
    selector,
    limit,
    dedupe,
    maxScrolls,
    pauseMs,
    stallRounds,
  }
}

async function resolveSnapshotExportPath(outputPath: string | null): Promise<string> {
  if (outputPath) {
    return outputPath
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-snapshot-'))
  return path.join(tempDir, `snapshot-${Date.now()}.jsonl`)
}

function parseSnapshotFieldSelectors(rest: string[]): {
  outputPath: string | null
  selection: SnapshotFieldSelection
} {
  const selection: SnapshotFieldSelection = { fields: [] }
  let outputPath: string | null = null

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--field') {
      const rawField = rest[index + 1]
      if (rawField === undefined) {
        throw new Error('missing field value')
      }

      selection.fields.push(
        ...rawField
          .split(',')
          .map((field) => field.trim())
          .filter(Boolean),
      )
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`unsupported snapshot extract option: ${value}`)
    }

    if (!outputPath) {
      outputPath = value
      continue
    }

    throw new Error(`unexpected extra argument for snapshot extract: ${value}`)
  }

  return { outputPath, selection }
}

// 从 eval 参数里抽走 --timeout-ms，其余原样交给 resolveEvalScript 当脚本内容
function extractEvalTimeoutMs(rest: string[]): { scriptRest: string[]; timeoutMs?: number } {
  const scriptRest: string[] = []
  let timeoutMs: number | undefined

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--timeout-ms') {
      timeoutMs = parseNumberArg(rest[index + 1], 'timeout ms', { min: 1, integer: true })
      index += 1
      continue
    }
    scriptRest.push(value)
  }

  return { scriptRest, timeoutMs }
}

async function handleEval(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['eval'])) {
    return 0
  }

  const { scriptRest, timeoutMs } = extractEvalTimeoutMs(rest)
  const script = await context.resolveEvalScript(scriptRest)
  const args: Record<string, unknown> = { script }
  if (timeoutMs !== undefined) {
    args.timeoutMs = timeoutMs
  }
  const payload = await context.requestCommand(context.flags.server, 'eval', args)
  context.writeResult(payload)
  return 0
}

async function handleScript(rest: string[], context: CommandContext): Promise<number | void> {
  const action = readAllowedArg(rest[0], context, ['script'], SCRIPT_ACTIONS)
  if (!action) {
    return 0
  }

  if (action === 'add') {
    const scriptArgs = rest.slice(1)
    if (helpRequested(scriptArgs[0], context, ['script', 'add'])) {
      return 0
    }

    // 源码输入与 eval 完全同一条管线：位置参数、--file、--stdin、--base64
    const source = (await context.resolveEvalScript(scriptArgs)).trim()
    if (!source) {
      process.stderr.write('missing script source\n')
      return 1
    }

    await requestAndWrite(context, 'script', { action: 'add', source })
    return 0
  }

  if (action === 'list') {
    await requestAndWrite(context, 'script', { action: 'list' })
    return 0
  }

  const target = rest[1]
  if (helpRequested(target, context, ['script', 'remove'])) {
    return 0
  }

  if (target === '--all' || target === 'all') {
    await requestAndWrite(context, 'script', { action: 'remove', all: true })
    return 0
  }

  if (!target) {
    return context.writeHelp(['script', 'remove'])
  }

  await requestAndWrite(context, 'script', { action: 'remove', id: target })
  return 0
}

async function handleSnapshot(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['snapshot'])) {
    return 0
  }

  if (rest[0] === 'export') {
    if (helpRequested(rest[1], context, ['snapshot', 'export'])) {
      return 0
    }

    const outputPath = await resolveSnapshotExportPath(rest[1] || null)
    const payload = await context.requestCommand(context.flags.server, 'snapshot', {})

    if (payload.ok === false) {
      context.writeResult(payload)
      return 1
    }

    const snapshot = isRecord(payload.result) ? (payload.result as Record<string, unknown>) : null
    if (!snapshot) {
      process.stderr.write('snapshot export requires a structured snapshot result\n')
      return 1
    }

    const { content, recordCount } = buildSnapshotJsonl(snapshot)
    await writeFile(outputPath, content, 'utf8')

    if (context.flags.json) {
      context.writeResult({
        ok: true,
        result: {
          path: outputPath,
          format: 'jsonl',
          recordCount,
        },
      })
      return 0
    }

    process.stdout.write(`${outputPath}\n`)
    return 0
  }

  if (rest[0] === 'extract') {
    if (helpRequested(rest[1], context, ['snapshot', 'extract'])) {
      return 0
    }

    const parsedExtractArgs = parseOrWriteError(() => parseSnapshotFieldSelectors(rest.slice(1)))
    if (!parsedExtractArgs) {
      return 1
    }

    const resolvedOutputPath = await resolveSnapshotExportPath(parsedExtractArgs.outputPath)
    const payload = await context.requestCommand(context.flags.server, 'snapshot', {})

    if (payload.ok === false) {
      context.writeResult(payload)
      return 1
    }

    const snapshot = isRecord(payload.result) ? (payload.result as Record<string, unknown>) : null
    if (!snapshot) {
      process.stderr.write('snapshot extract requires a structured snapshot result\n')
      return 1
    }

    const { content, recordCount } = buildSnapshotFieldJsonl(snapshot, parsedExtractArgs.selection)
    await writeFile(resolvedOutputPath, content, 'utf8')

    if (context.flags.json) {
      context.writeResult({
        ok: true,
        result: {
          path: resolvedOutputPath,
          format: 'jsonl',
          recordCount,
        },
      })
      return 0
    }

    process.stdout.write(`${resolvedOutputPath}\n`)
    return 0
  }

  const snapshotTarget = parseOrWriteError(() => parseSnapshotArgs(rest))
  if (!snapshotTarget) {
    return 1
  }

  const payload = await context.requestCommand(context.flags.server, 'snapshot', {
    ...(snapshotTarget.target ? { selector: snapshotTarget.target } : {}),
    ...(snapshotTarget.roles && snapshotTarget.roles.length > 0
      ? { roles: snapshotTarget.roles }
      : {}),
    ...(snapshotTarget.changed ? { changed: true } : {}),
  })
  context.writeResult(payload)
  return 0
}

async function handleSearch(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['search'])) {
    return 0
  }

  const searchArgs = parseOrWriteError(() => parseSearchArgs(rest))
  if (!searchArgs) {
    return 1
  }

  const payload = await context.requestCommand(context.flags.server, 'search', searchArgs)
  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

async function handleFeed(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['feed'])) {
    return 0
  }

  const feedArgs = parseOrWriteError(() => parseFeedArgs(rest))
  if (!feedArgs) {
    return 1
  }

  const payload = await context.requestCommand(context.flags.server, 'feed', feedArgs)
  context.writeResult(payload)
  return 0
}

async function handleScreenshot(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['screenshot'])) {
    return 0
  }

  const screenshotArgs = parseOrWriteError(() => parseScreenshotArgs(rest))
  if (!screenshotArgs) {
    return 1
  }

  const payload = await context.requestCommand(context.flags.server, 'screenshot', {
    full: screenshotArgs.full,
    annotate: screenshotArgs.annotate,
    format: screenshotArgs.format,
    ...(screenshotArgs.element ? { element: screenshotArgs.element } : {}),
    ...(screenshotArgs.quality !== null ? { quality: screenshotArgs.quality } : {}),
  })

  if (payload.ok === false) {
    context.writeResult(payload)
    return 1
  }

  const { data, mimeType } = context.extractScreenshotData(
    payload.result as Record<string, unknown> | undefined,
  )
  const outputPath = await context.resolveScreenshotOutputPath(screenshotArgs)
  await writeFile(outputPath, data)

  if (context.flags.json) {
    context.writeResult({
      path: outputPath,
      mimeType,
      format: screenshotArgs.format,
      full: screenshotArgs.full,
      annotate: screenshotArgs.annotate,
    })
    return 0
  }

  process.stdout.write(`${outputPath}\n`)
  return 0
}

const handleBack = createNoArgRequestCommand({ helpPath: ['back'], command: 'back' })

const handleForward = createNoArgRequestCommand({ helpPath: ['forward'], command: 'forward' })

const handleReload: CommandHandler = async (rest, context) => {
  if (helpRequested(rest[0], context, ['reload'])) return 0
  const args: Record<string, unknown> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--wait-until') {
      args.waitUntil = rest[++index]
      continue
    }
    if (value === '--timeout-ms') {
      args.timeoutMs = parseNumberArg(rest[++index], 'timeout ms', { min: 1, integer: true })
      continue
    }
    if (value === '--wait-for') {
      const waitFor = rest[index + 1]
      const waitValue = rest[index + 2]
      if (waitFor !== 'url' && waitFor !== 'selector') {
        return writeCommandError('reload --wait-for must be url or selector')
      }
      if (waitValue === undefined) {
        return writeCommandError(`missing reload --wait-for ${waitFor} value`)
      }
      args.waitFor = waitFor
      args[waitFor] = waitValue
      index += 2
      continue
    }
    return writeCommandError(`unsupported reload option: ${value}`)
  }
  await requestAndWrite(context, 'reload', args)
  return 0
}

async function handleClose(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['close'])) {
    return 0
  }

  await requestAndWrite(context, 'close', {
    all: rest[0] === 'all' || rest[0] === '--all',
  })
  return 0
}

const handleWindow = createActionCommand({
  helpPath: ['window'],
  allowed: WINDOW_ACTIONS,
  handle: async (_rest, context, action) => {
    await requestAndWrite(context, 'window', { action })
    return 0
  },
})

const handleFrame = createSingleArgRequestCommand({
  helpPath: ['frame'],
  command: 'frame',
  argName: 'selector',
})

async function handleIs(rest: string[], context: CommandContext): Promise<number | void> {
  const state = rest[0] || 'visible'
  const selector = rest[1]
  if (helpRequested(rest[0], context, ['is']) || helpRequested(selector, context, ['is'])) {
    return 0
  }

  if (!selector) {
    return context.writeHelp(['is'])
  }

  const payload = await context.requestCommand(context.flags.server, 'is', {
    selector,
    state,
  })
  if (payload.ok === false) {
    context.writeResult(payload)
    return 1
  }

  const value = (payload.result as { value?: unknown } | undefined)?.value
  if (value !== undefined) {
    context.writeResult(value as string | number | boolean | bigint)
    return 0
  }

  context.writeResult(payload)
  return 0
}

async function handleGet(rest: string[], context: CommandContext): Promise<number | void> {
  const attr = rest[0] || 'text'
  const selector = rest[1]
  if (helpRequested(rest[0], context, ['get']) || helpRequested(selector, context, ['get'])) {
    return 0
  }

  if (attr === 'cdp-url') {
    try {
      const cdpUrl = await context.getCdpUrl(context.flags.server)
      context.writeResult(cdpUrl)
      return 0
    } catch (error) {
      return writeCommandError(error)
    }
  }

  if (commandNeedsSelector(attr) && !selector) {
    process.stderr.write('missing selector\n')
    return 1
  }

  await requestAndWrite(context, 'get', {
    selector,
    attr,
  })
  return 0
}

const handleDialog = createActionCommand({
  helpPath: ['dialog'],
  allowed: DIALOG_ACTIONS,
  handle: async (rest, context, action) => {
    if (action === 'status') {
      await requestAndWrite(context, 'dialog', { action: 'status' })
      return 0
    }

    if (action === 'auto') {
      // 不带开关只查询当前值；--on/--off 设置开关（重启扩展后回到默认 true）
      const rawValue = rest[0]
      if (rawValue === '--on' || rawValue === 'on') {
        await requestAndWrite(context, 'dialog', { action: 'auto', enabled: true })
        return 0
      }
      if (rawValue === '--off' || rawValue === 'off') {
        await requestAndWrite(context, 'dialog', { action: 'auto', enabled: false })
        return 0
      }
      if (rawValue !== undefined) {
        return writeCommandError(`unexpected dialog auto argument: ${rawValue}`)
      }
      await requestAndWrite(context, 'dialog', { action: 'auto' })
      return 0
    }

    await requestAndWrite(context, 'dialog', {
      accept: action !== 'dismiss',
      promptText: rest.join(' '),
    })
    return 0
  },
})

const handleDownloads: CommandHandler = async (rest, context) => {
  const subcommand = rest[0]
  if (helpRequested(subcommand, context, ['downloads'])) {
    return 0
  }

  // list 是默认 subaction（不带子命令时直接列出），分页参数复用 console/errors 的解析
  const action = subcommand === 'clear' ? 'clear' : 'list'
  const argRest = subcommand === 'clear' || subcommand === 'list' ? rest.slice(1) : rest

  if (action === 'clear') {
    if (argRest.length > 0) {
      return writeCommandError(`unexpected downloads clear argument: ${argRest[0]}`)
    }
    await requestAndWrite(context, 'downloads', { action: 'clear' })
    return 0
  }

  const listArgs = parseOrWriteError(() => parseConsoleArgs(argRest))
  if (!listArgs) {
    return 1
  }
  await requestAndWrite(context, 'downloads', {
    action: 'list',
    ...(listArgs.pageIdx !== undefined ? { pageIdx: listArgs.pageIdx } : {}),
    ...(listArgs.pageSize !== undefined ? { pageSize: listArgs.pageSize } : {}),
  })
  return 0
}

async function handleWait(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['wait'])) {
    return 0
  }

  const waitArgs = parseOrWriteError(() => parseWaitArgs(rest))
  if (!waitArgs) {
    return 1
  }

  await requestAndWrite(context, 'wait', waitArgs)
  return 0
}

const CONSOLE_LEVEL_ORDER = ['error', 'warning', 'info', 'debug'] as const

function consoleTypeRank(type: string): number {
  // CDP consoleAPICalled 的 type 细分很多（log/dir/table/...），除 error/warning/debug 外
  // 一律归入 info，与 Playwright 的 level 语义对齐
  if (type === 'error') {
    return 0
  }
  if (type === 'warning') {
    return 1
  }
  if (type === 'debug') {
    return 3
  }
  return 2
}

const handleConsole: CommandHandler = async (rest, context) => {
  if (helpRequested(rest[0], context, ['console'])) {
    return 0
  }

  const consoleArgs = parseOrWriteError(() => parseConsoleArgs(rest))
  if (!consoleArgs) {
    return 1
  }

  const payload = await context.requestCommand(context.flags.server, 'console', {
    action: consoleArgs.action || 'list',
    ...(consoleArgs.since !== undefined ? { since: consoleArgs.since } : {}),
    ...(consoleArgs.allEpochs ? { allEpochs: true } : {}),
    ...(consoleArgs.pageIdx !== undefined ? { pageIdx: consoleArgs.pageIdx } : {}),
    ...(consoleArgs.pageSize !== undefined ? { pageSize: consoleArgs.pageSize } : {}),
  })
  // --level 语义与 Playwright 一致：每个级别包含更严重的消息（error < warning < info < debug）
  if (consoleArgs.level && payload.ok && isRecord(payload.result)) {
    const maxRank = CONSOLE_LEVEL_ORDER.indexOf(consoleArgs.level)
    const messages = Array.isArray(payload.result.messages) ? payload.result.messages : []
    context.writeResult({
      ...payload,
      result: {
        ...payload.result,
        messages: messages.filter((message) =>
          isRecord(message) ? consoleTypeRank(String(message.type || '')) <= maxRank : true,
        ),
      },
    })
    return 0
  }

  context.writeResult(payload)
  return 0
}

const handleErrors: CommandHandler = async (rest, context) => {
  if (helpRequested(rest[0], context, ['errors'])) {
    return 0
  }

  const errorsArgs = parseOrWriteError(() => parseConsoleArgs(rest))
  if (!errorsArgs) {
    return 1
  }

  await requestAndWrite(context, 'errors', {
    action: errorsArgs.action || 'list',
    ...(errorsArgs.since !== undefined ? { since: errorsArgs.since } : {}),
    ...(errorsArgs.allEpochs ? { allEpochs: true } : {}),
    ...(errorsArgs.pageIdx !== undefined ? { pageIdx: errorsArgs.pageIdx } : {}),
    ...(errorsArgs.pageSize !== undefined ? { pageSize: errorsArgs.pageSize } : {}),
  })
  return 0
}

const handlePdf = createNoArgRequestCommand({ helpPath: ['pdf'], command: 'pdf' })

export const pageCommandRegistry: CommandRegistry = {
  eval: handleEval,
  script: handleScript,
  snapshot: handleSnapshot,
  search: handleSearch,
  feed: handleFeed,
  screenshot: handleScreenshot,
  back: handleBack,
  forward: handleForward,
  reload: handleReload,
  close: handleClose,
  quit: handleClose,
  exit: handleClose,
  window: handleWindow,
  frame: handleFrame,
  is: handleIs,
  get: handleGet,
  dialog: handleDialog,
  downloads: handleDownloads,
  wait: handleWait,
  console: handleConsole,
  errors: handleErrors,
  pdf: handlePdf,
}
