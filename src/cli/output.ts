import type { CommandResponse } from './client.js'
import type { ResponseFormat } from './response-format.js'

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
    responseFormat?: ResponseFormat
  },
): void {
  if (options.json) {
    const spacing = options.responseFormat === 'concise' ? undefined : 2
    process.stdout.write(`${JSON.stringify(payload, null, spacing)}\n`)
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
    return
  }

  const result = responsePayload?.result ?? payload
  if (typeof result === 'string') {
    process.stdout.write(result.endsWith('\n') ? result : `${result}\n`)
    return
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
