import type {
  CommandErrorInfo,
  ConnectionErrorInfo,
  ConnectionStatus,
  SocketCloseInfo,
} from '../shared.js'

export interface ScreenshotCaptureOptions {
  full?: boolean
  annotate?: boolean
  format?: string
  quality?: number
}

export interface ErrorWithCode extends Error {
  code?: string
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

export interface NetworkRoute {
  id: string
  pattern: string
  abort: boolean
  body?: unknown
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
  responseMimeType?: string
  postData?: string | null
  [key: string]: unknown
}

export interface NetworkState {
  routes: NetworkRoute[]
  requests: NetworkRequestRecord[]
  requestMap: Map<string, NetworkRequestRecord>
  harRecording: boolean
  harStartedAt: string | null
}

export interface ConsoleMessageRecord {
  type: string
  text: string
  timestamp: number
}

export interface PageErrorRecord {
  error: string
  url: string | null
  line?: number
  column?: number
  timestamp: number
}

export interface ExtensionState {
  socket: WebSocket | null
  reconnectTimer: number | null
  connecting: boolean
  suppressCloseError: boolean
  attachedTabs: Set<number>
  selectedFrames: Map<number, string>
  targetTabId: number | null
  tabHandles: Map<number, string>
  tabIdsByHandle: Map<string, number>
  pageEpochs: Map<number, number>
  nextTabHandleIndex: number
  dialog: DialogState | null
  network: NetworkState
  shouldReconnect: boolean
  token: string
  relayPort: number
  consoleMessages: ConsoleMessageRecord[]
  pageErrors: PageErrorRecord[]
  connectionStatus: ConnectionStatus
  connectionError: ConnectionErrorInfo | null
  lastSocketClose: SocketCloseInfo | null
  lastCommandError: CommandErrorInfo | null
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

export interface EvaluateInTabContextOptions extends Record<string, unknown> {
  frameSelector?: string
}

export interface FrameExecutionContext {
  tab: TabWithId
  executionContextId: number | null
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
