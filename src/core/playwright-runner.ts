import type { ErrorWithCode, TabInfo } from './runtime-types.js'
import {
  PlaywrightBrowserModel,
  type CDPMessage,
  type DebuggerSession,
  type PlaywrightTab,
} from './playwright-browser-model.js'

export interface PlaywrightRunTransport {
  start: (tabId: number) => Promise<void>
  stop: () => Promise<void>
  send: (method: string, params: unknown) => Promise<any>
  onEvent: (listener: (event: { method: string; params: any }) => void) => () => void
  onDisconnect: (listener: () => void) => () => void
  close: () => void
}

interface PlaywrightRunOptions {
  source: string
  tab: TabInfo
  timeoutMs: number
  runId: string
  transport: PlaywrightRunTransport
}

function runError(message: string, code: string, details: Record<string, unknown> = {}) {
  const error = new Error(message) as ErrorWithCode
  error.code = code
  error.details = details
  return error
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, runId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = runError(
        `Playwright script timed out after ${timeoutMs}ms; the connection was closed, but browser side effects may already have happened`,
        'COMMAND_TIMEOUT',
        { runId, timeoutMs },
      )
      error.retryable = false
      error.suggestedAction =
        'Inspect the current page before retrying. The script was disconnected, but its completed browser actions cannot be rolled back.'
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function compilePageFunction(source: string): (page: any) => Promise<unknown> {
  try {
    // 与 pwcli run 对齐：文件内容是 async (page) => {}，并在持有真实 Page 的 relay 进程执行。
    // 间接 eval 是这里有意的不安全代码入口，同时避免源码捕获编译器的局部变量。
    // oxlint-disable-next-line no-eval
    const compiled = (0, eval)(`(${source}\n)`)
    if (typeof compiled !== 'function') throw new Error('script did not evaluate to a function')
    return compiled
  } catch (error) {
    throw runError(
      `invalid Playwright script; expected an async (page) => { ... } function: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_COMMAND_ARGS',
      { field: 'source' },
    )
  }
}

export async function runPlaywrightScript({
  source,
  tab,
  timeoutMs,
  runId,
  transport,
}: PlaywrightRunOptions): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const deadlineAt = startedAt + timeoutMs
  const remaining = () => Math.max(1, deadlineAt - Date.now())
  const model = new PlaywrightBrowserModel(transport.send)
  const initialTab: PlaywrightTab = {
    id: tab.id,
    index: 0,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    pinned: tab.pinned,
  }
  model.onTabCreated(initialTab)

  let cdpSocket: Bun.ServerWebSocket<unknown> | null = null
  let bridgeServer: Bun.Server<unknown> | null = null
  const cdpPath = `/cdp/${crypto.randomUUID()}`
  const unsubscribeEvent = transport.onEvent(({ method, params }) => {
    if (method === 'chrome.debugger.onEvent') {
      const [eventSource, cdpMethod, cdpParams] = params as [DebuggerSession, string, any]
      model.onDebuggerEvent(eventSource, cdpMethod, cdpParams)
    } else if (method === 'chrome.debugger.onDetach') {
      model.onDebuggerDetach(params[0])
    } else if (method === 'chrome.tabs.onRemoved') {
      model.onTabRemoved(params[0])
    }
  })
  let rejectDisconnected!: (error: Error) => void
  const disconnected = new Promise<never>((_resolve, reject) => {
    rejectDisconnected = reject
  })
  void disconnected.catch(() => {})
  const unsubscribeDisconnect = transport.onDisconnect(() => {
    const error = runError(
      'extension disconnected during Playwright run; the script result is unknown',
      'COMMAND_EXECUTION_UNKNOWN',
      { runId },
    )
    error.retryable = false
    error.suggestedAction =
      'Wait for the extension to reconnect, then inspect the page before deciding whether to rerun the script.'
    rejectDisconnected(error)
    try {
      cdpSocket?.close()
    } catch {
      // relay 断连已经使脚本结果未知，关闭本地 CDP socket 只是唤醒 Playwright 客户端。
    }
  })

  async function handleCdpMessage(message: CDPMessage): Promise<void> {
    const { id, sessionId, method, params } = message
    if (!method) return
    try {
      let result: unknown
      if (method === 'Browser.getVersion') {
        result = {
          protocolVersion: '1.3',
          product: 'Chrome/Autobrowser-Extension-Bridge',
          userAgent: 'Autobrowser-CDP-Bridge/1.0',
        }
      } else if (method === 'Browser.setDownloadBehavior') {
        result = {}
      } else if (method === 'Target.createTarget') {
        throw new Error(
          'Target.createTarget is not available in single-tab run mode; create the tab with autobrowser tab new, then run a script with --tab',
        )
      } else if (method === 'Target.setAutoAttach' && !sessionId) {
        await model.enableAutoAttach()
        result = {}
      } else if (method === 'Target.closeTarget') {
        result = await model.closeTarget(params?.targetId)
      } else if (method === 'Target.getTargetInfo') {
        result = model.getTargetInfo(sessionId)
      } else if (sessionId) {
        result = await model.sendCommand(sessionId, method, params)
      } else {
        result = await model.sendBrowserCommand(method, params)
      }
      cdpSocket?.send(JSON.stringify({ id, sessionId, result }))
    } catch (error) {
      cdpSocket?.send(
        JSON.stringify({
          id,
          sessionId,
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      )
    }
  }

  try {
    await withTimeout(transport.start(tab.id), remaining(), runId)
    bridgeServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname !== cdpPath || url.searchParams.get('token') !== transportToken) {
          return new Response('not found', { status: 404 })
        }
        if (cdpSocket)
          return new Response('another CDP client is already connected', { status: 409 })
        return server.upgrade(request, { data: {} })
          ? undefined
          : new Response('upgrade failed', { status: 400 })
      },
      websocket: {
        open(socket) {
          cdpSocket = socket
          model.connectOverCDP((message) => socket.send(JSON.stringify(message)))
        },
        message(_socket, message) {
          void handleCdpMessage(JSON.parse(String(message)) as CDPMessage)
        },
        close() {
          cdpSocket = null
        },
      },
    })
    const { chromium } = await import('playwright-core')
    const browser = await withTimeout(
      chromium.connectOverCDP(
        `ws://127.0.0.1:${bridgeServer.port}${cdpPath}?token=${encodeURIComponent(transportToken)}`,
        { isLocal: true, timeout: 0, noDefaults: true } as any,
      ),
      remaining(),
      runId,
    )
    const context = browser.contexts()[0]
    if (!context) throw runError('Playwright did not expose a browser context', 'EXTENSION_ERROR')
    const page = context.pages()[0]
    if (!page)
      throw runError('Playwright did not expose the selected tab as a Page', 'STALE_TAB_HANDLE')
    const pageFunction = compilePageFunction(source)
    const value = await withTimeout(
      Promise.race([Promise.resolve(pageFunction(page)), disconnected]),
      remaining(),
      runId,
    )
    return {
      value: value === undefined ? null : value,
      tabId: tab.id,
      handle: tab.handle ?? null,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    unsubscribeEvent()
    unsubscribeDisconnect()
    try {
      bridgeServer?.stop(true)
    } catch {
      // 本地桥接只存活于本次 run，清理失败也不能覆盖脚本原错误。
    }
    await Promise.race([
      transport.stop().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
    transport.close()
  }
}

const transportToken = crypto.randomUUID()
