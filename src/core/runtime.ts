import {
  cleanupStaleTempFiles,
  createId,
  createToken,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_IPC_PORT,
  DEFAULT_RELAY_PORT,
  getHomeDir,
  getStatePath,
  getTokenPath,
  readJsonFile,
  writeJsonFile,
} from './protocol.js'
import { validateCommandArgs } from './command-spec.js'

export interface TabInfo {
  id: number
  title: string
  url: string
  active: boolean
  pinned: boolean
  status: string
  windowId: number
}

export interface ExtensionInfo {
  extensionId: string | null
  connectedAt: string
  userAgent: string | null
  lastHeartbeatAt: string | null
}

export interface Snapshot {
  extension: ExtensionInfo | null
  tabs: TabInfo[]
  activeTabId: number | null
  targetTabId: number | null
  pageEpochs: Record<number, number>
  lastCommand: { command: string; args: unknown; at: string } | null
  lastError: { message: string; at: string } | null
}

export interface RuntimeOptions {
  homeDir?: string
  relayPort?: number
  ipcPort?: number
  requestTimeoutMs?: number
  heartbeatTimeoutMs?: number
  token?: string
}

/** 扩展每 30s 发一次心跳；超过该时长未收到心跳视为连接已死（半开连接），主动断开 */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ConnectionWaiter {
  resolve: (socket: Bun.ServerWebSocket<ExtensionMetadata>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ExtensionMetadata {
  extensionId?: string | null
  userAgent?: string | null
}

interface ErrorWithCode extends Error {
  code?: string
  details?: unknown
  suggestedAction?: string
}

function rejectPendingRequests(
  pendingRequests: Map<string, PendingRequest>,
  message: string,
): void {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer)
    // 带 EXTENSION_DISCONNECTED 标记，便于调用方区分「扩展断开」与「超时」
    pending.reject(createExtensionDisconnectedError(message))
    pendingRequests.delete(id)
  }
}

function createExtensionDisconnectedError(message: string = 'no extension is connected'): Error {
  const error = new Error(message) as ErrorWithCode
  error.code = 'EXTENSION_DISCONNECTED'
  return error
}

function createDefaultSnapshot(): Snapshot {
  return {
    extension: null,
    tabs: [],
    activeTabId: null,
    targetTabId: null,
    pageEpochs: {},
    lastCommand: null,
    lastError: null,
  }
}

const REDACTED_VALUE = '[redacted]'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function redactCommandArgs(command: string, args: unknown): unknown {
  if (!isRecord(args)) {
    return args
  }

  const redactedArgs: Record<string, unknown> = { ...args }
  const action = typeof redactedArgs.action === 'string' ? redactedArgs.action : ''
  const type = typeof redactedArgs.type === 'string' ? redactedArgs.type : ''
  const redact = (...keys: string[]): void => {
    for (const key of keys) {
      if (key in redactedArgs) {
        redactedArgs[key] = REDACTED_VALUE
      }
    }
  }

  // lastCommand 会持久化到 state.json，这里只保留排障所需的结构信息。
  if (command === 'eval') {
    redact('script')
  }
  if (command === 'fill' || command === 'type') {
    redact('value')
  }
  if (command === 'find' && (action === 'fill' || action === 'type')) {
    redact('value')
  }
  if (command === 'keyboard') {
    redact('text')
  }
  if (command === 'dialog') {
    redact('promptText')
  }
  if (command === 'clipboard' && action === 'write') {
    redact('text')
  }
  if (command === 'cookies' && action === 'set') {
    redact('value')
  }
  if (command === 'storage' && action === 'set') {
    redact('value')
  }
  if (command === 'network' && action === 'route') {
    redact('body')
  }
  if (command === 'set' && type === 'headers') {
    redact('headers')
  }
  if (command === 'state' && action === 'load') {
    redact('data')
  }

  return redactedArgs
}

function normalizeLastCommand(value: unknown): Snapshot['lastCommand'] {
  if (!isRecord(value) || typeof value.command !== 'string' || !value.command) {
    return null
  }

  return {
    command: value.command,
    args: redactCommandArgs(value.command, value.args),
    at: typeof value.at === 'string' ? value.at : new Date().toISOString(),
  }
}

function normalizePageEpochs(value: unknown): Record<number, number> {
  if (!isRecord(value)) {
    return {}
  }

  const normalized: Record<number, number> = {}
  for (const [key, epoch] of Object.entries(value)) {
    const tabId = Number(key)
    if (!Number.isInteger(tabId) || tabId <= 0) {
      continue
    }

    if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch <= 0) {
      continue
    }

    normalized[tabId] = Math.floor(epoch)
  }

  return normalized
}

interface RuntimeState {
  homeDir: string
  relayPort: number
  ipcPort: number
  requestTimeoutMs: number
  token: string
  startedAt: string
  extensionSocket: Bun.ServerWebSocket<ExtensionMetadata> | null
  extensionId: string | null
}

/**
 * 核心运行时接口，负责管理浏览器扩展连接、状态持久化和命令分发。
 */
export interface Runtime {
  /** 当前运行时的配置和状态信息 */
  runtime: RuntimeState
  /** 将当前运行时状态持久化到磁盘 */
  persist: () => Promise<void>
  /** 导出当前快照数据 */
  exportSnapshot: () => Promise<unknown>
  /** 设置运行时的错误状态 */
  setError: (message: string) => void
  /** 记录最后执行的命令（会进行脱敏处理） */
  setLastCommand: (command: string, args: unknown) => void
  /** 更新当前打开的标签页列表 */
  setTabs: (tabs?: TabInfo[]) => void
  /** 关联一个新的浏览器扩展 WebSocket 连接 */
  attachExtension: (
    socket: Bun.ServerWebSocket<ExtensionMetadata>,
    meta?: ExtensionMetadata,
  ) => void
  /** 断开浏览器扩展连接并清理状态；传入 socket 时仅当它是当前连接才断开（防重连竞态） */
  detachExtension: (socket?: Bun.ServerWebSocket<ExtensionMetadata>) => void
  /** 处理来自扩展的原始消息（RPC 响应、事件、心跳） */
  handleExtensionMessage: (rawMessage: unknown) => void
  /** 向扩展分发命令并等待响应 */
  dispatchCommand: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  /** 获取当前运行时的状态摘要 */
  snapshot: () => {
    token: string
    relayPort: number
    ipcPort: number
    startedAt: string
    snapshot: Snapshot
    extensionConnected: boolean
  }
}

/**
 * 创建并初始化 autobrowser 运行时。
 * 它会尝试从 state.json 恢复之前的状态（包括 token、最后一条命令、页面 Epoch 等）。
 * @param options 运行配置选项
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const homeDir = options.homeDir || getHomeDir()
  const relayPort = options.relayPort || DEFAULT_RELAY_PORT
  const ipcPort = options.ipcPort || DEFAULT_IPC_PORT
  const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS

  const persistedState = await readJsonFile<{
    token?: string
    snapshot?: Snapshot
  } | null>(getStatePath(homeDir), null)

  const tokenFile = await readJsonFile<{ token: string } | null>(getTokenPath(homeDir), null)

  const persistedToken = options.token || persistedState?.token || tokenFile?.token

  // 清理上一次崩溃（如 SIGKILL）可能残留的 .tmp 文件，避免状态目录堆积垃圾
  await cleanupStaleTempFiles(homeDir)

  // pendingRequests maps CLI commands to extension responses
  const pendingRequests = new Map<string, PendingRequest>()
  const connectionWaiters = new Set<ConnectionWaiter>()
  const snapshot: Snapshot = createDefaultSnapshot()

  const runtime: RuntimeState = {
    homeDir,
    relayPort,
    ipcPort,
    requestTimeoutMs,
    token: persistedToken || createToken(),
    startedAt: new Date().toISOString(),
    extensionSocket: null,
    extensionId: null,
  }

  // Only restore stable state, avoid stale tab lists
  if (persistedState?.snapshot && typeof persistedState.snapshot === 'object') {
    snapshot.lastCommand = normalizeLastCommand(persistedState.snapshot.lastCommand)
    snapshot.lastError = persistedState.snapshot.lastError ?? null
    snapshot.pageEpochs = normalizePageEpochs(persistedState.snapshot.pageEpochs)
  }

  // token 从不在运行期变化，只在首次写盘或值变化时落盘，避免心跳等高频 persist 反复 chmod
  let lastPersistedToken: string | null = null

  async function persistNow(): Promise<void> {
    await writeJsonFile(getStatePath(homeDir), {
      token: runtime.token,
      relayPort,
      ipcPort,
      startedAt: runtime.startedAt,
      snapshot,
    })
    if (lastPersistedToken !== runtime.token) {
      await writeJsonFile(getTokenPath(homeDir), { token: runtime.token })
      lastPersistedToken = runtime.token
    }
  }

  let persistChain: Promise<void> = Promise.resolve()

  function schedulePersist(): void {
    persistChain = persistChain
      .then(() => persistNow())
      .catch((err) => {
        console.error('[autobrowser] state persist failed:', err)
      })
  }

  async function persist(): Promise<void> {
    persistChain = persistChain.then(() => persistNow())
    await persistChain
  }

  function resolveConnectionWaiters(socket: Bun.ServerWebSocket<ExtensionMetadata>): void {
    for (const waiter of connectionWaiters) {
      connectionWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(socket)
    }
  }

  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

  function clearHeartbeatTimeout(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function scheduleHeartbeatTimeout(socket: Bun.ServerWebSocket<ExtensionMetadata>): void {
    clearHeartbeatTimeout()
    if (!(heartbeatTimeoutMs > 0)) {
      return
    }

    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null
      // 重连竞态：定时器触发时可能已经换了连接，只对当前 socket 生效
      if (runtime.extensionSocket !== socket) {
        return
      }

      // 主动关掉半开连接；close 事件会走 detach 身份校验（对当前 socket 生效）。
      // 直接 detach 兜底，避免部分环境 close 事件不可达时扩展仍被误认为在线。
      try {
        if (typeof socket.close === 'function') {
          socket.close()
        }
      } catch {
        // 连接可能已断开，忽略关闭失败
      }
      // detachExtension 是 hoisted 的函数声明，定时器触发时必然已定义；
      // 直接调用（runtime 是 RuntimeState 对象，没有 detachExtension）
      detachExtension(socket)
    }, heartbeatTimeoutMs)
  }

  function waitForExtensionConnection(
    timeoutMs: number,
  ): Promise<Bun.ServerWebSocket<ExtensionMetadata>> {
    if (runtime.extensionSocket && runtime.extensionSocket.readyState === WebSocket.OPEN) {
      return Promise.resolve(runtime.extensionSocket)
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(createExtensionDisconnectedError())
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let waiter: ConnectionWaiter

      const settle = (callback: () => void): void => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(waiter.timer)
        connectionWaiters.delete(waiter)
        callback()
      }

      const timer = setTimeout(() => {
        settle(() => reject(createExtensionDisconnectedError()))
      }, timeoutMs)

      waiter = {
        timer,
        resolve(socket) {
          settle(() => resolve(socket))
        },
        reject(error) {
          settle(() => reject(error))
        },
      }

      connectionWaiters.add(waiter)
    })
  }

  await persistNow()

  function setError(message: string): void {
    snapshot.lastError = {
      message,
      at: new Date().toISOString(),
    }
    schedulePersist()
  }

  function setLastCommand(command: string, args: unknown): void {
    snapshot.lastCommand = {
      command,
      args: redactCommandArgs(command, args),
      at: new Date().toISOString(),
    }
    schedulePersist()
  }

  function setTabs(tabs: TabInfo[] = []): void {
    snapshot.tabs = Array.isArray(tabs) ? tabs : []
    snapshot.activeTabId = snapshot.tabs.find((tab: TabInfo) => tab.active)?.id ?? null
    schedulePersist()
  }

  function attachExtension(
    socket: Bun.ServerWebSocket<ExtensionMetadata>,
    meta: ExtensionMetadata = {},
  ): void {
    const previousSocket = runtime.extensionSocket
    if (previousSocket && previousSocket !== socket) {
      // 扩展重连时旧 socket 还挂在运行时上：先通知旧连接被新实例顶替，再主动关闭，
      // 否则旧侧会把断开误判成网络故障；detachExtension 会做身份校验，不会误伤新连接
      try {
        const displacedPayload = JSON.stringify({
          type: 'displaced',
          reason: 'A new extension instance connected and took over this connection.',
        })
        if (typeof previousSocket.send === 'function') {
          previousSocket.send(displacedPayload)
        }
      } catch {
        // 旧连接可能已断开，忽略发送失败
      }
      try {
        previousSocket.close()
      } catch {
        // 旧连接可能已断开，忽略关闭失败
      }
    }

    runtime.extensionSocket = socket
    runtime.extensionId = typeof meta.extensionId === 'string' ? meta.extensionId : null
    snapshot.extension = {
      extensionId: runtime.extensionId,
      connectedAt: new Date().toISOString(),
      userAgent: (meta.userAgent as string) || null,
      lastHeartbeatAt: null,
    }
    resolveConnectionWaiters(socket)
    scheduleHeartbeatTimeout(socket)
    schedulePersist()
  }

  function detachExtension(socket?: Bun.ServerWebSocket<ExtensionMetadata>): void {
    if (socket && runtime.extensionSocket !== socket) {
      // 重连竞态：旧 socket 的 close 事件晚于新连接 attach 到达，不能把新连接踢掉
      return
    }

    runtime.extensionSocket = null
    runtime.extensionId = null
    snapshot.extension = null
    clearHeartbeatTimeout()
    rejectPendingRequests(pendingRequests, 'extension disconnected')
    // 断开时立即唤醒等待连接的 waiter，否则它们只能干等超时
    // reject 内的 settle 会把 waiter 从 Set 删除，Set 迭代期间删除当前元素是安全的
    for (const waiter of connectionWaiters) {
      waiter.reject(
        createExtensionDisconnectedError('extension disconnected while waiting for connection'),
      )
    }
    schedulePersist()
  }

  interface ExtensionMessage {
    type?: string
    tabs?: TabInfo[]
    activeTabId?: number
    targetTabId?: number | null
    pageEpochs?: Record<string, unknown>
    id?: string
    ok?: boolean
    error?: { message?: string; code?: string; details?: unknown }
    result?: unknown
    sentAt?: string
  }

  function handleExtensionMessage(rawMessage: unknown): void {
    let message: ExtensionMessage
    try {
      message =
        typeof rawMessage === 'string' ? JSON.parse(rawMessage) : (rawMessage as ExtensionMessage)
    } catch {
      setError('received invalid JSON from extension')
      return
    }

    if (message?.type === 'state') {
      if (Array.isArray(message.tabs)) {
        setTabs(message.tabs)
      }

      if (message.activeTabId !== undefined) {
        snapshot.activeTabId = message.activeTabId
      }

      if (message.targetTabId !== undefined) {
        snapshot.targetTabId = message.targetTabId ?? null
      }

      if (message.pageEpochs !== undefined) {
        snapshot.pageEpochs = normalizePageEpochs(message.pageEpochs)
      }

      schedulePersist()

      return
    }

    if (message?.type === 'heartbeat') {
      // 心跳每 30s 一次，lastHeartbeatAt 是运行时状态无需持久化；只更新内存，避免每次都全量落盘
      if (snapshot.extension) {
        snapshot.extension.lastHeartbeatAt = new Date().toISOString()
      }

      // 收到心跳说明连接仍健康，重置超时计时
      if (runtime.extensionSocket) {
        scheduleHeartbeatTimeout(runtime.extensionSocket)
      }

      if (runtime.extensionSocket && runtime.extensionSocket.readyState === WebSocket.OPEN) {
        runtime.extensionSocket.send(
          JSON.stringify({
            type: 'heartbeat',
            sentAt: typeof message.sentAt === 'string' ? message.sentAt : null,
            receivedAt: new Date().toISOString(),
          }),
        )
      }

      return
    }

    if (message?.type !== 'response' || typeof message.id !== 'string') {
      return
    }

    const pending = pendingRequests.get(message.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timer)
    pendingRequests.delete(message.id)

    if (message.ok === false) {
      const error = new Error(message.error?.message || 'extension command failed') as ErrorWithCode
      error.code = message.error?.code || 'EXTENSION_ERROR'
      error.details = message.error?.details || null
      pending.reject(error)
      return
    }

    pending.resolve(message.result)
  }

  interface CommandPayload {
    type: 'command'
    id: string
    command: string
    args: Record<string, unknown>
    requestedAt: string
    deadlineAt: string
  }

  async function dispatchCommand(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    validateCommandArgs(command, args)
    setLastCommand(command, args)

    const connectionTimeoutMs = Math.min(requestTimeoutMs, 10_000)
    const socket = await waitForExtensionConnection(connectionTimeoutMs)

    const id = createId('cmd')
    const deadlineAt = new Date(Date.now() + requestTimeoutMs).toISOString()
    const payload: CommandPayload = {
      type: 'command',
      id,
      command,
      args,
      requestedAt: new Date().toISOString(),
      deadlineAt,
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id)
        try {
          socket.send(JSON.stringify({ type: 'cancel', id, reason: 'relay timeout' }))
        } catch {
          // socket 断开时 detachExtension 会负责清理 pending；取消消息属于尽力而为。
        }
        const timeoutError = new Error(
          `command timed out after ${requestTimeoutMs}ms: ${command}. ` +
            'The relay cancelled the queued command; a running browser operation may still be finishing.',
        ) as ErrorWithCode
        timeoutError.code = 'COMMAND_TIMEOUT'
        timeoutError.details = { commandId: id, command, deadlineAt }
        timeoutError.suggestedAction =
          "Run 'status', then 'command list'. Tab control remains available; use 'tab list', 'target clear', or 'tab close <tN>' to recover before retrying."
        reject(timeoutError)
      }, requestTimeoutMs)

      pendingRequests.set(id, { resolve, reject, timer })

      try {
        // waitForExtensionConnection 返回到 send 之间扩展可能已断开；
        // Bun 对已关闭 socket 的 send 不抛异常而是返回 ≤0，需检查返回值快速失败
        const sent = socket.send(JSON.stringify(payload))
        if (sent <= 0) {
          clearTimeout(timer)
          pendingRequests.delete(id)
          reject(
            createExtensionDisconnectedError(
              `extension disconnected while sending command: ${command}`,
            ),
          )
        }
      } catch (error) {
        clearTimeout(timer)
        pendingRequests.delete(id)
        reject(
          error instanceof Error
            ? error
            : createExtensionDisconnectedError('failed to send command to extension'),
        )
      }
    })
  }

  async function exportSnapshot(): Promise<unknown> {
    const state = {
      token: runtime.token,
      relayPort,
      ipcPort,
      startedAt: runtime.startedAt,
      snapshot,
    }
    await persist()
    return state
  }

  return {
    runtime,
    persist,
    exportSnapshot,
    setError,
    setLastCommand,
    setTabs,
    attachExtension,
    detachExtension,
    handleExtensionMessage,
    dispatchCommand,
    snapshot: () => ({
      token: runtime.token,
      relayPort,
      ipcPort,
      startedAt: runtime.startedAt,
      snapshot,
      extensionConnected: Boolean(runtime.extensionSocket),
    }),
  }
}
