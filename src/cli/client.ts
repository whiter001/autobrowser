export interface CommandResponse {
  ok: boolean
  result?: unknown
  error?: { message: string; code?: string }
}

export function shouldOpenInNewTab(payload: CommandResponse): boolean {
  if (payload.ok !== false) {
    return false
  }

  const message = String(payload.error?.message || '').toLowerCase()
  return (
    message.includes('cannot access chrome:// and edge:// urls') ||
    message.includes('cannot access chrome://') ||
    message.includes('cannot access edge://')
  )
}

export function shouldTriggerAutoConnect(payload: CommandResponse): boolean {
  if (payload.ok !== false) {
    return false
  }

  const code = String(payload.error?.code || '')
  const message = String(payload.error?.message || '').toLowerCase()
  return code === 'EXTENSION_DISCONNECTED' || message.includes('no extension is connected')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

export async function requestCommandRaw(
  baseUrl: string,
  command: string,
  args: object = {},
): Promise<CommandResponse> {
  const response = await fetch(`${baseUrl}/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ command, args }),
  })

  return (await response.json()) as CommandResponse
}

export async function getStatus(baseUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/status`)
  return (await response.json()) as Record<string, unknown>
}
