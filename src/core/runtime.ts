import {
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
}

export interface Snapshot {
  extension: ExtensionInfo | null
  tabs: TabInfo[]
  activeTabId: number | null
  targetTabId: number | null
  lastCommand: { command: string; args: unknown; at: string } | null
  lastError: { message: string; at: string } | null
}

export interface RuntimeOptions {
  homeDir?: string
  relayPort?: number
  ipcPort?: number
  requestTimeoutMs?: number
  token?: string
}

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
}

function rejectPendingRequests(
  pendingRequests: Map<string, PendingRequest>,
  message: string,
): void {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
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

export interface Runtime {
  runtime: RuntimeState
  persist: () => Promise<void>
  exportSnapshot: () => Promise<unknown>
  setError: (message: string) => void
  setLastCommand: (command: string, args: unknown) => void
  setTabs: (tabs?: TabInfo[]) => void
  attachExtension: (
    socket: Bun.ServerWebSocket<ExtensionMetadata>,
    meta?: ExtensionMetadata,
  ) => void
  detachExtension: () => void
  handleExtensionMessage: (rawMessage: unknown) => void
  dispatchCommand: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  snapshot: () => {
    token: string
    relayPort: number
    ipcPort: number
    startedAt: string
    snapshot: Snapshot
    extensionConnected: boolean
  }
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const homeDir = options.homeDir || getHomeDir()
  const relayPort = options.relayPort || DEFAULT_RELAY_PORT
  const ipcPort = options.ipcPort || DEFAULT_IPC_PORT
  const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS

  const persistedState = await readJsonFile<{
    token?: string
    snapshot?: Snapshot
  } | null>(getStatePath(homeDir), null)

  const tokenFile = await readJsonFile<{ token: string } | null>(getTokenPath(homeDir), null)

  const persistedToken = options.token || persistedState?.token || tokenFile?.token

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
  }

  async function persist(): Promise<void> {
    await writeJsonFile(getStatePath(homeDir), {
      token: runtime.token,
      relayPort,
      ipcPort,
      startedAt: runtime.startedAt,
      snapshot,
    })
    await writeJsonFile(getTokenPath(homeDir), { token: runtime.token })
  }

  let persistChain: Promise<void> = Promise.resolve()

  function schedulePersist(): void {
    persistChain = persistChain.then(() => persist()).catch(() => {})
  }

  function resolveConnectionWaiters(socket: Bun.ServerWebSocket<ExtensionMetadata>): void {
    for (const waiter of connectionWaiters) {
      connectionWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(socket)
    }
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

  await persist()

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
    runtime.extensionSocket = socket
    runtime.extensionId = typeof meta.extensionId === 'string' ? meta.extensionId : null
    snapshot.extension = {
      extensionId: runtime.extensionId,
      connectedAt: new Date().toISOString(),
      userAgent: (meta.userAgent as string) || null,
    }
    resolveConnectionWaiters(socket)
    schedulePersist()
  }

  function detachExtension(): void {
    runtime.extensionSocket = null
    runtime.extensionId = null
    snapshot.extension = null
    rejectPendingRequests(pendingRequests, 'extension disconnected')
    schedulePersist()
  }

  interface ExtensionMessage {
    type?: string
    tabs?: TabInfo[]
    activeTabId?: number
    targetTabId?: number | null
    id?: string
    ok?: boolean
    error?: { message?: string; code?: string; details?: unknown }
    result?: unknown
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

      schedulePersist()

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
  }

  async function dispatchCommand(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    setLastCommand(command, args)

    const connectionTimeoutMs = Math.min(requestTimeoutMs, 10_000)
    const socket = await waitForExtensionConnection(connectionTimeoutMs)

    const id = createId('cmd')
    const payload: CommandPayload = {
      type: 'command',
      id,
      command,
      args,
      requestedAt: new Date().toISOString(),
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id)
        reject(new Error(`command timed out: ${command}`))
      }, requestTimeoutMs)

      pendingRequests.set(id, { resolve, reject, timer })

      try {
        socket.send(JSON.stringify(payload))
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
    await writeJsonFile(getStatePath(homeDir), state)
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
