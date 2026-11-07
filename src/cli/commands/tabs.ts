import { isRecord, shouldOpenInNewTab, type CommandResponse } from '../client.js'
import { parseNumberArg } from '../parse.js'
import { optionHintSuffix } from '../option-hints.js'
import {
  helpRequested,
  parseOrThrow,
  readRequiredArg,
  requestAndWrite,
  throwCommandError,
  resolveCommandAction,
  runActionCommand,
} from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

async function handleTab(rest: string[], context: CommandContext): Promise<number | void> {
  const resolution = resolveCommandAction(rest[0], 'tab', context, ['tab'])
  if (resolution.kind === 'help') return 0
  // 没有子命令时打印帮助；不认识的子命令当作 tab handle 处理（见下方 unsupported 分支）。
  if (resolution.kind === 'missing') return context.writeHelp(['tab'])
  if (resolution.kind === 'unsupported') {
    // 未识别的子命令当作 tab handle 处理：`autobrowser tab t3` 等价于 `tab select t3`。
    await requestAndWrite(context, 'tab.select', { handle: resolution.token })
    return 0
  }

  const tabAction = resolution.action
  const tabArgs = rest.slice(1)
  // switch 分支集合就是 tab 的实现面，测试会拿它和 action 表核对。
  switch (tabAction) {
    case 'list': {
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
        if (value === '--page-size' || value === '--limit') {
          args.pageSize = parseNumberArg(tabArgs[++index], 'page size', {
            min: 1,
            max: 200,
            integer: true,
          })
          continue
        }
        // 未知参数此前会打印帮助并以 0 退出，调用方容易误以为列表已返回
        if (value.startsWith('--')) {
          return throwCommandError(
            `unsupported tab list option: ${value}` +
              optionHintSuffix(value, [
                '--active',
                '--current-window',
                '--filter',
                '--page',
                '--page-size',
              ]),
          )
        }
        return context.writeHelp(['tab', 'list'])
      }
      await requestAndWrite(context, 'tab.list', args)
      return 0
    }

    case 'new': {
      if (helpRequested(tabArgs[0], context, ['tab', 'new'])) {
        return 0
      }
      const parsed = parseOrThrow(() => {
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
      const payload = await createTabAndWait(context, parsed.url || 'about:blank', parsed)
      context.writeResult(payload)
      return payload.ok === false ? 1 : 0
    }

    case 'select': {
      const handle = readRequiredArg(tabArgs[0], context, ['tab', 'select'])
      if (!handle) {
        return 0
      }
      await requestAndWrite(context, 'tab.select', { handle })
      return 0
    }

    case 'close': {
      const handle = tabArgs[0]
      if (helpRequested(handle, context, ['tab', 'close'])) {
        return 0
      }
      await requestAndWrite(context, 'tab.close', handle ? { handle } : {})
      return 0
    }

    default: {
      // 表里声明了 action 但还没有实现分支：必须报错，不能静默当成功。
      return throwCommandError(`tab action is not implemented: ${tabAction}`)
    }
  }
}

async function handleTarget(rest: string[], context: CommandContext): Promise<number | void> {
  const resolution = resolveCommandAction(rest[0], 'target', context, ['target'])
  if (resolution.kind === 'help') return 0
  if (resolution.kind !== 'action') return context.writeHelp(['target'])

  const targetAction = resolution.action
  // switch 分支集合就是 target 的实现面，测试会拿它和 action 表核对。
  switch (targetAction) {
    case 'show':
    case 'clear':
    case 'active': {
      return await runActionCommand(context, 'target', { action: targetAction })
    }
    case 'set': {
      const handle = readRequiredArg(rest[1], context, ['target', 'set'])
      if (!handle) return 0
      return await runActionCommand(context, 'target', { action: 'set', handle })
    }
    default: {
      // 表里声明了 action 但还没有实现分支：必须报错，不能静默当成功。
      return throwCommandError(`target action is not implemented: ${targetAction}`)
    }
  }
}

async function handleCommandControl(
  rest: string[],
  context: CommandContext,
): Promise<number | void> {
  const resolution = resolveCommandAction(rest[0], 'command', context, ['command'])
  if (resolution.kind === 'help') return 0
  if (resolution.kind !== 'action') return context.writeHelp(['command'])

  const commandAction = resolution.action
  // switch 分支集合就是 command 的实现面，测试会拿它和 action 表核对。
  switch (commandAction) {
    case 'list': {
      return await runActionCommand(context, 'command', { action: 'list' })
    }
    case 'status': {
      return await runActionCommand(context, 'command', {
        action: 'status',
        ...(rest[1] ? { commandId: rest[1] } : {}),
      })
    }
    case 'cancel': {
      const commandId = readRequiredArg(rest[1], context, ['command', 'cancel'])
      if (!commandId) return 0
      return await runActionCommand(context, 'command', { action: 'cancel', commandId })
    }
    case 'reset': {
      return await runActionCommand(context, 'command', {
        action: 'reset',
        ...(context.flags.tab ? { handle: context.flags.tab } : {}),
      })
    }
    default: {
      // 表里声明了 action 但还没有实现分支：必须报错，不能静默当成功。
      return throwCommandError(`command action is not implemented: ${commandAction}`)
    }
  }
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

  const parsedArgs = parseOrThrow(() => parseGotoArgs(rest))

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
