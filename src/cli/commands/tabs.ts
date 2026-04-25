import { shouldOpenInNewTab } from '../client.js'
import { helpRequested, readRequiredArg } from './shared.js'
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

async function handleOpenOrGoto(
  command: 'open' | 'goto',
  rest: string[],
  context: CommandContext,
): Promise<number | void> {
  const url = readRequiredArg(rest[0], context, [command])
  if (!url) {
    return 0
  }

  const payload = await context.requestCommand(context.flags.server, 'goto', { url })
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
