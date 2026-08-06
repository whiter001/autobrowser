import { shouldOpenInNewTab } from '../client.js'
import { parseNumberArg } from '../parse.js'
import { helpRequested, parseOrWriteError, readRequiredArg } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

async function handleTab(rest: string[], context: CommandContext): Promise<number | void> {
  const [subcommand, ...tabArgs] = rest
  if (helpRequested(subcommand, context, ['tab'])) {
    return 0
  }

  if (subcommand === 'list') {
    if (helpRequested(tabArgs[0], context, ['tab', 'list'])) {
      return 0
    }
    const args: Record<string, unknown> = {}
    for (let index = 0; index < tabArgs.length; index += 1) {
      const value = tabArgs[index]
      if (value === '--active' || value === '--current-window') {
        args[value === '--active' ? 'active' : 'currentWindow'] = true
        continue
      }
      if (value === '--filter') {
        args.filter = tabArgs[++index]
        continue
      }
      if (value === '--page' || value === '--page-idx') {
        args.pageIdx = parseNumberArg(tabArgs[++index], 'page idx', { min: 0, integer: true })
        continue
      }
      if (value === '--page-size') {
        args.pageSize = parseNumberArg(tabArgs[++index], 'page size', {
          min: 1,
          max: 200,
          integer: true,
        })
        continue
      }
      return context.writeHelp(['tab', 'list'])
    }
    const payload = await context.requestCommand(context.flags.server, 'tab.list', args)
    context.writeResult(payload)
    return 0
  }

  if (subcommand === 'new') {
    if (helpRequested(tabArgs[0], context, ['tab', 'new'])) {
      return 0
    }
    const url = tabArgs[0] || 'about:blank'
    const payload = await context.requestCommand(context.flags.server, 'tab.new', { url })
    context.writeResult(payload)
    return 0
  }

  if (subcommand === 'select') {
    const handle = readRequiredArg(tabArgs[0], context, ['tab', 'select'])
    if (!handle) {
      return 0
    }
    const payload = await context.requestCommand(context.flags.server, 'tab.select', { handle })
    context.writeResult(payload)
    return 0
  }

  if (subcommand === 'close') {
    const handle = tabArgs[0]
    if (helpRequested(handle, context, ['tab', 'close'])) {
      return 0
    }
    const payload = await context.requestCommand(
      context.flags.server,
      'tab.close',
      handle ? { handle } : {},
    )
    context.writeResult(payload)
    return 0
  }

  if (subcommand) {
    const payload = await context.requestCommand(context.flags.server, 'tab.select', {
      handle: subcommand,
    })
    context.writeResult(payload)
    return 0
  }

  return context.writeHelp(['tab'])
}

async function handleTarget(rest: string[], context: CommandContext): Promise<number | void> {
  const action = rest[0] || 'show'
  if (helpRequested(action, context, ['target'])) return 0
  if (!['show', 'clear', 'active', 'set'].includes(action)) return context.writeHelp(['target'])
  const handle = action === 'set' ? readRequiredArg(rest[1], context, ['target', 'set']) : undefined
  if (action === 'set' && !handle) return 0
  const payload = await context.requestCommand(context.flags.server, 'target', {
    action,
    ...(handle ? { handle } : {}),
  })
  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

async function handleCommandControl(
  rest: string[],
  context: CommandContext,
): Promise<number | void> {
  const action = rest[0] || 'list'
  if (helpRequested(action, context, ['command'])) return 0
  if (!['list', 'status', 'cancel', 'reset'].includes(action)) {
    return context.writeHelp(['command'])
  }
  const commandId =
    action === 'cancel' ? readRequiredArg(rest[1], context, ['command', 'cancel']) : undefined
  if (action === 'cancel' && !commandId) return 0
  const payload = await context.requestCommand(context.flags.server, 'command', {
    action,
    ...(commandId ? { commandId } : {}),
    ...(action === 'status' && rest[1] ? { commandId: rest[1] } : {}),
    ...(action === 'reset' && context.flags.tab ? { handle: context.flags.tab } : {}),
  })
  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

function parseGotoArgs(rest: string[]): {
  url?: string
  timeoutMs?: number
  wait?: boolean
  waitUntil?: string
  settleTimeoutMs?: number
  domQuietMs?: number
} {
  const parsed: {
    url?: string
    timeoutMs?: number
    wait?: boolean
    waitUntil?: string
    settleTimeoutMs?: number
    domQuietMs?: number
  } = {}

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--timeout-ms') {
      parsed.timeoutMs = parseNumberArg(rest[index + 1], 'timeout ms', { min: 1, integer: true })
      index += 1
      continue
    }

    if (value === '--wait' || value === '--no-wait') {
      parsed.wait = value === '--wait'
      continue
    }

    if (value === '--wait-until') {
      const waitUntil = rest[index + 1]
      if (
        ![
          'none',
          'commit',
          'domcontentloaded',
          'interactive',
          'load',
          'networkidle',
          'domquiet',
        ].includes(waitUntil || '')
      ) {
        throw new Error(
          'invalid --wait-until (expected none|commit|domcontentloaded|interactive|load|networkidle|domquiet)',
        )
      }
      parsed.waitUntil = waitUntil
      index += 1
      continue
    }

    if (value === '--settle-timeout') {
      parsed.settleTimeoutMs = parseNumberArg(rest[index + 1], 'settle timeout', {
        min: 1,
        integer: true,
      })
      index += 1
      continue
    }

    if (value === '--dom-quiet-ms') {
      parsed.domQuietMs = parseNumberArg(rest[index + 1], 'dom quiet ms', { min: 1, integer: true })
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`unsupported goto option: ${value}`)
    }

    if (parsed.url === undefined) {
      parsed.url = value
      continue
    }

    throw new Error(`unexpected extra argument for goto: ${value}`)
  }

  return parsed
}

async function handleOpenOrGoto(
  command: 'open' | 'goto',
  rest: string[],
  context: CommandContext,
): Promise<number | void> {
  if (helpRequested(rest[0], context, [command])) {
    return 0
  }

  const parsedArgs = parseOrWriteError(() => parseGotoArgs(rest))
  if (!parsedArgs) {
    return 1
  }

  const url = readRequiredArg(parsedArgs.url, context, [command])
  if (!url) {
    return 0
  }

  const args: Record<string, unknown> = { url }
  if (parsedArgs.timeoutMs !== undefined) {
    args.timeoutMs = parsedArgs.timeoutMs
  }
  if (parsedArgs.wait !== undefined) {
    args.wait = parsedArgs.wait
  }
  if (parsedArgs.waitUntil !== undefined) args.waitUntil = parsedArgs.waitUntil
  if (parsedArgs.settleTimeoutMs !== undefined) args.settleTimeoutMs = parsedArgs.settleTimeoutMs
  if (parsedArgs.domQuietMs !== undefined) args.domQuietMs = parsedArgs.domQuietMs

  const payload = await context.requestCommand(context.flags.server, 'goto', args)

  if (shouldOpenInNewTab(payload)) {
    const fallbackPayload = await context.requestCommand(context.flags.server, 'tab.new', { url })
    context.writeResult(fallbackPayload)
    return fallbackPayload.ok === false ? 1 : 0
  }

  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

export const tabCommandRegistry: CommandRegistry = {
  tab: handleTab,
  target: handleTarget,
  command: handleCommandControl,
  open: (rest, context) => handleOpenOrGoto('open', rest, context),
  goto: (rest, context) => handleOpenOrGoto('goto', rest, context),
}
