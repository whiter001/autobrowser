import { isHelpToken } from '../help.js'
import { findCommandDefaultAction, isCommandAction, type CommandActionPath } from './actions.js'
import type { CommandContext, CommandHandler } from './types.js'

export function helpRequested(
  value: string | undefined,
  context: CommandContext,
  helpPath: string[],
): boolean {
  if (!isHelpToken(value)) {
    return false
  }

  context.writeHelp(helpPath)
  return true
}

export function readRequiredArg(
  value: string | undefined,
  context: CommandContext,
  helpPath: string[],
): string | undefined {
  if (isHelpToken(value)) {
    context.writeHelp(helpPath)
    return undefined
  }
  if (!value) {
    throw new Error(`missing value for ${helpPath.join(' ')}`)
  }

  return value
}

export function readAllowedArg<T extends string>(
  value: string | undefined,
  context: CommandContext,
  helpPath: string[],
  allowed: readonly T[],
): T | undefined {
  if (isHelpToken(value)) {
    context.writeHelp(helpPath)
    return undefined
  }
  if (!value || !allowed.includes(value as T)) {
    throw new Error(
      `unsupported ${helpPath.join(' ')} action: ${value || '(empty)'} (expected ${allowed.join('|')})`,
    )
  }

  return value as T
}

/**
 * action 入口的解析结果。
 *
 * - action：识别出合法 action，交给调用方的 switch 分发；
 * - help：token 是帮助旗标，帮助已经打印，调用方直接返回即可；
 * - missing：既没给 action，该命令路径也没有默认 action；
 * - unsupported：给了 action 但不在白名单里，兜底方式由调用方决定（多半是打印帮助）。
 */
export type CommandActionResolution =
  | { kind: 'action'; action: string }
  | { kind: 'help' }
  | { kind: 'missing' }
  | { kind: 'unsupported'; token: string }

/**
 * 解析命令的 action。
 *
 * target / command / tab 的 action 入口是同一套流程：省略 action 时用 action 表里的默认
 * action，帮助旗标直接打印帮助，其余 token 交给调用方兜底。收在这里是为了让「默认值从哪
 * 来、什么算合法 action」只有 action 表一个出处。
 */
export function resolveCommandAction(
  token: string | undefined,
  path: CommandActionPath,
  context: CommandContext,
  helpPath: string[],
): CommandActionResolution {
  if (helpRequested(token, context, helpPath)) {
    return { kind: 'help' }
  }

  const action = token ?? findCommandDefaultAction(path)
  if (action === undefined) {
    return { kind: 'missing' }
  }
  if (!isCommandAction(path, action)) {
    return { kind: 'unsupported', token: action }
  }
  return { kind: 'action', action }
}

export function writeCommandError(error: unknown): 1 {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  return 1
}

export function parseOrWriteError<T>(parser: () => T): T | undefined {
  try {
    return parser()
  } catch (error) {
    writeCommandError(error)
    return undefined
  }
}

export async function requestAndWrite(context: CommandContext, command: string, args: object = {}) {
  const payload = await context.requestCommand(context.flags.server, command, args)
  context.writeResult(payload)
  return payload
}

/**
 * 执行一个 action 命令并返回退出码。
 *
 * 扩展返回失败时退出码为 1：脚本靠退出码判断成败，失败不能被当成成功。
 */
export async function runActionCommand(
  context: CommandContext,
  command: string,
  args: object = {},
): Promise<number> {
  const payload = await requestAndWrite(context, command, args)
  return payload.ok === false ? 1 : 0
}

export function createNoArgRequestCommand(options: {
  helpPath: string[]
  command: string
  args?: object
}): CommandHandler {
  return async (rest, context) => {
    if (helpRequested(rest[0], context, options.helpPath)) {
      return 0
    }
    if (rest.length > 0) {
      throw new Error(`unexpected argument for ${options.helpPath.join(' ')}: ${rest[0]}`)
    }

    await requestAndWrite(context, options.command, options.args ?? {})
    return 0
  }
}

export function createSingleArgRequestCommand(options: {
  helpPath: string[]
  command: string
  argName: string
}): CommandHandler {
  return async (rest, context) => {
    const args = rest[0] === '--' ? rest.slice(1) : rest
    const value = readRequiredArg(args[0], context, options.helpPath)
    if (!value) {
      return 0
    }
    if (args.length > 1) {
      throw new Error(`unexpected extra argument for ${options.helpPath.join(' ')}: ${args[1]}`)
    }

    await requestAndWrite(context, options.command, {
      [options.argName]: value,
    })
    return 0
  }
}

export function createActionCommand<T extends string>(options: {
  helpPath: string[]
  allowed: readonly T[]
  handle: (rest: string[], context: CommandContext, action: T) => Promise<number | void>
}): CommandHandler {
  return async (rest, context) => {
    const action = readAllowedArg(rest[0], context, options.helpPath, options.allowed)
    if (!action) {
      return 0
    }

    return await options.handle(rest.slice(1), context, action)
  }
}
