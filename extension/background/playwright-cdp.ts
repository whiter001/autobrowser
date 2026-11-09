interface DebuggerSession {
  tabId?: number
  sessionId?: string
}

interface CdpBridgeMessage {
  type?: string
  id?: string
  runId?: string
  action?: string
  tabId?: number
  method?: string
  params?: any
}

interface PlaywrightCdpDependencies {
  getSocket: () => WebSocket | null
  ensureDebuggerAttached: (tabId: number) => Promise<void>
  sendDebuggerSessionCommand: (
    target: DebuggerSession,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>
  refreshInterceptors: (onlyTabId?: number) => Promise<void>
}

/** 只桥接 Playwright 所需的最小 chrome.* 协议，旧命令仍走原 command router。 */
export function createPlaywrightCdpBridge({
  getSocket,
  ensureDebuggerAttached,
  sendDebuggerSessionCommand,
  refreshInterceptors,
}: PlaywrightCdpDependencies) {
  const runs = new Map<string, number>()

  function respond(
    socket: WebSocket,
    message: CdpBridgeMessage,
    ok: boolean,
    result?: unknown,
    error?: unknown,
  ) {
    socket.send(
      JSON.stringify({
        type: 'cdp.response',
        id: message.id,
        runId: message.runId,
        ok,
        ...(ok ? { result } : { error: error instanceof Error ? error.message : String(error) }),
      }),
    )
  }

  async function handleMessage(socket: WebSocket, message: CdpBridgeMessage): Promise<boolean> {
    if (message.type !== 'cdp.control' && message.type !== 'cdp.command') return false
    const runId = typeof message.runId === 'string' ? message.runId : ''
    if (!runId) {
      respond(socket, message, false, undefined, new Error('missing CDP runId'))
      return true
    }

    try {
      if (message.type === 'cdp.control') {
        if (message.action === 'start') {
          if (!Number.isInteger(message.tabId) || (message.tabId ?? 0) <= 0) {
            throw new Error('cdp start requires a positive tabId')
          }
          const tabId = message.tabId!
          if ([...runs.values()].includes(tabId)) {
            throw new Error(`tab ${tabId} already has an active Playwright bridge`)
          }
          runs.set(runId, tabId)
          try {
            // 旧功能已提前启用 Runtime；重置订阅让 Playwright enable 时重放主世界上下文。
            await sendDebuggerSessionCommand({ tabId }, 'Runtime.disable', {})
            // 独占期间旧 route 不再与 Playwright 同时消费 Fetch.requestPaused；stop 时恢复。
            await sendDebuggerSessionCommand({ tabId }, 'Fetch.disable', {})
          } catch (error) {
            runs.delete(runId)
            throw error
          }
          respond(socket, message, true, { tabId })
          return true
        }
        if (message.action === 'stop') {
          const tabId = runs.get(runId)
          const removed = runs.delete(runId)
          // page.route 依赖存活的 Playwright 客户端；只恢复当前 tab，避免打断其它并行 run。
          if (removed && tabId !== undefined) await refreshInterceptors(tabId)
          respond(socket, message, true, { stopped: removed })
          return true
        }
        throw new Error(`unsupported CDP control action: ${String(message.action)}`)
      }

      const tabId = runs.get(runId)
      if (tabId === undefined) throw new Error('Playwright bridge has not started')
      const params = message.params ?? []
      switch (message.method) {
        case 'chrome.debugger.attach':
          await ensureDebuggerAttached(tabId)
          respond(socket, message, true, {})
          return true
        case 'chrome.debugger.sendCommand': {
          const [target, method, commandParams] = params as [
            DebuggerSession,
            string,
            Record<string, unknown>?,
          ]
          if (target?.tabId !== tabId)
            throw new Error('CDP command crossed the exclusive tab boundary')
          await ensureDebuggerAttached(tabId)
          const result = await sendDebuggerSessionCommand(
            { tabId, ...(target.sessionId ? { sessionId: target.sessionId } : {}) },
            method,
            commandParams,
          )
          respond(socket, message, true, result)
          return true
        }
        case 'chrome.tabs.remove': {
          const [targetTabId] = params as [number]
          if (targetTabId !== tabId)
            throw new Error('cannot remove a tab outside the exclusive run')
          await chrome.tabs.remove(targetTabId)
          respond(socket, message, true, {})
          return true
        }
        default:
          throw new Error(`unsupported Playwright extension command: ${String(message.method)}`)
      }
    } catch (error) {
      respond(socket, message, false, undefined, error)
      return true
    }
  }

  function sendEvent(runId: string, method: string, params: unknown): void {
    const socket = getSocket()
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'cdp.event', runId, method, params }))
  }

  function handleDebuggerEvent(source: DebuggerSession, method: string, params: unknown): void {
    for (const [runId, tabId] of runs) {
      if (tabId === source.tabId)
        sendEvent(runId, 'chrome.debugger.onEvent', [source, method, params])
    }
  }

  function handleDebuggerDetach(source: DebuggerSession): void {
    for (const [runId, tabId] of runs) {
      if (tabId === source.tabId) sendEvent(runId, 'chrome.debugger.onDetach', [source, 'canceled'])
    }
  }

  function handleTabRemoved(tabId: number): void {
    for (const [runId, candidate] of runs) {
      if (candidate === tabId) sendEvent(runId, 'chrome.tabs.onRemoved', [tabId, {}])
    }
  }

  function ownsTab(tabId: number): boolean {
    return [...runs.values()].includes(tabId)
  }

  function clear(): void {
    if (!runs.size) return
    runs.clear()
    void refreshInterceptors().catch(() => {})
  }

  return {
    handleMessage,
    handleDebuggerEvent,
    handleDebuggerDetach,
    handleTabRemoved,
    ownsTab,
    clear,
  }
}
