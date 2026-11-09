import { createId } from './protocol.js'
import { createExtensionDisconnectedError } from './runtime-connection.js'
import type { ErrorWithCode, ExtensionMetadata } from './runtime-types.js'
import type { PlaywrightRunTransport } from './playwright-runner.js'

interface PendingCdpRequest {
  runId: string
  resolve: (value: any) => void
  reject: (error: Error) => void
}

interface CdpMessage {
  type?: string
  id?: string
  runId?: string
  ok?: boolean
  result?: unknown
  error?: string | { message?: string }
  method?: string
  params?: unknown
}

/** 复用扩展主 WebSocket 承载 CDP，不另开一条无鉴权的扩展控制通道。 */
export function createPlaywrightTransportHub(
  getSocket: () => Bun.ServerWebSocket<ExtensionMetadata> | null,
) {
  const pending = new Map<string, PendingCdpRequest>()
  const eventListeners = new Map<string, Set<(event: { method: string; params: any }) => void>>()
  const disconnectListeners = new Map<string, Set<() => void>>()

  function request(runId: string, message: Record<string, unknown>): Promise<any> {
    const socket = getSocket()
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(createExtensionDisconnectedError())
    }
    const id = createId('cdp')
    return new Promise((resolve, reject) => {
      pending.set(id, { runId, resolve, reject })
      try {
        const sent = socket.send(JSON.stringify({ ...message, type: message.type, id, runId }))
        if (sent === 0) {
          pending.delete(id)
          reject(
            createExtensionDisconnectedError('extension disconnected while sending CDP command'),
          )
        }
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function create(runId: string): PlaywrightRunTransport {
    return {
      start: async (tabId) => {
        await request(runId, { type: 'cdp.control', action: 'start', tabId })
      },
      stop: async () => {
        await request(runId, { type: 'cdp.control', action: 'stop' })
      },
      send: async (method, params) => await request(runId, { type: 'cdp.command', method, params }),
      onEvent(listener) {
        const listeners = eventListeners.get(runId) ?? new Set()
        listeners.add(listener)
        eventListeners.set(runId, listeners)
        return () => listeners.delete(listener)
      },
      onDisconnect(listener) {
        const listeners = disconnectListeners.get(runId) ?? new Set()
        listeners.add(listener)
        disconnectListeners.set(runId, listeners)
        return () => listeners.delete(listener)
      },
      close() {
        for (const [id, item] of pending) {
          if (item.runId !== runId) continue
          pending.delete(id)
          item.reject(createExtensionDisconnectedError('Playwright run closed'))
        }
        eventListeners.delete(runId)
        disconnectListeners.delete(runId)
      },
    }
  }

  function handleMessage(message: CdpMessage): boolean {
    if (message.type === 'cdp.response' && typeof message.id === 'string') {
      const item = pending.get(message.id)
      if (!item) return true
      pending.delete(message.id)
      if (message.ok === false) {
        const detail = message.error
        const error = new Error(
          typeof detail === 'string' ? detail : detail?.message || 'extension CDP command failed',
        ) as ErrorWithCode
        error.code = 'CDP_COMMAND_FAILED'
        item.reject(error)
      } else {
        item.resolve(message.result)
      }
      return true
    }
    if (
      message.type === 'cdp.event' &&
      typeof message.runId === 'string' &&
      typeof message.method === 'string'
    ) {
      for (const listener of eventListeners.get(message.runId) ?? []) {
        listener({ method: message.method, params: message.params })
      }
      return true
    }
    return false
  }

  function rejectAll(reason: string): void {
    for (const item of pending.values()) item.reject(createExtensionDisconnectedError(reason))
    pending.clear()
    for (const listeners of disconnectListeners.values()) {
      for (const listener of listeners) listener()
    }
  }

  return { create, handleMessage, rejectAll }
}
