import { isRecord, shouldOpenInNewTab, type CommandResponse } from '../client.js'
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
        const filter = tabArgs[index + 1]
        if (filter === undefined) {
          throw new Error('missing value for --filter')
        }
        args.filter = filter
        index += 1
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
    const parsed = parseOrWriteError(() => {
      for (let index = 0; index < tabArgs.length; index += 1) {
        const value = tabArgs[index]!
        if (value === '--wait-for') index += 2
        else if (value === '--timeout-ms') index += 1
        else if (value.startsWith('--')) throw new Error(`unsupported tab new option: ${value}`)
      }
      const options = parseGotoArgs(tabArgs)
      if (options.timeoutMs !== undefined && !options.waitFor) {
        throw new Error('--timeout-ms requires --wait-for for tab new')
      }
      return options
    })
    if (!parsed) return 1
    const payload = await createTabAndWait(context, parsed.url || 'about:blank', parsed)
    context.writeResult(payload)
    return payload.ok === false ? 1 : 0
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

interface GotoArgs {
  url?: string
  timeoutMs?: number
  wait?: boolean
  waitUntil?: string
  settleTimeoutMs?: number
  domQuietMs?: number
  waitFor?: 'url' | 'selector'
  waitUrl?: string
  selector?: string
}

async function createTabAndWait(
  context: CommandContext,
  url: string,
  options: GotoArgs,
): Promise<CommandResponse> {
  const created = await context.requestCommand(context.flags.server, 'tab.new', { url })
  if (!created.ok || !options.waitFor) return created
  const result = isRecord(created.result) ? created.result : {}
  const tab = isRecord(result.tab) ? result.tab : {}
  const target = tab.handle ?? tab.id
  let waited: CommandResponse
  try {
    if (typeof target !== 'string' && typeof target !== 'number') {
      throw new Error('tab.new returned no handle or id; cannot safely wait for the new tab')
    }
    waited = await context.requestCommand(context.flags.server, 'wait', {
      tabId: target,
      type: options.waitFor,
      ...(options.waitFor === 'url'
        ? { url: options.waitUrl }
        : { selector: options.selector, state: 'visible' }),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    })
  } catch (error) {
    waited = {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
  // Only emit the final response. Keep the created tab recoverable even on wait/transport failure.
  return { ...waited, result: { ...result, wait: waited.ok ? waited.result : waited } }
}

function parseGotoArgs(rest: string[]): GotoArgs {
  const parsed: GotoArgs = {}

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--timeout-ms') {
      if (parsed.timeoutMs !== undefined) throw new Error('duplicate goto option: --timeout-ms')
      parsed.timeoutMs = parseNumberArg(rest[index + 1], 'timeout ms', { min: 1, integer: true })
      index += 1
      continue
    }

    if (value === '--wait-for') {
      if (parsed.waitFor !== undefined) throw new Error('duplicate goto option: --wait-for')
      const type = rest[index + 1]
      const waitValue = rest[index + 2]
      if (type !== 'url' && type !== 'selector')
        throw new Error('--wait-for must be url or selector')
      if (!waitValue || waitValue.startsWith('--'))
        throw new Error(`missing --wait-for ${type} value`)
      parsed.waitFor = type
      if (type === 'url') parsed.waitUrl = waitValue
      else parsed.selector = waitValue
      index += 2
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
  if (parsedArgs.waitFor !== undefined) {
    args.waitFor = parsedArgs.waitFor
    if (parsedArgs.waitFor === 'url') args.waitUrl = parsedArgs.waitUrl
    else args.selector = parsedArgs.selector
  }

  const payload = await context.requestCommand(context.flags.server, 'goto', args)

  if (shouldOpenInNewTab(payload)) {
    const fallbackPayload = await createTabAndWait(context, url, parsedArgs)
    context.writeResult(fallbackPayload)
    return fallbackPayload.ok === false ? 1 : 0
  }

  if (payload.ok && parsedArgs.waitFor) {
    const result = isRecord(payload.result) ? payload.result : {}
    const proof = isRecord(result.wait) ? result.wait : {}
    const value = parsedArgs.waitFor === 'url' ? parsedArgs.waitUrl : parsedArgs.selector
    if (proof.completed !== true || proof.type !== parsedArgs.waitFor || proof.value !== value) {
      context.writeResult({
        ...payload,
        ok: false,
        error: {
          code: 'WAIT_NOT_CONFIRMED',
          message:
            'Extension did not confirm the requested navigation wait; update the extension and retry. Navigation may already have completed.',
        },
      })
      return 1
    }
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
