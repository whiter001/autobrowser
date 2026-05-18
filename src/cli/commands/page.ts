import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isRecord } from '../client.js'
import { parseScreenshotArgs, parseWaitArgs } from '../parse.js'
import { buildSnapshotJsonl } from '../snapshot-export.js'
import { buildSnapshotFieldJsonl, type SnapshotFieldSelection } from '../snapshot-structure.js'
import {
  createActionCommand,
  createNoArgRequestCommand,
  createSingleArgRequestCommand,
  helpRequested,
  parseOrWriteError,
  requestAndWrite,
  writeCommandError,
} from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

const WINDOW_ACTIONS = ['new'] as const
const DIALOG_ACTIONS = ['accept', 'dismiss', 'status'] as const

function commandNeedsSelector(attr: string): boolean {
  return !['title', 'url', 'cdp-url'].includes(attr)
}

async function resolveSnapshotExportPath(outputPath: string | null): Promise<string> {
  if (outputPath) {
    return outputPath
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-snapshot-'))
  return path.join(tempDir, `snapshot-${Date.now()}.jsonl`)
}

function parseSnapshotFieldSelectors(rest: string[]): { outputPath: string | null; selection: SnapshotFieldSelection } {
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

async function handleEval(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['eval'])) {
    return 0
  }

  const script = await context.resolveEvalScript(rest)
  const payload = await context.requestCommand(context.flags.server, 'eval', { script })
  context.writeResult(payload)
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

    const parsedExtractArgs = parseOrWriteError(() =>
      parseSnapshotFieldSelectors(rest.slice(1)),
    )
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

  const payload = await context.requestCommand(context.flags.server, 'snapshot', {})
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

const handleReload = createNoArgRequestCommand({ helpPath: ['reload'], command: 'reload' })

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

    await requestAndWrite(context, 'dialog', {
      accept: action !== 'dismiss',
      promptText: rest.join(' '),
    })
    return 0
  },
})

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

const handleConsole = createNoArgRequestCommand({ helpPath: ['console'], command: 'console' })

const handleErrors = createNoArgRequestCommand({ helpPath: ['errors'], command: 'errors' })

const handlePdf = createNoArgRequestCommand({ helpPath: ['pdf'], command: 'pdf' })

export const pageCommandRegistry: CommandRegistry = {
  eval: handleEval,
  snapshot: handleSnapshot,
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
  wait: handleWait,
  console: handleConsole,
  errors: handleErrors,
  pdf: handlePdf,
}
