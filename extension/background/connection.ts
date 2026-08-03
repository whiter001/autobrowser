import {
  CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  RELAY_PORT_STORAGE_KEY,
  STORAGE_KEY,
  normalizeRelayPort,
  type ConnectionStatus,
  type DiagnosticsState,
} from '../shared.js'
import type {
  CommandMessage,
  DialogState,
  ErrorWithCode,
  ExtensionState,
  TabSummary,
} from './types.js'
import { serializeCommandError } from './errors.js'
import { getPageEpoch } from './targeting.js'

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
  const HEARTBEAT_INTERVAL_MS = 30_000
  const HEARTBEAT_TIMEOUT_MS = 10_000
  const RECONNECT_BASE_DELAY_MS = 1_000
  const RECONNECT_MAX_DELAY_MS = 60_000
  const RECONNECT_MAX_EXPONENT = 6

  function pushBounded<T>(list: T[], item: T, maxSize: number): void {
    list.push(item)
    if (list.length > maxSize) {
      list.splice(0, list.length - maxSize)
    }
  }

  function clearHeartbeatTimers(): void {
    if (state.connection.heartbeatTimer) {
      clearInterval(state.connection.heartbeatTimer)
      state.connection.heartbeatTimer = null
    }

    if (state.connection.heartbeatTimeoutTimer) {
      clearTimeout(state.connection.heartbeatTimeoutTimer)
      state.connection.heartbeatTimeoutTimer = null
    }
  }

  function startHeartbeat(socket: WebSocket): void {
    clearHeartbeatTimers()

    const sendHeartbeat = () => {
      if (socket.readyState !== WebSocket.OPEN) {
        return
      }

      const sentAt = new Date().toISOString()
      state.connection.lastHeartbeatSentAt = sentAt

      try {
        socket.send(
          JSON.stringify({
            type: 'heartbeat',
            sentAt,
          }),
        )
      } catch (error) {
        console.warn('failed to send relay heartbeat', error)
        setConnectionError('relay heartbeat send failed', 'HEARTBEAT_SEND_FAILED')
        setConnectionStatus('disconnected')
        state.connection.suppressCloseError = true
        try {
          socket.close()
        } catch (closeError) {
          console.warn('failed to close relay socket after heartbeat send failure', closeError)
        }
        return
      }

      if (state.connection.heartbeatTimeoutTimer) {
        clearTimeout(state.connection.heartbeatTimeoutTimer)
      }

      state.connection.heartbeatTimeoutTimer = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          return
        }

        setConnectionError('relay heartbeat timeout', 'HEARTBEAT_TIMEOUT')
        setConnectionStatus('disconnected')
        state.connection.suppressCloseError = true
        try {
          socket.close()
        } catch (closeError) {
          console.warn('failed to close relay socket after heartbeat timeout', closeError)
        }
      }, HEARTBEAT_TIMEOUT_MS)
    }

    state.connection.heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
  }

  function persistDiagnostics(): void {
    chrome.storage.local
      .set({
        [CONNECTION_DIAGNOSTICS_STORAGE_KEY]: {
          status: state.connection.status,
          connectionError: state.connection.error,
          lastSocketClose: state.connection.lastSocketClose,
          lastCommandError: state.connection.lastCommandError,
          lastHeartbeatAt: state.connection.lastHeartbeatAt,
          lastHeartbeatSentAt: state.connection.lastHeartbeatSentAt,
          updatedAt: new Date().toISOString(),
        } satisfies DiagnosticsState,
      })
      .catch((error: Error) => {
        console.error('failed to persist plugin diagnostics', error)
      })
  }

  function setConnectionError(message: string, code?: string): void {
    state.connection.error = {
      message,
      at: new Date().toISOString(),
      ...(code ? { code } : {}),
    }
    persistDiagnostics()
  }

  function setConnectionStatus(status: ConnectionStatus): void {
    state.connection.status = status
    if (status === 'connected') {
      state.connection.error = null
    }
    persistDiagnostics()
  }

  function recordSocketClose(close: { code: number; reason: string; wasClean: boolean }): void {
    clearHeartbeatTimers()
    state.connection.lastSocketClose = {
      code: close.code,
      reason: close.reason,
      wasClean: close.wasClean,
      at: new Date().toISOString(),
    }

    if (!state.connection.suppressCloseError && close.code !== 1000) {
      setConnectionError(
        `relay socket closed: ${close.code}${close.reason ? ` ${close.reason}` : ''}`.trim(),
        'SOCKET_CLOSED',
      )
      setConnectionStatus('disconnected')
    }

    state.connection.suppressCloseError = false
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
    if (socket.readyState !== WebSocket.OPEN) {
      return
    }

    const tabs = await listTabs()
    const pageEpochs = Object.fromEntries(
      tabs.map((tab) => [tab.id, typeof tab.id === 'number' ? getPageEpoch(state, tab.id) : 0]),
    )

    if (socket.readyState !== WebSocket.OPEN) {
      return
    }

    socket.send(
      JSON.stringify({
        type: 'state',
        tabs,
        activeTabId: tabs.find((tab) => tab.active)?.id || null,
        targetTabId: state.targeting.targetTabId,
        pageEpochs,
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
        state.targeting.pageEpochs.set(
          source.tabId,
          (state.targeting.pageEpochs.get(source.tabId) || 1) + 1,
        )
        state.targeting.selectedFrames.delete(source.tabId)
      }

      if (method === 'Runtime.consoleAPICalled') {
        const consoleParams = params as {
          type?: string
          args?: unknown[]
        }

        // 控制台消息可能含巨型数组（如 rAF 每帧打印的动画数据），逐项 stringify 开销过大，
        // 这里直接限制每个参数的字符串长度

        const messageText = Array.isArray(consoleParams.args)
          ? consoleParams.args
              .map((item: unknown) => {
                try {
                  const text = stringifyRemoteValue(item)
                  return text.length > 500 ? text.slice(0, 500) + '...' : text
                } catch {
                  return ''
                }
              })
              .join(' ')
          : ''

        pushBounded(
          state.session.consoleMessages,
          {
            type: String(consoleParams.type || ''),
            text: messageText,
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
          state.session.pageErrors,
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

        const tabId = typeof source?.tabId === 'number' ? source.tabId : null
        const dialogState: DialogState = {
          open: true,
          type: String(dialogParams.type || ''),
          message: String(dialogParams.message || ''),
          defaultPrompt: String(dialogParams.defaultPrompt || ''),
          url: dialogParams.url ? String(dialogParams.url) : null,
          openedAt: new Date().toISOString(),
        }
        if (tabId !== null) {
          state.session.dialogs.set(tabId, dialogState)
        }

        if (['alert', 'beforeunload'].includes(dialogState.type) && tabId !== null) {
          void sendDebuggerCommand(tabId, 'Page.handleJavaScriptDialog', {
            accept: true,
          })
            .then(() => {
              state.session.dialogs.delete(tabId)
              state.session.lastDialog = {
                tabId,
                type: dialogState.type,
                message: dialogState.message,
                handledBy: 'auto-accept',
                accepted: true,
                openedAt: dialogState.openedAt,
                handledAt: new Date().toISOString(),
              }
            })
            .catch((error) => {
              // auto-accept 失败时同样清理 dialog，避免状态残留影响后续命令诊断
              state.session.dialogs.delete(tabId)
              state.session.lastDialog = {
                tabId,
                type: dialogState.type,
                message: dialogState.message,
                handledBy: 'auto-accept',
                accepted: false,
                openedAt: dialogState.openedAt,
                handledAt: new Date().toISOString(),
              }
              console.error('failed to auto accept dialog', error)
            })
        }
      }

      if (method === 'Page.javascriptDialogClosed') {
        const tabId = typeof source?.tabId === 'number' ? source.tabId : null
        if (tabId !== null) {
          const openDialog = state.session.dialogs.get(tabId)
          if (openDialog) {
            // 未被自动 accept 或 dialog 命令处理时，把关闭事件记为 page-closed。
            // auto-accept/dialog 命令的写入路径若后到会覆盖这里，最终记录保持一致
            state.session.dialogs.delete(tabId)
            state.session.lastDialog = {
              tabId,
              type: openDialog.type,
              message: openDialog.message,
              handledBy: 'page-closed',
              accepted: false,
              openedAt: openDialog.openedAt,
              handledAt: new Date().toISOString(),
            }
          } else {
            state.session.dialogs.delete(tabId)
          }
        }
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

    chrome.debugger.onDetach?.addListener((source) => {
      if (typeof source?.tabId !== 'number') {
        return
      }

      state.targeting.attachedTabs.delete(source.tabId)
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
    state.connection.token = token.trim()
    requestReconnect()
  }

  function requestReconnect(): void {
    if (state.connection.socket && state.connection.socket.readyState < WebSocket.CLOSING) {
      state.connection.suppressCloseError = true
      clearHeartbeatTimers()
      try {
        state.connection.socket.close()
        return
      } catch (error) {
        console.warn('failed to close relay socket before reconnect', error)
      }
    }

    reconnect()
  }

  async function connect() {
    if (
      state.connection.connecting ||
      (state.connection.socket &&
        state.connection.socket.readyState !== WebSocket.CLOSED &&
        state.connection.socket.readyState !== WebSocket.CLOSING)
    ) {
      return
    }

    state.connection.connecting = true
    setConnectionStatus('connecting')

    try {
      state.connection.token = state.connection.token || (await getToken())
      if (!state.connection.token) {
        setConnectionStatus('missing-token')
        setConnectionError('missing token; save it in the options page')
        return
      }

      const socket = new WebSocket(
        `ws://127.0.0.1:${state.connection.relayPort}/ws?token=${encodeURIComponent(state.connection.token)}&extensionId=${encodeURIComponent(chrome.runtime.id)}`,
      )

      state.connection.socket = socket

      socket.addEventListener('open', () => {
        state.connection.lastHeartbeatAt = null
        state.connection.lastHeartbeatSentAt = null
        // 连接成功，重置重试计数
        state.connection.reconnectAttempts = 0
        if (state.connection.reconnectTimer) {
          clearTimeout(state.connection.reconnectTimer)
          state.connection.reconnectTimer = null
        }
        setConnectionStatus('connected')
        socket.send(
          JSON.stringify({
            type: 'extension.hello',
            extensionId: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
          }),
        )

        void publishState(socket).catch((error) => {
          console.error('failed to publish initial extension state', error)
        })

        startHeartbeat(socket)
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

        if (message?.type === 'heartbeat') {
          state.connection.lastHeartbeatAt =
            typeof message.receivedAt === 'string' ? message.receivedAt : new Date().toISOString()

          if (state.connection.heartbeatTimeoutTimer) {
            clearTimeout(state.connection.heartbeatTimeoutTimer)
            state.connection.heartbeatTimeoutTimer = null
          }

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
          state.connection.lastCommandError = {
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
              error: serializeCommandError(error),
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
        clearHeartbeatTimers()
        state.connection.socket = null
        state.connection.connecting = false
        recordSocketClose({
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        })
        if (state.connection.shouldReconnect) {
          reconnect()
        }
      })

      socket.addEventListener('error', () => {
        clearHeartbeatTimers()
        state.connection.connecting = false
        setConnectionError('relay websocket error')
        try {
          socket.close()
        } catch (error) {
          console.warn('failed to close relay socket after websocket error', error)
        }
      })
    } catch (error) {
      const err = error as ErrorWithCode
      setConnectionStatus('error')
      setConnectionError(err.message, err.code)
      throw error
    } finally {
      state.connection.connecting = false
    }
  }

  async function reconnect() {
    if (!state.connection.shouldReconnect) {
      return
    }

    if (state.connection.reconnectTimer) {
      clearTimeout(state.connection.reconnectTimer)
      state.connection.reconnectTimer = null
    }

    const attempts = Math.min(state.connection.reconnectAttempts, RECONNECT_MAX_EXPONENT)
    const delayMs = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempts),
      RECONNECT_MAX_DELAY_MS,
    )
    state.connection.reconnectAttempts = Math.min(attempts + 1, RECONNECT_MAX_EXPONENT)

    // 指数退避只影响重试间隔，不会把连接逻辑永久关掉；达到上限后保持最大间隔继续重试。
    state.connection.reconnectTimer = setTimeout(async () => {
      state.connection.reconnectTimer = null
      if (!state.connection.socket || state.connection.socket.readyState === WebSocket.CLOSED) {
        await connect().catch((error) => {
          console.error('failed to reconnect autobrowser extension', error)
        })
      }
    }, delayMs)
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
          connected: Boolean(
            state.connection.socket && state.connection.socket.readyState === WebSocket.OPEN,
          ),
          connectionStatus: state.connection.status,
          connectionError: state.connection.error,
          lastSocketClose: state.connection.lastSocketClose,
          lastCommandError: state.connection.lastCommandError,
          lastHeartbeatAt: state.connection.lastHeartbeatAt,
          lastHeartbeatSentAt: state.connection.lastHeartbeatSentAt,
          dialog: getDialogStatus(),
          token: state.connection.token || '',
          relayPort: state.connection.relayPort,
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
        state.connection.token = String(changes[STORAGE_KEY].newValue || '')
        needsReconnect = true
      }

      if (changes[RELAY_PORT_STORAGE_KEY]) {
        state.connection.relayPort = normalizeRelayPort(changes[RELAY_PORT_STORAGE_KEY].newValue)
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
        state.connection.token = token
        state.connection.relayPort = relayPort
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
