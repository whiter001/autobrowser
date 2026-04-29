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
import { createNetworkDomain } from './background/network.js'
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
  getPageEpoch,
  rememberTargetTab,
  resolveTabInput,
  toTabSummary,
} from './background/targeting.js'
import type {
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
import { clearRemovedTabId, pickLastNonActiveTab } from '../src/core/tab-selection.js'

const DEFAULT_SERVER_PORT = DEFAULT_RELAY_PORT
const FRAME_WORLD_NAME = 'autobrowser-frame'

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

const network = createNetworkDomain({
  state,
  getTargetTab,
  sendRawDebuggerCommand,
  sendDebuggerCommand,
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
  listTabs,
  getTargetTab,
})

const connection = createConnectionRuntime({
  state,
  network,
  listTabs,
  handleCommand: commandRouter.handleCommand,
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
    return await tabsGet(resolvedTabId)
  }

  if (tabId !== undefined && tabId !== null && String(tabId).trim()) {
    throw new Error(`tab not found: ${tabId}`)
  }

  if (typeof state.targetTabId === 'number') {
    try {
      return await tabsGet(state.targetTabId)
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
  if (state.attachedTabs.has(tabId)) {
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

  state.attachedTabs.add(tabId)
  await enableDebuggerDomains(tabId)
  await network.refreshInterceptors()
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!state.attachedTabs.has(tabId)) {
    return
  }

  try {
    await debuggerDetach({ tabId })
  } catch (error) {
    console.warn('failed to detach debugger from tab', tabId, error)
  }

  state.attachedTabs.delete(tabId)
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
      const root = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!root) return null;
      const frame = root.tagName === 'IFRAME' ? root : root.querySelector('iframe');
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
      : state.selectedFrames.get(tab.id)
  if (!selector) {
    return { tab, executionContextId: null }
  }

  const frame = await resolveFrameTarget(tab.id, selector)
  await sendDebuggerCommand(tab.id, 'Page.enable', {})
  const isolatedWorld = await sendDebuggerCommand<{ executionContextId?: number | null }>(
    tab.id,
    'Page.createIsolatedWorld',
    {
      frameId: frame.frameId,
      worldName: FRAME_WORLD_NAME,
    },
  )
  return {
    tab,
    executionContextId: isolatedWorld.executionContextId ?? null,
  }
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
  const { frameSelector, ...runtimeOptions } = runtimeConfig
  const { tab, executionContextId } = await getFrameExecutionContext(tabId, frameSelector)
  const response = await sendDebuggerCommand<{ result: unknown }>(tab.id, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(executionContextId ? { contextId: executionContextId } : {}),
    ...runtimeOptions,
  })
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
    value?: unknown
    description?: string | null
  }

  if (Object.prototype.hasOwnProperty.call(evaluationResult, 'value')) {
    return evaluationResult.value as TValue
  }

  return (evaluationResult.description || null) as TValue | null
}

function clearTabRuntimeState(tabId: number): void {
  clearSelectedFrame(state, tabId)
  state.targetTabId = clearRemovedTabId(state.targetTabId, tabId)
  clearRemovedTabHandle(state, tabId)
  clearRemovedPageEpoch(state, tabId)
}

connection.registerChromeListeners()
connection.initialize()
