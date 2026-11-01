/**
 * runtime 拆分后共享的类型定义。
 * 这些类型被 runtime.ts、runtime-connection.ts、runtime-transfer.ts 同时引用，
 * 单独成文件是为了避免三者之间出现循环导入。
 */

/** 扩展连接握手时携带的元数据 */
export interface ExtensionMetadata {
  extensionId?: string | null
  userAgent?: string | null
}

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
  /**
   * 最近一次命令成功的时间。lastError 保留历史语义、不会因成功而清空；
   * 调用方可比较两者判断当前是否仍有故障（lastError.at > lastSuccessAt）。
   */
  lastSuccessAt: string | null
}

export interface RuntimeOptions {
  homeDir?: string
  relayPort?: number
  ipcPort?: number
  requestTimeoutMs?: number
  heartbeatTimeoutMs?: number
  token?: string
}

export interface RuntimeState {
  homeDir: string
  relayPort: number
  ipcPort: number
  requestTimeoutMs: number
  token: string
  startedAt: string
  extensionSocket: Bun.ServerWebSocket<ExtensionMetadata> | null
  extensionId: string | null
}

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  command: string
  /** download 命令的绝对落盘路径，由 relay 自己保存，扩展另传的路径一律不采信 */
  outputPath?: string
}

export interface ErrorWithCode extends Error {
  code?: string
  details?: unknown
  suggestedAction?: string
}
