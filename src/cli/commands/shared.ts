import { isHelpToken } from '../help.js'
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
  if (isHelpToken(value) || !value) {
    context.writeHelp(helpPath)
    return undefined
  }

  return value
}

export function readAllowedArg<T extends string>(
  value: string | undefined,
  context: CommandContext,
  helpPath: string[],
  allowed: readonly T[],
): T | undefined {
  if (isHelpToken(value) || !value || !allowed.includes(value as T)) {
    context.writeHelp(helpPath)
    return undefined
  }

  return value as T
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

export function createNoArgRequestCommand(options: {
  helpPath: string[]
  command: string
  args?: object
}): CommandHandler {
  return async (rest, context) => {
    if (helpRequested(rest[0], context, options.helpPath)) {
      return 0
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
    const value = readRequiredArg(rest[0], context, options.helpPath)
    if (!value) {
      return 0
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
