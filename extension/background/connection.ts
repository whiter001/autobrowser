import {
  CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  RELAY_PORT_STORAGE_KEY,
  STORAGE_KEY,
  normalizeRelayPort,
  type ConnectionStatus,
  type DiagnosticsState,
} from '../shared.js'
import type { CommandMessage, ErrorWithCode, ExtensionState, TabSummary } from './types.js'

interface NetworkDomain {
  handleRequestPaused: (tabId: number, params: unknown) => Promise<void>
  handleEvent: (source: { tabId?: number }, method: string, params: unknown) => Promise<void>
}

interface ConnectionRuntimeDependencies {
  state: ExtensionState
  network: NetworkDomain
  listTabs: () => Promise<TabSummary[]>
  handleCommand: (message: CommandMessage) => Promise<unknown>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
  storageLocalGet: <T extends Record<string, unknown> = Record<string, unknown>>(
    keys: string | string[] | null,
  ) => Promise<T>
  storageLocalSet: (items: Record<string, unknown>) => Promise<void>
  clearTabRuntimeState: (tabId: number) => void
  detachDebugger: (tabId: number) => Promise<void>
  getDialogStatus: () => Record<string, unknown>
}

export function createConnectionRuntime({
  state,
  network,
  listTabs,
  handleCommand,
  sendDebuggerCommand,
  storageLocalGet,
  storageLocalSet,
  clearTabRuntimeState,
  detachDebugger,
  getDialogStatus,
}: ConnectionRuntimeDependencies) {
  function pushBounded<T>(list: T[], item: T, maxSize: number): void {
    list.push(item)
    if (list.length > maxSize) {
      list.splice(0, list.length - maxSize)
    }
  }

  function persistDiagnostics(): void {
    chrome.storage.local
      .set({
        [CONNECTION_DIAGNOSTICS_STORAGE_KEY]: {
          status: state.connectionStatus,
          connectionError: state.connectionError,
          lastSocketClose: state.lastSocketClose,
          lastCommandError: state.lastCommandError,
          updatedAt: new Date().toISOString(),
        } satisfies DiagnosticsState,
      })
      .catch((error: Error) => {
        console.error('failed to persist plugin diagnostics', error)
      })
  }

  function setConnectionError(message: string, code?: string): void {
    state.connectionError = {
      message,
      at: new Date().toISOString(),
      ...(code ? { code } : {}),
    }
    persistDiagnostics()
  }

  function setConnectionStatus(status: ConnectionStatus): void {
    state.connectionStatus = status
    if (status === 'connected') {
      state.connectionError = null
    }
    persistDiagnostics()
  }

  function recordSocketClose(close: { code: number; reason: string; wasClean: boolean }): void {
    state.lastSocketClose = {
      code: close.code,
      reason: close.reason,
      wasClean: close.wasClean,
      at: new Date().toISOString(),
    }

    if (!state.suppressCloseError && close.code !== 1000) {
      setConnectionError(
        `relay socket closed: ${close.code}${close.reason ? ` ${close.reason}` : ''}`.trim(),
        'SOCKET_CLOSED',
      )
      setConnectionStatus('disconnected')
    }

    state.suppressCloseError = false
    persistDiagnostics()
  }

  function stringifyRemoteValue(value: unknown): string {
    if (!value) {
      return ''
    }

    const remoteValue = value as {
      value?: unknown
      unserializableValue?: string
      description?: string
      type?: string
    }

    if (Object.prototype.hasOwnProperty.call(remoteValue, 'value')) {
      if (typeof remoteValue.value === 'string') {
        return remoteValue.value
      }

      try {
        return JSON.stringify(remoteValue.value)
      } catch (error) {
        console.debug('failed to stringify remote value', error)
        return String(remoteValue.value)
      }
    }

    if (remoteValue.unserializableValue) {
      return remoteValue.unserializableValue
    }

    return remoteValue.description || remoteValue.type || ''
  }

  async function publishState(socket: WebSocket): Promise<void> {
    const tabs = await listTabs()
    socket.send(
      JSON.stringify({
        type: 'state',
        tabs,
        activeTabId: tabs.find((tab) => tab.active)?.id || null,
        targetTabId: state.targetTabId,
      }),
    )
  }

  function setupDebuggerEventListeners() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const navigationParams = params as {
        frame?: { parentId?: string | null }
      }

      if (
        typeof source?.tabId === 'number' &&
        ((method === 'Page.frameNavigated' && !navigationParams.frame?.parentId) ||
          method === 'Page.navigatedWithinDocument')
      ) {
        state.pageEpochs.set(source.tabId, (state.pageEpochs.get(source.tabId) || 1) + 1)
        state.selectedFrames.delete(source.tabId)
      }

      if (method === 'Runtime.consoleAPICalled') {
        const consoleParams = params as {
          type?: string
          args?: unknown[]
        }

        pushBounded(
          state.consoleMessages,
          {
            type: String(consoleParams.type || ''),
            text: Array.isArray(consoleParams.args)
              ? consoleParams.args.map((item: unknown) => stringifyRemoteValue(item)).join(' ')
              : '',
            timestamp: Date.now(),
          },
          500,
        )
      }

      if (method === 'Runtime.exceptionThrown') {
        const exceptionParams = params as {
          exceptionDetails?: {
            exception?: { description?: string }
            text?: string
            url?: string
            lineNumber?: number
            columnNumber?: number
          }
        }

        pushBounded(
          state.pageErrors,
          {
            error:
              exceptionParams.exceptionDetails?.exception?.description ||
              exceptionParams.exceptionDetails?.text ||
              '',
            url: exceptionParams.exceptionDetails?.url || null,
            line: exceptionParams.exceptionDetails?.lineNumber,
            column: exceptionParams.exceptionDetails?.columnNumber,
            timestamp: Date.now(),
          },
          100,
        )
      }

      if (method === 'Page.javascriptDialogOpening') {
        const dialogParams = params as {
          type?: string
          message?: string
          defaultPrompt?: string
          url?: string
        }

        state.dialog = {
          open: true,
          type: String(dialogParams.type || ''),
          message: String(dialogParams.message || ''),
          defaultPrompt: String(dialogParams.defaultPrompt || ''),
          url: dialogParams.url ? String(dialogParams.url) : null,
          openedAt: new Date().toISOString(),
        }

        if (
          ['alert', 'beforeunload'].includes(state.dialog.type) &&
          typeof source?.tabId === 'number'
        ) {
          void sendDebuggerCommand(source.tabId, 'Page.handleJavaScriptDialog', {
            accept: true,
          })
            .then(() => {
              state.dialog = null
            })
            .catch((error) => {
              console.error('failed to auto accept dialog', error)
            })
        }
      }

      if (method === 'Page.javascriptDialogClosed') {
        state.dialog = null
      }

      if (method === 'Fetch.requestPaused') {
        const tabId = typeof source?.tabId === 'number' ? source.tabId : null
        if (tabId !== null) {
          void network.handleRequestPaused(tabId, params).catch((error) => {
            console.error('failed to handle paused network request', error)
          })
        }
      }

      if (
        method === 'Network.requestWillBeSent' ||
        method === 'Network.responseReceived' ||
        method === 'Network.loadingFinished' ||
        method === 'Network.loadingFailed'
      ) {
        void network.handleEvent(source, method, params).catch((error) => {
          console.error('failed to record network event', error)
        })
      }
    })
  }

  async function getToken(): Promise<string> {
    const result = await storageLocalGet(STORAGE_KEY)
    return String(result?.[STORAGE_KEY] || '')
  }

  async function getRelayPort(): Promise<number> {
    const result = await storageLocalGet(RELAY_PORT_STORAGE_KEY)
    return normalizeRelayPort(result?.[RELAY_PORT_STORAGE_KEY])
  }

  async function saveToken(token: string): Promise<void> {
    await storageLocalSet({
      [STORAGE_KEY]: token.trim(),
    })
    state.token = token.trim()
    requestReconnect()
  }

  function requestReconnect(): void {
    if (state.socket && state.socket.readyState < WebSocket.CLOSING) {
      state.suppressCloseError = true
      try {
        state.socket.close()
        return
      } catch (error) {
        console.warn('failed to close relay socket before reconnect', error)
      }
    }

    reconnect()
  }

  async function connect() {
    if (
      state.connecting ||
      (state.socket &&
        state.socket.readyState !== WebSocket.CLOSED &&
        state.socket.readyState !== WebSocket.CLOSING)
    ) {
      return
    }

    state.connecting = true
    setConnectionStatus('connecting')

    try {
      state.token = state.token || (await getToken())
      if (!state.token) {
        setConnectionStatus('missing-token')
        setConnectionError('missing token; save it in the options page')
        return
      }

      const socket = new WebSocket(
        `ws://127.0.0.1:${state.relayPort}/ws?token=${encodeURIComponent(state.token)}&extensionId=${encodeURIComponent(chrome.runtime.id)}`,
      )

      state.socket = socket

      socket.addEventListener('open', () => {
        setConnectionStatus('connected')
        socket.send(
          JSON.stringify({
            type: 'extension.hello',
            extensionId: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
          }),
        )
      })

      socket.addEventListener('message', async (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch (error) {
          console.warn('received invalid JSON from server', error)
          socket.send(
            JSON.stringify({
              type: 'response',
              id: null,
              ok: false,
              error: { message: 'invalid JSON from server' },
            }),
          )
          return
        }

        if (message?.type !== 'command') {
          return
        }

        try {
          const result = await handleCommand(message)
          socket.send(
            JSON.stringify({
              type: 'response',
              id: message.id,
              ok: true,
              result,
            }),
          )
        } catch (error) {
          const err = error as ErrorWithCode
          state.lastCommandError = {
            command: String(message.command || ''),
            message: err.message,
            code: err.code || 'EXTENSION_COMMAND_ERROR',
            at: new Date().toISOString(),
          }
          persistDiagnostics()
          socket.send(
            JSON.stringify({
              type: 'response',
              id: message.id,
              ok: false,
              error: {
                message: err.message,
                code: err.code || 'EXTENSION_COMMAND_ERROR',
                ...(err.suggestedAction ? { suggestedAction: err.suggestedAction } : {}),
                ...(err.ref ? { ref: err.ref } : {}),
                ...(typeof err.expectedPageEpoch === 'number'
                  ? { expectedPageEpoch: err.expectedPageEpoch }
                  : {}),
                ...(typeof err.currentPageEpoch === 'number'
                  ? { currentPageEpoch: err.currentPageEpoch }
                  : {}),
              },
            }),
          )
        }

        try {
          await publishState(socket)
        } catch (error) {
          console.error('failed to publish extension state', error)
        }
      })

      socket.addEventListener('close', (event) => {
        state.socket = null
        state.connecting = false
        recordSocketClose({
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        })
        if (state.shouldReconnect) {
          reconnect()
        }
      })

      socket.addEventListener('error', () => {
        state.connecting = false
        setConnectionError('relay websocket error')
        try {
          socket.close()
        } catch (error) {
          console.warn('failed to close relay socket after websocket error', error)
        }
      })

      try {
        await publishState(socket)
      } catch (error) {
        console.error('failed to publish initial extension state', error)
      }
    } catch (error) {
      const err = error as ErrorWithCode
      setConnectionStatus('error')
      setConnectionError(err.message, err.code)
      throw error
    } finally {
      state.connecting = false
    }
  }

  async function reconnect() {
    if (!state.shouldReconnect) {
      return
    }

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
    }

    state.reconnectTimer = setTimeout(async () => {
      if (!state.socket || state.socket.readyState === WebSocket.CLOSED) {
        await connect()
      }
    }, 1000)
  }

  function registerChromeListeners(): void {
    chrome.runtime.onInstalled.addListener(() => {
      chrome.runtime.openOptionsPage().catch(() => {})
    })

    chrome.runtime.onStartup.addListener(() => {
      connect().catch((error) => {
        console.error('failed to connect autobrowser extension on startup', error)
      })
    })

    connect().catch((error) => {
      console.error('failed to connect autobrowser extension', error)
    })

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'autobrowser.setToken') {
        saveToken(String(message.token || '')).then(
          () => sendResponse({ ok: true }),
          (error) => sendResponse({ ok: false, error: error.message }),
        )
        return true
      }

      if (message?.type === 'autobrowser.getStatus') {
        sendResponse({
          ok: true,
          connected: Boolean(state.socket && state.socket.readyState === WebSocket.OPEN),
          connectionStatus: state.connectionStatus,
          connectionError: state.connectionError,
          lastSocketClose: state.lastSocketClose,
          lastCommandError: state.lastCommandError,
          dialog: getDialogStatus(),
          token: state.token || '',
          relayPort: state.relayPort,
        })
        return false
      }

      return false
    })

    chrome.tabs.onRemoved.addListener((tabId) => {
      clearTabRuntimeState(tabId)
      detachDebugger(tabId).catch(() => {})
    })

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return
      }

      let needsReconnect = false

      if (changes[STORAGE_KEY]) {
        state.token = String(changes[STORAGE_KEY].newValue || '')
        needsReconnect = true
      }

      if (changes[RELAY_PORT_STORAGE_KEY]) {
        state.relayPort = normalizeRelayPort(changes[RELAY_PORT_STORAGE_KEY].newValue)
        needsReconnect = true
      }

      if (needsReconnect) {
        requestReconnect()
      }
    })
  }

  function initialize(): void {
    Promise.all([getToken(), getRelayPort()])
      .then(([token, relayPort]) => {
        state.token = token
        state.relayPort = relayPort
        setupDebuggerEventListeners()
        return connect()
      })
      .catch((error) => {
        console.error('failed to initialize autobrowser extension', error)
        const message = error instanceof Error ? error.message : String(error)
        setConnectionStatus('error')
        setConnectionError(message, 'STARTUP_ERROR')
      })
  }

  return {
    initialize,
    registerChromeListeners,
  }
}
