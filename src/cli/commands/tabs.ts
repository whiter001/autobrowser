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
    const payload = await context.requestCommand(context.flags.server, 'tab.list', {})
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

function parseGotoArgs(rest: string[]): {
  url?: string
  timeoutMs?: number
  wait?: boolean
} {
  const parsed: { url?: string; timeoutMs?: number; wait?: boolean } = {}

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
  open: (rest, context) => handleOpenOrGoto('open', rest, context),
  goto: (rest, context) => handleOpenOrGoto('goto', rest, context),
}
