import { tabsQuery, tabsRemove, windowsCreate } from './chrome.js'
import {
  getPageEpoch,
  rememberTargetTab,
  resolveEffectiveFrameSelector,
  resolveTabInput,
} from './targeting.js'
import { createCommandQueue, type CommandExecutionContext } from './command-queue.js'
import { createBatchCommandHandler } from './command-batch.js'
import { createCommandMetaBuilder } from './command-meta.js'
import { createDiagnosticsCommandHandler } from './command-router-diagnostics.js'
import { createNetworkCommandHandler } from './command-router-network.js'
import { createSessionCommandHandler } from './command-router-session.js'
import { createTabsCommandHandler } from './command-router-tabs.js'
import type { CommandRunScope } from './command-router-context.js'
import { getCommandRequestBudgetMs } from '../../src/core/command-budget.js'
import { DEFAULT_PAGE_SIZE } from './pagination.js'
import type { ExtensionControlDomain } from './extension-control.js'
import { commandSupportsTabTarget, validateCommandArgs } from '../../src/core/command-spec.js'
import type {
  CommandArgs,
  CommandMessage,
  DialogState,
  ExtensionState,
  FrameSelector,
  ErrorWithCode,
  SavedStateData,
  ScreenshotCaptureOptions,
  TabInput,
  TabSummary,
  TabWithId,
} from './types.js'
import type { FindSemanticTargetOptions, SemanticTargetResult } from './page-observe.js'
import type {
  CollectFeedOptions,
  FeedCollectionResult,
  SearchPageTextOptions,
  SearchPageTextResult,
  SnapshotTabOptions,
} from './page-observe.js'

/** 目标 tab 存在未处理 JS 对话框时需要拒绝的命令（交互/导航/读取类）。
 *  查询类（console/errors/network/status）与 dialog 命令本身不受阻，
 *  snapshot 放行到 snapshotTab，由其返回 modal 描述 */
const DIALOG_BLOCKED_COMMANDS = new Set([
  'goto',
  'open',
  'eval',
  'feed',
  'screenshot',
  'click',
  'dblclick',
  'fill',
  'fillform',
  'find',
  'type',
  'highlight',
  'hover',
  'locator',
  'press',
  'keyboard',
  'focus',
  'select',
  'check',
  'uncheck',
  'scroll',
  'scrollintoview',
  'drag',
  'drop',
  'mousemove',
  'mousedown',
  'mouseup',
  'mousewheel',
  'upload',
  'back',
  'forward',
  'reload',
  'frame',
  'is',
  'get',
  'media',
  'wait',
])

interface PageInputDomain {
  navigateTo: (
    tabId: TabInput,
    url: string,
    options?: {
      timeoutMs?: number
      wait?: boolean
      waitUntil?: string
      settleTimeoutMs?: number
      domQuietMs?: number
    },
  ) => Promise<unknown>
  evaluateScript: (
    tabId: TabInput,
    script: string,
    frameSelector: FrameSelector,
    timeoutMs?: number,
    elementSelector?: string,
    maxResultBytes?: number,
  ) => Promise<unknown>
  generateLocator: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  highlightElement: (
    tabId: TabInput,
    selector: string | undefined,
    style: string | undefined,
    hide: boolean,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  // 多步骤交互动作的末位可选参数是命令执行上下文，供动作内部逐段检查取消
  clickSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    timeoutMs?: number,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  doubleClickSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  fillSelector: (
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  fillFields: (
    tabId: TabInput,
    fields: Array<{ selector: string; value: string }>,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  typeIntoSelector: (
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
    submit?: boolean,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  hoverElement: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  pressKey: (tabId: TabInput, key: string, context?: CommandExecutionContext) => Promise<unknown>
  insertTextSequentially: (
    tabId: TabInput,
    text: string,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  insertTextOnce: (
    tabId: TabInput,
    text: string,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  keyDownOnly: (tabId: TabInput, key: string, context?: CommandExecutionContext) => Promise<unknown>
  keyUpOnly: (tabId: TabInput, key: string, context?: CommandExecutionContext) => Promise<unknown>
  focusElement: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  selectOption: (
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  checkElement: (
    tabId: TabInput,
    selector: string,
    checked: boolean,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  scrollElement: (
    tabId: TabInput,
    selector: string | null,
    deltaX: number,
    deltaY: number,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  scrollIntoViewSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  dragElement: (
    tabId: TabInput,
    startSelector: string,
    endSelector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  uploadFiles: (
    tabId: TabInput,
    selector: string,
    filePaths: string[],
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  dropData: (
    tabId: TabInput,
    selector: string,
    data: Record<string, string>,
    files: Array<{ name: string; mimeType: string; dataBase64: string }>,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  mouseMove: (
    tabId: TabInput,
    x: number,
    y: number,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  mouseButton: (
    tabId: TabInput,
    pressed: boolean,
    button: string,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  mouseWheel: (
    tabId: TabInput,
    deltaX: number,
    deltaY: number,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  navigateBack: (tabId: TabInput) => Promise<unknown>
  navigateForward: (tabId: TabInput) => Promise<unknown>
  reloadPage: (
    tabId: TabInput,
    options?: { timeoutMs?: number; waitUntil?: string },
  ) => Promise<unknown>
  switchToFrame: (tabId: TabInput, selector: string) => Promise<unknown>
  checkIsState: (
    tabId: TabInput,
    selector: string,
    stateType: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  getAttribute: (
    tabId: TabInput,
    selector: string,
    attrName: string,
    frameSelector: FrameSelector,
  ) => Promise<{ value?: unknown } & Record<string, unknown>>
}

interface PageObserveDomain {
  snapshotTab: (
    tabId: TabInput,
    frameSelector: FrameSelector,
    options?: SnapshotTabOptions,
  ) => Promise<unknown>
  collectFeed: (
    tabId: TabInput,
    options: CollectFeedOptions,
    frameSelector: FrameSelector,
  ) => Promise<FeedCollectionResult>
  captureScreenshot: (
    tabId: TabInput,
    options: ScreenshotCaptureOptions,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  findSemanticTarget: (
    tabId: TabInput,
    options: FindSemanticTargetOptions,
    frameSelector: FrameSelector,
  ) => Promise<SemanticTargetResult>
  searchPageText: (
    tabId: TabInput,
    options: SearchPageTextOptions,
    frameSelector: FrameSelector,
  ) => Promise<SearchPageTextResult>
  waitWithTimeout: (tabId: TabInput, ms: number) => Promise<unknown>
  waitForSelectorState: (
    tabId: TabInput,
    selector: string,
    state: string,
    timeout: number,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  waitForUrl: (
    tabId: TabInput,
    pattern: string,
    timeout: number,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  waitForText: (
    tabId: TabInput,
    text: string,
    timeout: number,
    frameSelector: FrameSelector,
    gone?: boolean,
  ) => Promise<unknown>
  waitForLoadEvent: (tabId: TabInput, timeout: number) => Promise<unknown>
  waitForNetworkIdle: (tabId: TabInput, timeout: number) => Promise<unknown>
  waitForExpression: (
    tabId: TabInput,
    expression: string,
    timeout: number,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
}

interface SessionDomain {
  getDialogStatus: (tabId?: TabInput) => Record<string, unknown>
  handleDialog: (tabId: TabInput, accept: boolean, promptText?: string) => Promise<unknown>
  getDialogAutoAccept: () => boolean
  setDialogAutoAccept: (enabled: boolean) => { autoAccept: boolean }
  cookiesGet: (tabId: TabInput, filters?: { domain?: string; path?: string }) => Promise<unknown>
  cookiesSet: (tabId: TabInput, name: string, value: string, domain?: string) => Promise<unknown>
  cookiesClear: (tabId: TabInput) => Promise<unknown>
  cookiesDelete: (tabId: TabInput, name: string) => Promise<unknown>
  storageGet: (
    tabId: TabInput,
    key: string | null | undefined,
    frameSelector: FrameSelector,
    sessionOnly?: boolean,
  ) => Promise<unknown>
  storageSet: (
    tabId: TabInput,
    key: string,
    value: string,
    frameSelector: FrameSelector,
    sessionOnly?: boolean,
  ) => Promise<unknown>
  storageDelete: (
    tabId: TabInput,
    key: string,
    frameSelector: FrameSelector,
    sessionOnly?: boolean,
  ) => Promise<unknown>
  storageClear: (
    tabId: TabInput,
    frameSelector: FrameSelector,
    sessionOnly?: boolean,
  ) => Promise<unknown>
  setViewport: (
    tabId: TabInput,
    width: number,
    height: number,
    deviceScaleFactor?: number,
    mobile?: boolean,
  ) => Promise<unknown>
  setOffline: (tabId: TabInput, enabled: boolean) => Promise<unknown>
  setHeaders: (
    tabId: TabInput,
    headers: Array<{ name?: string; value?: unknown }> | Record<string, unknown> | null | undefined,
  ) => Promise<unknown>
  setGeo: (
    tabId: TabInput,
    latitude: number,
    longitude: number,
    accuracy?: number,
  ) => Promise<unknown>
  setMedia: (tabId: TabInput, media: string | null | undefined) => Promise<unknown>
  setMediaType: (tabId: TabInput, mediaType: string | null | undefined) => Promise<unknown>
  setMediaFeature: (
    tabId: TabInput,
    name: string,
    value: string | null | undefined,
  ) => Promise<unknown>
  setDevice: (tabId: TabInput, name: string | null | undefined) => Promise<unknown>
  setPermission: (tabId: TabInput, name: string, reset?: boolean) => Promise<unknown>
  setUserAgent: (tabId: TabInput, userAgent: string | null | undefined) => Promise<unknown>
  setTimezone: (tabId: TabInput, timezone: string | null | undefined) => Promise<unknown>
  setLocale: (tabId: TabInput, locale: string | null | undefined) => Promise<unknown>
  generatePdf: (tabId: TabInput) => Promise<unknown>
  clipboardRead: (tabId: TabInput) => Promise<unknown>
  clipboardWrite: (tabId: TabInput, text: string) => Promise<unknown>
  saveState: (tabId: TabInput, name: string) => Promise<unknown>
  loadState: (tabId: TabInput, stateData: SavedStateData) => Promise<unknown>
  loadStateByName: (tabId: TabInput, name: string) => Promise<unknown>
}

interface NetworkRouteCommandOptions {
  abort?: boolean
  body?: unknown
  status?: number
  contentType?: string
  headers?: Record<string, string>
  removeHeaders?: string[]
}

interface NetworkDomain {
  routeRequest: (
    tabId: TabInput,
    url: string,
    options: NetworkRouteCommandOptions,
  ) => Promise<unknown>
  unrouteRequest: (tabId: TabInput, url: string) => Promise<unknown>
  listRoutes: () => unknown
  listRequests: (args: CommandArgs) => unknown
  getRequestDetail: (requestId: string, tabId?: number | null) => unknown
  startHar: (
    tabId: TabInput,
    options?: {
      maxRequests?: number | null
      maxBodyBytes?: number | null
      includePattern?: string
      excludePattern?: string
    },
  ) => Promise<unknown>
  stopHar: (options?: { captureId?: string; includeUrls?: boolean }) => Promise<unknown>
  getHarStatus: () => Promise<unknown>
  recoverHar: () => Promise<unknown>
}

interface InitScriptDomain {
  addScript: (source: string) => Promise<unknown>
  listScripts: () => unknown
  removeScript: (id: string) => Promise<unknown>
  removeAllScripts: () => Promise<unknown>
}

interface DownloadsDomain {
  listDownloads: (pageIdx?: number, pageSize?: number) => unknown
  clearDownloads: () => unknown
}

/** 文件直传通道：浏览器取二进制，经本地鉴权 HTTP 交给 relay 落盘 */
interface FileTransferDomain {
  download: (args: {
    url: string
    retries?: number
    retryDelayMs?: number
    requestId?: string
    deadlineAt?: string | null
    context?: CommandExecutionContext
  }) => Promise<unknown>
}

interface MediaDomain {
  list: (
    tabId: number,
    frameSelector: FrameSelector,
    options: {
      resolve?: boolean
      selector?: string | null
      includeBackground?: boolean
    },
    context?: CommandExecutionContext,
  ) => Promise<unknown>
}

interface TracingDomain {
  start: (tabId: TabInput) => Promise<unknown>
  status: (tabId: TabInput) => Promise<unknown>
  stop: (tabId: TabInput) => Promise<unknown>
}

interface VideoDomain {
  start: (tabId: TabInput, maxDurationMs?: number) => Promise<unknown>
  status: (tabId: TabInput) => Promise<unknown>
  stop: (tabId: TabInput) => Promise<unknown>
  chapter: (
    tabId: TabInput,
    title: string,
    description?: string,
    durationMs?: number,
  ) => Promise<unknown>
  showActions: (
    tabId: TabInput,
    options: { durationMs: number; position: string; highlightStyle?: string },
  ) => Promise<unknown>
  hideActions: (tabId: TabInput) => Promise<unknown>
  handleAction: (
    command: string,
    tabId: number,
    frameSelector: FrameSelector,
    selector: string,
    ok: boolean,
  ) => Promise<void>
}

interface WebMcpDomain {
  list: (
    tabId: TabInput,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
  call: (
    tabId: TabInput,
    frameSelector: FrameSelector,
    name: string,
    args: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<unknown>
}

interface CommandRouterDependencies {
  state: ExtensionState
  extensionControl: ExtensionControlDomain
  pageInput: PageInputDomain
  pageObserve: PageObserveDomain
  session: SessionDomain
  network: NetworkDomain
  downloads: DownloadsDomain
  fileTransfer: FileTransferDomain
  mediaDomain: MediaDomain
  initScripts: InitScriptDomain
  tracing: TracingDomain
  video: VideoDomain
  webmcp: WebMcpDomain
  listTabs: () => Promise<TabSummary[]>
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
}

export function createCommandRouter({
  state,
  extensionControl,
  pageInput,
  pageObserve,
  session,
  network,
  downloads,
  fileTransfer,
  mediaDomain,
  initScripts,
  tracing,
  video,
  webmcp,
  listTabs,
  getTargetTab,
  sendDebuggerCommand,
}: CommandRouterDependencies) {
  // 同一 tab 的 chrome.debugger.sendCommand 互斥，多 CLI 并发时必须按 tab 串行执行
  const commandQueue = createCommandQueue()
  // 仅在 eval 真正开始执行后登记：队列任务会与队列脱钩，靠这份映射判断
  // 取消的到底是"运行中的 eval"（可中断页面执行）还是普通命令/尚未开始的 eval
  const runningEvalTabIds = new Map<string, number>()
  // batch 步骤执行与命令元数据构建各自独立成模块：依赖在这里注入，
  // 避免子模块反向依赖路由器形成循环导入
  const { handleBatchCommand } = createBatchCommandHandler(executeCommand)
  const { buildCommandMeta, attachCommandMeta } = createCommandMetaBuilder({ state, getTargetTab })
  const { handleDiagnosticsCommand } = createDiagnosticsCommandHandler({ state, tracing, video })
  const { handleNetworkCommand } = createNetworkCommandHandler({ state, network })
  const { handleSessionCommand } = createSessionCommandHandler({ state, session })
  const { handleTabsCommand } = createTabsCommandHandler({
    state,
    extensionControl,
    listTabs,
    getTargetTab,
    commandQueue,
    cancelTrackedCommand,
    resolveCommandQueueKey,
  })

  /** 取消命令的统一入口：先脱钩队列；只有运行中的 eval 才定向中断页面侧执行。
   *  terminateExecution 是 best-effort，底层拒绝不能冒泡成 unhandled rejection */
  function cancelTrackedCommand(id: string): boolean {
    const cancelled = commandQueue.cancel(id)
    const evalTabId = runningEvalTabIds.get(id)
    if (evalTabId !== undefined) {
      void sendDebuggerCommand(evalTabId, 'Runtime.terminateExecution', {}).catch(() => {})
    }
    return cancelled
  }

  function readStringArg(args: CommandArgs, key: string, fallback = ''): string {
    const value = args[key]
    return typeof value === 'string' ? value : fallback
  }

  function readOptionalStringArg(args: CommandArgs, key: string): string | undefined {
    const value = args[key]
    return typeof value === 'string' ? value : undefined
  }

  function readNumberArg(args: CommandArgs, key: string, fallback = 0): number {
    const value = args[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  function readOptionalNumberArg(args: CommandArgs, key: string): number | undefined {
    const value = args[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  function readBooleanArg(args: CommandArgs, key: string, fallback = false): boolean {
    const value = args[key]
    return typeof value === 'boolean' ? value : fallback
  }

  function readStringArrayArg(args: CommandArgs, key: string): string[] {
    const value = args[key]
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  }

  function readTabInputArg(args: CommandArgs, key: string): TabInput {
    const value = args[key]
    return typeof value === 'number' || typeof value === 'string' || value == null
      ? value
      : undefined
  }

  function readFrameSelectorArg(args: CommandArgs, key: string): FrameSelector {
    const value = readOptionalStringArg(args, key)
    return value && value.trim() ? value.trim() : null
  }

  function readObjectArg(args: CommandArgs, key: string): Record<string, unknown> | undefined {
    const value = args[key]
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  }

  /** validateCommandArgs 已保证 fields 结构合法，这里只做防御性读取 */
  function readFillFormFields(args: CommandArgs): Array<{ selector: string; value: string }> {
    const raw = args.fields
    if (!Array.isArray(raw)) {
      return []
    }
    return raw
      .filter(isRecord)
      .map((field) => ({
        selector: typeof field.selector === 'string' ? field.selector : '',
        value: typeof field.value === 'string' ? field.value : '',
      }))
      .filter((field) => field.selector.trim().length > 0)
  }

  function readScreenshotOptions(args: CommandArgs): ScreenshotCaptureOptions {
    const format = readOptionalStringArg(args, 'format')
    const quality = readNumberArg(args, 'quality', 80)
    const element = readOptionalStringArg(args, 'element')?.trim() || undefined

    return {
      full: readBooleanArg(args, 'full', false),
      annotate: readBooleanArg(args, 'annotate', false),
      ...(element ? { element } : {}),
      ...(format ? { format } : {}),
      ...(quality ? { quality } : {}),
    }
  }

  function resolveDialogTabId(tabTarget: TabInput): number | null {
    if (typeof tabTarget === 'number') {
      return tabTarget
    }
    if (typeof tabTarget === 'string') {
      return state.targeting.tabIdsByHandle.get(tabTarget) ?? null
    }
    return state.targeting.targetTabId
  }

  /** 解析命令的有效目标 tab id：显式 tabId/handle → 数字 tabId，否则用当前 targetTabId */
  function resolveEffectiveTargetTabId(tabTarget: TabInput): number | null {
    const resolved = resolveTabInput(state, tabTarget)
    if (resolved !== null) {
      return resolved
    }
    return state.targeting.targetTabId
  }

  /** 命令串行化队列的 key：同 tab 的命令共用同一 key，无 tab 目标的命令落到 'default' */
  function resolveCommandQueueKey(tabTarget: TabInput): string {
    const tabId = resolveEffectiveTargetTabId(tabTarget)
    return typeof tabId === 'number' ? `tab:${tabId}` : 'default'
  }

  /** 执行前固定真实目标 tab id：排队等待期间 targetTabId 可能被别的命令改写，
   *  再解析就会打到别的 tab 上。取不到返回 null，交由各域沿用原解析路径报错。 */
  async function pinCommandTargetTabId(
    command: string,
    tabTarget: TabInput,
  ): Promise<number | null> {
    if (!commandSupportsTabTarget(command)) {
      return null
    }

    const resolved = resolveTabInput(state, tabTarget)
    if (typeof resolved === 'number') {
      return resolved
    }

    // 显式但无法解析的 handle：保持原样传下去，由执行阶段抛 STALE_TAB_HANDLE
    if (tabTarget != null && String(tabTarget).trim()) {
      return null
    }

    try {
      const tab = await getTargetTab(tabTarget)
      return typeof tab?.id === 'number' ? tab.id : null
    } catch {
      return null
    }
  }

  function createDialogBlockedError(dialog: DialogState): ErrorWithCode {
    const error = new Error(
      `page has an open ${dialog.type} dialog: ${dialog.message || '(no message)'}`,
    ) as ErrorWithCode
    error.code = 'MODAL_OPEN'
    error.suggestedAction =
      "Handle the dialog first: run 'dialog accept' to accept it, 'dialog dismiss' to dismiss it, or run 'dialog status' to inspect it."
    error.details = {
      type: dialog.type,
      message: dialog.message,
      defaultPrompt: dialog.defaultPrompt,
    }
    return error
  }

  async function assertNoOpenDialog(command: string, tabTarget: TabInput): Promise<void> {
    if (!DIALOG_BLOCKED_COMMANDS.has(command)) {
      return
    }

    let tabId = resolveDialogTabId(tabTarget)
    if (tabId === null && (tabTarget == null || typeof tabTarget === 'string')) {
      // 未显式指定目标或只给了 handle 时，按实际解析出的目标 tab 再查一次，
      // 覆盖"活动 tab 有未处理对话框但 targetTabId 未记录"的情况
      const tab = await getTargetTab(tabTarget)
      tabId = typeof tab?.id === 'number' ? tab.id : null
    }

    if (tabId !== null) {
      const dialog = state.session.dialogs.get(tabId)
      if (dialog) {
        throw createDialogBlockedError(dialog)
      }
    }
  }

  async function createWindow() {
    const window = await windowsCreate({
      url: 'about:blank',
      focused: true,
    })
    const tabId = window?.tabs?.[0]?.id
    if (typeof tabId === 'number') {
      // 新窗口的第一个 tab 成为新的命令目标，否则后续命令的目标会漂移到旧 tab
      rememberTargetTab(state, tabId)
    }
    return { windowId: window?.id ?? null, tabId: tabId ?? null }
  }

  const VALID_FIND_ACTIONS = [
    'locate',
    'click',
    'fill',
    'type',
    'hover',
    'focus',
    'check',
    'uncheck',
    'text',
  ] as const

  async function handleFindCommand(
    tabId: TabInput,
    args: CommandArgs,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const action = readStringArg(args, 'action', 'locate').trim()
    // 提前校验 action，避免执行耗时的语义搜索后才发现参数非法。
    if (!VALID_FIND_ACTIONS.includes(action as (typeof VALID_FIND_ACTIONS)[number])) {
      const err = new Error(`unsupported find action: ${action}`) as any
      err.code = 'INVALID_ACTION'
      err.suggestedAction = `Supported actions are: ${VALID_FIND_ACTIONS.join(', ')}.`
      throw err
    }
    const actionValue = readStringArg(args, 'value')
    const position = readStringArg(args, 'position').trim()
    const candidatesCount = Math.floor(readNumberArg(args, 'candidates', 0))
    const findOptions: FindSemanticTargetOptions = {
      strategy: readStringArg(args, 'strategy').trim(),
      role: readStringArg(args, 'role').trim(),
      query: readStringArg(args, 'query').trim(),
      name: readStringArg(args, 'name').trim(),
      exact: args.exact === true,
      requireUnique: action !== 'locate' && action !== 'text' && !position,
      ...(position ? { position } : {}),
      ...(candidatesCount > 0 ? { candidates: candidatesCount } : {}),
    }
    const result = await pageObserve.findSemanticTarget(tabId, findOptions, frameSelector)
    // 语义搜索可能耗时较久，取消后不再执行后续动作
    context?.throwIfCancelled()
    // 候选模式只返回候选列表，不执行动作（参数校验已保证 candidates 只搭配 locate）
    if (findOptions.candidates && Array.isArray(result.candidates)) {
      return result
    }
    const ref = result.match?.ref
    if (!ref) {
      const err = new Error(result.reason || 'semantic target ref missing') as any
      err.code = 'NOT_FOUND'
      err.suggestedAction =
        'Check if the target element exists in the current viewport. Re-run `snapshot` to analyze the page state.'
      if (result.candidates && Array.isArray(result.candidates) && result.candidates.length > 0) {
        err.suggestedAction += ` Additionally, found other potential candidates:\n${JSON.stringify(result.candidates, null, 2)}`
      }
      throw err
    }

    if (action === 'locate') {
      return result
    }

    if (action === 'click') {
      return {
        ...result,
        action,
        result: await pageInput.clickSelector(tabId, ref, frameSelector, undefined, context),
      }
    }

    if (action === 'fill') {
      return {
        ...result,
        action,
        result: await pageInput.fillSelector(tabId, ref, actionValue, frameSelector, context),
      }
    }

    if (action === 'type') {
      return {
        ...result,
        action,
        result: await pageInput.typeIntoSelector(
          tabId,
          ref,
          actionValue,
          frameSelector,
          undefined,
          context,
        ),
      }
    }

    if (action === 'hover') {
      return {
        ...result,
        action,
        result: await pageInput.hoverElement(tabId, ref, frameSelector, context),
      }
    }

    if (action === 'focus') {
      return {
        ...result,
        action,
        result: await pageInput.focusElement(tabId, ref, frameSelector, context),
      }
    }

    if (action === 'check') {
      return {
        ...result,
        action,
        result: await pageInput.checkElement(tabId, ref, true, frameSelector),
      }
    }

    if (action === 'uncheck') {
      return {
        ...result,
        action,
        result: await pageInput.checkElement(tabId, ref, false, frameSelector),
      }
    }

    if (action === 'text') {
      const textResult = await pageInput.getAttribute(tabId, ref, 'text', frameSelector)
      return {
        ...result,
        action,
        result: {
          found: true,
          value: textResult.value,
        },
      }
    }

    throw new Error(`unsupported find action: ${action}`)
  }

  async function handleWait(tabId: TabInput, args: CommandArgs, frameSelector: FrameSelector) {
    const timeout = readNumberArg(args, 'timeout', 30000)
    const waitType = readStringArg(args, 'type')
    const waitMs = readNumberArg(args, 'ms', 0)
    const waitSelector = readStringArg(args, 'selector')
    const waitState = readStringArg(args, 'state', 'visible')
    const waitUrl = readStringArg(args, 'url')
    const waitText = readStringArg(args, 'text')
    const waitFn = readStringArg(args, 'fn')
    const waitGone = readBooleanArg(args, 'gone', false)

    // --gone 只定义在文本等待上（对齐 Playwright textGone），其它等待类型给了就报明确错误
    if (waitGone && waitType !== 'text' && !waitText) {
      throw new Error('wait --gone requires --text <text>')
    }

    if (waitType === 'time' || waitMs > 0) {
      // time 等待必须显式给时长；缺省时兜底成整个 timeout（默认 30s）会让调用方傻等
      if (waitMs <= 0) {
        throw new Error('wait type "time" requires a positive ms duration (pass --ms <ms>)')
      }
      return await pageObserve.waitWithTimeout(tabId, waitMs)
    }

    if (waitType === 'selector' || waitSelector) {
      return await pageObserve.waitForSelectorState(
        tabId,
        waitSelector,
        waitState,
        timeout,
        frameSelector,
      )
    }

    if (waitType === 'url' || waitUrl) {
      return await pageObserve.waitForUrl(tabId, waitUrl, timeout, frameSelector)
    }

    if (waitType === 'text' || waitText) {
      return await pageObserve.waitForText(tabId, waitText, timeout, frameSelector, waitGone)
    }

    if (waitType === 'load') {
      return await pageObserve.waitForLoadEvent(tabId, timeout)
    }

    if (waitType === 'networkidle') {
      return await pageObserve.waitForNetworkIdle(tabId, timeout)
    }

    if (waitType === 'fn' || waitFn) {
      return await pageObserve.waitForExpression(tabId, waitFn, timeout, frameSelector)
    }

    throw new Error(`unsupported wait type: ${waitType}`)
  }

  async function closeTabs(tabId: TabInput, closeAll: boolean) {
    if (closeAll) {
      const tabs = await tabsQuery({
        currentWindow: true,
      })
      const tabIds = tabs.map((tab) => tab.id).filter((candidate) => typeof candidate === 'number')
      if (tabIds.length > 0) {
        await tabsRemove(tabIds)
      }
      return { closed: true, all: true, count: tabIds.length }
    }

    const tab = await getTargetTab(tabId)
    await tabsRemove([tab.id])
    return { closed: true, all: false, tabId: tab.id }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  }

  const CONTROL_COMMANDS = new Set([
    'extension',
    'status',
    'tab.list',
    'tab.select',
    'tab.new',
    'tab.close',
    'target',
    'command',
  ])
  const AUTO_SNAPSHOT_COMMANDS = new Set([
    'goto',
    'open',
    'back',
    'forward',
    'reload',
    'click',
    'dblclick',
    'fill',
    'fillform',
    'type',
    'press',
    'keyboard',
    'check',
    'uncheck',
    'select',
    'drag',
    'drop',
    'mousemove',
    'mousedown',
    'mouseup',
    'mousewheel',
    'upload',
  ])

  function recordAction(
    command: string,
    request: { id?: string } | undefined,
    tabId: number | null,
    frame: string | null,
    selector: string,
    startedAt: number,
    ok: boolean,
    error: unknown,
  ): void {
    if (tabId !== null) void video.handleAction(command, tabId, frame, selector, ok).catch(() => {})
    state.session.actionLog.push({
      id: request?.id || null,
      command,
      tabId,
      frame,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ok,
      error: ok
        ? null
        : typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'Command failed',
    })
    if (state.session.actionLog.length > 500)
      state.session.actionLog.splice(0, state.session.actionLog.length - 500)
  }

  async function executeCommand(
    command: string,
    args: CommandArgs = {},
    skipQueue = false,
    request?: { id?: string; deadlineAt?: string },
    context?: CommandExecutionContext,
  ) {
    context?.throwIfCancelled()
    validateCommandArgs(command, args)

    const requestedTabId = readTabInputArg(args, 'tabId')
    const handle = readTabInputArg(args, 'handle')
    const explicitTabTarget = handle || requestedTabId
    const frameSelector = readFrameSelectorArg(args, 'frame')
    const action = readStringArg(args, 'action')
    const url = readStringArg(args, 'url', 'about:blank')
    const script = readStringArg(args, 'script', 'document.title')
    const selector = readStringArg(args, 'selector')
    const snapshotRoles = readStringArrayArg(args, 'roles')
    const snapshotChanged = readBooleanArg(args, 'changed', false)
    const value = readStringArg(args, 'value')
    const key = readStringArg(args, 'key')
    const text = readStringArg(args, 'text')
    const start = readStringArg(args, 'start')
    const end = readStringArg(args, 'end')
    const stateName = readStringArg(args, 'state', 'visible')
    const attr = readStringArg(args, 'attr', 'text')
    const files = readStringArrayArg(args, 'files')
    const scrollSelector = selector || null
    const deltaX = readNumberArg(args, 'deltaX', 0)
    const deltaY = readNumberArg(args, 'deltaY', 100)
    const requestId = readStringArg(args, 'requestId')
    const subaction = readStringArg(args, 'subaction')
    const screenshotOptions = readScreenshotOptions(args)
    const feedSelector = readOptionalStringArg(args, 'selector')
    const feedLimit = readNumberArg(args, 'limit', 30)
    const feedDedupe = readStringArg(args, 'dedupe', 'url')
    const feedMaxScrolls = readNumberArg(args, 'maxScrolls', 20)
    const feedPauseMs = readNumberArg(args, 'pauseMs', 900)
    const feedStallRounds = readNumberArg(args, 'stallRounds', 3)
    const searchQuery = readStringArg(args, 'query')
    const searchContext = readNumberArg(args, 'context', 3)
    const searchLimit = readNumberArg(args, 'limit', 20)
    const pageIdx = readNumberArg(args, 'pageIdx', 0)
    const pageSize = readNumberArg(args, 'pageSize', DEFAULT_PAGE_SIZE)

    // fallback note 与查询口径都要用固定之前的目标，取值时机不能晚于 pinCommandTargetTabId
    const targetTabIdBeforeCommand = state.targeting.targetTabId
    const queryTargetTabId = resolveEffectiveTargetTabId(explicitTabTarget)
    const networkControl =
      command === 'network' && action === 'har' && ['stop', 'status', 'recover'].includes(subaction)
    // 每次执行前固定目标：batch 子步骤在自己的队列槽内就地执行，
    // 按步骤固定才能让 tab.select/tab.new 之后的步骤走新的 target；控制命令会改写 target，不固定
    const pinnedTabId =
      CONTROL_COMMANDS.has(command) || networkControl
        ? null
        : await pinCommandTargetTabId(command, explicitTabTarget)
    const tabId: TabInput = typeof pinnedTabId === 'number' ? pinnedTabId : explicitTabTarget

    await assertNoOpenDialog(command, tabId)

    async function runCommand(executionFrame: FrameSelector): Promise<unknown> {
      context?.throwIfCancelled()
      // 排队期间可能新弹出对话框，入队前那次检查不够，执行前要针对固定后的 tab 再查一次
      await assertNoOpenDialog(command, tabId)
      const scope: CommandRunScope = {
        command,
        args,
        action,
        subaction,
        url,
        requestId,
        tabId,
        explicitTabTarget,
        frameSelector,
        queryTargetTabId,
        pageIdx,
        pageSize,
      }
      switch (command) {
        case 'extension':
        case 'status':
          return await handleTabsCommand(scope)
        case 'actions':
        case 'tracing':
        case 'video':
          return await handleDiagnosticsCommand(scope)
        case 'webmcp':
          if (action === 'list') return await webmcp.list(tabId, frameSelector, context)
          if (action === 'call') {
            return await webmcp.call(
              tabId,
              frameSelector,
              readStringArg(args, 'name'),
              readObjectArg(args, 'args') || {},
              context,
            )
          }
          throw new Error(`unsupported webmcp action: ${action}`)
        case 'tab.list':
        case 'tab.select':
        case 'tab.new':
        case 'tab.close':
        case 'target':
        case 'command':
          return await handleTabsCommand(scope)
        case 'goto':
        case 'open': {
          const navigationResult = await pageInput.navigateTo(tabId, url, {
            timeoutMs: readNumberArg(args, 'timeoutMs', 10000),
            wait: readBooleanArg(args, 'wait', true),
            waitUntil: readStringArg(args, 'waitUntil', 'domquiet'),
            settleTimeoutMs: readOptionalNumberArg(args, 'settleTimeoutMs'),
            domQuietMs: readOptionalNumberArg(args, 'domQuietMs'),
          })
          const waitFor = readOptionalStringArg(args, 'waitFor')
          if (!waitFor) return navigationResult
          // url is the navigation destination; waitUrl is its URL condition.
          // reload retains the historical url condition field because it has no destination.
          const value = readStringArg(args, waitFor === 'url' ? 'waitUrl' : 'selector')
          const waitArgs = {
            type: waitFor,
            timeout: readNumberArg(args, 'timeoutMs', 30000),
            ...(waitFor === 'url' ? { url: value } : { selector: value, state: 'visible' }),
          }
          try {
            const wait = await handleWait(tabId, waitArgs, frameSelector)
            return {
              ...(navigationResult as Record<string, unknown>),
              wait: { ...(wait as Record<string, unknown>), type: waitFor, value, completed: true },
            }
          } catch (error) {
            const failure =
              error instanceof Error
                ? (error as ErrorWithCode)
                : (new Error(String(error)) as ErrorWithCode)
            failure.details = {
              ...(isRecord(failure.details) ? failure.details : {}),
              result: {
                ...(navigationResult as Record<string, unknown>),
                navigationResult,
                wait: { type: waitFor, value, completed: false },
              },
            }
            throw failure
          }
        }
        case 'eval':
          return await pageInput.evaluateScript(
            tabId,
            script,
            frameSelector,
            readOptionalNumberArg(args, 'timeoutMs'),
            readOptionalStringArg(args, 'element'),
            readOptionalNumberArg(args, 'maxResultBytes'),
          )
        case 'locator':
          return await pageInput.generateLocator(tabId, selector, frameSelector)
        case 'highlight':
          return await pageInput.highlightElement(
            tabId,
            readOptionalStringArg(args, 'selector'),
            readOptionalStringArg(args, 'style'),
            readBooleanArg(args, 'hide'),
            frameSelector,
          )
        case 'cdp': {
          const tab = await getTargetTab(tabId)
          const method = readStringArg(args, 'method')
          const result = await sendDebuggerCommand(
            tab.id,
            method,
            (args.params || {}) as Record<string, unknown>,
            context,
          )
          return { method, result }
        }
        case 'snapshot':
          return await pageObserve.snapshotTab(tabId, frameSelector, {
            selector: selector.trim() || undefined,
            ...(snapshotRoles.length > 0 ? { roles: snapshotRoles } : {}),
            ...(snapshotChanged ? { changed: true } : {}),
          })
        case 'feed':
          return await pageObserve.collectFeed(
            tabId,
            {
              selector: feedSelector?.trim() || 'article',
              limit: feedLimit,
              dedupe: feedDedupe as CollectFeedOptions['dedupe'],
              maxScrolls: feedMaxScrolls,
              pauseMs: feedPauseMs,
              stallRounds: feedStallRounds,
            },
            frameSelector,
          )
        case 'search':
          return await pageObserve.searchPageText(
            tabId,
            {
              query: searchQuery,
              context: searchContext,
              limit: searchLimit,
              ...(args.startLine !== undefined
                ? { startLine: readNumberArg(args, 'startLine', 1) }
                : {}),
            },
            frameSelector,
          )
        case 'screenshot':
          return await pageObserve.captureScreenshot(tabId, screenshotOptions, frameSelector)
        case 'click':
          return await pageInput.clickSelector(
            tabId,
            selector,
            frameSelector,
            readNumberArg(args, 'timeoutMs', 10000),
            context,
          )
        case 'dblclick':
          return await pageInput.doubleClickSelector(tabId, selector, frameSelector, context)
        case 'fill':
          return await pageInput.fillSelector(tabId, selector, value, frameSelector, context)
        case 'fillform':
          return await pageInput.fillFields(tabId, readFillFormFields(args), frameSelector, context)
        case 'find':
          return await handleFindCommand(tabId, args, frameSelector, context)
        case 'type':
          return await pageInput.typeIntoSelector(
            tabId,
            selector,
            value,
            frameSelector,
            readBooleanArg(args, 'submit', false),
            context,
          )
        case 'hover':
          return await pageInput.hoverElement(tabId, selector, frameSelector, context)
        case 'press':
          return await pageInput.pressKey(tabId, key, context)
        case 'keyboard':
          if (action === 'type') {
            return await pageInput.insertTextSequentially(tabId, text, context)
          }
          if (action === 'inserttext') {
            return await pageInput.insertTextOnce(tabId, text, context)
          }
          if (action === 'keydown') {
            return await pageInput.keyDownOnly(tabId, text, context)
          }
          if (action === 'keyup') {
            return await pageInput.keyUpOnly(tabId, text, context)
          }
          throw new Error(`unsupported keyboard action: ${action}`)
        case 'focus':
          return await pageInput.focusElement(tabId, selector, frameSelector, context)
        case 'select':
          return await pageInput.selectOption(tabId, selector, value, frameSelector)
        case 'check':
          return await pageInput.checkElement(tabId, selector, true, frameSelector)
        case 'uncheck':
          return await pageInput.checkElement(tabId, selector, false, frameSelector)
        case 'scroll':
          return await pageInput.scrollElement(
            tabId,
            scrollSelector,
            deltaX,
            deltaY,
            frameSelector,
            context,
          )
        case 'scrollintoview':
          return await pageInput.scrollIntoViewSelector(tabId, selector, frameSelector, context)
        case 'drag':
          return await pageInput.dragElement(tabId, start, end, frameSelector, context)
        case 'drop':
          return await pageInput.dropData(
            tabId,
            selector,
            (args.data || {}) as Record<string, string>,
            (args.files || []) as Array<{ name: string; mimeType: string; dataBase64: string }>,
            frameSelector,
            context,
          )
        case 'mousemove':
          return await pageInput.mouseMove(
            tabId,
            readNumberArg(args, 'x'),
            readNumberArg(args, 'y'),
            context,
          )
        case 'mousedown':
          return await pageInput.mouseButton(
            tabId,
            true,
            readStringArg(args, 'button', 'left'),
            context,
          )
        case 'mouseup':
          return await pageInput.mouseButton(
            tabId,
            false,
            readStringArg(args, 'button', 'left'),
            context,
          )
        case 'mousewheel':
          return await pageInput.mouseWheel(
            tabId,
            readNumberArg(args, 'deltaX'),
            readNumberArg(args, 'deltaY'),
            context,
          )
        case 'upload':
          return await pageInput.uploadFiles(tabId, selector, files, frameSelector, context)
        case 'back':
          return await pageInput.navigateBack(tabId)
        case 'forward':
          return await pageInput.navigateForward(tabId)
        case 'reload': {
          const reloadResult = await pageInput.reloadPage(tabId, {
            timeoutMs: readOptionalNumberArg(args, 'timeoutMs'),
            waitUntil: readOptionalStringArg(args, 'waitUntil'),
          })
          const waitFor = readOptionalStringArg(args, 'waitFor')
          const timeout = readNumberArg(args, 'timeoutMs', 30000)
          if (waitFor === 'url') {
            return {
              ...(reloadResult as Record<string, unknown>),
              wait: await pageObserve.waitForUrl(
                tabId,
                readStringArg(args, 'url'),
                timeout,
                frameSelector,
              ),
            }
          }
          if (waitFor === 'selector') {
            return {
              ...(reloadResult as Record<string, unknown>),
              wait: await pageObserve.waitForSelectorState(
                tabId,
                readStringArg(args, 'selector'),
                'visible',
                timeout,
                frameSelector,
              ),
            }
          }
          if (waitFor) {
            throw new Error('reload waitFor must be url or selector')
          }
          return reloadResult
        }
        case 'close':
          return await closeTabs(tabId, readBooleanArg(args, 'all', false))
        case 'window':
          if (action === 'new') {
            return await createWindow()
          }
          throw new Error(`unsupported window action: ${action}`)
        case 'frame':
          return await pageInput.switchToFrame(tabId, selector)
        case 'is':
          return await pageInput.checkIsState(tabId, selector, stateName, frameSelector)
        case 'get':
          return await pageInput.getAttribute(tabId, selector, attr, frameSelector)
        case 'dialog':
          return await handleSessionCommand(scope)
        case 'downloads':
          if (action === 'clear') {
            return downloads.clearDownloads()
          }
          // list 是默认 subaction，复用 console/errors 的分页参数
          return downloads.listDownloads(pageIdx, pageSize)
        case 'download':
          // 落盘路径由 relay 决定，扩展只负责取字节并直传
          return await fileTransfer.download({
            url,
            retries: readOptionalNumberArg(args, 'retries'),
            retryDelayMs: readOptionalNumberArg(args, 'retryDelayMs'),
            ...(typeof request?.id === 'string' ? { requestId: request.id } : {}),
            ...(typeof request?.deadlineAt === 'string' ? { deadlineAt: request.deadlineAt } : {}),
            context,
          })
        case 'media': {
          if (typeof tabId !== 'number') throw new Error('media list requires a resolved tab')
          const waitFor = readOptionalStringArg(args, 'waitFor')
          const wait = waitFor
            ? {
                selector: waitFor,
                completed: true,
                result: await handleWait(
                  tabId,
                  {
                    type: 'selector',
                    selector: waitFor,
                    state: 'visible',
                    timeout: readNumberArg(args, 'timeoutMs', 30000),
                  },
                  executionFrame,
                ),
              }
            : undefined
          const mediaEpoch = readOptionalNumberArg(args, 'mediaEpoch')
          if (mediaEpoch !== undefined && mediaEpoch !== getPageEpoch(state, tabId)) {
            throw Object.assign(new Error('media epoch changed; collect again'), {
              code: 'STALE_MEDIA_STATE',
            })
          }
          const result = await mediaDomain.list(
            tabId,
            executionFrame,
            {
              resolve: readBooleanArg(args, 'resolve', false),
              selector: readOptionalStringArg(args, 'selector') ?? null,
              includeBackground: readBooleanArg(args, 'includeBackground', false),
            },
            context,
          )
          return { ...(result as Record<string, unknown>), ...(wait ? { wait } : {}) }
        }
        case 'wait':
          return await handleWait(tabId, args, frameSelector)
        case 'cookies':
        case 'storage':
          return await handleSessionCommand(scope)
        case 'console':
        case 'errors':
          return await handleDiagnosticsCommand(scope)
        case 'batch':
          return await handleBatchCommand(args, context)
        case 'script':
          if (action === 'add') {
            return await initScripts.addScript(readStringArg(args, 'source'))
          }
          if (action === 'list') {
            return initScripts.listScripts()
          }
          if (action === 'remove') {
            if (readBooleanArg(args, 'all', false)) {
              return await initScripts.removeAllScripts()
            }
            const scriptId = readStringArg(args, 'id')
            if (!scriptId) {
              throw new Error('script remove requires an id or --all')
            }
            return await initScripts.removeScript(scriptId)
          }
          throw new Error(`unsupported script action: ${action}`)
        case 'network':
          return await handleNetworkCommand(scope)
        case 'set':
        case 'pdf':
        case 'clipboard':
        case 'state':
          return await handleSessionCommand(scope)
        default:
          throw new Error(`unsupported command: ${command}`)
      }
    }

    async function runWithMeta() {
      // 在真正开始执行时捕获，而不是入队时捕获；前面的 frame 命令可能尚未执行。
      // top 是显式哨兵，避免 meta 查询 tab 的 await 后重新读取 selectedFrames。
      const executionFrame =
        pinnedTabId === null
          ? frameSelector
          : resolveEffectiveFrameSelector(state, { id: pinnedTabId }, frameSelector) || 'top'
      let result = await runCommand(executionFrame)
      if (state.session.autoSnapshot && AUTO_SNAPSHOT_COMMANDS.has(command) && isRecord(result)) {
        const actionResult = result
        try {
          result = {
            ...actionResult,
            snapshot: await pageObserve.snapshotTab(tabId, executionFrame, {}),
          }
        } catch (error) {
          result = {
            ...actionResult,
            snapshotError: error instanceof Error ? error.message : String(error),
          }
        }
      }
      // frame 命令回显切换后的 frame；普通页面命令回显开始执行时的 frame。
      const metaFrame =
        command === 'frame' && pinnedTabId !== null
          ? resolveEffectiveFrameSelector(state, { id: pinnedTabId }, null) || 'top'
          : executionFrame
      const meta = await buildCommandMeta(command, args, tabId, metaFrame, {
        pinnedTabId,
        targetTabIdBeforeCommand,
      })
      return attachCommandMeta(result, meta)
    }

    // metadata 也在队列槽内完成，不能让后继 frame 切换污染前一命令的响应。
    // batch 子步骤（skipQueue）在 batch 自己的队列槽内执行，重入队列会死锁。
    const runsInQueue = !skipQueue && !CONTROL_COMMANDS.has(command) && !networkControl
    const actionStartedAt = Date.now()
    try {
      const result = runsInQueue
        ? await commandQueue.enqueue(
            command === 'download'
              ? // 后台 fetch 不占用 tab 的 CDP；每个文件独立队列，HLS 分片才能真正并行。
                `download:${request?.id || crypto.randomUUID()}`
              : resolveCommandQueueKey(tabId),
            async (queueContext) => {
              context = queueContext
              // eval 只在此刻（真正开始执行）才可中断；使用 pin 后的真实数字 tabId，
              // 避免排队期间 target 漂移导致 terminate 打到别的 tab
              const evalTabId = command === 'eval' ? pinnedTabId : null
              const trackedEvalId =
                evalTabId !== null && typeof request?.id === 'string' ? request.id : null
              if (trackedEvalId !== null && evalTabId !== null) {
                runningEvalTabIds.set(trackedEvalId, evalTabId)
              }
              try {
                return await runWithMeta()
              } finally {
                if (trackedEvalId !== null) runningEvalTabIds.delete(trackedEvalId)
              }
            },
            {
              ...request,
              deadlineAt:
                request?.deadlineAt ??
                new Date(Date.now() + getCommandRequestBudgetMs(command, args)).toISOString(),
            },
          )
        : await runWithMeta()
      recordAction(
        command,
        request,
        queryTargetTabId,
        frameSelector || null,
        selector,
        actionStartedAt,
        true,
        null,
      )
      return result
    } catch (error) {
      recordAction(
        command,
        request,
        queryTargetTabId,
        frameSelector || null,
        selector,
        actionStartedAt,
        false,
        error,
      )
      throw error
    }
  }

  async function handleCommand(message: CommandMessage) {
    return await executeCommand(String(message.command || ''), message.args || {}, false, {
      ...(typeof message.id === 'string' ? { id: message.id } : {}),
      ...(typeof message.deadlineAt === 'string' ? { deadlineAt: message.deadlineAt } : {}),
    })
  }

  function cancelCommand(id: string): boolean {
    return cancelTrackedCommand(id)
  }

  return {
    handleCommand,
    cancelCommand,
  }
}
