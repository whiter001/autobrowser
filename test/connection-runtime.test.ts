import { describe, expect, test } from 'bun:test'
import { createConnectionRuntime } from '../extension/background/connection.js'
import { createExtensionState } from '../extension/background/state.js'
import { DEFAULT_RELAY_PORT, RELAY_PORT_STORAGE_KEY, STORAGE_KEY } from '../extension/shared.js'
import type { TabSummary } from '../extension/background/types.js'

function defineGlobalValue(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  })
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  sentPayloads: string[] = []
  attemptedSends = 0
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>()

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const existing = this.listeners.get(type) || []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  send(payload: string): void {
    this.attemptedSends += 1
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new DOMException('Still in CONNECTING state')
    }

    this.sentPayloads.push(payload)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }

  dispatch(type: string, event: unknown = {}): void {
    if (type === 'open') {
      this.readyState = MockWebSocket.OPEN
    }

    for (const listener of this.listeners.get(type) || []) {
      listener(event)
    }
  }

  dispatchOpen(): void {
    this.dispatch('open', {})
  }
}

describe('connection runtime', () => {
  test('publishes the initial state only after the websocket opens', async () => {
    const originalGlobals = {
      chrome: globalThis.chrome,
      WebSocket: globalThis.WebSocket,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    }
    const intervalCallbacks: Array<() => void> = []

    const tabs: TabSummary[] = [
      {
        id: 11,
        handle: 'T1',
        title: 'active tab',
        url: 'https://example.com/active',
        active: true,
        pinned: false,
        status: 'complete',
        windowId: 1,
      },
      {
        id: 22,
        handle: 'T2',
        title: 'target tab',
        url: 'https://example.com/target',
        active: false,
        pinned: false,
        status: 'complete',
        windowId: 1,
      },
    ]

    const mockChrome = {
      debugger: {
        onEvent: {
          addListener: () => {},
        },
      },
      runtime: {
        id: 'test-extension-id',
        getManifest: () => ({ version: '1.2.3' }),
      },
      storage: {
        local: {
          set: async () => {},
        },
      },
    }

    defineGlobalValue('chrome', mockChrome)
    defineGlobalValue('WebSocket', MockWebSocket)
    defineGlobalValue('setInterval', (callback: () => void) => {
      intervalCallbacks.push(callback)
      return intervalCallbacks.length
    })
    defineGlobalValue('clearInterval', () => {})
    MockWebSocket.instances = []

    const mockStorageItems: Record<string, unknown> = {
      [STORAGE_KEY]: 'test-token',
      [RELAY_PORT_STORAGE_KEY]: DEFAULT_RELAY_PORT,
    }

    const sendDebuggerCommand = async <TResult = unknown>(): Promise<TResult> =>
      undefined as TResult

    const storageLocalGet = async <T extends Record<string, unknown> = Record<string, unknown>>(
      keys: string | string[] | null,
    ): Promise<T> => {
      if (typeof keys === 'string') {
        return { [keys]: mockStorageItems[keys] } as T
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, mockStorageItems[key]])) as T
      }

      return { ...mockStorageItems } as T
    }

    try {
      const state = createExtensionState(DEFAULT_RELAY_PORT)
      state.targeting.targetTabId = 22

      const connection = createConnectionRuntime({
        state,
        network: {
          handleRequestPaused: async () => {},
          handleEvent: async () => {},
        },
        listTabs: async () => tabs,
        handleCommand: async () => ({ ok: true }),
        sendDebuggerCommand,
        storageLocalGet,
        storageLocalSet: async () => {},
        clearTabRuntimeState: () => {},
        detachDebugger: async () => {},
        getDialogStatus: () => ({}),
      })

      connection.initialize()
      await flushMicrotasks()
      await flushMicrotasks()

      expect(MockWebSocket.instances).toHaveLength(1)

      const socket = MockWebSocket.instances[0]
      expect(socket.attemptedSends).toBe(0)
      expect(socket.sentPayloads).toEqual([])

      socket.dispatchOpen()
      await flushMicrotasks()

      expect(socket.attemptedSends).toBe(2)

      const messages = socket.sentPayloads.map((payload) => JSON.parse(payload)) as Array<{
        type: string
        tabs?: TabSummary[]
        activeTabId?: number | null
        targetTabId?: number | null
        pageEpochs?: Record<string, number>
        extensionId?: string
        version?: string
      }>

      expect(messages).toHaveLength(2)
      expect(messages[0]).toEqual({
        type: 'extension.hello',
        extensionId: 'test-extension-id',
        version: '1.2.3',
      })
      expect(messages[1]).toEqual({
        type: 'state',
        tabs,
        activeTabId: 11,
        targetTabId: 22,
        pageEpochs: { 11: 1, 22: 1 },
      })

      expect(state.connection.lastHeartbeatAt).toBeNull()
      expect(state.connection.lastHeartbeatSentAt).toBeNull()

      intervalCallbacks[0]?.()
      expect(socket.sentPayloads).toHaveLength(3)

      const heartbeatMessage = JSON.parse(socket.sentPayloads[2]) as {
        type?: string
        sentAt?: string
      }
      expect(heartbeatMessage.type).toBe('heartbeat')
      expect(typeof heartbeatMessage.sentAt).toBe('string')
      const sentAt = heartbeatMessage.sentAt
      if (!sentAt) {
        throw new Error('missing heartbeat sentAt')
      }

      expect(state.connection.lastHeartbeatSentAt).toBe(sentAt)

      socket.dispatch('message', {
        data: JSON.stringify({
          type: 'heartbeat',
          sentAt,
          receivedAt: '2026-05-09T12:00:00.000Z',
        }),
      })

      expect(state.connection.lastHeartbeatAt).toBe('2026-05-09T12:00:00.000Z')
    } finally {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('WebSocket', originalGlobals.WebSocket)
      defineGlobalValue('setInterval', originalGlobals.setInterval)
      defineGlobalValue('clearInterval', originalGlobals.clearInterval)
      MockWebSocket.instances = []
    }
  })

  test('drops cached attached tabs when chrome reports a debugger detach', async () => {
    const originalGlobals = {
      chrome: globalThis.chrome,
      WebSocket: globalThis.WebSocket,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    }

    let detachListener: ((source: { tabId?: number }) => void) | null = null

    const mockChrome = {
      debugger: {
        onEvent: {
          addListener: () => {},
        },
        onDetach: {
          addListener: (listener: (source: { tabId?: number }) => void) => {
            detachListener = listener
          },
        },
      },
      runtime: {
        id: 'test-extension-id',
        getManifest: () => ({ version: '1.2.3' }),
      },
      storage: {
        local: {
          set: async () => {},
        },
      },
    }

    defineGlobalValue('chrome', mockChrome)
    defineGlobalValue('WebSocket', MockWebSocket)
    defineGlobalValue('setInterval', () => 1)
    defineGlobalValue('clearInterval', () => {})
    MockWebSocket.instances = []

    const mockStorageItems: Record<string, unknown> = {
      [STORAGE_KEY]: 'test-token',
      [RELAY_PORT_STORAGE_KEY]: DEFAULT_RELAY_PORT,
    }

    const storageLocalGet = async <T extends Record<string, unknown> = Record<string, unknown>>(
      keys: string | string[] | null,
    ): Promise<T> => {
      if (typeof keys === 'string') {
        return { [keys]: mockStorageItems[keys] } as T
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, mockStorageItems[key]])) as T
      }

      return { ...mockStorageItems } as T
    }

    try {
      const state = createExtensionState(DEFAULT_RELAY_PORT)
      state.targeting.attachedTabs.add(22)

      const connection = createConnectionRuntime({
        state,
        network: {
          handleRequestPaused: async () => {},
          handleEvent: async () => {},
        },
        listTabs: async () => [],
        handleCommand: async () => ({ ok: true }),
        sendDebuggerCommand: async <TResult = unknown>() => undefined as TResult,
        storageLocalGet,
        storageLocalSet: async () => {},
        clearTabRuntimeState: () => {},
        detachDebugger: async () => {},
        getDialogStatus: () => ({}),
      })

      connection.initialize()
      await flushMicrotasks()
      await flushMicrotasks()

      expect(state.targeting.attachedTabs.has(22)).toBe(true)
      expect(detachListener).not.toBeNull()

      if (!detachListener) {
        throw new Error('missing debugger detach listener')
      }

      const triggerDetach = detachListener as (source: { tabId?: number }) => void
      triggerDetach({ tabId: 22 })

      expect(state.targeting.attachedTabs.has(22)).toBe(false)
    } finally {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('WebSocket', originalGlobals.WebSocket)
      defineGlobalValue('setInterval', originalGlobals.setInterval)
      defineGlobalValue('clearInterval', originalGlobals.clearInterval)
      MockWebSocket.instances = []
    }
  })
})
