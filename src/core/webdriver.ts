import { rm } from 'node:fs/promises'
import path from 'node:path'
import { getStateDir, readJsonFile, writeJsonFile } from './protocol.js'

export type WebDriverEngine = 'firefox' | 'webkit'

export interface WebDriverError extends Error {
  code?: string
  details?: unknown
  suggestedAction?: string
}

interface WebDriverClientOptions {
  engine: WebDriverEngine
  driverUrl: string
  homeDir: string
  fetchImpl?: typeof fetch
}

interface StoredSession {
  sessionId: string
}

function webDriverError(
  message: string,
  code: string,
  suggestedAction?: string,
  details?: unknown,
): WebDriverError {
  const error = new Error(message) as WebDriverError
  error.code = code
  if (suggestedAction) error.suggestedAction = suggestedAction
  if (details !== undefined) error.details = details
  return error
}

function getSessionPath(homeDir: string, engine: WebDriverEngine): string {
  return path.join(getStateDir(homeDir), `webdriver-${engine}.json`)
}

export function createWebDriverClient({
  engine,
  driverUrl,
  homeDir,
  fetchImpl = fetch,
}: WebDriverClientOptions) {
  const baseUrl = driverUrl.replace(/\/+$/, '')
  const sessionPath = getSessionPath(homeDir, engine)
  let activeSessionId: string | null = null

  async function request<TValue = unknown>(
    requestPath: string,
    method: string,
    body?: unknown,
  ): Promise<TValue> {
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${requestPath}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw webDriverError(
        `WebDriver is unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        'BROWSER_DRIVER_UNAVAILABLE',
        engine === 'firefox'
          ? 'Start geckodriver on the configured port, then retry.'
          : 'Start safaridriver on the configured port and enable Safari Develop > Allow Remote Automation, then retry.',
      )
    }
    const text = await response.text()
    let payload: Record<string, unknown> = {}
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>
      } catch {
        throw webDriverError(
          `WebDriver returned a non-JSON response (${response.status})`,
          'WEBDRIVER_PROTOCOL_ERROR',
          undefined,
          { status: response.status, body: text.slice(0, 500) },
        )
      }
    }
    const value = payload.value
    const protocolError =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
    if (!response.ok || protocolError?.error) {
      const errorName = typeof protocolError?.error === 'string' ? protocolError.error : ''
      const message =
        typeof protocolError?.message === 'string'
          ? protocolError.message
          : `WebDriver request failed (${response.status})`
      if (
        errorName === 'invalid session id' ||
        (response.status === 404 && !protocolError?.error)
      ) {
        throw webDriverError(
          message || 'WebDriver session is no longer valid',
          'WEBDRIVER_SESSION_INVALID',
        )
      }
      throw webDriverError(message, 'WEBDRIVER_COMMAND_ERROR', undefined, {
        error: errorName || 'unknown error',
        status: response.status,
      })
    }
    return value as TValue
  }

  async function createSession(): Promise<string> {
    const value = await request<{ sessionId?: string; capabilities?: unknown }>(
      '/session',
      'POST',
      {
        capabilities: {
          alwaysMatch: { browserName: engine === 'firefox' ? 'firefox' : 'safari' },
        },
      },
    )
    const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
    if (!sessionId) {
      throw webDriverError('WebDriver did not return a sessionId', 'WEBDRIVER_PROTOCOL_ERROR')
    }
    activeSessionId = sessionId
    await writeJsonFile(sessionPath, { sessionId } satisfies StoredSession)
    return sessionId
  }

  async function ensureSession(): Promise<string> {
    if (activeSessionId) return activeSessionId
    const stored = await readJsonFile<StoredSession | null>(sessionPath, null)
    if (stored?.sessionId) {
      try {
        await request(`/session/${stored.sessionId}/url`, 'GET')
        activeSessionId = stored.sessionId
        return activeSessionId
      } catch (error) {
        if ((error as WebDriverError).code !== 'WEBDRIVER_SESSION_INVALID') throw error
        await rm(sessionPath, { force: true }).catch(() => {})
      }
    }
    return await createSession()
  }

  async function call<TValue = unknown>(
    method: string,
    pathForSession: (sessionId: string) => string,
    body?: unknown,
  ): Promise<TValue> {
    const sessionId = await ensureSession()
    return await request<TValue>(pathForSession(sessionId), method, body)
  }

  return {
    engine,
    driverUrl: baseUrl,
    ensureSession,
    call,
    async status() {
      const sessionId = await ensureSession()
      return { engine, driverUrl: baseUrl, sessionId, connected: true }
    },
    async closeSession() {
      const stored = await readJsonFile<StoredSession | null>(sessionPath, null)
      const sessionId = activeSessionId || stored?.sessionId
      if (sessionId) {
        try {
          await request(`/session/${sessionId}`, 'DELETE')
        } catch (error) {
          if ((error as WebDriverError).code !== 'WEBDRIVER_SESSION_INVALID') throw error
        }
      }
      activeSessionId = null
      await rm(sessionPath, { force: true }).catch(() => {})
    },
  }
}
