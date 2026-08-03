import {
  tabsCreate,
  tabsQuery,
  tabsRemove,
  tabsUpdate,
  windowsCreate,
  windowsUpdate,
} from './chrome.js'
import {
  getOrCreateTabHandle,
  getPageEpoch,
  rememberTargetTab,
  resolveEffectiveFrameSelector,
  resolveTabInput,
  toTabSummary,
} from './targeting.js'
import { serializeCommandError, type SerializedCommandError } from './errors.js'
import { createCommandQueue } from './command-queue.js'
import { DEFAULT_PAGE_SIZE, paginateList } from './pagination.js'
import { commandSupportsTabTarget, validateCommandArgs } from '../../src/core/command-spec.js'
import type {
  CommandArgs,
  CommandMessage,
  CommandMeta,
  ConsoleMessageRecord,
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
  'hover',
  'press',
  'keyboard',
  'focus',
  'select',
  'check',
  'uncheck',
  'scroll',
  'scrollintoview',
  'drag',
  'upload',
  'back',
  'forward',
  'reload',
  'frame',
  'is',
  'get',
  'wait',
])

interface PageInputDomain {
  navigateTo: (
    tabId: TabInput,
    url: string,
    options?: { timeoutMs?: number; wait?: boolean },
  ) => Promise<unknown>
  evaluateScript: (
    tabId: TabInput,
    script: string,
    frameSelector: FrameSelector,
    timeoutMs?: number,
  ) => Promise<unknown>
  clickSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    timeoutMs?: number,
  ) => Promise<unknown>
  doubleClickSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  fillSelector: (
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  fillFields: (
    tabId: TabInput,
    fields: Array<{ selector: string; value: string }>,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  typeIntoSelector: (
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
    submit?: boolean,
  ) => Promise<unknown>
  hoverElement: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  pressKey: (tabId: TabInput, key: string) => Promise<unknown>
  insertTextSequentially: (tabId: TabInput, text: string) => Promise<unknown>
  insertTextOnce: (tabId: TabInput, text: string) => Promise<unknown>
  keyDownOnly: (tabId: TabInput, key: string) => Promise<unknown>
  keyUpOnly: (tabId: TabInput, key: string) => Promise<unknown>
  focusElement: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
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
  ) => Promise<unknown>
  scrollIntoViewSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  dragElement: (
    tabId: TabInput,
    startSelector: string,
    endSelector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  uploadFiles: (
    tabId: TabInput,
    selector: string,
    filePaths: string[],
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  navigateBack: (tabId: TabInput) => Promise<unknown>
  navigateForward: (tabId: TabInput) => Promise<unknown>
  reloadPage: (tabId: TabInput) => Promise<unknown>
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
  getRequestDetail: (requestId: string) => unknown
  startHar: (
    tabId: TabInput,
    options?: { maxRequests?: number | null; maxBodyBytes?: number | null },
  ) => Promise<unknown>
  stopHar: () => Promise<unknown>
}

interface InitScriptDomain {
  addScript: (source: string) => Promise<unknown>
  listScripts: () => unknown
  removeScript: (id: string) => Promise<unknown>
  removeAllScripts: () => Promise<unknown>
}

interface CommandRouterDependencies {
  state: ExtensionState
  pageInput: PageInputDomain
  pageObserve: PageObserveDomain
  session: SessionDomain
  network: NetworkDomain
  initScripts: InitScriptDomain
  listTabs: () => Promise<TabSummary[]>
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
}

export function createCommandRouter({
  state,
  pageInput,
  pageObserve,
  session,
  network,
  initScripts,
  listTabs,
  getTargetTab,
}: CommandRouterDependencies) {
  // 同一 tab 的 chrome.debugger.sendCommand 互斥，多 CLI 并发时必须按 tab 串行执行
  const commandQueue = createCommandQueue()

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

  function readSavedStateArg(args: CommandArgs, key: string): SavedStateData | undefined {
    const value = args[key]
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as SavedStateData)
      : undefined
  }

  function readHeadersArg(
    args: CommandArgs,
    key: string,
  ): Array<{ name?: string; value?: unknown }> | Record<string, unknown> | undefined {
    const value = args[key]
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is { name?: string; value?: unknown } =>
          Boolean(item) && typeof item === 'object',
      )
    }

    return readObjectArg(args, key)
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
    return { windowId: window?.id ?? null, tabId: window?.tabs?.[0]?.id ?? null }
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
      ...(position ? { position } : {}),
      ...(candidatesCount > 0 ? { candidates: candidatesCount } : {}),
    }
    const result = await pageObserve.findSemanticTarget(tabId, findOptions, frameSelector)
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
      return { ...result, action, result: await pageInput.clickSelector(tabId, ref, frameSelector) }
    }

    if (action === 'fill') {
      return {
        ...result,
        action,
        result: await pageInput.fillSelector(tabId, ref, actionValue, frameSelector),
      }
    }

    if (action === 'type') {
      return {
        ...result,
        action,
        result: await pageInput.typeIntoSelector(tabId, ref, actionValue, frameSelector),
      }
    }

    if (action === 'hover') {
      return { ...result, action, result: await pageInput.hoverElement(tabId, ref, frameSelector) }
    }

    if (action === 'focus') {
      return { ...result, action, result: await pageInput.focusElement(tabId, ref, frameSelector) }
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

  async function selectTab(tabHandle: TabInput) {
    const tab = await getTargetTab(tabHandle)
    const updatedTab = await tabsUpdate(tab.id, {
      active: true,
    })

    rememberTargetTab(state, tab.id)

    if (typeof updatedTab?.windowId === 'number') {
      try {
        await windowsUpdate(updatedTab.windowId, {
          focused: true,
        })
      } catch {
        // Best effort only.
      }
    }

    return {
      selected: true,
      tab: toTabSummary(state, updatedTab || tab),
    }
  }

  async function closeTab(tabHandle: TabInput) {
    const tab = await getTargetTab(tabHandle)
    const handle = getOrCreateTabHandle(state, tab.id)
    await tabsRemove([tab.id])
    return {
      closed: true,
      tab: {
        ...toTabSummary(state, tab),
        handle,
      },
    }
  }

  interface BatchStepCondition {
    step: string | number
    path?: string
    equals?: unknown
    truthy?: boolean
    exists?: boolean
  }

  interface BatchCommandStep {
    command: string
    args: CommandArgs
    label: string | null
    id?: string | null
    when?: BatchStepCondition | null
    skipRemainingOnFailure?: boolean
  }

  interface BatchCommandStepResult {
    index: number
    command: string
    args: CommandArgs
    label: string | null
    id?: string
    skipped?: true
    reason?: string
    response?: { ok: true; result: unknown } | { ok: false; error: SerializedCommandError }
  }

  interface BatchCommandOptions {
    continueOnError: boolean
    retries: number
    retryDelayMs: number
  }

  interface BatchCommandSummary {
    total: number
    completed: number
    succeeded: number
    failed: number
    skippedCount: number
    retried: number
    continueOnError: boolean
    retries: number
    retryDelayMs: number
    terminated?: true
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  }

  type FoldedConsoleMessage = ConsoleMessageRecord & { repeatCount?: number }

  /** 连续相同（type+text）的 console 消息折叠成一条，折叠结果带 repeatCount；不改动原始数组 */
  function foldConsoleMessages(messages: ConsoleMessageRecord[]): FoldedConsoleMessage[] {
    const folded: FoldedConsoleMessage[] = []
    for (const message of messages) {
      const previous = folded[folded.length - 1]
      if (previous && previous.type === message.type && previous.text === message.text) {
        // 用最后一条的时间戳，计数累加
        folded[folded.length - 1] = { ...message, repeatCount: (previous.repeatCount ?? 1) + 1 }
      } else {
        folded.push({ ...message })
      }
    }
    return folded
  }

  function normalizeBatchStepCondition(value: unknown, index: number): BatchStepCondition {
    if (!isRecord(value)) {
      throw new Error(`invalid batch step ${index + 1}: when must be an object`)
    }

    const stepRef = value.step
    const isStringRef = typeof stepRef === 'string' && stepRef.trim().length > 0
    const isIntegerRef = typeof stepRef === 'number' && Number.isInteger(stepRef) && stepRef >= 1
    if (!isStringRef && !isIntegerRef) {
      throw new Error(
        `invalid batch step ${index + 1}: when.step must be a step id string or a positive integer`,
      )
    }

    if (value.path !== undefined && typeof value.path !== 'string') {
      throw new Error(`invalid batch step ${index + 1}: when.path must be a string`)
    }

    const declared = ['equals', 'truthy', 'exists'].filter((key) => key in value)
    if (declared.length !== 1) {
      throw new Error(
        `invalid batch step ${index + 1}: when must declare exactly one of equals, truthy, or exists`,
      )
    }

    if (value.truthy !== undefined && typeof value.truthy !== 'boolean') {
      throw new Error(`invalid batch step ${index + 1}: when.truthy must be a boolean`)
    }
    if (value.exists !== undefined && typeof value.exists !== 'boolean') {
      throw new Error(`invalid batch step ${index + 1}: when.exists must be a boolean`)
    }

    const condition: BatchStepCondition = { step: stepRef as string | number }
    if (value.path !== undefined) {
      condition.path = value.path
    }
    if (value.equals !== undefined) {
      condition.equals = value.equals
    }
    if (value.truthy !== undefined) {
      condition.truthy = value.truthy
    }
    if (value.exists !== undefined) {
      condition.exists = value.exists
    }
    return condition
  }

  function normalizeBatchCommandStep(value: unknown, index: number): BatchCommandStep {
    if (typeof value === 'string') {
      const command = value.trim()
      if (!command) {
        throw new Error(`invalid batch step ${index + 1}: empty command string`)
      }

      return {
        command,
        args: {},
        label: null,
      }
    }

    if (!isRecord(value)) {
      throw new Error(`invalid batch step ${index + 1}: expected a command string or object`)
    }

    const command = typeof value.command === 'string' ? value.command.trim() : ''
    if (!command) {
      throw new Error(`invalid batch step ${index + 1}: missing command`)
    }

    const args = value.args === undefined ? {} : value.args
    if (!isRecord(args)) {
      throw new Error(`invalid batch step ${index + 1}: args must be an object`)
    }

    const step: BatchCommandStep = {
      command,
      args,
      label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : null,
    }

    if (value.id !== undefined && value.id !== null) {
      if (typeof value.id !== 'string' || !value.id.trim()) {
        throw new Error(`invalid batch step ${index + 1}: id must be a non-empty string`)
      }
      step.id = value.id.trim()
    }

    if (value.skipRemainingOnFailure !== undefined && value.skipRemainingOnFailure !== null) {
      if (typeof value.skipRemainingOnFailure !== 'boolean') {
        throw new Error(`invalid batch step ${index + 1}: skipRemainingOnFailure must be a boolean`)
      }
      step.skipRemainingOnFailure = value.skipRemainingOnFailure
    }

    if (value.when !== undefined && value.when !== null) {
      step.when = normalizeBatchStepCondition(value.when, index)
    }

    return step
  }

  function readBatchCommandSteps(args: CommandArgs): BatchCommandStep[] {
    const rawSteps = args.steps
    if (!Array.isArray(rawSteps)) {
      throw new Error('batch steps must be a JSON array')
    }

    return rawSteps.map((value, index) => normalizeBatchCommandStep(value, index))
  }

  function readBatchCommandOptions(args: CommandArgs): BatchCommandOptions {
    return {
      continueOnError: readBooleanArg(args, 'continueOnError', false),
      retries: Math.max(0, Math.floor(readNumberArg(args, 'retries', 0))),
      retryDelayMs: Math.max(0, Math.floor(readNumberArg(args, 'retryDelayMs', 0))),
    }
  }

  async function waitForRetryDelay(ms: number): Promise<void> {
    if (ms <= 0) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  function createBatchStepResponse(result: unknown): { ok: true; result: unknown } {
    return {
      ok: true,
      result,
    }
  }

  function createBatchStepFailureResponse(error: unknown): {
    ok: false
    error: SerializedCommandError
  } {
    return {
      ok: false,
      error: serializeCommandError(error),
    }
  }

  function createBatchSummary(
    total: number,
    completed: number,
    succeeded: number,
    failed: number,
    skippedCount: number,
    retried: number,
    options: BatchCommandOptions,
    terminated = false,
  ): BatchCommandSummary {
    return {
      total,
      completed,
      succeeded,
      failed,
      skippedCount,
      retried,
      continueOnError: options.continueOnError,
      retries: options.retries,
      retryDelayMs: options.retryDelayMs,
      ...(terminated ? { terminated: true as const } : {}),
    }
  }

  async function executeBatchStep(
    step: BatchCommandStep,
    index: number,
    options: BatchCommandOptions,
  ): Promise<{
    result: BatchCommandStepResult
    failed: boolean
    retryCount: number
  }> {
    let attempt = 0
    let lastError: unknown = null
    let retryCount = 0
    // 防御性截断：确保 retries 是有限非负整数，避免 Infinity/NaN 导致无限循环
    const maxRetries = Number.isFinite(options.retries)
      ? Math.max(0, Math.floor(options.retries))
      : 0

    while (attempt <= maxRetries) {
      try {
        // batch 已在自身队列槽内执行，子步骤再进队列会死锁，直接执行
        const result = await executeCommand(step.command, step.args, true)
        return {
          result: {
            index: index + 1,
            command: step.command,
            args: step.args,
            label: step.label,
            ...(step.id ? { id: step.id } : {}),
            response: createBatchStepResponse(result),
          },
          failed: false,
          retryCount,
        }
      } catch (error) {
        lastError = error
        if (attempt >= maxRetries) {
          break
        }

        retryCount += 1
        await waitForRetryDelay(options.retryDelayMs)
      }

      attempt += 1
    }

    return {
      result: {
        index: index + 1,
        command: step.command,
        args: step.args,
        label: step.label,
        ...(step.id ? { id: step.id } : {}),
        response: createBatchStepFailureResponse(lastError),
      },
      failed: true,
      retryCount,
    }
  }

  function batchValuesEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
      return true
    }
    if (typeof a !== typeof b) {
      return false
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((item, i) => batchValuesEqual(item, b[i]))
    }
    if (isRecord(a) && isRecord(b)) {
      const aKeys = Object.keys(a)
      const bKeys = Object.keys(b)
      return (
        aKeys.length === bKeys.length &&
        aKeys.every(
          (key) => Object.prototype.hasOwnProperty.call(b, key) && batchValuesEqual(a[key], b[key]),
        )
      )
    }
    return false
  }

  function getBatchStepResultValue(
    container: unknown,
    path: string | undefined,
  ): { exists: boolean; value: unknown } {
    if (!path) {
      return { exists: true, value: container }
    }

    let current: unknown = container
    for (const part of path.split('.')) {
      if (current === null || current === undefined) {
        return { exists: false, value: undefined }
      }
      if (Array.isArray(current)) {
        if (!/^(0|[1-9]\d*)$/.test(part)) {
          return { exists: false, value: undefined }
        }
        const arrayIndex = Number(part)
        if (arrayIndex >= current.length) {
          return { exists: false, value: undefined }
        }
        current = current[arrayIndex]
        continue
      }
      if (typeof current === 'object') {
        const record = current as Record<string, unknown>
        if (!Object.prototype.hasOwnProperty.call(record, part)) {
          return { exists: false, value: undefined }
        }
        current = record[part]
        continue
      }
      return { exists: false, value: undefined }
    }

    return { exists: true, value: current }
  }

  function resolveBatchStepIndex(ref: string | number, steps: BatchCommandStep[]): number | null {
    if (typeof ref === 'number') {
      return ref >= 1 && ref <= steps.length ? ref - 1 : null
    }
    const matchedIndex = steps.findIndex((step) => step.id === ref)
    return matchedIndex === -1 ? null : matchedIndex
  }

  /** 求值 when 条件：被引用的前置 step 必须已成功执行且未跳过，再按 path/谓词匹配其结果 */
  function evaluateBatchStepCondition(
    condition: BatchStepCondition,
    steps: BatchCommandStep[],
    results: BatchCommandStepResult[],
    currentIndex: number,
  ): boolean {
    const referencedIndex = resolveBatchStepIndex(condition.step, steps)
    if (
      referencedIndex === null ||
      referencedIndex >= currentIndex ||
      referencedIndex >= results.length
    ) {
      return false
    }

    const referencedResult = results[referencedIndex]
    if (referencedResult.skipped || referencedResult.response?.ok !== true) {
      return false
    }

    const { exists, value } = getBatchStepResultValue(
      referencedResult.response.result,
      condition.path,
    )

    if (condition.exists !== undefined) {
      return condition.exists === exists
    }
    if (condition.truthy !== undefined) {
      return condition.truthy ? Boolean(value) : !value
    }
    if (condition.equals !== undefined) {
      return exists && batchValuesEqual(condition.equals, value)
    }
    return false
  }

  function validateBatchWhenReferences(steps: BatchCommandStep[]): void {
    for (const [index, step] of steps.entries()) {
      if (!step.when) {
        continue
      }
      const referencedIndex = resolveBatchStepIndex(step.when.step, steps)
      if (referencedIndex === null || referencedIndex >= index) {
        throw new Error(
          `invalid batch step ${index + 1}: when.step must reference an earlier step (got ${JSON.stringify(step.when.step)})`,
        )
      }
    }
  }

  function createSkippedBatchStepResult(
    step: BatchCommandStep,
    index: number,
    reason: string,
  ): BatchCommandStepResult {
    return {
      index: index + 1,
      command: step.command,
      args: step.args,
      label: step.label,
      ...(step.id ? { id: step.id } : {}),
      skipped: true,
      reason,
    }
  }

  async function handleBatchCommand(
    args: CommandArgs,
  ): Promise<{ steps: BatchCommandStepResult[]; summary: BatchCommandSummary }> {
    const steps = readBatchCommandSteps(args)
    const options = readBatchCommandOptions(args)
    validateBatchWhenReferences(steps)
    const results: BatchCommandStepResult[] = []
    let succeeded = 0
    let failed = 0
    let retried = 0
    let skippedCount = 0
    let terminated = false
    let terminatedAtIndex: number | null = null

    for (const [index, step] of steps.entries()) {
      if (terminated) {
        skippedCount += 1
        results.push(
          createSkippedBatchStepResult(
            step,
            index,
            `terminated: step ${terminatedAtIndex} failed with skipRemainingOnFailure`,
          ),
        )
        continue
      }

      if (step.when) {
        const conditionMet = evaluateBatchStepCondition(step.when, steps, results, index)
        if (!conditionMet) {
          skippedCount += 1
          results.push(
            createSkippedBatchStepResult(
              step,
              index,
              `skipped: when condition not met (references step ${String(step.when.step)})`,
            ),
          )
          continue
        }
      }

      const stepExecution = await executeBatchStep(step, index, options)
      results.push(stepExecution.result)

      if (stepExecution.failed) {
        failed += 1
        retried += stepExecution.retryCount

        // skipRemainingOnFailure 只在 continueOnError 下生效：失败时不继续执行后续步骤，而是显式终止。
        if (step.skipRemainingOnFailure === true && options.continueOnError) {
          terminated = true
          terminatedAtIndex = index + 1
          continue
        }

        if (!options.continueOnError) {
          const summary = createBatchSummary(
            steps.length,
            results.length - skippedCount,
            succeeded,
            failed,
            skippedCount,
            retried,
            options,
          )
          const batchError = new Error(
            `batch step ${index + 1} failed: ${step.command}`,
          ) as ErrorWithCode
          batchError.code = 'BATCH_STEP_FAILED'
          batchError.details = {
            steps: results,
            failedStep: stepExecution.result,
            summary,
          }
          throw batchError
        }

        continue
      }

      succeeded += 1
      retried += stepExecution.retryCount
    }

    return {
      steps: results,
      summary: createBatchSummary(
        steps.length,
        results.length - skippedCount,
        succeeded,
        failed,
        skippedCount,
        retried,
        options,
        terminated,
      ),
    }
  }

  /** 无页面上下文的命令（status/tab.list/script/batch 等）返回的元数据全为 null */
  function emptyCommandMeta(): CommandMeta {
    return {
      tabHandle: null,
      tabId: null,
      frame: null,
      pageEpoch: null,
      url: null,
      title: null,
    }
  }

  /** 构建命令实际目标 tab 的上下文元数据；取 tab 失败时回退为全 null，永不 throw */
  async function buildCommandMeta(
    command: string,
    args: CommandArgs,
    tabTarget: TabInput,
    frameSelector: FrameSelector,
  ): Promise<CommandMeta> {
    if (!commandSupportsTabTarget(command)) {
      return emptyCommandMeta()
    }

    // 命令是否显式指定了 tabId/handle；未指定时 getTargetTab 内部可能走了兜底选择
    const explicitTarget =
      readTabInputArg(args, 'tabId') !== undefined || readTabInputArg(args, 'handle') !== undefined
    // getTargetTab 成功后会 rememberTargetTab，必须在解析前记住旧值才能判断是否发生过 fallback
    const preCommandTargetTabId = state.targeting.targetTabId

    let tab
    try {
      tab = await getTargetTab(tabTarget)
    } catch {
      return emptyCommandMeta()
    }

    if (!tab || typeof tab.id !== 'number') {
      return emptyCommandMeta()
    }

    const handle = getOrCreateTabHandle(state, tab.id)
    const meta: CommandMeta = {
      tabHandle: handle,
      tabId: tab.id,
      frame: resolveEffectiveFrameSelector(state, { id: tab.id }, frameSelector),
      pageEpoch: getPageEpoch(state, tab.id),
      url: tab.url || null,
      title: tab.title || null,
    }

    const openDialog = state.session.dialogs.get(tab.id)
    if (openDialog) {
      meta.dialog = {
        type: openDialog.type,
        message: openDialog.message,
        openedAt: openDialog.openedAt,
      }
    }

    const emulationOverrides = state.session.emulation.get(tab.id)
    if (emulationOverrides && Object.keys(emulationOverrides).length > 0) {
      meta.emulation = { ...emulationOverrides }
    }

    const target: NonNullable<CommandMeta['target']> = {
      tabId: tab.id,
      handle,
      explicit: explicitTarget,
    }
    if (!explicitTarget && preCommandTargetTabId !== tab.id) {
      target.note = 'fell back to last non-active tab'
    }
    meta.target = target

    return meta
  }

  /** 只对对象结果增量附加 meta；原始值/数组保持原样透传 */
  function attachCommandMeta(result: unknown, meta: CommandMeta): unknown {
    if (!isRecord(result)) {
      return result
    }
    // 导航类命令（goto/open）结果体里带新 url，覆盖 buildCommandMeta 从 tabsGet 拿到的旧值
    const effectiveMeta = typeof result.url === 'string' ? { ...meta, url: result.url } : meta
    return { ...result, meta: effectiveMeta }
  }

  async function executeCommand(command: string, args: CommandArgs = {}, skipQueue = false) {
    validateCommandArgs(command, args)

    const tabId = readTabInputArg(args, 'tabId')
    const handle = readTabInputArg(args, 'handle')
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
    const name = readStringArg(args, 'name', 'default')
    const domain = readOptionalStringArg(args, 'domain')
    const promptText = readOptionalStringArg(args, 'promptText')
    const files = readStringArrayArg(args, 'files')
    const scrollSelector = selector || null
    const deltaX = readNumberArg(args, 'deltaX', 0)
    const deltaY = readNumberArg(args, 'deltaY', 100)
    const viewportWidth = readNumberArg(args, 'width', 0)
    const viewportHeight = readNumberArg(args, 'height', 0)
    const deviceScaleFactor = readNumberArg(args, 'deviceScaleFactor', 1)
    const mobile = readBooleanArg(args, 'mobile', false)
    const enabled = readBooleanArg(args, 'enabled', true)
    const accept = readBooleanArg(args, 'accept', true)
    const headers = readHeadersArg(args, 'headers')
    const latitude = readNumberArg(args, 'latitude', 0)
    const longitude = readNumberArg(args, 'longitude', 0)
    const accuracy = readNumberArg(args, 'accuracy', 1)
    const media = readOptionalStringArg(args, 'media')
    const requestId = readStringArg(args, 'requestId')
    const subaction = readStringArg(args, 'subaction')
    const storageKey = readOptionalStringArg(args, 'key')
    const storageValue = readStringArg(args, 'value')
    const savedStateData = readSavedStateArg(args, 'data')
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
    const tabTarget = handle || tabId

    await assertNoOpenDialog(command, tabTarget)

    async function runCommand(): Promise<unknown> {
      switch (command) {
        case 'status':
          return {
            connected: true,
            tabs: await listTabs(),
          }
        case 'tab.list':
          return { tabs: await listTabs() }
        case 'tab.select':
          return await selectTab(tabTarget)
        case 'tab.new': {
          const tab = await tabsCreate({
            url,
          })

          if (tab && typeof tab.id === 'number') {
            rememberTargetTab(state, tab.id)
          }

          return { tab: toTabSummary(state, tab || {}) }
        }
        case 'tab.close':
          return await closeTab(tabTarget)
        case 'goto':
        case 'open':
          return await pageInput.navigateTo(tabId, url, {
            timeoutMs: readNumberArg(args, 'timeoutMs', 10000),
            wait: readBooleanArg(args, 'wait', true),
          })
        case 'eval':
          return await pageInput.evaluateScript(
            tabId,
            script,
            frameSelector,
            readOptionalNumberArg(args, 'timeoutMs'),
          )
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
          )
        case 'dblclick':
          return await pageInput.doubleClickSelector(tabId, selector, frameSelector)
        case 'fill':
          return await pageInput.fillSelector(tabId, selector, value, frameSelector)
        case 'fillform':
          return await pageInput.fillFields(tabId, readFillFormFields(args), frameSelector)
        case 'find':
          return await handleFindCommand(tabId, args, frameSelector)
        case 'type':
          return await pageInput.typeIntoSelector(
            tabId,
            selector,
            value,
            frameSelector,
            readBooleanArg(args, 'submit', false),
          )
        case 'hover':
          return await pageInput.hoverElement(tabId, selector, frameSelector)
        case 'press':
          return await pageInput.pressKey(tabId, key)
        case 'keyboard':
          if (action === 'type') {
            return await pageInput.insertTextSequentially(tabId, text)
          }
          if (action === 'inserttext') {
            return await pageInput.insertTextOnce(tabId, text)
          }
          if (action === 'keydown') {
            return await pageInput.keyDownOnly(tabId, text)
          }
          if (action === 'keyup') {
            return await pageInput.keyUpOnly(tabId, text)
          }
          throw new Error(`unsupported keyboard action: ${action}`)
        case 'focus':
          return await pageInput.focusElement(tabId, selector, frameSelector)
        case 'select':
          return await pageInput.selectOption(tabId, selector, value, frameSelector)
        case 'check':
          return await pageInput.checkElement(tabId, selector, true, frameSelector)
        case 'uncheck':
          return await pageInput.checkElement(tabId, selector, false, frameSelector)
        case 'scroll':
          return await pageInput.scrollElement(tabId, scrollSelector, deltaX, deltaY, frameSelector)
        case 'scrollintoview':
          return await pageInput.scrollIntoViewSelector(tabId, selector, frameSelector)
        case 'drag':
          return await pageInput.dragElement(tabId, start, end, frameSelector)
        case 'upload':
          return await pageInput.uploadFiles(tabId, selector, files, frameSelector)
        case 'back':
          return await pageInput.navigateBack(tabId)
        case 'forward':
          return await pageInput.navigateForward(tabId)
        case 'reload':
          return await pageInput.reloadPage(tabId)
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
          if (action === 'status') {
            return session.getDialogStatus(tabId)
          }
          return await session.handleDialog(tabId, accept, promptText)
        case 'wait':
          return await handleWait(tabId, args, frameSelector)
        case 'cookies':
          if (action === 'get') {
            return await session.cookiesGet(tabId, {
              domain: readOptionalStringArg(args, 'domain'),
              path: readOptionalStringArg(args, 'path'),
            })
          }
          if (action === 'set') {
            return await session.cookiesSet(tabId, name, value, domain)
          }
          if (action === 'clear') {
            return await session.cookiesClear(tabId)
          }
          if (action === 'delete') {
            if (!name || name === 'default') {
              throw new Error('cookies delete requires a cookie name')
            }
            return await session.cookiesDelete(tabId, name)
          }
          throw new Error(`unsupported cookies action: ${action}`)
        case 'storage': {
          const sessionOnly = readBooleanArg(args, 'session', false)
          if (action === 'get') {
            return await session.storageGet(tabId, storageKey, frameSelector, sessionOnly)
          }
          if (action === 'set') {
            return await session.storageSet(
              tabId,
              storageKey || '',
              storageValue,
              frameSelector,
              sessionOnly,
            )
          }
          if (action === 'delete') {
            if (!storageKey) {
              throw new Error('storage delete requires a key')
            }
            return await session.storageDelete(tabId, storageKey, frameSelector, sessionOnly)
          }
          if (action === 'clear') {
            return await session.storageClear(tabId, frameSelector, sessionOnly)
          }
          throw new Error(`unsupported storage action: ${action}`)
        }
        case 'console': {
          const targetTabId = resolveEffectiveTargetTabId(tabTarget)
          const messages =
            targetTabId === null
              ? state.session.consoleMessages
              : state.session.consoleMessages.filter((message) => message.tabId === targetTabId)
          // 分页作用在 tabId 过滤 + 折叠之后的结果上，折叠逻辑本身不动
          const { items, pagination } = paginateList(
            foldConsoleMessages(messages),
            pageIdx,
            pageSize,
          )
          return { messages: items, pagination }
        }
        case 'errors': {
          const targetTabId = resolveEffectiveTargetTabId(tabTarget)
          const errors =
            targetTabId === null
              ? state.session.pageErrors
              : state.session.pageErrors.filter((error) => error.tabId === targetTabId)
          const { items, pagination } = paginateList(errors, pageIdx, pageSize)
          return { errors: items, pagination }
        }
        case 'batch':
          return await handleBatchCommand(args)
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
          if (action === 'route') {
            if (subaction === 'list') {
              return network.listRoutes()
            }
            const removeHeaders = readStringArrayArg(args, 'removeHeaders')
            return await network.routeRequest(tabId, url, {
              abort: args.abort === true,
              body: args.body,
              status: typeof args.status === 'number' ? args.status : undefined,
              contentType: readOptionalStringArg(args, 'contentType'),
              headers: readObjectArg(args, 'headers') as Record<string, string> | undefined,
              removeHeaders: removeHeaders.length > 0 ? removeHeaders : undefined,
            })
          }
          if (action === 'unroute') {
            return await network.unrouteRequest(tabId, readStringArg(args, 'url'))
          }
          if (action === 'requests') {
            return network.listRequests(args)
          }
          if (action === 'request') {
            return network.getRequestDetail(requestId)
          }
          if (action === 'har') {
            if (subaction === 'start') {
              return await network.startHar(tabId, {
                maxRequests:
                  typeof args.maxRequests === 'number' || args.maxRequests === null
                    ? (args.maxRequests as number | null)
                    : undefined,
                maxBodyBytes:
                  typeof args.maxBodyBytes === 'number' || args.maxBodyBytes === null
                    ? (args.maxBodyBytes as number | null)
                    : undefined,
              })
            }
            if (subaction === 'stop') {
              return await network.stopHar()
            }
            throw new Error(`unsupported network har action: ${subaction}`)
          }
          throw new Error(`unsupported network action: ${action}`)
        case 'set':
          if (readStringArg(args, 'type') === 'viewport') {
            return await session.setViewport(
              tabId,
              viewportWidth,
              viewportHeight,
              deviceScaleFactor,
              mobile,
            )
          }
          if (readStringArg(args, 'type') === 'offline') {
            return await session.setOffline(tabId, enabled)
          }
          if (readStringArg(args, 'type') === 'headers') {
            return await session.setHeaders(tabId, headers)
          }
          if (readStringArg(args, 'type') === 'geo') {
            return await session.setGeo(tabId, latitude, longitude, accuracy)
          }
          if (readStringArg(args, 'type') === 'media') {
            return await session.setMedia(tabId, media)
          }
          if (readStringArg(args, 'type') === 'permission') {
            return await session.setPermission(tabId, name, readBooleanArg(args, 'reset', false))
          }
          if (readStringArg(args, 'type') === 'ua') {
            return await session.setUserAgent(tabId, value || null)
          }
          if (readStringArg(args, 'type') === 'timezone') {
            return await session.setTimezone(tabId, value || null)
          }
          if (readStringArg(args, 'type') === 'locale') {
            return await session.setLocale(tabId, value || null)
          }
          throw new Error(`unsupported set type: ${readStringArg(args, 'type')}`)
        case 'pdf':
          return await session.generatePdf(tabId)
        case 'clipboard':
          if (action === 'read') {
            return await session.clipboardRead(tabId)
          }
          if (action === 'write') {
            return await session.clipboardWrite(tabId, text)
          }
          throw new Error(`unsupported clipboard action: ${action}`)
        case 'state':
          if (action === 'save') {
            return await session.saveState(tabId, name)
          }
          if (action === 'load') {
            if (savedStateData) {
              return await session.loadState(tabId, savedStateData)
            }

            return await session.loadStateByName(tabId, name)
          }
          throw new Error(`unsupported state action: ${action}`)
        default:
          throw new Error(`unsupported command: ${command}`)
      }
    }

    // 按 tab 串行执行，避免同一 tab 的 chrome.debugger.sendCommand 并发冲突；
    // batch 子步骤（skipQueue）在 batch 自己的队列槽内执行，重入队列会死锁
    const result = skipQueue
      ? await runCommand()
      : await commandQueue.enqueue(resolveCommandQueueKey(tabTarget), runCommand)
    const meta = await buildCommandMeta(command, args, tabTarget, frameSelector)
    return attachCommandMeta(result, meta)
  }

  async function handleCommand(message: CommandMessage) {
    return await executeCommand(String(message.command || ''), message.args || {})
  }

  return {
    handleCommand,
  }
}
