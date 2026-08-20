import { DEFAULT_RELAY_PORT } from './shared.js'
import {
  debuggerAttach,
  debuggerDetach,
  debuggerSendCommand,
  storageLocalGet,
  storageLocalSet,
  tabsGet,
  tabsQuery,
} from './background/chrome.js'
import { createCommandRouter } from './background/command-router.js'
import { createConnectionRuntime } from './background/connection.js'
import { createDownloadsDomain } from './background/downloads.js'
import { createNetworkDomain } from './background/network.js'
import { createInitScriptDomain } from './background/init-scripts.js'
import { createPageInputDomain } from './background/page-input.js'
import { createPageObserveDomain } from './background/page-observe.js'
import { createSessionDomain } from './background/session.js'
import { createExtensionState } from './background/state.js'
import {
  assertFreshElementRef,
  assertFreshFrameRef,
  clearRemovedPageEpoch,
  clearRemovedTabHandle,
  clearSelectedFrame,
  createStaleTabHandleError,
  getPageEpoch,
  rememberTargetTab,
  resolveTabInput,
  toTabSummary,
} from './background/targeting.js'
import type {
  ErrorWithCode,
  EvaluateInTabContextOptions,
  FrameExecutionContext,
  FrameSelector,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  TabInput,
  TabWithId,
} from './background/types.js'
import {
  AGENT_FRAME_REF_ATTRIBUTE,
  formatAgentFrameRef,
  resolveAgentFrameSelector,
} from '../src/core/agent-handles.js'
import { resolveAgentSelector } from '../src/core/agent-selectors.js'
import { buildDeepDomTraversalHelpersSource } from './background/deep-dom.js'
import { clearRemovedTabId, pickLastNonActiveTab } from '../src/core/tab-selection.js'

const DEFAULT_SERVER_PORT = DEFAULT_RELAY_PORT
const FRAME_WORLD_NAME = 'autobrowser-frame'
// 页面脚本挂起时先于 server 30s 命令超时把 evaluate 掐掉，避免长等
const DEFAULT_EVALUATE_TIMEOUT_MS = 25_000
// 按 (tabId, frameId) 缓存 isolated world 的 executionContextId，epoch 不匹配即视为导航后失效。
// 否则带 frameSelector 的每次 evaluate 都 createIsolatedWorld，world 会持续累积到导航才释放
const frameWorldContextCache = new Map<string, { epoch: number; contextId: number }>()
const PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE = buildDeepDomTraversalHelpersSource()

interface FrameTargetEvaluation {
  refValue: string | null
  src: string | null
  left: number
  top: number
  width: number
  height: number
  x: number
  y: number
}

const state = createExtensionState(DEFAULT_SERVER_PORT)

const downloads = createDownloadsDomain(state)

const network = createNetworkDomain({
  state,
  getTargetTab,
  sendRawDebuggerCommand,
  sendDebuggerCommand,
})

const initScripts = createInitScriptDomain({
  state,
  sendRawDebuggerCommand,
})

const pageInput = createPageInputDomain({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  getFrameExecutionContext,
  evaluateInTabContext,
  sendDebuggerCommand,
})

const pageObserve = createPageObserveDomain({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  evaluateInTabContext,
  sendDebuggerCommand,
})

const session = createSessionDomain({
  state,
  getTargetTab,
  evaluateInTabContext,
  sendDebuggerCommand,
  storageLocalGet,
  storageLocalSet,
})

const commandRouter = createCommandRouter({
  state,
  pageInput,
  pageObserve,
  session,
  network,
  downloads,
  initScripts,
  listTabs,
  getTargetTab,
})

const connection = createConnectionRuntime({
  state,
  network,
  listTabs,
  handleCommand: commandRouter.handleCommand,
  cancelCommand: commandRouter.cancelCommand,
  sendDebuggerCommand,
  storageLocalGet,
  storageLocalSet,
  clearTabRuntimeState,
  detachDebugger,
  getDialogStatus: session.getDialogStatus,
})

async function loadTargetTab(tabId: TabInput): Promise<TabWithId | null> {
  const resolvedTabId = resolveTabInput(state, tabId)

  if (typeof resolvedTabId === 'number') {
    try {
      return await tabsGet(resolvedTabId)
    } catch {
      // 数字 tabId / 已失效 handle 指向的 tab 已关闭：统一抛机器可读的错误码，
      // 让 agent 能区分「句柄过期」与其它失败，并按 suggestedAction 重新拉取 tab 列表
      throw createStaleTabHandleError(tabId)
    }
  }

  if (tabId !== undefined && tabId !== null && String(tabId).trim()) {
    throw createStaleTabHandleError(tabId)
  }

  if (typeof state.targeting.targetTabId === 'number') {
    try {
      return await tabsGet(state.targeting.targetTabId)
    } catch {
      rememberTargetTab(state, null)
    }
  }

  const tabs = await tabsQuery({
    currentWindow: true,
  })
  const fallbackTab = pickLastNonActiveTab(
    tabs
      .filter(
        (candidate): candidate is chrome.tabs.Tab & { id: number } =>
          typeof candidate.id === 'number',
      )
      .map((candidate) => ({
        ...candidate,
        active: Boolean(candidate.active),
      })),
  )
  if (!fallbackTab || typeof fallbackTab.id !== 'number') {
    return null
  }

  return await tabsGet(fallbackTab.id)
}

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (state.targeting.attachedTabs.has(tabId)) {
    return
  }

  try {
    await debuggerAttach({ tabId }, '1.3')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (!errorMessage.includes('already attached')) {
      throw error
    }
  }

  state.targeting.attachedTabs.add(tabId)
  await enableDebuggerDomains(tabId)
  await network.refreshInterceptors()
  await initScripts.replayForTab(tabId)
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!state.targeting.attachedTabs.has(tabId)) {
    return
  }

  try {
    await debuggerDetach({ tabId })
  } catch (error) {
    console.warn('failed to detach debugger from tab', tabId, error)
  }

  state.targeting.attachedTabs.delete(tabId)
}

async function sendRawDebuggerCommand<TResult = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<TResult> {
  return await debuggerSendCommand<TResult>({ tabId }, method, params)
}

async function enableDebuggerDomains(tabId: number): Promise<void> {
  await Promise.allSettled([
    sendRawDebuggerCommand(tabId, 'Runtime.enable', {}),
    sendRawDebuggerCommand(tabId, 'Console.enable', {}),
    sendRawDebuggerCommand(tabId, 'Network.enable', {}),
  ])
}

async function sendDebuggerCommand<TResult = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<TResult> {
  await ensureDebuggerAttached(tabId)
  return await sendRawDebuggerCommand<TResult>(tabId, method, params)
}

async function listTabs() {
  const tabs = await tabsQuery({})
  return tabs.map((tab) => toTabSummary(state, tab))
}

async function getTargetTab(tabId: TabInput): Promise<TabWithId> {
  const tab = await loadTargetTab(tabId)
  if (!tab) {
    throw new Error('no target tab available')
  }

  rememberTargetTab(state, tab.id)
  return tab
}

async function resolveElementSelectorForTab(
  tabId: TabInput,
  selector: string,
): Promise<ResolvedSelectorTarget> {
  const tab = await getTargetTab(tabId)
  assertFreshElementRef(state, tab.id, selector)
  return {
    tab,
    pageEpoch: getPageEpoch(state, tab.id),
    resolvedSelector: resolveAgentSelector(selector),
  }
}

async function resolveFrameSelectorForTab(
  tabId: TabInput,
  selector: string,
): Promise<ResolvedSelectorTarget> {
  const tab = await getTargetTab(tabId)
  assertFreshFrameRef(state, tab.id, selector)
  return {
    tab,
    pageEpoch: getPageEpoch(state, tab.id),
    resolvedSelector: resolveAgentFrameSelector(selector),
  }
}

async function resolveFrameTarget(tabId: TabInput, selector: string): Promise<ResolvedFrameTarget> {
  const { tab, pageEpoch, resolvedSelector } = await resolveFrameSelectorForTab(tabId, selector)
  const evaluation = await sendDebuggerCommand<{ result: unknown }>(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      ${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

      const root = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
      if (!root) return null;
      const frame = root.tagName === 'IFRAME' ? root : deepQuerySelector(root, 'iframe');
      if (!frame) return null;
      const rect = frame.getBoundingClientRect();
      const refValue = frame.getAttribute(${JSON.stringify(AGENT_FRAME_REF_ATTRIBUTE)});
      return {
        src: frame.src || null,
        refValue: refValue || null,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  const target = unwrapEvaluationResult<FrameTargetEvaluation>(evaluation.result)
  if (!target) {
    throw new Error(`frame not found: ${selector}`)
  }

  await sendDebuggerCommand(tab.id, 'DOM.enable', {})
  const location = await sendDebuggerCommand<{ frameId?: string }>(
    tab.id,
    'DOM.getNodeForLocation',
    {
      x: Math.round(target.x),
      y: Math.round(target.y),
      ignorePointerEventsNone: true,
    },
  )
  if (!location.frameId) {
    throw new Error(`frame is not ready: ${selector}`)
  }

  return {
    tab,
    frameId: location.frameId,
    selector,
    ref: target.refValue
      ? formatAgentFrameRef(Number(String(target.refValue).slice(1)), pageEpoch)
      : null,
    src: target.src,
    pageEpoch,
    left: Number(target.left || 0),
    top: Number(target.top || 0),
    width: Number(target.width || 0),
    height: Number(target.height || 0),
  }
}

async function getFrameExecutionContext(
  tabId: TabInput,
  frameSelector: FrameSelector,
): Promise<FrameExecutionContext> {
  const tab = await getTargetTab(tabId)
  const selector =
    typeof frameSelector === 'string' && frameSelector.trim()
      ? frameSelector.trim()
      : state.targeting.selectedFrames.get(tab.id)
  if (!selector) {
    return { tab, executionContextId: null }
  }

  const frame = await resolveFrameTarget(tab.id, selector)
  const worldCacheKey = `${tab.id}:${frame.frameId}`
  const cachedWorld = frameWorldContextCache.get(worldCacheKey)
  if (cachedWorld && cachedWorld.epoch === frame.pageEpoch) {
    return {
      tab,
      executionContextId: cachedWorld.contextId,
      worldCacheKey,
      worldFromCache: true,
    }
  }

  await sendDebuggerCommand(tab.id, 'Page.enable', {})
  const isolatedWorld = await sendDebuggerCommand<{ executionContextId?: number | null }>(
    tab.id,
    'Page.createIsolatedWorld',
    {
      frameId: frame.frameId,
      worldName: FRAME_WORLD_NAME,
    },
  )
  const executionContextId = isolatedWorld.executionContextId ?? null
  if (executionContextId !== null) {
    frameWorldContextCache.set(worldCacheKey, {
      epoch: frame.pageEpoch,
      contextId: executionContextId,
    })
  }
  return {
    tab,
    executionContextId,
    worldCacheKey,
    worldFromCache: false,
  }
}

// 缓存的 world 可能已被页面销毁（如 iframe 重载但 epoch 未变），CDP 此时报 context 不存在
function isStaleWorldContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cannot find context/i.test(message)
}

// CDP 超时中断 evaluate 的报错文案不统一（同步挂起是 "Execution was terminated"，
// 部分版本是 "Script execution timed out"），两种都要识别
function isEvaluationTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed\s*out|execution was terminated|execution terminated/i.test(message)
}

function createEvaluationTimeoutError(timeoutMs: number): ErrorWithCode {
  const error = new Error(`page evaluation timed out after ${timeoutMs}ms`) as ErrorWithCode
  error.code = 'EVALUATION_TIMEOUT'
  error.suggestedAction =
    'Keep the original task goal, split complex eval into smaller steps, and pass complex source with --file or --stdin. Increase --timeout-ms only after confirming this is a long-running page task.'
  return error
}

function createPageEvaluationExceptionError(description: string): ErrorWithCode {
  const error = new Error(`page evaluation failed: ${description}`) as ErrorWithCode
  error.code = 'PAGE_EVALUATION_EXCEPTION'
  error.suggestedAction =
    'Check the original script, pass complex or multiline source with eval --file <path> or eval --stdin to avoid shell escaping issues, diagnose page state with snapshot, console, or status, then retry around the original task goal.'
  return error
}

async function evaluateInTabContext<TValue = unknown>(
  tabId: TabInput,
  expression: string,
  options: EvaluateInTabContextOptions = {},
): Promise<{
  tab: TabWithId
  response: { result: unknown }
  value: TValue | null
}> {
  const runtimeConfig = options
  const {
    frameSelector,
    timeoutMs = DEFAULT_EVALUATE_TIMEOUT_MS,
    ...runtimeOptions
  } = runtimeConfig
  const context = await getFrameExecutionContext(tabId, frameSelector)
  let { tab, executionContextId } = context

  const evaluate = (contextId: number | null) =>
    sendDebuggerCommand<{
      result: unknown
      exceptionDetails?: {
        text?: string
        exception?: { description?: string }
      }
    }>(tab.id, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: Math.max(1, Math.floor(timeoutMs)),
      ...(contextId ? { contextId } : {}),
      ...runtimeOptions,
    })

  let response: Awaited<ReturnType<typeof evaluate>>
  try {
    response = await evaluate(executionContextId)
  } catch (error) {
    if (isEvaluationTimeoutError(error)) {
      throw createEvaluationTimeoutError(timeoutMs)
    }
    // 只有命中缓存的 world 才可能是缓存失效，清掉重建一次，再失败就原样抛出
    if (!context.worldFromCache || !context.worldCacheKey || !isStaleWorldContextError(error)) {
      throw error
    }
    frameWorldContextCache.delete(context.worldCacheKey)
    const retryContext = await getFrameExecutionContext(tabId, frameSelector)
    tab = retryContext.tab
    executionContextId = retryContext.executionContextId
    response = await evaluate(executionContextId)
  }
  // 页面内表达式抛异常时 CDP 不返回 value，必须把真实异常原因抛给调用方，
  // 否则 description 字符串会被当成正常结果继续传递
  if (response.exceptionDetails) {
    const details = response.exceptionDetails
    const description = details.exception?.description || details.text || 'unknown error'
    if (isEvaluationTimeoutError(description)) {
      throw createEvaluationTimeoutError(timeoutMs)
    }
    throw createPageEvaluationExceptionError(description)
  }
  return {
    tab,
    response,
    value: unwrapEvaluationResult<TValue>(response.result),
  }
}

function unwrapEvaluationResult<TValue = unknown>(result: unknown): TValue | null {
  if (!result) {
    return null
  }

  const evaluationResult = result as {
    type?: string
    value?: unknown
    description?: string | null
  }

  if (Object.prototype.hasOwnProperty.call(evaluationResult, 'value')) {
    return evaluationResult.value as TValue
  }

  // 表达式结果为 undefined 时 CDP 只给 { type: 'undefined' }，没有 value；
  // 不能把 description 里的字符串 'undefined' 当成正常结果
  if (evaluationResult.type === 'undefined') {
    return null
  }

  return (evaluationResult.description || null) as TValue | null
}

function clearTabRuntimeState(tabId: number): void {
  clearSelectedFrame(state, tabId)
  state.targeting.targetTabId = clearRemovedTabId(state.targeting.targetTabId, tabId)
  clearRemovedTabHandle(state, tabId)
  clearRemovedPageEpoch(state, tabId)
  // tab 关闭后其打开的对话框一并失效，清掉避免残留阻塞该 tab 后续命令
  state.session.dialogs.delete(tabId)
  // tab 关闭后其 isolated world 一并销毁，清掉对应缓存避免泄漏
  for (const key of frameWorldContextCache.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      frameWorldContextCache.delete(key)
    }
  }
}

connection.registerChromeListeners()
downloads.registerChromeListeners()
connection.initialize()
