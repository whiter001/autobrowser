import { describe, expect, test } from 'bun:test'
import { createConnectionRuntime } from '../extension/background/connection.js'
import { createExtensionState } from '../extension/background/state.js'
import { invalidatePageRefs } from '../extension/background/targeting.js'
import {
  CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  RELAY_PORT_STORAGE_KEY,
  STORAGE_KEY,
} from '../extension/shared.js'

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

type InstalledListener = (details?: { reason?: string }) => void

/** 用真实注册的 onInstalled listener 驱动安装引导逻辑，避免只测抽离后的纯函数。 */
function createInstalledListenerHarness(options: { token: string; readError?: boolean }) {
  const originalGlobals = {
    chrome: globalThis.chrome,
    WebSocket: globalThis.WebSocket,
  }

  const installedListeners: InstalledListener[] = []
  let openOptionsPageCalls = 0

  defineGlobalValue('chrome', {
    runtime: {
      id: 'ext-id',
      getManifest: () => ({ version: '1.2.3' }),
      lastError: undefined,
      onInstalled: {
        addListener: (listener: InstalledListener) => installedListeners.push(listener),
      },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      openOptionsPage: async () => {
        openOptionsPageCalls += 1
      },
    },
    storage: {
      local: {
        set: async () => {},
        get: async () => ({}),
      },
      onChanged: { addListener: () => {} },
    },
    tabs: { onRemoved: { addListener: () => {} } },
    debugger: { onEvent: { addListener: () => {} } },
  })
  defineGlobalValue('WebSocket', MockWebSocket)

  const runtime = createConnectionRuntime({
    state: createExtensionState(57978),
    handleDebuggerDetach: () => {},
    handlePageNavigation: () => {},
    network: { handleRequestPaused: async () => {}, handleEvent: async () => {} },
    listTabs: async () => [],
    handleCommand: async () => ({ ok: true }),
    sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    storageLocalGet: (async (keys: string | string[] | null) => {
      if (options.readError) {
        throw new Error('storage unavailable')
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys.map((key) => [key, key === STORAGE_KEY ? options.token : undefined]),
        )
      }

      if (typeof keys === 'string') {
        return { [keys]: keys === STORAGE_KEY ? options.token : undefined }
      }

      return { [STORAGE_KEY]: options.token }
    }) as never,
    storageLocalSet: async () => {},
    clearTabRuntimeState: () => {},
    detachDebugger: async () => {},
    getDialogStatus: () => ({}),
  })
  runtime.registerChromeListeners()

  return {
    listener: installedListeners[0],
    openOptionsPageCalls: () => openOptionsPageCalls,
    restore: () => {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('WebSocket', originalGlobals.WebSocket)
    },
  }
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
                keys.map((key) => [key, key === STORAGE_KEY ? 'test-token' : 57978]),
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

    const state = createExtensionState(57978)

    const runtime = createConnectionRuntime({
      state,
      handleDebuggerDetach: (tabId) => state.targeting.attachedTabs.delete(tabId),
      handlePageNavigation: (tabId) => invalidatePageRefs(state, tabId),
      network: {
        handleRequestPaused: async () => {},
        handleEvent: async () => {},
      },
      listTabs: async () => [
        {
          id: 11,
          handle: 't1',
          title: 'active',
          url: 'https://example.com/active',
          active: true,
          pinned: false,
          status: 'complete',
          windowId: 1,
        },
        {
          id: 22,
          handle: 't2',
          title: 'target',
          url: 'https://example.com/target',
          active: false,
          pinned: false,
          status: 'complete',
          windowId: 1,
        },
      ],
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
            keys.map((key) => [key, key === STORAGE_KEY ? 'test-token' : 57978]),
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

      state.targeting.pageEpochs.set(11, 4)

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
        pageEpochs?: Record<string, unknown>
      }

      expect(helloMessage.type).toBe('extension.hello')
      expect(helloMessage.version).toBe('1.2.3')
      expect(stateMessage.type).toBe('state')
      expect(stateMessage.pageEpochs).toEqual({
        11: 4,
        22: 1,
      })
    } finally {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('WebSocket', originalGlobals.WebSocket)
      MockWebSocket.instances = []
    }
  })

  test('keeps retrying with capped exponential backoff instead of stopping permanently', async () => {
    const originalGlobals = {
      chrome: globalThis.chrome,
      WebSocket: globalThis.WebSocket,
    }

    defineGlobalValue('chrome', {
      runtime: {
        id: 'test-extension-id',
        getManifest: () => ({ version: '1.2.3' }),
        onInstalled: {
          addListener: () => {},
        },
        onStartup: {
          addListener: () => {},
        },
        onMessage: {
          addListener: () => {},
        },
        openOptionsPage: async () => {},
      },
      debugger: {
        onEvent: {
          addListener: () => {},
        },
      },
      storage: {
        local: {
          set: async () => {},
          get: async (keys: string | string[] | null) => {
            if (Array.isArray(keys)) {
              return Object.fromEntries(
                keys.map((key) => [key, key === STORAGE_KEY ? 'test-token' : 57978]),
              )
            }

            if (typeof keys === 'string') {
              return { [keys]: keys === STORAGE_KEY ? 'test-token' : 57978 }
            }

            return {
              [STORAGE_KEY]: 'test-token',
              [RELAY_PORT_STORAGE_KEY]: 57978,
            }
          },
        },
        onChanged: {
          addListener: () => {},
        },
      },
      tabs: {
        onRemoved: {
          addListener: () => {},
        },
      },
    })
    defineGlobalValue('WebSocket', MockWebSocket)
    MockWebSocket.instances = []

    const state = createExtensionState(57978)
    state.connection.reconnectAttempts = 6

    const runtime = createConnectionRuntime({
      state,
      handleDebuggerDetach: (tabId) => state.targeting.attachedTabs.delete(tabId),
      handlePageNavigation: (tabId) => invalidatePageRefs(state, tabId),
      network: {
        handleRequestPaused: async () => {},
        handleEvent: async () => {},
      },
      listTabs: async () => [
        {
          id: 11,
          handle: 't1',
          title: 'active',
          url: 'https://example.com/active',
          active: true,
          pinned: false,
          status: 'complete',
          windowId: 1,
        },
      ],
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
            keys.map((key) => [key, key === STORAGE_KEY ? 'test-token' : 57978]),
          ) as unknown as T
        }

        if (typeof keys === 'string') {
          return { [keys]: keys === STORAGE_KEY ? 'test-token' : 57978 } as unknown as T
        }

        return {
          [STORAGE_KEY]: 'test-token',
          [RELAY_PORT_STORAGE_KEY]: 57978,
        } as unknown as T
      },
      storageLocalSet: async () => {},
      clearTabRuntimeState: () => {},
      detachDebugger: async () => {},
      getDialogStatus: () => ({}),
    })

    try {
      runtime.registerChromeListeners()
      runtime.initialize()
      await flushMicrotasks()
      await flushMicrotasks()

      expect(MockWebSocket.instances).toHaveLength(1)

      const socket = MockWebSocket.instances[0]
      socket.dispatch('open')
      await flushMicrotasks()

      socket.dispatch('close', { code: 1006, reason: 'relay closed', wasClean: false })

      expect(state.connection.shouldReconnect).toBe(true)
      expect(state.connection.reconnectTimer).not.toBeNull()

      expect(MockWebSocket.instances).toHaveLength(1)
    } finally {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('WebSocket', originalGlobals.WebSocket)
      MockWebSocket.instances = []
    }
  })
  test('registers a keepalive alarm and redials only when the connection is gone', async () => {
    const originalGlobals = { chrome: globalThis.chrome, WebSocket: globalThis.WebSocket }
    const alarmListeners: Array<(alarm: { name?: string }) => void> = []
    const createdAlarms: Array<{ name: string; periodInMinutes?: number }> = []
    const diagnosticsWrites: Array<Record<string, unknown>> = []

    defineGlobalValue('chrome', {
      runtime: {
        id: 'ext-id',
        getManifest: () => ({ version: '1.2.3' }),
        lastError: undefined,
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        openOptionsPage: async () => {},
      },
      storage: {
        local: { set: async () => {}, get: async () => ({}) },
        onChanged: { addListener: () => {} },
      },
      tabs: { onRemoved: { addListener: () => {} } },
      debugger: { onEvent: { addListener: () => {} } },
      alarms: {
        create: (name: string, info: { periodInMinutes?: number } = {}) => {
          createdAlarms.push({ name, periodInMinutes: info.periodInMinutes })
        },
        onAlarm: {
          addListener: (listener: (alarm: { name?: string }) => void) =>
            alarmListeners.push(listener),
        },
      },
    })
    defineGlobalValue('WebSocket', MockWebSocket)
    MockWebSocket.instances.length = 0

    const state = createExtensionState(57978)
    const runtime = createConnectionRuntime({
      state,
      handleDebuggerDetach: (tabId) => state.targeting.attachedTabs.delete(tabId),
      handlePageNavigation: (tabId) => invalidatePageRefs(state, tabId),
      network: { handleRequestPaused: async () => {}, handleEvent: async () => {} },
      listTabs: async () => [],
      handleCommand: async () => ({ ok: true }),
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      storageLocalGet: (async (keys: string | string[] | null) => {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, key === STORAGE_KEY ? 't' : 57978]))
        }
        if (typeof keys === 'string') return { [keys]: keys === STORAGE_KEY ? 't' : 57978 }
        return { [STORAGE_KEY]: 't', [RELAY_PORT_STORAGE_KEY]: 57978 }
      }) as never,
      storageLocalSet: async (items: Record<string, unknown>) => {
        diagnosticsWrites.push(items)
      },
      clearTabRuntimeState: () => {},
      detachDebugger: async () => {},
      getDialogStatus: () => ({}),
    })

    try {
      runtime.registerChromeListeners()
      expect(createdAlarms).toEqual([{ name: 'autobrowser-keepalive', periodInMinutes: 0.5 }])
      expect(alarmListeners).toHaveLength(1)

      runtime.initialize()
      await flushMicrotasks()
      expect(MockWebSocket.instances).toHaveLength(1)

      // 连接还活着时，alarm 不应把正常连接踢掉重来
      MockWebSocket.instances[0].readyState = MockWebSocket.OPEN
      alarmListeners[0]({ name: 'autobrowser-keepalive' })
      await flushMicrotasks()
      expect(MockWebSocket.instances).toHaveLength(1)

      // service worker 被回收后连接是 CLOSED，alarm 应把拨号补回来
      MockWebSocket.instances[0].readyState = MockWebSocket.CLOSED
      alarmListeners[0]({ name: 'autobrowser-keepalive' })
      await flushMicrotasks()
      expect(MockWebSocket.instances).toHaveLength(2)

      // 触发次数要落进诊断，extension info 才能证明 alarm 真的在按时唤醒 worker
      const latest = diagnosticsWrites.at(-1)?.[CONNECTION_DIAGNOSTICS_STORAGE_KEY] as
        | { keepalive?: { alarmFires: number; lastAlarmAt: string | null } }
        | undefined
      expect(latest?.keepalive?.alarmFires).toBe(2)
      expect(typeof latest?.keepalive?.lastAlarmAt).toBe('string')
    } finally {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('WebSocket', originalGlobals.WebSocket)
    }
  })

  test('opens the options page once on initial install without a saved token', async () => {
    const harness = createInstalledListenerHarness({ token: '' })

    try {
      harness.listener({ reason: 'install' })
      await flushMicrotasks()

      expect(harness.openOptionsPageCalls()).toBe(1)
    } finally {
      harness.restore()
    }
  })

  test('does not open the options page on initial install when a token already exists', async () => {
    const harness = createInstalledListenerHarness({ token: 'existing-token' })

    try {
      harness.listener({ reason: 'install' })
      await flushMicrotasks()

      expect(harness.openOptionsPageCalls()).toBe(0)
    } finally {
      harness.restore()
    }
  })

  test('does not open the options page when an existing install updates', async () => {
    const harness = createInstalledListenerHarness({ token: '' })

    try {
      harness.listener({ reason: 'update' })
      await flushMicrotasks()

      expect(harness.openOptionsPageCalls()).toBe(0)
    } finally {
      harness.restore()
    }
  })

  test('swallows token read failures on install instead of opening the options page', async () => {
    const harness = createInstalledListenerHarness({ token: '', readError: true })

    try {
      harness.listener({ reason: 'install' })
      await flushMicrotasks()

      expect(harness.openOptionsPageCalls()).toBe(0)
    } finally {
      harness.restore()
    }
  })
})
