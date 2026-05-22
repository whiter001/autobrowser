import { isRecord, type CommandResponse } from './client.js'

export class CommandResultError extends Error {
  suggestion?: string
  constructor(message: string, suggestion?: string) {
    super(message)
    this.name = 'CommandResultError'
    this.suggestion = suggestion
  }
}

function isFailedCommandResponse(payload: unknown): payload is CommandResponse {
  return isRecord(payload) && (payload as Record<string, unknown>).ok === false
}

export function writeResult(
  payload:
    | CommandResponse
    | Record<string, unknown>
    | string
    | number
    | boolean
    | bigint
    | null
    | undefined,
  options: {
    json: boolean
  },
): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (isFailedCommandResponse(payload)) {
      throw new CommandResultError(
        payload.error?.message || 'command failed',
        payload.error?.suggestion,
      )
    }
    return
  }

  if (
    typeof payload === 'string' ||
    typeof payload === 'number' ||
    typeof payload === 'boolean' ||
    typeof payload === 'bigint'
  ) {
    process.stdout.write(`${String(payload)}\n`)
    return
  }

  const responsePayload = payload as CommandResponse
  if (responsePayload?.ok === false) {
    let errorMsg = responsePayload.error?.message || 'command failed'
    const suggestion = responsePayload.error?.suggestion || responsePayload.error?.suggestedAction
    if (suggestion) {
      errorMsg += `\n\n[AI SUGGESTION]: ${suggestion}`
    }
    process.stderr.write(`${errorMsg}\n`)
    throw new CommandResultError(errorMsg, suggestion)
  }

  const result = responsePayload?.result ?? payload
  if (typeof result === 'string') {
    process.stdout.write(result.endsWith('\n') ? result : `${result}\n`)
    return
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
