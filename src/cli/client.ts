export interface CommandResponse {
  ok: boolean
  result?: unknown
  error?: {
    message: string
    code?: string
    details?: unknown
    suggestion?: string
    suggestedAction?: string
  }
}

export interface RequestCommandOptions {
  token?: string | null
}

export class CommandRequestError extends Error {
  constructor(
    readonly phase: 'fetch' | 'response',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'CommandRequestError'
  }
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
  options: RequestCommandOptions = {},
): Promise<CommandResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`
  }

  const body = JSON.stringify({ command, args })
  let response: Response
  try {
    response = await fetch(`${baseUrl}/command`, { method: 'POST', headers, body })
  } catch (error) {
    throw new CommandRequestError('fetch', error)
  }

  try {
    return (await response.json()) as CommandResponse
  } catch (error) {
    // 收到响应后，读取/解码失败不能再作为“尚未送达”的证据。
    throw new CommandRequestError('response', error)
  }
}

export async function getStatus(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/status`, { signal })
  return (await response.json()) as Record<string, unknown>
}
