import { describe, expect, test } from 'bun:test'
import { createConnectionRuntime } from '../extension/background/connection.js'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  readonly url: string
  readonly sentMessages: string[] = []
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(message: string): void {
    this.sentMessages.push(message)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.dispatch('close', { code: 1000, reason: '', wasClean: true })
  }

  dispatch(type: string, event: unknown = {}): void {
    if (type === 'open') {
      this.readyState = MockWebSocket.OPEN
    }

    for (const listener of this.listeners.get(type) || []) {
      listener(event)
    }
  }
}

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

describe('extension background connection', () => {
  test('connects with persisted relay port and publishes state only after open', async () => {
    const originalGlobals = {
      chrome: globalThis.chrome,
      WebSocket: globalThis.WebSocket,
    }

    const listenerRegistry = {
      runtimeInstalled: [] as Array<() => void>,
      runtimeStartup: [] as Array<() => void>,
      runtimeMessage: [] as Array<
        (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean
      >,
      tabsRemoved: [] as Array<(tabId: number) => void>,
      storageChanged: [] as Array<
        (changes: Record<string, { newValue?: unknown }>, areaName: string) => void
      >,
      debuggerEvent: [] as Array<
        (source: { tabId?: number }, method: string, params: unknown) => void
      >,
    }

    const storageValues = {
      autobrowserToken: 'saved-token',
      autobrowserRelayPort: 49002,
    }

    defineGlobalValue('chrome', {
      runtime: {
        id: 'ext-id',
        getManifest: () => ({ version: '1.2.3' }),
        lastError: undefined,
        onInstalled: {
          addListener: (listener: () => void) => listenerRegistry.runtimeInstalled.push(listener),
        },
        onStartup: {
          addListener: (listener: () => void) => listenerRegistry.runtimeStartup.push(listener),
        },
        onMessage: {
          addListener: (
            listener: (
              message: unknown,
              sender: unknown,
              sendResponse: (value: unknown) => void,
            ) => boolean,
          ) => listenerRegistry.runtimeMessage.push(listener),
        },
        openOptionsPage: async () => {},
      },
      storage: {
        local: {
          set: async () => {},
          get: async (keys: string | string[] | null) => {
            if (Array.isArray(keys)) {
              return Object.fromEntries(
                keys.map((key) => [key, storageValues[key as keyof typeof storageValues]]),
              )
            }

            if (typeof keys === 'string') {
              return { [keys]: storageValues[keys as keyof typeof storageValues] }
            }

            return storageValues
          },
        },
        onChanged: {
          addListener: (
            listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void,
          ) => listenerRegistry.storageChanged.push(listener),
        },
      },
      tabs: {
        onRemoved: {
          addListener: (listener: (tabId: number) => void) =>
            listenerRegistry.tabsRemoved.push(listener),
        },
      },
      debugger: {
        onEvent: {
          addListener: (
            listener: (source: { tabId?: number }, method: string, params: unknown) => void,
          ) => listenerRegistry.debuggerEvent.push(listener),
        },
      },
    })

    defineGlobalValue('WebSocket', MockWebSocket)

    const state = {
      socket: null,
      reconnectTimer: null,
      connecting: false,
      suppressCloseError: false,
      attachedTabs: new Set<number>(),
      selectedFrames: new Map<number, string>(),
      targetTabId: null,
      tabHandles: new Map<number, string>(),
      tabIdsByHandle: new Map<string, number>(),
      pageEpochs: new Map<number, number>(),
      nextTabHandleIndex: 1,
      dialog: null,
      network: {
        routes: [],
        requests: [],
        requestMap: new Map(),
        harRecording: false,
        harStartedAt: null,
      },
      shouldReconnect: true,
      token: '',
      relayPort: 57978,
      consoleMessages: [],
      pageErrors: [],
      connectionStatus: 'idle',
      connectionError: null,
      lastSocketClose: null,
      lastCommandError: null,
    } as const

    const runtime = createConnectionRuntime({
      state: state as never,
      network: {
        handleRequestPaused: async () => {},
        handleEvent: async () => {},
      },
      listTabs: async () => [],
      handleCommand: async () => ({ ok: true }),
      sendDebuggerCommand: async <TResult = unknown>(
        _tabId: number,
        _method: string,
        _params: Record<string, unknown> = {},
      ): Promise<TResult> => ({}) as TResult,
      storageLocalGet: async <T extends Record<string, unknown> = Record<string, unknown>>(
        keys: string | string[] | null,
      ): Promise<T> => {
        if (Array.isArray(keys)) {
          return Object.fromEntries(
            keys.map((key) => [key, storageValues[key as keyof typeof storageValues]]),
          ) as unknown as T
        }

        if (typeof keys === 'string') {
          return { [keys]: storageValues[keys as keyof typeof storageValues] } as unknown as T
        }

        return storageValues as unknown as T
      },
      storageLocalSet: async () => {},
      clearTabRuntimeState: () => {},
      detachDebugger: async () => {},
      getDialogStatus: () => ({}),
    })

    try {
      runtime.registerChromeListeners()
      expect(MockWebSocket.instances).toHaveLength(0)

      runtime.initialize()
      await flushMicrotasks()
      expect(MockWebSocket.instances).toHaveLength(1)

      const socket = MockWebSocket.instances[0]
      expect(socket.url).toContain('ws://127.0.0.1:49002/ws')
      expect(socket.url).toContain('token=saved-token')
      expect(socket.sentMessages).toHaveLength(0)

      socket.dispatch('open')
      await flushMicrotasks()
      expect(socket.sentMessages).toHaveLength(2)

      const helloMessage = JSON.parse(socket.sentMessages[0]) as { type?: string; version?: string }
      const stateMessage = JSON.parse(socket.sentMessages[1]) as {
        type?: string
        activeTabId?: unknown
      }

      expect(helloMessage.type).toBe('extension.hello')
      expect(helloMessage.version).toBe('1.2.3')
      expect(stateMessage.type).toBe('state')
    } finally {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('WebSocket', originalGlobals.WebSocket)
      MockWebSocket.instances = []
    }
  })
})
