import { describe, expect, test } from 'bun:test'
import { createConnectionRuntime } from '../extension/background/connection.js'
import { createSessionDomain } from '../extension/background/session.js'
import { createExtensionState } from '../extension/background/state.js'
import type { DialogState, ExtensionState, TabWithId } from '../extension/background/types.js'

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

function sampleDialog(overrides: Partial<DialogState> = {}): DialogState {
  return {
    open: true,
    type: 'confirm',
    message: 'Continue?',
    defaultPrompt: '',
    url: 'https://example.com',
    openedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

interface SessionHarnessOptions {
  dialog?: DialogState
  handleDialogError?: Error
  targetTabId?: number | null
  tabIdsByHandle?: Map<string, number>
}

function createSessionHarness(options: SessionHarnessOptions = {}) {
  const debuggerCalls: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> =
    []
  const state = {
    targeting: {
      targetTabId: options.targetTabId ?? null,
      tabIdsByHandle: options.tabIdsByHandle ?? new Map<string, number>(),
    },
    session: {
      dialogs: new Map<number, DialogState>(),
      lastDialog: null as Record<string, unknown> | null,
      consoleMessages: [] as unknown[],
      pageErrors: [] as unknown[],
      dialogAutoAccept: true,
    },
  }
  if (options.dialog) {
    state.session.dialogs.set(7, options.dialog)
  }

  const session = createSessionDomain({
    state: state as unknown as ExtensionState,
    getTargetTab: async () => ({ id: 7 }) as TabWithId,
    evaluateInTabContext: async () => {
      throw new Error('not used in this test')
    },
    sendDebuggerCommand: async <TResult>(
      tabId: number,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<TResult> => {
      debuggerCalls.push({ tabId, method, params })
      if (method === 'Page.handleJavaScriptDialog' && options.handleDialogError) {
        throw options.handleDialogError
      }
      return {} as TResult
    },
    storageLocalGet: async () => ({}) as never,
    storageLocalSet: async () => {},
  })

  return { session, state, debuggerCalls }
}

describe('session handleDialog', () => {
  test('dialog auto-accept flag queries and toggles the runtime-only setting', () => {
    const { session, state } = createSessionHarness()

    expect(session.getDialogAutoAccept()).toBe(true)
    // 设置后立即反映到状态；不持久化（重启回默认 true）
    expect(session.setDialogAutoAccept(false)).toMatchObject({ autoAccept: false })
    expect(state.session.dialogAutoAccept).toBe(false)
    expect(session.getDialogAutoAccept()).toBe(false)
    expect(session.setDialogAutoAccept(true)).toMatchObject({ autoAccept: true })
    expect(session.getDialogAutoAccept()).toBe(true)
  })

  test('accepts an open prompt and records a dialog-command entry', async () => {
    const { session, state, debuggerCalls } = createSessionHarness({
      dialog: sampleDialog({ type: 'prompt', message: 'Enter name', defaultPrompt: 'Alice' }),
    })

    const result = (await session.handleDialog(7, true, 'alice')) as {
      handled: boolean
      accepted: boolean
    }

    expect(result).toEqual({ handled: true, accepted: true })
    expect(state.session.dialogs.size).toBe(0)

    const handleCall = debuggerCalls.find((call) => call.method === 'Page.handleJavaScriptDialog')
    expect(handleCall?.params).toEqual({ accept: true, promptText: 'alice' })

    expect(state.session.lastDialog).toMatchObject({
      tabId: 7,
      type: 'prompt',
      message: 'Enter name',
      handledBy: 'dialog-command',
      accepted: true,
      openedAt: '2025-01-01T00:00:00.000Z',
    })
    expect(typeof state.session.lastDialog?.handledAt).toBe('string')
  })

  test('dismisses an open dialog with accepted false', async () => {
    const { session, state } = createSessionHarness({
      dialog: sampleDialog({ type: 'confirm' }),
    })

    const result = (await session.handleDialog(7, false)) as {
      handled: boolean
      accepted: boolean
    }

    expect(result).toEqual({ handled: true, accepted: false })
    expect(state.session.dialogs.size).toBe(0)
    expect(state.session.lastDialog).toMatchObject({
      tabId: 7,
      type: 'confirm',
      handledBy: 'dialog-command',
      accepted: false,
    })
  })

  test('keeps the dialog in the map when handling reports no dialog', async () => {
    const { session, state } = createSessionHarness({
      dialog: sampleDialog(),
      handleDialogError: new Error('No dialog is showing'),
    })

    const result = (await session.handleDialog(7, true)) as { handled: boolean; reason: string }

    expect(result).toEqual({ handled: false, reason: 'no dialog opened' })
    expect(state.session.dialogs.size).toBe(1)
    expect(state.session.lastDialog).toBeNull()
  })
})

describe('session getDialogStatus', () => {
  test('returns the open dialog together with lastDialog', () => {
    const { session, state } = createSessionHarness({
      dialog: sampleDialog(),
    })
    state.session.lastDialog = {
      tabId: 7,
      type: 'confirm',
      message: 'Continue?',
      handledBy: 'dialog-command',
      accepted: true,
      openedAt: '2025-01-01T00:00:00.000Z',
      handledAt: '2025-01-02T00:00:00.000Z',
    }

    expect(session.getDialogStatus(7)).toEqual({
      ...sampleDialog(),
      lastDialog: state.session.lastDialog,
    })
  })

  test('returns a closed shape when no dialog is open', () => {
    const { session } = createSessionHarness()

    expect(session.getDialogStatus()).toEqual({
      open: false,
      type: null,
      message: null,
      defaultPrompt: null,
      url: null,
      openedAt: null,
      lastDialog: null,
    })
  })

  test('resolves a tab handle and falls back to targetTabId', () => {
    const { session } = createSessionHarness({
      dialog: sampleDialog(),
      tabIdsByHandle: new Map<string, number>([['t1', 7]]),
      targetTabId: 7,
    })

    expect(session.getDialogStatus('t1').open).toBe(true)
    expect(session.getDialogStatus(7).open).toBe(true)
    expect(session.getDialogStatus().open).toBe(true)
  })
})

interface ConnectionHarness {
  state: ExtensionState
  listenerRegistry: {
    debuggerEvent: Array<(source: { tabId?: number }, method: string, params: unknown) => void>
  }
  initialize: () => void
  restore: () => void
}

function createConnectionHarness(): ConnectionHarness {
  const originalGlobals = {
    chrome: globalThis.chrome,
    WebSocket: globalThis.WebSocket,
  }
  const listenerRegistry = {
    debuggerEvent: [] as Array<
      (source: { tabId?: number }, method: string, params: unknown) => void
    >,
  }

  defineGlobalValue('chrome', {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '1.2.3' }),
    },
    storage: {
      local: {
        set: async () => {},
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
  MockWebSocket.instances = []

  const state = createExtensionState(57978)
  const runtime = createConnectionRuntime({
    state,
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
      _keys: string | string[] | null,
    ): Promise<T> => ({}) as T,
    storageLocalSet: async () => {},
    clearTabRuntimeState: () => {},
    detachDebugger: async () => {},
    getDialogStatus: () => ({}),
  })

  return {
    state,
    listenerRegistry,
    initialize: () => runtime.initialize(),
    restore: () => {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('WebSocket', originalGlobals.WebSocket)
      MockWebSocket.instances = []
    },
  }
}

describe('connection dialog event tracking', () => {
  test('tracks confirm dialogs per tab without auto-accepting them', async () => {
    const harness = createConnectionHarness()
    try {
      harness.initialize()
      await flushMicrotasks()
      expect(harness.listenerRegistry.debuggerEvent).toHaveLength(1)

      harness.listenerRegistry.debuggerEvent[0]({ tabId: 11 }, 'Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Continue?',
        defaultPrompt: '',
        url: 'https://example.com',
      })

      const dialog = harness.state.session.dialogs.get(11)
      expect(dialog).toMatchObject({
        open: true,
        type: 'confirm',
        message: 'Continue?',
        defaultPrompt: '',
        url: 'https://example.com',
      })
      expect(typeof dialog?.openedAt).toBe('string')
      expect(harness.state.session.lastDialog).toBeNull()
    } finally {
      harness.restore()
    }
  })

  test('auto-accepts alert dialogs and records lastDialog', async () => {
    const harness = createConnectionHarness()
    try {
      harness.initialize()
      await flushMicrotasks()

      harness.listenerRegistry.debuggerEvent[0]({ tabId: 11 }, 'Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'Hello',
        defaultPrompt: '',
        url: null,
      })
      await flushMicrotasks()

      expect(harness.state.session.dialogs.size).toBe(0)
      expect(harness.state.session.lastDialog).toMatchObject({
        tabId: 11,
        type: 'alert',
        message: 'Hello',
        handledBy: 'auto-accept',
        accepted: true,
      })
    } finally {
      harness.restore()
    }
  })

  test('records page-closed when an open dialog closes unhandled', async () => {
    const harness = createConnectionHarness()
    try {
      harness.initialize()
      await flushMicrotasks()

      harness.listenerRegistry.debuggerEvent[0]({ tabId: 11 }, 'Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Continue?',
        defaultPrompt: '',
        url: null,
      })
      harness.listenerRegistry.debuggerEvent[0]({ tabId: 11 }, 'Page.javascriptDialogClosed', {})

      expect(harness.state.session.dialogs.size).toBe(0)
      expect(harness.state.session.lastDialog).toMatchObject({
        tabId: 11,
        type: 'confirm',
        handledBy: 'page-closed',
        accepted: false,
      })
    } finally {
      harness.restore()
    }
  })

  test('keeps the auto-accept record when closed fires before the accept promise settles', async () => {
    const harness = createConnectionHarness()
    try {
      harness.initialize()
      await flushMicrotasks()

      harness.listenerRegistry.debuggerEvent[0]({ tabId: 11 }, 'Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'Hello',
        defaultPrompt: '',
        url: null,
      })
      // closed 事件先于 sendDebuggerCommand 回调执行时，auto-accept 的回调后到并覆盖 page-closed 记录，
      // 两种时序下的最终记录一致
      harness.listenerRegistry.debuggerEvent[0]({ tabId: 11 }, 'Page.javascriptDialogClosed', {})
      await flushMicrotasks()

      expect(harness.state.session.dialogs.size).toBe(0)
      expect(harness.state.session.lastDialog).toMatchObject({
        tabId: 11,
        handledBy: 'auto-accept',
        accepted: true,
      })
    } finally {
      harness.restore()
    }
  })

  test('keeps alert dialogs open with MODAL_OPEN semantics when auto-accept is disabled', async () => {
    const harness = createConnectionHarness()
    try {
      harness.state.session.dialogAutoAccept = false
      harness.initialize()
      await flushMicrotasks()

      harness.listenerRegistry.debuggerEvent[0]({ tabId: 11 }, 'Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'Hello',
        defaultPrompt: '',
        url: null,
      })
      await flushMicrotasks()

      // 关闭自动 accept 后 alert 留在 dialog map 里，交互命令会走 MODAL_OPEN 阻塞语义
      expect(harness.state.session.dialogs.size).toBe(1)
      expect(harness.state.session.dialogs.get(11)).toMatchObject({
        open: true,
        type: 'alert',
        message: 'Hello',
      })
      expect(harness.state.session.lastDialog).toBeNull()
    } finally {
      harness.restore()
    }
  })

  test('beforeunload also blocks when auto-accept is disabled', async () => {
    const harness = createConnectionHarness()
    try {
      harness.state.session.dialogAutoAccept = false
      harness.initialize()
      await flushMicrotasks()

      harness.listenerRegistry.debuggerEvent[0]({ tabId: 11 }, 'Page.javascriptDialogOpening', {
        type: 'beforeunload',
        message: '',
        defaultPrompt: '',
        url: null,
      })
      await flushMicrotasks()

      expect(harness.state.session.dialogs.get(11)?.type).toBe('beforeunload')
      expect(harness.state.session.lastDialog).toBeNull()
    } finally {
      harness.restore()
    }
  })
})
