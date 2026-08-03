import type {
  CommandErrorInfo,
  ConnectionErrorInfo,
  ConnectionStatus,
  SocketCloseInfo,
} from '../shared.js'

export interface ScreenshotCaptureOptions {
  full?: boolean
  annotate?: boolean
  /** 元素级截图目标（selector 或 @eN ref），与 full 互斥 */
  element?: string
  format?: string
  quality?: number
}

export interface ErrorWithCode extends Error {
  code?: string
  details?: unknown
  suggestedAction?: string
  ref?: string
  expectedPageEpoch?: number
  currentPageEpoch?: number
}

export interface DialogState {
  open: boolean
  type: string
  message: string
  defaultPrompt: string
  url: string | null
  openedAt: string
}

/** 对话框被处理/关闭后留档的记录，让 agent 感知发生过但已自动处理的对话框 */
export interface LastDialogRecord {
  tabId: number
  type: string
  message: string
  handledBy: 'auto-accept' | 'dialog-command' | 'page-closed'
  accepted: boolean
  openedAt: string
  handledAt: string
}

export interface NetworkRoute {
  id: string
  pattern: string
  abort: boolean
  body?: unknown
  /** mock 响应的状态码，默认 200 */
  status?: number
  /** mock 响应的 content-type，默认 application/json */
  contentType?: string
  /** mock 响应额外附加的响应头 */
  headers?: Record<string, string>
  /** 放行请求前要从请求头删除的字段名 */
  removeHeaders?: string[]
  createdAt?: string
}

export interface NetworkRequestRecord {
  id?: string
  requestId?: string
  tabId?: number | null
  url?: string
  method?: string
  resourceType?: string
  status?: number | null
  statusText?: string | null
  routeId?: string | null
  routeAction?: string | null
  finishedAt?: string | null
  startedAt?: string | null
  durationMs?: number | null
  errorText?: string | null
  canceled?: boolean
  requestHeaders?: Record<string, unknown>
  responseHeaders?: Record<string, unknown>
  responseBody?: string
  responseBodyBase64?: boolean
  responseBodyTruncated?: boolean
  responseBodyBytes?: number
  responseMimeType?: string
  postData?: string | null
  postDataTruncated?: boolean
  postDataBytes?: number
  [key: string]: unknown
}

/** 每次导航后、页面自身脚本执行前注入的脚本（CDP Page.addScriptToEvaluateOnNewDocument） */
export interface InitScriptRecord {
  id: string
  source: string
  createdAt: string
  /** addScriptToEvaluateOnNewDocument 按 CDP 会话注册，identifier 必须按 tab 记录，remove 时逐一移除 */
  identifiersByTab: Map<number, string>
}

export interface NetworkState {
  routes: NetworkRoute[]
  requests: NetworkRequestRecord[]
  requestMap: Map<string, NetworkRequestRecord>
  /** requests 数组下标索引，避免每个网络事件对上万条记录做 findIndex 全表扫描 */
  requestIndex: Map<string, number>
  /** 进行中的响应体抓取（Network.getResponseBody），stopHar 收集前需等待其 settle，避免 HAR 丢 body */
  pendingBodyFetches: Set<Promise<unknown>>
  harRecording: boolean
  harStartedAt: string | null
  harMaxRequests: number | null
  harMaxBodyBytes: number | null
}

export interface ConsoleMessageRecord {
  type: string
  text: string
  timestamp: number
  /** 消息来源 tab；source 里没带 tabId 时（罕见）为 null */
  tabId: number | null
}

export interface PageErrorRecord {
  error: string
  url: string | null
  line?: number
  column?: number
  timestamp: number
  /** 消息来源 tab；source 里没带 tabId 时（罕见）为 null */
  tabId: number | null
}

/** WebSocket 连接生命周期与诊断信息 */
export interface ConnectionState {
  socket: WebSocket | null
  reconnectTimer: number | ReturnType<typeof setTimeout> | null
  /** 当前已重试次数，用于计算指数退避延迟 */
  reconnectAttempts: number
  heartbeatTimer: number | ReturnType<typeof setInterval> | null
  heartbeatTimeoutTimer: number | ReturnType<typeof setTimeout> | null
  connecting: boolean
  suppressCloseError: boolean
  shouldReconnect: boolean
  token: string
  relayPort: number
  status: ConnectionStatus
  error: ConnectionErrorInfo | null
  lastSocketClose: SocketCloseInfo | null
  lastCommandError: CommandErrorInfo | null
  lastHeartbeatAt: string | null
  lastHeartbeatSentAt: string | null
}

/** Tab/Frame 路由与调试器附加状态 */
export interface TargetingState {
  attachedTabs: Set<number>
  selectedFrames: Map<number, string>
  targetTabId: number | null
  tabHandles: Map<number, string>
  tabIdsByHandle: Map<string, number>
  pageEpochs: Map<number, number>
  nextTabHandleIndex: number
}

/** 页面会话级别的可观测状态 */
export interface SessionState {
  /** 当前打开的 JS 对话框，按 tab 记录 */
  dialogs: Map<number, DialogState>
  /** 最近一次对话框处理/关闭记录（含自动 accept），null 表示从未发生过 */
  lastDialog: LastDialogRecord | null
  consoleMessages: ConsoleMessageRecord[]
  pageErrors: PageErrorRecord[]
}

export interface ExtensionState {
  connection: ConnectionState
  targeting: TargetingState
  session: SessionState
  network: NetworkState
  initScripts: InitScriptRecord[]
}

export type TabInput = number | string | null | undefined
export type FrameSelector = string | null | undefined
export type TabWithId = chrome.tabs.Tab & { id: number }

export interface SavedStateCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
}

export interface SavedStateData {
  name: string
  cookies: SavedStateCookie[]
  storage: Record<string, string | null>
}

export type SavedStatesMap = Record<string, SavedStateData>

export interface CommandArgs {
  [key: string]: unknown
}

export interface CommandMessage {
  command?: string
  args?: CommandArgs
  id?: unknown
  type?: string
}

export interface TabSummary {
  id: number | null
  handle: string | null
  title: string
  url: string
  active: boolean
  pinned: boolean
  status: string
  windowId: number | null
}

/** 命令成功响应中回显的目标 tab 上下文元数据，取不到的字段为 null */
export interface CommandMeta {
  tabHandle: string | null
  tabId: number | null
  frame: string | null
  pageEpoch: number | null
  url: string | null
  title: string | null
}

export interface EvaluateInTabContextOptions extends Record<string, unknown> {
  frameSelector?: string
  /** Runtime.evaluate 的执行超时（毫秒），缺省 25000（小于 server 的命令超时 30s） */
  timeoutMs?: number
}

export interface FrameExecutionContext {
  tab: TabWithId
  executionContextId: number | null
  /** isolated world 缓存键，无 frame 场景为 null */
  worldCacheKey?: string | null
  /** executionContextId 是否来自缓存（用于失效重试判断） */
  worldFromCache?: boolean
}

export interface ResolvedSelectorTarget {
  tab: TabWithId
  pageEpoch: number
  resolvedSelector: string
}

export interface ResolvedFrameTarget {
  tab: TabWithId
  frameId: string
  selector: string
  ref: string | null
  src: string | null
  pageEpoch: number
  left: number
  top: number
  width: number
  height: number
}
