import { writeFile } from 'node:fs/promises'
import { parseScreenshotArgs, parseWaitArgs } from '../parse.js'
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

async function handleEval(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['eval'])) {
    return 0
  }

  const script = await context.resolveEvalScript(rest)
  const payload = await context.requestCommand(context.flags.server, 'eval', { script })
  context.writeResult(payload)
  return 0
}

const handleSnapshot = createNoArgRequestCommand({
  helpPath: ['snapshot'],
  command: 'snapshot',
})

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
