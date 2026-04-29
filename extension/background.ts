import {
  CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  DEFAULT_RELAY_PORT,
  RELAY_PORT_STORAGE_KEY,
  STORAGE_KEY,
  normalizeRelayPort,
  type ConnectionStatus,
  type DiagnosticsState,
} from './shared.js'
import {
  debuggerAttach,
  debuggerDetach,
  debuggerSendCommand,
  storageLocalGet,
  storageLocalSet,
  tabsCreate,
  tabsGet,
  tabsQuery,
  tabsRemove,
  tabsUpdate,
  windowsCreate,
  windowsUpdate,
} from './background/chrome.js'
import { createNetworkDomain } from './background/network.js'
import {
  collapseWhitespace,
  parsePageContextElementRefIndex,
  splitWhitespaceTokens,
} from './background/page-context-helpers.js'
import { createExtensionState } from './background/state.js'
import {
  assertFreshElementRef,
  assertFreshFrameRef,
  clearRemovedPageEpoch,
  clearRemovedTabHandle,
  clearSelectedFrame,
  getOrCreateTabHandle,
  getPageEpoch,
  invalidatePageRefs,
  rememberTargetTab,
  resolveEffectiveFrameSelector,
  resolveTabInput,
  toTabSummary,
  withFrameSelectorOptions,
} from './background/targeting.js'
import type {
  CommandArgs,
  CommandMessage,
  ErrorWithCode,
  EvaluateInTabContextOptions,
  FrameExecutionContext,
  FrameSelector,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  SavedStateData,
  SavedStatesMap,
  ScreenshotCaptureOptions,
  TabInput,
  TabWithId,
} from './background/types.js'
import {
  AGENT_FRAME_REF_ATTRIBUTE,
  formatAgentFrameRef,
  resolveAgentFrameSelector,
} from '../src/core/agent-handles.js'
import { AGENT_ELEMENT_REF_ATTRIBUTE, resolveAgentSelector } from '../src/core/agent-selectors.js'
import { clearRemovedTabId, pickLastNonActiveTab } from '../src/core/tab-selection.js'

const DEFAULT_SERVER_PORT = DEFAULT_RELAY_PORT
const SAVED_STATES_STORAGE_KEY = 'autobrowserSavedStates'
const FRAME_WORLD_NAME = 'autobrowser-frame'
const SCREENSHOT_ANNOTATION_OVERLAY_ID = 'autobrowser-screenshot-annotations'
const SCREENSHOT_ANNOTATION_MAX_ELEMENTS = 200
const AGENT_SNAPSHOT_MAX_ELEMENTS = 200

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

interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

interface ElementActionResult extends Record<string, unknown> {
  found: boolean
  reason?: string
}

interface ScreenshotAnnotationResult {
  count?: number
}

interface SemanticTargetMatch extends Record<string, unknown> {
  ref?: string
  tag?: string
  role?: string
  text?: string
  name?: string
  x?: number
  y?: number
  width?: number
  height?: number
}

interface SemanticTargetResult extends Record<string, unknown> {
  found: boolean
  reason?: string
  pageEpoch?: number
  match?: SemanticTargetMatch
}

const state = createExtensionState(DEFAULT_SERVER_PORT)

const PAGE_CONTEXT_TEXT_HELPERS_SOURCE = [
  collapseWhitespace.toString(),
  splitWhitespaceTokens.toString(),
].join('\n')

const PAGE_CONTEXT_FIND_HELPERS_SOURCE = [
  PAGE_CONTEXT_TEXT_HELPERS_SOURCE,
  parsePageContextElementRefIndex.toString(),
].join('\n')

const network = createNetworkDomain({
  state,
  getTargetTab,
  sendRawDebuggerCommand,
  sendDebuggerCommand,
})

function pushBounded<T>(list: T[], item: T, maxSize: number): void {
  list.push(item)
  if (list.length > maxSize) {
    list.splice(0, list.length - maxSize)
  }
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
  return typeof value === 'number' || typeof value === 'string' || value == null ? value : undefined
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

  return {
    full: readBooleanArg(args, 'full', false),
    annotate: readBooleanArg(args, 'annotate', false),
    ...(format ? { format } : {}),
    ...(quality ? { quality } : {}),
  }
}

function persistDiagnostics(): void {
  chrome.storage.local
    .set({
      [CONNECTION_DIAGNOSTICS_STORAGE_KEY]: {
        status: state.connectionStatus,
        connectionError: state.connectionError,
        lastSocketClose: state.lastSocketClose,
        lastCommandError: state.lastCommandError,
        updatedAt: new Date().toISOString(),
      } satisfies DiagnosticsState,
    })
    .catch((error: Error) => {
      console.error('failed to persist plugin diagnostics', error)
    })
}

function setConnectionError(message: string, code?: string): void {
  state.connectionError = {
    message,
    at: new Date().toISOString(),
    ...(code ? { code } : {}),
  }
  persistDiagnostics()
}

function setConnectionStatus(status: ConnectionStatus): void {
  state.connectionStatus = status
  if (status === 'connected') {
    state.connectionError = null
  }
  persistDiagnostics()
}

function recordSocketClose(close: { code: number; reason: string; wasClean: boolean }): void {
  state.lastSocketClose = {
    code: close.code,
    reason: close.reason,
    wasClean: close.wasClean,
    at: new Date().toISOString(),
  }

  if (!state.suppressCloseError && close.code !== 1000) {
    setConnectionError(
      `relay socket closed: ${close.code}${close.reason ? ` ${close.reason}` : ''}`.trim(),
      'SOCKET_CLOSED',
    )
    setConnectionStatus('disconnected')
  }

  state.suppressCloseError = false
  persistDiagnostics()
}

function stringifyRemoteValue(value: unknown): string {
  if (!value) {
    return ''
  }

  const remoteValue = value as {
    value?: unknown
    unserializableValue?: string
    description?: string
    type?: string
  }

  if (Object.prototype.hasOwnProperty.call(remoteValue, 'value')) {
    if (typeof remoteValue.value === 'string') {
      return remoteValue.value
    }

    try {
      return JSON.stringify(remoteValue.value)
    } catch (error) {
      console.debug('failed to stringify remote value', error)
      return String(remoteValue.value)
    }
  }

  if (remoteValue.unserializableValue) {
    return remoteValue.unserializableValue
  }

  return remoteValue.description || remoteValue.type || ''
}

function setupDebuggerEventListeners() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const navigationParams = params as {
      frame?: { parentId?: string | null }
    }

    if (
      typeof source?.tabId === 'number' &&
      ((method === 'Page.frameNavigated' && !navigationParams.frame?.parentId) ||
        method === 'Page.navigatedWithinDocument')
    ) {
      invalidatePageRefs(state, source.tabId)
    }

    if (method === 'Runtime.consoleAPICalled') {
      const consoleParams = params as {
        type?: string
        args?: unknown[]
      }

      pushBounded(
        state.consoleMessages,
        {
          type: String(consoleParams.type || ''),
          text: Array.isArray(consoleParams.args)
            ? consoleParams.args.map((item: unknown) => stringifyRemoteValue(item)).join(' ')
            : '',
          timestamp: Date.now(),
        },
        500,
      )
    }
    if (method === 'Runtime.exceptionThrown') {
      const exceptionParams = params as {
        exceptionDetails?: {
          exception?: { description?: string }
          text?: string
          url?: string
          lineNumber?: number
          columnNumber?: number
        }
      }

      pushBounded(
        state.pageErrors,
        {
          error:
            exceptionParams.exceptionDetails?.exception?.description ||
            exceptionParams.exceptionDetails?.text ||
            '',
          url: exceptionParams.exceptionDetails?.url || null,
          line: exceptionParams.exceptionDetails?.lineNumber,
          column: exceptionParams.exceptionDetails?.columnNumber,
          timestamp: Date.now(),
        },
        100,
      )
    }

    if (method === 'Page.javascriptDialogOpening') {
      const dialogParams = params as {
        type?: string
        message?: string
        defaultPrompt?: string
        url?: string
      }

      state.dialog = {
        open: true,
        type: String(dialogParams.type || ''),
        message: String(dialogParams.message || ''),
        defaultPrompt: String(dialogParams.defaultPrompt || ''),
        url: dialogParams.url ? String(dialogParams.url) : null,
        openedAt: new Date().toISOString(),
      }

      if (
        ['alert', 'beforeunload'].includes(state.dialog.type) &&
        typeof source?.tabId === 'number'
      ) {
        void sendDebuggerCommand(source.tabId, 'Page.handleJavaScriptDialog', {
          accept: true,
        })
          .then(() => {
            state.dialog = null
          })
          .catch((error) => {
            console.error('failed to auto accept dialog', error)
          })
      }
    }

    if (method === 'Page.javascriptDialogClosed') {
      state.dialog = null
    }

    if (method === 'Fetch.requestPaused') {
      const tabId = typeof source?.tabId === 'number' ? source.tabId : null
      if (tabId !== null) {
        void network.handleRequestPaused(tabId, params).catch((error) => {
          console.error('failed to handle paused network request', error)
        })
      }
    }

    if (
      method === 'Network.requestWillBeSent' ||
      method === 'Network.responseReceived' ||
      method === 'Network.loadingFinished' ||
      method === 'Network.loadingFailed'
    ) {
      void network.handleEvent(source, method, params).catch((error) => {
        console.error('failed to record network event', error)
      })
    }
  })
}

async function getToken(): Promise<string> {
  const result = await storageLocalGet(STORAGE_KEY)
  return String(result?.[STORAGE_KEY] || '')
}

async function getRelayPort(): Promise<number> {
  const result = await storageLocalGet(RELAY_PORT_STORAGE_KEY)
  return normalizeRelayPort(result?.[RELAY_PORT_STORAGE_KEY])
}

async function saveToken(token: string): Promise<void> {
  await storageLocalSet({
    [STORAGE_KEY]: token.trim(),
  })
  state.token = token.trim()
  requestReconnect()
}

function requestReconnect(): void {
  if (state.socket && state.socket.readyState < WebSocket.CLOSING) {
    state.suppressCloseError = true
    try {
      state.socket.close()
      return
    } catch (error) {
      console.warn('failed to close relay socket before reconnect', error)
    }
  }

  reconnect()
}

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

async function getSavedStates(): Promise<SavedStatesMap> {
  const result = await storageLocalGet(SAVED_STATES_STORAGE_KEY)
  const savedStates = result?.[SAVED_STATES_STORAGE_KEY]
  return savedStates && typeof savedStates === 'object' ? (savedStates as SavedStatesMap) : {}
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

async function evaluateScript(tabId: TabInput, script: string, frameSelector: FrameSelector) {
  const { value } = await evaluateInTabContext(
    tabId,
    script,
    withFrameSelectorOptions(frameSelector, {
      userGesture: true,
    }),
  )
  return value
}

async function navigateTo(tabId: TabInput, url: string) {
  const tab = await getTargetTab(tabId)
  invalidatePageRefs(state, tab.id)
  await sendDebuggerCommand(tab.id, 'Page.enable', {})
  await sendDebuggerCommand(tab.id, 'Page.navigate', { url })
  return { tabId: tab.id, url }
}

async function clickSelector(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const { value: result } = await evaluateInTabContext<ElementActionResult>(
    tab.id,
    `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) return { found: false };
      node.scrollIntoView({ block: 'center', inline: 'center' });
      node.click();
      return { found: true, selector: ${JSON.stringify(selector)} };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  if (result?.found) {
    return result
  }

  const box = await getElementBox(tab.id, selector, frameSelector)
  if (!box) {
    throw new Error(`element not found: ${selector}`)
  }

  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  })
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  })

  return { found: true, selector }
}

async function clearScreenshotAnnotations(tabId: TabInput, frameSelector: FrameSelector) {
  await evaluateInTabContext(
    tabId,
    `(() => {
      const overlay = document.getElementById(${JSON.stringify(SCREENSHOT_ANNOTATION_OVERLAY_ID)})
      if (overlay) {
        overlay.remove()
      }

      const body = document.body
      if (!body) {
        return true
      }

      if (body.dataset.autobrowserScreenshotPreviousPosition !== undefined) {
        const previousPosition = body.dataset.autobrowserScreenshotPreviousPosition
        if (previousPosition) {
          body.style.position = previousPosition
        } else {
          body.style.removeProperty('position')
        }
        delete body.dataset.autobrowserScreenshotPreviousPosition
      }

      return true
    })()`,
    withFrameSelectorOptions(frameSelector),
  )
}

async function addScreenshotAnnotations(tabId: TabInput, frameSelector: FrameSelector) {
  const { value } = await evaluateInTabContext<ScreenshotAnnotationResult>(
    tabId,
    `(() => {
      const body = document.body
      if (!body) {
        return { count: 0 }
      }

      const doc = document.documentElement
      const existing = document.getElementById(${JSON.stringify(SCREENSHOT_ANNOTATION_OVERLAY_ID)})
      if (existing) {
        existing.remove()
      }

      if (getComputedStyle(body).position === 'static') {
        body.dataset.autobrowserScreenshotPreviousPosition = body.style.position || ''
        body.style.position = 'relative'
      }

      const overlay = document.createElement('div')
      overlay.id = ${JSON.stringify(SCREENSHOT_ANNOTATION_OVERLAY_ID)}
      overlay.style.position = 'absolute'
      overlay.style.left = '0'
      overlay.style.top = '0'
      overlay.style.pointerEvents = 'none'
      overlay.style.zIndex = '2147483647'
      overlay.style.width = Math.max(doc.scrollWidth, doc.clientWidth, body.scrollWidth, body.clientWidth) + 'px'
      overlay.style.height = Math.max(doc.scrollHeight, doc.clientHeight, body.scrollHeight, body.clientHeight) + 'px'

      const selectors = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[tabindex]:not([tabindex="-1"])',
        'img',
      ]

      const seen = new Set()
      const candidates = []
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) {
            continue
          }
          seen.add(element)
          candidates.push(element)
        }
      }

      let count = 0
      for (const element of candidates) {
        if (!(element instanceof HTMLElement)) {
          continue
        }

        if (count >= ${SCREENSHOT_ANNOTATION_MAX_ELEMENTS}) {
          break
        }

        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (rect.width < 4 || rect.height < 4 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
          continue
        }

        const badge = document.createElement('div')
        badge.textContent = String(count + 1)
        badge.style.position = 'absolute'
        badge.style.left = Math.max(0, rect.left + window.scrollX) + 'px'
        badge.style.top = Math.max(0, rect.top + window.scrollY) + 'px'
        badge.style.transform = 'translate(-6px, -6px)'
        badge.style.background = 'rgba(220, 38, 38, 0.94)'
        badge.style.color = '#ffffff'
        badge.style.border = '2px solid #ffffff'
        badge.style.borderRadius = '999px'
        badge.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.35)'
        badge.style.font = '700 12px/1.1 system-ui, sans-serif'
        badge.style.padding = '3px 6px'
        badge.style.minWidth = '16px'
        badge.style.textAlign = 'center'
        badge.style.whiteSpace = 'nowrap'
        overlay.appendChild(badge)
        count += 1
      }

      body.appendChild(overlay)
      return { count }
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  return Number(value?.count || 0)
}

async function captureScreenshot(
  tabId: TabInput,
  options: ScreenshotCaptureOptions = {},
  frameSelector: FrameSelector,
) {
  const tab = await getTargetTab(tabId)
  const effectiveFrameSelector = resolveEffectiveFrameSelector(state, tab, frameSelector)
  await sendDebuggerCommand(tab.id, 'Page.enable', {})

  let annotationCount = 0
  try {
    if (options.annotate) {
      await clearScreenshotAnnotations(tab.id, effectiveFrameSelector).catch(() => {})
      annotationCount = await addScreenshotAnnotations(tab.id, effectiveFrameSelector)
    }

    const format = options.format === 'jpeg' ? 'jpeg' : 'png'
    const captureOptions = {
      format,
      fromSurface: true,
      ...(format === 'jpeg' && typeof options.quality === 'number'
        ? { quality: options.quality }
        : {}),
    }

    if (effectiveFrameSelector) {
      const frame = await resolveFrameTarget(tab.id, effectiveFrameSelector)
      Object.assign(captureOptions, {
        clip: {
          x: Math.max(0, frame.left),
          y: Math.max(0, frame.top),
          width: Math.max(1, frame.width),
          height: Math.max(1, frame.height),
          scale: 1,
        },
      })
    } else if (options.full) {
      Object.assign(captureOptions, {
        captureBeyondViewport: true,
      })
    }

    const result = await sendDebuggerCommand<{ data: string }>(
      tab.id,
      'Page.captureScreenshot',
      captureOptions,
    )

    return {
      tabId: tab.id,
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      format,
      fullPage: Boolean(options.full),
      annotated: Boolean(options.annotate),
      annotationCount,
      dataUrl: `data:${format === 'jpeg' ? 'image/jpeg' : 'image/png'};base64,${result.data}`,
      data: result.data,
    }
  } finally {
    if (options.annotate) {
      await clearScreenshotAnnotations(tab.id, effectiveFrameSelector).catch((error) => {
        console.error('failed to clear screenshot annotations', error)
      })
    }
  }
}

async function snapshotTab(tabId: TabInput, frameSelector: FrameSelector) {
  const tab = await getTargetTab(tabId)
  const pageEpoch = getPageEpoch(state, tab.id)
  const refAttribute = AGENT_ELEMENT_REF_ATTRIBUTE
  const frameAttribute = AGENT_FRAME_REF_ATTRIBUTE
  const frameRefPrefix = formatAgentFrameRef(1).replace('1', '')
  const { value } = await evaluateInTabContext(
    tab.id,
    `(() => {
      const refAttribute = ${JSON.stringify(refAttribute)};
      const frameAttribute = ${JSON.stringify(frameAttribute)};
      const frameRefPrefix = ${JSON.stringify(frameRefPrefix)};
      const pageEpoch = ${pageEpoch};

${PAGE_CONTEXT_TEXT_HELPERS_SOURCE}

      const readText = (node) => collapseWhitespace(node.innerText || node.textContent || '');

      const getAssociatedLabel = (node) => {
        if (!(node instanceof HTMLElement) || !node.id) {
          return '';
        }

        try {
          const label = document.querySelector('label[for="' + CSS.escape(node.id) + '"]');
          return label ? readText(label) : '';
        } catch {
          return '';
        }
      };

      const getAriaLabelledByText = (node) => {
        const labelledBy = node.getAttribute('aria-labelledby');
        if (!labelledBy) {
          return '';
        }

        return splitWhitespaceTokens(labelledBy)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((element) => readText(element))
          .filter(Boolean)
          .join(' ')
          .trim();
      };

      const inferRole = (node) => {
        const explicitRole = node.getAttribute('role');
        if (explicitRole) {
          return explicitRole;
        }

        const tagName = node.tagName.toLowerCase();
        if (tagName === 'a' && node.getAttribute('href')) return 'link';
        if (tagName === 'button') return 'button';
        if (tagName === 'select') return 'combobox';
        if (tagName === 'textarea') return 'textbox';
        if (tagName === 'summary') return 'button';
        if (tagName === 'input') {
          const inputType = (node.getAttribute('type') || 'text').toLowerCase();
          if (['button', 'submit', 'reset'].includes(inputType)) return 'button';
          if (inputType === 'checkbox') return 'checkbox';
          if (inputType === 'radio') return 'radio';
          return 'textbox';
        }

        return null;
      };

      const getName = (node) => {
        const candidates = [
          node.getAttribute('aria-label') || '',
          getAriaLabelledByText(node),
          getAssociatedLabel(node),
          node.getAttribute('alt') || '',
          node.getAttribute('title') || '',
          node.getAttribute('placeholder') || '',
          typeof node.value === 'string' ? node.value : '',
          readText(node),
        ]

        return candidates.find((value) => value && value.trim()) || '';
      };

      const toNodeSummary = (node) => ({
        tag: node.tagName,
        text: readText(node).slice(0, 120),
        id: node.id || null,
        className: typeof node.className === "string" ? node.className : null,
        ref: node.getAttribute(refAttribute)
          ? '@' + node.getAttribute(refAttribute) + '#p' + pageEpoch
          : null,
      });

      for (const element of document.querySelectorAll('[' + refAttribute + ']')) {
        element.removeAttribute(refAttribute);
      }

      for (const frameElement of document.querySelectorAll('[' + frameAttribute + ']')) {
        frameElement.removeAttribute(frameAttribute);
      }

      const selectors = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'summary',
        '[role]',
        '[tabindex]:not([tabindex="-1"])',
      ];

      const seen = new Set();
      const candidates = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) {
            continue;
          }

          seen.add(element);
          candidates.push(element);
        }
      }

      const elements = [];
      for (const element of candidates) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }

        if (elements.length >= ${AGENT_SNAPSHOT_MAX_ELEMENTS}) {
          break;
        }

        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') !== 0;

        if (!visible) {
          continue;
        }

        const refValue = 'e' + (elements.length + 1);
        element.setAttribute(refAttribute, refValue);

        elements.push({
          ref: '@' + refValue + '#p' + pageEpoch,
          tag: element.tagName.toLowerCase(),
          role: inferRole(element),
          text: readText(element).slice(0, 240),
          name: getName(element).slice(0, 240),
          placeholder: element.getAttribute('placeholder') || null,
          type: element instanceof HTMLInputElement ? element.type || 'text' : null,
          href: element instanceof HTMLAnchorElement ? element.href || null : null,
          disabled: 'disabled' in element ? Boolean(element.disabled) : false,
          checked: 'checked' in element ? Boolean(element.checked) : null,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }

      const frames = [];
      for (const frameElement of document.querySelectorAll('iframe')) {
        if (!(frameElement instanceof HTMLIFrameElement)) {
          continue;
        }

        if (frames.length >= ${AGENT_SNAPSHOT_MAX_ELEMENTS}) {
          break;
        }

        const rect = frameElement.getBoundingClientRect();
        const style = getComputedStyle(frameElement);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') !== 0;

        if (!visible) {
          continue;
        }

        const refValue = 'f' + (frames.length + 1);
        frameElement.setAttribute(frameAttribute, refValue);
        frames.push({
          ref: frameRefPrefix + (frames.length + 1) + '#p' + pageEpoch,
          name: frameElement.name || null,
          title: frameElement.title || null,
          src: frameElement.src || frameElement.getAttribute('src') || null,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }

      return {
        pageEpoch,
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        text: (document.body?.innerText || "").slice(0, 5000),
        elements,
        frames,
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 20).map(toNodeSummary),
        buttons: Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")).slice(0, 20).map(toNodeSummary),
      };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  return value
}

// 解析组合键，返回 { key, modifiers }
function parseKeyboardKey(key: string): { key: string; modifiers: number } {
  const modifiers = { shift: false, ctrl: false, alt: false, meta: false }
  let remaining = key

  // 解析前缀修饰键
  if (remaining.includes('Control+')) {
    modifiers.ctrl = true
    remaining = remaining.replace('Control+', '')
  }
  if (remaining.includes('Shift+')) {
    modifiers.shift = true
    remaining = remaining.replace('Shift+', '')
  }
  if (remaining.includes('Alt+')) {
    modifiers.alt = true
    remaining = remaining.replace('Alt+', '')
  }
  if (remaining.includes('Meta+')) {
    modifiers.meta = true
    remaining = remaining.replace('Meta+', '')
  }

  // 计算 modifiers 位掩码
  let mask = 0
  if (modifiers.ctrl) mask |= 2
  if (modifiers.shift) mask |= 4
  if (modifiers.alt) mask |= 1
  if (modifiers.meta) mask |= 8

  return { key: remaining, modifiers: mask }
}

async function getElementBox(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const { value } = await evaluateInTabContext<ElementBox>(
    tab.id,
    `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height
      };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )
  return value
}

async function hoverElement(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const box = await getElementBox(tab.id, selector, frameSelector)
  if (!box) {
    throw new Error(`element not found: ${selector}`)
  }

  // 先尝试 JS 方式
  const { value } = await evaluateInTabContext<boolean>(
    tab.id,
    `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const win = node.ownerDocument.defaultView;
      const opts = { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y };
      node.dispatchEvent(new PointerEvent('pointerover', opts));
      node.dispatchEvent(new MouseEvent('mouseover', opts));
      node.dispatchEvent(new PointerEvent('pointerenter', opts));
      node.dispatchEvent(new MouseEvent('mouseenter', opts));
      node.dispatchEvent(new MouseEvent('mousemove', opts));
      return true;
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  if (value) {
    return { found: true, selector }
  }

  // Fallback: Input.dispatchMouseEvent
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y,
    button: 'none',
    clickCount: 0,
  })

  return { found: true, selector }
}

async function pressKey(tabId: TabInput, key: string) {
  const { key: keyName, modifiers } = parseKeyboardKey(key)
  const tab = await getTargetTab(tabId)

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyName,
    code: keyName,
    modifiers,
  })

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    code: keyName,
    modifiers,
  })

  return { key, pressed: true }
}

async function focusElement(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const { value } = await evaluateInTabContext<ElementActionResult>(
    tab.id,
    `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) return { found: false };
      node.focus();
      return { found: true, focused: document.activeElement === node };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  if (value?.found) {
    return value
  }

  throw new Error(`element not found: ${selector}`)
}

async function selectOption(
  tabId: TabInput,
  selector: string,
  value: string,
  frameSelector: FrameSelector,
) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const { value: result } = await evaluateInTabContext<ElementActionResult>(
    tab.id,
    `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) return { found: false };
      node.focus();
      node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, value: node.value };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  if (result?.found) {
    return result
  }
  throw new Error(`element not found: ${selector}`)
}

async function checkElement(
  tabId: TabInput,
  selector: string,
  checked: boolean,
  frameSelector: FrameSelector,
) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const { value: result } = await evaluateInTabContext<ElementActionResult>(
    tab.id,
    `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) return { found: false };
      node.focus();
      node.checked = ${checked};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, checked: node.checked };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  if (result?.found) {
    return result
  }
  throw new Error(`element not found: ${selector}`)
}

async function scrollElement(
  tabId: TabInput,
  selector: string | null,
  deltaX = 0,
  deltaY = 100,
  frameSelector: FrameSelector,
) {
  let resolvedSelector = ''
  if (selector) {
    ;({ resolvedSelector } = await resolveElementSelectorForTab(tabId, selector))
  }
  const { value } = await evaluateInTabContext<ElementActionResult>(
    tabId,
    `(() => {
      ${
        selector
          ? `
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) return { found: false };
      node.scrollIntoView({ block: 'center', inline: 'center' });
      `
          : ''
      }
      window.scrollBy(${deltaX}, ${deltaY});
      return { found: true, scrolled: true };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  return value || { found: true, scrolled: true }
}

async function dragElement(
  tabId: TabInput,
  startSelector: string,
  endSelector: string,
  frameSelector: FrameSelector,
) {
  const startBox = await getElementBox(tabId, startSelector, frameSelector)
  if (!startBox) {
    throw new Error(`start element not found: ${startSelector}`)
  }

  let endBox: ElementBox
  if (endSelector) {
    const resolvedEndBox = await getElementBox(tabId, endSelector, frameSelector)
    if (!resolvedEndBox) {
      throw new Error(`end element not found: ${endSelector}`)
    }
    endBox = resolvedEndBox
  } else {
    endBox = {
      x: startBox.x,
      y: startBox.y + 100,
      width: startBox.width,
      height: startBox.height,
    }
  }

  const tab = await getTargetTab(tabId)

  // mousePressed
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startBox.x,
    y: startBox.y,
    button: 'left',
    clickCount: 1,
  })

  // mouseMoved - 分 10 步平滑移动
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    const x = startBox.x + (endBox.x - startBox.x) * (i / steps)
    const y = startBox.y + (endBox.y - startBox.y) * (i / steps)
    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }

  // mouseReleased
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endBox.x,
    y: endBox.y,
    button: 'left',
    clickCount: 1,
  })

  return { found: true, dragged: true }
}

async function uploadFiles(
  tabId: TabInput,
  selector: string,
  filePaths: string[],
  frameSelector: FrameSelector,
) {
  const { resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const { tab, executionContextId } = await getFrameExecutionContext(tabId, frameSelector)
  const result = await sendDebuggerCommand<{ result?: { objectId?: string } }>(
    tab.id,
    'Runtime.evaluate',
    {
      expression: `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      return node && node.tagName === 'INPUT' && node.type === 'file' ? node : null;
    })()`,
      awaitPromise: true,
      returnByValue: false,
      ...(executionContextId ? { contextId: executionContextId } : {}),
    },
  )

  const objectId = result?.result?.objectId
  if (!objectId) {
    throw new Error(`file input not found: ${selector}`)
  }

  try {
    await sendDebuggerCommand(tab.id, 'DOM.setFileInputFiles', {
      files: filePaths,
      objectId,
    })
  } finally {
    await sendDebuggerCommand(tab.id, 'Runtime.releaseObject', {
      objectId,
    }).catch(() => {})
  }

  return { found: true, files: filePaths }
}

async function navigateBack(tabId: TabInput) {
  const tab = await getTargetTab(tabId)
  invalidatePageRefs(state, tab.id)
  // 获取导航历史
  const history = await sendDebuggerCommand<{
    entries?: Array<{ id: number }>
    currentIndex?: number
  }>(tab.id, 'Page.getNavigationHistory')
  const entries = history.entries || []
  const currentIndex = history.currentIndex

  if (typeof currentIndex === 'number' && currentIndex > 0) {
    const targetIndex = currentIndex - 1
    const targetEntry = entries[targetIndex]
    if (targetEntry) {
      await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
        entryId: targetEntry.id,
      })
      return { navigated: true, back: true }
    }
  }
  return { navigated: false, reason: 'no back history' }
}

async function navigateForward(tabId: TabInput) {
  const tab = await getTargetTab(tabId)
  invalidatePageRefs(state, tab.id)
  const history = await sendDebuggerCommand<{
    entries?: Array<{ id: number }>
    currentIndex?: number
  }>(tab.id, 'Page.getNavigationHistory')
  const entries = history.entries || []
  const currentIndex = history.currentIndex

  if (typeof currentIndex === 'number' && currentIndex < entries.length - 1) {
    const targetIndex = currentIndex + 1
    const targetEntry = entries[targetIndex]
    if (targetEntry) {
      await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
        entryId: targetEntry.id,
      })
      return { navigated: true, forward: true }
    }
  }
  return { navigated: false, reason: 'no forward history' }
}

async function reloadPage(tabId: TabInput) {
  const tab = await getTargetTab(tabId)
  invalidatePageRefs(state, tab.id)
  await sendDebuggerCommand(tab.id, 'Page.reload', {})
  return { reloaded: true }
}

async function createWindow() {
  const window = await windowsCreate({
    url: 'about:blank',
    focused: true,
  })
  return { windowId: window?.id ?? null, tabId: window?.tabs?.[0]?.id ?? null }
}

async function switchToFrame(tabId: TabInput, selector: string) {
  const tab = await getTargetTab(tabId)
  if (['top', 'main', 'default'].includes(selector)) {
    clearSelectedFrame(state, tab.id)
    return {
      found: true,
      cleared: true,
      pageEpoch: getPageEpoch(state, tab.id),
      frame: null as null,
    }
  }

  const frame = await resolveFrameTarget(tab.id, selector)
  state.selectedFrames.set(tab.id, selector)
  return {
    found: true,
    pageEpoch: frame.pageEpoch,
    frame: {
      ref: frame.ref,
      selector: frame.selector,
      src: frame.src,
    },
  }
}

async function findSemanticTarget(
  tabId: TabInput,
  args: CommandArgs,
  frameSelector: FrameSelector,
): Promise<SemanticTargetResult> {
  const tab = await getTargetTab(tabId)
  const pageEpoch = getPageEpoch(state, tab.id)
  const strategy = readStringArg(args, 'strategy').trim()
  const role = readStringArg(args, 'role').trim()
  const query = readStringArg(args, 'query').trim()
  const name = readStringArg(args, 'name').trim()
  const exact = args.exact === true

  if (!['role', 'text', 'label'].includes(strategy)) {
    throw new Error(`unsupported find strategy: ${strategy || '(empty)'}`)
  }

  if (strategy === 'role' && !role) {
    throw new Error('missing role value')
  }

  if (strategy !== 'role' && !query) {
    throw new Error(`missing ${strategy} value`)
  }

  const { value } = await evaluateInTabContext<SemanticTargetResult>(
    tab.id,
    `(() => {
      const refAttribute = ${JSON.stringify(AGENT_ELEMENT_REF_ATTRIBUTE)};
      const pageEpoch = ${pageEpoch};
      const strategy = ${JSON.stringify(strategy)};
      const role = ${JSON.stringify(role.toLowerCase())};
      const query = ${JSON.stringify(query)};
      const name = ${JSON.stringify(name)};
      const exact = ${exact ? 'true' : 'false'};
      const actionableSelector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role],[tabindex]:not([tabindex="-1"])';

${PAGE_CONTEXT_FIND_HELPERS_SOURCE}

      const normalizeText = (value) => collapseWhitespace(value);

      const matchesText = (candidate, needle) => {
        const normalizedCandidate = normalizeText(candidate).toLowerCase();
        const normalizedNeedle = normalizeText(needle).toLowerCase();
        if (!normalizedNeedle) {
          return false;
        }

        return exact
          ? normalizedCandidate === normalizedNeedle
          : normalizedCandidate.includes(normalizedNeedle);
      };

      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }

        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
      };

      const readText = (node) => normalizeText(node?.innerText || node?.textContent || '');

      const getAssociatedLabelText = (node) => {
        const labels = [];

        if ('labels' in node && node.labels) {
          labels.push(
            ...Array.from(node.labels)
              .map((label) => readText(label))
              .filter(Boolean),
          );
        }

        if (node.id) {
          try {
            const externalLabel = document.querySelector('label[for="' + CSS.escape(node.id) + '"]');
            if (externalLabel) {
              labels.push(readText(externalLabel));
            }
          } catch {
            // Ignore invalid selectors.
          }
        }

        return normalizeText(labels.join(' '));
      };

      const getAriaLabelledByText = (node) => {
        const labelledBy = normalizeText(node.getAttribute('aria-labelledby'));
        if (!labelledBy) {
          return '';
        }

        return normalizeText(
          splitWhitespaceTokens(labelledBy)
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map((element) => readText(element))
            .filter(Boolean)
            .join(' '),
        );
      };

      const inferRole = (node) => {
        const explicitRole = normalizeText(node.getAttribute('role'));
        if (explicitRole) {
          return explicitRole.toLowerCase();
        }

        const tagName = String(node.tagName || '').toLowerCase();
        if (tagName === 'a' && node.getAttribute('href')) return 'link';
        if (tagName === 'button') return 'button';
        if (tagName === 'select') return 'combobox';
        if (tagName === 'textarea') return 'textbox';
        if (tagName === 'summary') return 'button';
        if (tagName === 'input') {
          const inputType = normalizeText(node.getAttribute('type') || 'text').toLowerCase();
          if (['button', 'submit', 'reset'].includes(inputType)) return 'button';
          if (inputType === 'checkbox') return 'checkbox';
          if (inputType === 'radio') return 'radio';
          return 'textbox';
        }

        return null;
      };

      const getAccessibleName = (node) => {
        const candidates = [
          normalizeText(node.getAttribute('aria-label')),
          getAriaLabelledByText(node),
          getAssociatedLabelText(node),
          normalizeText(node.getAttribute('alt')),
          normalizeText(node.getAttribute('title')),
          normalizeText(node.getAttribute('placeholder')),
          typeof node.value === 'string' ? normalizeText(node.value) : '',
          readText(node),
        ];

        return candidates.find(Boolean) || '';
      };

      const uniqueCandidates = (selectors) => {
        const seen = new Set();
        const candidates = [];

        for (const selector of selectors) {
          for (const node of document.querySelectorAll(selector)) {
            if (!(node instanceof HTMLElement) || seen.has(node)) {
              continue;
            }

            seen.add(node);
            if (isVisible(node)) {
              candidates.push(node);
            }
          }
        }

        return candidates;
      };

      const interactiveCandidates = uniqueCandidates([
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'summary',
        '[role]',
        '[tabindex]:not([tabindex="-1"])',
      ]);

      const broadTextCandidates = Array.from(document.querySelectorAll('body *')).filter(
        (node) => node instanceof HTMLElement && isVisible(node),
      );

      const pickActionableNode = (node) => {
        if (!(node instanceof HTMLElement)) {
          return null;
        }

        return node.matches(actionableSelector) ? node : node.closest(actionableSelector) || node;
      };

      const ensureRef = (node) => {
        const currentRef = normalizeText(node.getAttribute(refAttribute));
        if (currentRef) {
          return '@' + currentRef + '#p' + pageEpoch;
        }

        let maxIndex = 0;
        for (const element of document.querySelectorAll('[' + refAttribute + ']')) {
          const refValue = normalizeText(element.getAttribute(refAttribute));
          const refIndex = parsePageContextElementRefIndex(refValue);
          if (refIndex !== null) {
            maxIndex = Math.max(maxIndex, refIndex);
          }
        }

        const refValue = 'e' + (maxIndex + 1);
        node.setAttribute(refAttribute, refValue);
        return '@' + refValue + '#p' + pageEpoch;
      };

      let match = null;

      if (strategy === 'role') {
        match = interactiveCandidates.find((node) => {
          if (inferRole(node) !== role) {
            return false;
          }

          if (!name) {
            return true;
          }

          return matchesText(getAccessibleName(node), name);
        }) || null;
      }

      if (strategy === 'text') {
        match = interactiveCandidates.find((node) => {
          return matchesText(getAccessibleName(node), query) || matchesText(readText(node), query);
        }) || null;

        if (!match) {
          match = broadTextCandidates.find((node) => matchesText(readText(node), query)) || null;
        }

        match = pickActionableNode(match);
      }

      if (strategy === 'label') {
        match = uniqueCandidates(['input:not([type="hidden"])', 'textarea', 'select']).find((node) => {
          return (
            matchesText(getAssociatedLabelText(node), query) ||
            matchesText(getAccessibleName(node), query)
          );
        }) || null;
      }

      if (!match) {
        return {
          found: false,
          reason:
            strategy === 'role'
              ? 'no role match found: ' + role + (name ? ' (' + name + ')' : '')
              : 'no ' + strategy + ' match found: ' + query,
        };
      }

      const rect = match.getBoundingClientRect();
      return {
        found: true,
        pageEpoch,
        match: {
          ref: ensureRef(match),
          tag: String(match.tagName || '').toLowerCase(),
          role: inferRole(match),
          text: readText(match).slice(0, 240),
          name: getAccessibleName(match).slice(0, 240),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  if (!value?.found || !value?.match?.ref) {
    throw new Error(value?.reason || `failed to find ${strategy} target`)
  }

  return value
}

async function handleFindCommand(tabId: TabInput, args: CommandArgs, frameSelector: FrameSelector) {
  const action = readStringArg(args, 'action', 'locate').trim()
  const actionValue = readStringArg(args, 'value')
  const result = await findSemanticTarget(tabId, args, frameSelector)
  const ref = result.match?.ref
  if (!ref) {
    throw new Error(result.reason || 'semantic target ref missing')
  }

  if (action === 'locate') {
    return result
  }

  if (action === 'click') {
    return { ...result, action, result: await clickSelector(tabId, ref, frameSelector) }
  }

  if (action === 'fill') {
    return {
      ...result,
      action,
      result: await fillSelector(tabId, ref, actionValue, frameSelector),
    }
  }

  if (action === 'type') {
    return {
      ...result,
      action,
      result: await typeIntoSelector(tabId, ref, actionValue, frameSelector),
    }
  }

  if (action === 'hover') {
    return { ...result, action, result: await hoverElement(tabId, ref, frameSelector) }
  }

  if (action === 'focus') {
    return { ...result, action, result: await focusElement(tabId, ref, frameSelector) }
  }

  if (action === 'check') {
    return { ...result, action, result: await checkElement(tabId, ref, true, frameSelector) }
  }

  if (action === 'uncheck') {
    return { ...result, action, result: await checkElement(tabId, ref, false, frameSelector) }
  }

  if (action === 'text') {
    const textResult = await getAttribute(tabId, ref, 'text', frameSelector)
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

async function checkIsState(
  tabId: TabInput,
  selector: string,
  stateType: string,
  frameSelector: FrameSelector,
) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const checkJs = {
    visible: `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    })()`,
    enabled: `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      return node && !node.disabled;
    })()`,
    checked: `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      return node && node.checked === true;
    })()`,
    disabled: `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      return node && node.disabled === true;
    })()`,
    focused: `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      return node && node === node.ownerDocument.activeElement;
    })()`,
  }

  const normalizedStateType = stateType as keyof typeof checkJs
  const js = checkJs[normalizedStateType]
  if (!js) {
    throw new Error(`unknown state type: ${stateType}`)
  }

  const { value } = await evaluateInTabContext(tab.id, js, withFrameSelectorOptions(frameSelector))
  return {
    found: true,
    state: stateType,
    value,
  }
}

async function getAttribute(
  tabId: TabInput,
  selector: string,
  attrName: string,
  frameSelector: FrameSelector,
) {
  if (attrName === 'cdp-url') {
    if (!state.token) {
      throw new Error('missing token')
    }

    return {
      found: true,
      value: `ws://127.0.0.1:${state.relayPort}/ws?token=${encodeURIComponent(state.token)}`,
    }
  }

  const selectorContext = ['title', 'url'].includes(attrName)
    ? null
    : await resolveElementSelectorForTab(tabId, selector)
  const resolvedSelector = selectorContext?.resolvedSelector || resolveAgentSelector(selector)
  const resolvedTabId = selectorContext?.tab.id ?? tabId

  if (attrName === 'text') {
    const { value } = await evaluateInTabContext(
      resolvedTabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node ? node.textContent : null;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  if (attrName === 'html') {
    const { value } = await evaluateInTabContext(
      resolvedTabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node ? node.innerHTML : null;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  if (attrName === 'value') {
    const { value } = await evaluateInTabContext(
      resolvedTabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node ? node.value : null;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  if (attrName === 'title') {
    const { value } = await evaluateInTabContext(
      resolvedTabId,
      'document.title',
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  if (attrName === 'url') {
    const { value } = await evaluateInTabContext(
      resolvedTabId,
      'window.location.href',
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  if (attrName === 'count') {
    const { value } = await evaluateInTabContext(
      resolvedTabId,
      `(() => {
        return document.querySelectorAll(${JSON.stringify(resolvedSelector)}).length;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  if (attrName === 'box') {
    const { value } = await evaluateInTabContext(
      resolvedTabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  if (attrName === 'styles') {
    const { value } = await evaluateInTabContext(
      resolvedTabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return null;
        const styles = window.getComputedStyle(node);
        return Object.fromEntries(Array.from(styles).map((name) => [name, styles.getPropertyValue(name)]));
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  // 其他属性
  const { value } = await evaluateInTabContext(
    resolvedTabId,
    `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      return node ? node.getAttribute(${JSON.stringify(attrName)}) : null;
    })()`,
    withFrameSelectorOptions(frameSelector),
  )
  return { found: true, value }
}

async function waitFor(
  tabId: TabInput,
  condition: string,
  timeout = 30000,
  frameSelector: FrameSelector,
) {
  const startTime = Date.now()

  if (condition === 'load') {
    const tab = await getTargetTab(tabId)
    // 等待页面加载
    return new Promise((resolve, reject) => {
      const listener = (source: { tabId?: number }, method: string) => {
        if (source.tabId === tab.id && method === 'Page.loadEventFired') {
          chrome.debugger.onEvent.removeListener(listener)
          clearTimeout(timeoutId)
          resolve({ waited: true, condition: 'load' })
        }
      }
      const timeoutId = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener)
        reject(new Error('wait load timeout'))
      }, timeout)

      chrome.debugger.onEvent.addListener(listener)

      // 启用 Page domain
      sendDebuggerCommand(tab.id, 'Page.enable', {}).catch((err) => {
        chrome.debugger.onEvent.removeListener(listener)
        clearTimeout(timeoutId)
        reject(err)
      })
    })
  }

  if (condition === 'networkidle') {
    const tab = await getTargetTab(tabId)
    // 等待网络空闲
    return new Promise((resolve, reject) => {
      const listener = (source: { tabId?: number }, method: string, params?: { name?: string }) => {
        if (
          source.tabId === tab.id &&
          method === 'Page.lifecycleEvent' &&
          params?.name === 'networkidle'
        ) {
          chrome.debugger.onEvent.removeListener(listener)
          clearTimeout(timeoutId)
          resolve({ waited: true, condition: 'networkidle' })
        }
      }
      const timeoutId = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener)
        reject(new Error('wait networkidle timeout'))
      }, timeout)

      chrome.debugger.onEvent.addListener(listener)

      Promise.all([
        sendDebuggerCommand(tab.id, 'Page.enable', {}),
        sendDebuggerCommand(tab.id, 'Page.setLifecycleEventsEnabled', { enabled: true }),
      ]).catch((err) => {
        chrome.debugger.onEvent.removeListener(listener)
        clearTimeout(timeoutId)
        reject(err)
      })
    })
  }

  const { tab, resolvedSelector: resolvedCondition } = await resolveElementSelectorForTab(
    tabId,
    condition,
  )

  // 轮询方式等待 selector
  while (Date.now() - startTime < timeout) {
    const { value } = await evaluateInTabContext(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedCondition)});
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value === true) {
      return { waited: true, condition: 'selector', selector: condition }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`wait selector timeout: ${condition}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(pattern: string): RegExp {
  const escaped = escapeRegExp(pattern)
    .replaceAll('\\*\\*', '.*')
    .replaceAll('\\*', '[^/]*')
    .replaceAll('\\?', '.')
  return new RegExp(`^${escaped}$`)
}

function matchesUrlPattern(currentUrl: string, pattern: string): boolean {
  const normalizedPattern = String(pattern || '').trim()
  if (!normalizedPattern) {
    return false
  }

  if (currentUrl.includes(normalizedPattern)) {
    return true
  }

  if (normalizedPattern.includes('*') || normalizedPattern.includes('?')) {
    try {
      return globToRegExp(normalizedPattern).test(currentUrl)
    } catch {
      return false
    }
  }

  try {
    return new RegExp(normalizedPattern).test(currentUrl)
  } catch {
    return false
  }
}

async function waitForSelectorState(
  tabId: TabInput,
  selector: string,
  state = 'visible',
  timeout = 30000,
  frameSelector: FrameSelector,
) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const startTime = Date.now()
  const hidden = state === 'hidden'

  while (Date.now() - startTime < timeout) {
    const { value } = await evaluateInTabContext(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        const visible = Boolean(node) && (() => {
          const rect = node.getBoundingClientRect();
          const style = node.ownerDocument.defaultView.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        })();
        return ${hidden ? '!visible' : 'visible'};
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value === true) {
      return { waited: true, condition: 'selector', selector, state }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`wait selector timeout: ${selector}`)
}

async function waitForUrl(
  tabId: TabInput,
  urlPattern: string,
  timeout = 30000,
  frameSelector: FrameSelector,
) {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const { value } = await evaluateInTabContext<string>(
      tabId,
      'window.location.href',
      withFrameSelectorOptions(frameSelector),
    )
    const currentUrl = value || ''
    if (matchesUrlPattern(currentUrl, urlPattern)) {
      return {
        waited: true,
        condition: 'url',
        url: currentUrl,
        pattern: urlPattern,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`wait url timeout: ${urlPattern}`)
}

async function waitForText(
  tabId: TabInput,
  text: string,
  timeout = 30000,
  frameSelector: FrameSelector,
) {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const { value } = await evaluateInTabContext<string>(
      tabId,
      "document.body ? document.body.innerText : ''",
      withFrameSelectorOptions(frameSelector),
    )
    const pageText = (value || '').toLowerCase()
    if (pageText.includes(text.toLowerCase())) {
      return { waited: true, condition: 'text', text }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`wait text timeout: ${text}`)
}

async function waitForExpression(
  tabId: TabInput,
  expression: string,
  timeout = 30000,
  frameSelector: FrameSelector,
) {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const { value } = await evaluateInTabContext(
      tabId,
      `(() => {
        try {
          return Boolean(Function('return (' + ${JSON.stringify(expression)} + ')')());
        } catch (error) {
          return false;
        }
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value === true) {
      return { waited: true, condition: 'fn', expression }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`wait fn timeout: ${expression}`)
}

async function waitWithTimeout(tabId: TabInput, ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { waited: true, condition: 'time', ms }
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

  if (waitType === 'time' || waitMs > 0) {
    return await waitWithTimeout(tabId, waitMs || timeout)
  }

  if (waitType === 'selector' || waitSelector) {
    return await waitForSelectorState(tabId, waitSelector, waitState, timeout, frameSelector)
  }

  if (waitType === 'url' || waitUrl) {
    return await waitForUrl(tabId, waitUrl, timeout, frameSelector)
  }

  if (waitType === 'text' || waitText) {
    return await waitForText(tabId, waitText, timeout, frameSelector)
  }

  if (waitType === 'load') {
    return await waitFor(tabId, 'load', timeout, frameSelector)
  }

  if (waitType === 'networkidle') {
    return await waitFor(tabId, 'networkidle', timeout, frameSelector)
  }

  if (waitType === 'fn' || waitFn) {
    return await waitForExpression(tabId, waitFn, timeout, frameSelector)
  }

  throw new Error(`unsupported wait type: ${waitType}`)
}

// Cookies commands
async function cookiesGet(tabId: TabInput) {
  const tab = await getTargetTab(tabId)
  const result = await sendDebuggerCommand<{ cookies?: unknown[] }>(
    tab.id,
    'Network.getCookies',
    {},
  )
  return { cookies: result.cookies || [] }
}

async function cookiesSet(tabId: TabInput, name: string, value: string, domain?: string) {
  const tab = await getTargetTab(tabId)
  const cookie: { name: string; value: string; domain?: string } = { name, value }
  if (domain) {
    cookie.domain = domain
  }
  await sendDebuggerCommand(tab.id, 'Network.setCookie', cookie)
  return { set: true, name, value, domain }
}

async function cookiesClear(tabId: TabInput) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Network.clearBrowserCookies', {})
  return { cleared: true }
}

// Storage commands
async function storageGet(
  tabId: TabInput,
  key: string | null | undefined,
  frameSelector: FrameSelector,
) {
  if (!key) {
    // 获取所有 localStorage
    const { value } = await evaluateInTabContext(
      tabId,
      `(() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          items[k] = localStorage.getItem(k);
        }
        return items;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return { storage: value || {} }
  }

  const { value } = await evaluateInTabContext(
    tabId,
    `localStorage.getItem(${JSON.stringify(key)})`,
    withFrameSelectorOptions(frameSelector),
  )
  return { key, value }
}

async function storageSet(
  tabId: TabInput,
  key: string,
  value: string,
  frameSelector: FrameSelector,
) {
  await evaluateInTabContext(
    tabId,
    `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    withFrameSelectorOptions(frameSelector),
  )
  return { key, value, set: true }
}

async function storageClear(tabId: TabInput, frameSelector: FrameSelector) {
  await evaluateInTabContext(tabId, 'localStorage.clear()', withFrameSelectorOptions(frameSelector))
  return { cleared: true }
}

// Set commands
async function setViewport(
  tabId: TabInput,
  width: number,
  height: number,
  deviceScaleFactor = 1,
  mobile = false,
) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Emulation.setDeviceMetricsOverride', {
    width: Number(width),
    height: Number(height),
    deviceScaleFactor: Number(deviceScaleFactor),
    mobile,
  })
  return { viewport: { width, height, deviceScaleFactor, mobile } }
}

async function setOffline(tabId: TabInput, enabled: boolean) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Network.emulateNetworkConditions', {
    offline: enabled,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  return { offline: enabled }
}

async function setHeaders(
  tabId: TabInput,
  headers: Array<{ name?: string; value?: unknown }> | Record<string, unknown> | null | undefined,
) {
  const tab = await getTargetTab(tabId)
  const normalizedHeaders = Array.isArray(headers)
    ? Object.fromEntries(
        headers
          .filter((header) => header?.name)
          .map((header) => [String(header.name), String(header.value ?? '')]),
      )
    : Object.fromEntries(
        Object.entries(headers && typeof headers === 'object' ? headers : {}).map(
          ([name, value]) => [String(name), String(value ?? '')],
        ),
      )
  await sendDebuggerCommand(tab.id, 'Network.enable', {})
  await sendDebuggerCommand(tab.id, 'Network.setExtraHTTPHeaders', {
    headers: normalizedHeaders,
  })
  return { headers: normalizedHeaders }
}

async function setGeo(tabId: TabInput, latitude: number, longitude: number, accuracy = 1) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Emulation.setGeolocationOverride', {
    latitude: Number(latitude),
    longitude: Number(longitude),
    accuracy: Number(accuracy),
  })
  return { geo: { latitude, longitude, accuracy } }
}

async function setMedia(tabId: TabInput, media: string | null | undefined) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Emulation.setEmulatedMedia', {
    features: media ? [{ name: 'prefers-color-scheme', value: media }] : [],
  })
  return { media }
}

async function generatePdf(tabId: TabInput) {
  const tab = await getTargetTab(tabId)
  const result = await sendDebuggerCommand<{ data: string }>(tab.id, 'Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.5,
    paperHeight: 11,
  })
  return {
    tabId: tab.id,
    mimeType: 'application/pdf',
    dataUrl: `data:application/pdf;base64,${result.data}`,
  }
}

async function clipboardRead(tabId: TabInput) {
  const tab = await getTargetTab(tabId)
  // 首先请求剪贴板权限
  try {
    await sendDebuggerCommand(tab.id, 'Browser.setPermission', {
      permission: { name: 'clipboardReadWrite' },
      setting: 'granted',
    })
  } catch (error) {
    console.warn('clipboard read permission request failed', error)
  }

  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
      return navigator.clipboard.readText().catch(() => '');
    })()`,
  )
  return { text: value || '' }
}

async function clipboardWrite(tabId: TabInput, text: string) {
  const tab = await getTargetTab(tabId)
  try {
    await sendDebuggerCommand(tab.id, 'Browser.setPermission', {
      permission: { name: 'clipboardReadWrite' },
      setting: 'granted',
    })
  } catch (error) {
    console.warn('clipboard write permission request failed', error)
  }

  await evaluateInTabContext(
    tabId,
    `navigator.clipboard.writeText(${JSON.stringify(text)}).catch(() => {})`,
  )
  return { written: true, text }
}

async function saveState(tabId: TabInput, name: string) {
  const tab = await getTargetTab(tabId)
  const cookiesResult = await sendDebuggerCommand<{ cookies?: unknown[] }>(
    tab.id,
    'Network.getCookies',
    {},
  )
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        items[k] = localStorage.getItem(k);
      }
      return items;
    })()`,
  )
  const savedState: SavedStateData = {
    name,
    cookies: (cookiesResult.cookies || []) as SavedStateData['cookies'],
    storage: value && typeof value === 'object' ? (value as SavedStateData['storage']) : {},
  }
  const savedStates = await getSavedStates()
  await storageLocalSet({
    [SAVED_STATES_STORAGE_KEY]: {
      ...savedStates,
      [name]: savedState,
    },
  })

  return {
    ...savedState,
    saved: true,
  }
}

async function loadState(tabId: TabInput, stateData: SavedStateData) {
  const tab = await getTargetTab(tabId)

  // 恢复 cookies
  if (stateData.cookies && stateData.cookies.length > 0) {
    for (const cookie of stateData.cookies) {
      await sendDebuggerCommand(tab.id, 'Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
      })
    }
  }

  // 恢复 storage
  if (stateData.storage) {
    for (const [key, value] of Object.entries(stateData.storage)) {
      await evaluateInTabContext(
        tab.id,
        `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
      )
    }
  }

  return { loaded: true, name: stateData.name }
}

async function handleDialog(tabId: TabInput, accept: boolean, promptText?: string) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Page.enable', {})

  try {
    await sendDebuggerCommand(tab.id, 'Page.handleJavaScriptDialog', {
      accept,
      promptText: accept ? promptText || '' : undefined,
    })
    state.dialog = null
    return { handled: true, accepted: accept }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.toLowerCase().includes('no dialog')) {
      return { handled: false, reason: 'no dialog opened' }
    }

    throw error
  }
}

function getDialogStatus(): Record<string, unknown> {
  if (!state.dialog) {
    return {
      open: false,
      type: null,
      message: null,
      defaultPrompt: null,
      url: null,
      openedAt: null,
    }
  }

  return {
    ...state.dialog,
  }
}

async function fillSelector(
  tabId: TabInput,
  selector: string,
  value: string,
  frameSelector: FrameSelector,
) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const { value: result } = await evaluateInTabContext<ElementActionResult>(
    tab.id,
    `(() => {
      const node = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!node) {
        return { found: false };
      }

      if (!("value" in node)) {
        return { found: false, reason: "element does not accept value" };
      }

      node.focus();
      node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true, selector: ${JSON.stringify(selector)} };
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  return result
}

async function dispatchInsertText(tabId: TabInput, text: string) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Input.insertText', {
    text: String(text || ''),
  })
  return { inserted: true, text }
}

async function insertTextSequentially(tabId: TabInput, text: string) {
  const normalizedText = String(text || '')

  for (const character of normalizedText) {
    await dispatchInsertText(tabId, character)
  }

  return { typed: true, text: normalizedText }
}

async function insertTextOnce(tabId: TabInput, text: string) {
  return await dispatchInsertText(tabId, text)
}

async function keyDownOnly(tabId: TabInput, key: string) {
  const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
  const tab = await getTargetTab(tabId)

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyName,
    code: keyName,
    modifiers,
  })

  return { key, pressed: true, type: 'keydown' }
}

async function keyUpOnly(tabId: TabInput, key: string) {
  const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
  const tab = await getTargetTab(tabId)

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    code: keyName,
    modifiers,
  })

  return { key, released: true, type: 'keyup' }
}

async function typeIntoSelector(
  tabId: TabInput,
  selector: string,
  value: string,
  frameSelector: FrameSelector,
) {
  await focusElement(tabId, selector, frameSelector)
  const typed = await insertTextSequentially(tabId, value)
  return {
    found: true,
    selector,
    ...typed,
  }
}

async function doubleClickSelector(
  tabId: TabInput,
  selector: string,
  frameSelector: FrameSelector,
) {
  const box = await getElementBox(tabId, selector, frameSelector)
  if (!box) {
    throw new Error(`element not found: ${selector}`)
  }

  const tab = await getTargetTab(tabId)

  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 2,
  })
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 2,
  })

  return { found: true, selector, doubleClicked: true }
}

async function scrollIntoViewSelector(
  tabId: TabInput,
  selector: string,
  frameSelector: FrameSelector,
) {
  const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
  const { value } = await evaluateInTabContext<ElementActionResult>(
    tab.id,
    `(() => {
      try {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false, reason: 'element not found' };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        return { found: true, selector: ${JSON.stringify(selector)} };
      } catch (error) {
        return {
          found: false,
          reason: error instanceof Error ? error.message : 'failed to scroll into view',
        };
      }
    })()`,
    withFrameSelectorOptions(frameSelector),
  )

  return value
}

async function closeTabs(tabId: TabInput, closeAll: boolean) {
  if (closeAll) {
    const tabs = await tabsQuery({
      currentWindow: true,
    })
    const tabIds = tabs.map((tab) => tab.id).filter((tabId) => typeof tabId === 'number')
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

async function handleCommand(message: CommandMessage) {
  const { command, args = {} } = message
  const tabId = readTabInputArg(args, 'tabId')
  const handle = readTabInputArg(args, 'handle')
  const frameSelector = readFrameSelectorArg(args, 'frame')
  const action = readStringArg(args, 'action')
  const url = readStringArg(args, 'url', 'about:blank')
  const script = readStringArg(args, 'script', 'document.title')
  const selector = readStringArg(args, 'selector')
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
  const tabTarget = handle || tabId

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
      return await navigateTo(tabId, url)
    case 'eval':
      return await evaluateScript(tabId, script, frameSelector)
    case 'snapshot':
      return await snapshotTab(tabId, frameSelector)
    case 'screenshot':
      return await captureScreenshot(tabId, screenshotOptions, frameSelector)
    case 'click':
      return await clickSelector(tabId, selector, frameSelector)
    case 'dblclick':
      return await doubleClickSelector(tabId, selector, frameSelector)
    case 'fill':
      return await fillSelector(tabId, selector, value, frameSelector)
    case 'find':
      return await handleFindCommand(tabId, args, frameSelector)
    case 'type':
      return await typeIntoSelector(tabId, selector, value, frameSelector)
    case 'hover':
      return await hoverElement(tabId, selector, frameSelector)
    case 'press':
      return await pressKey(tabId, key)
    case 'keyboard':
      if (action === 'type') {
        return await insertTextSequentially(tabId, text)
      }
      if (action === 'inserttext') {
        return await insertTextOnce(tabId, text)
      }
      if (action === 'keydown') {
        return await keyDownOnly(tabId, text)
      }
      if (action === 'keyup') {
        return await keyUpOnly(tabId, text)
      }
      throw new Error(`unsupported keyboard action: ${action}`)
    case 'focus':
      return await focusElement(tabId, selector, frameSelector)
    case 'select':
      return await selectOption(tabId, selector, value, frameSelector)
    case 'check':
      return await checkElement(tabId, selector, true, frameSelector)
    case 'uncheck':
      return await checkElement(tabId, selector, false, frameSelector)
    case 'scroll':
      return await scrollElement(tabId, scrollSelector, deltaX, deltaY, frameSelector)
    case 'scrollintoview':
      return await scrollIntoViewSelector(tabId, selector, frameSelector)
    case 'drag':
      return await dragElement(tabId, start, end, frameSelector)
    case 'upload':
      return await uploadFiles(tabId, selector, files, frameSelector)
    case 'back':
      return await navigateBack(tabId)
    case 'forward':
      return await navigateForward(tabId)
    case 'reload':
      return await reloadPage(tabId)
    case 'close':
      return await closeTabs(tabId, readBooleanArg(args, 'all', false))
    case 'window':
      if (action === 'new') {
        return await createWindow()
      }
      throw new Error(`unsupported window action: ${action}`)
    case 'frame':
      return await switchToFrame(tabId, selector)
    case 'is':
      return await checkIsState(tabId, selector, stateName, frameSelector)
    case 'get':
      return await getAttribute(tabId, selector, attr, frameSelector)
    case 'dialog':
      if (action === 'status') {
        return getDialogStatus()
      }
      return await handleDialog(tabId, accept, promptText)
    case 'wait':
      return await handleWait(tabId, args, frameSelector)
    case 'cookies':
      if (action === 'get') {
        return await cookiesGet(tabId)
      }
      if (action === 'set') {
        return await cookiesSet(tabId, name, value, domain)
      }
      if (action === 'clear') {
        return await cookiesClear(tabId)
      }
      throw new Error(`unsupported cookies action: ${action}`)
    case 'storage':
      if (action === 'get') {
        return await storageGet(tabId, storageKey, frameSelector)
      }
      if (action === 'set') {
        return await storageSet(tabId, storageKey || '', storageValue, frameSelector)
      }
      if (action === 'clear') {
        return await storageClear(tabId, frameSelector)
      }
      throw new Error(`unsupported storage action: ${action}`)
    case 'console':
      return { messages: state.consoleMessages }
    case 'errors':
      return { errors: state.pageErrors }
    case 'network':
      if (action === 'route') {
        return await network.routeRequest(tabId, url, args.abort === true, args.body)
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
          return await network.startHar(tabId)
        }
        if (subaction === 'stop') {
          return network.stopHar()
        }
        throw new Error(`unsupported network har action: ${subaction}`)
      }
      throw new Error(`unsupported network action: ${action}`)
    case 'set':
      if (readStringArg(args, 'type') === 'viewport') {
        return await setViewport(tabId, viewportWidth, viewportHeight, deviceScaleFactor, mobile)
      }
      if (readStringArg(args, 'type') === 'offline') {
        return await setOffline(tabId, enabled)
      }
      if (readStringArg(args, 'type') === 'headers') {
        return await setHeaders(tabId, headers)
      }
      if (readStringArg(args, 'type') === 'geo') {
        return await setGeo(tabId, latitude, longitude, accuracy)
      }
      if (readStringArg(args, 'type') === 'media') {
        return await setMedia(tabId, media)
      }
      throw new Error(`unsupported set type: ${readStringArg(args, 'type')}`)
    case 'pdf':
      return await generatePdf(tabId)
    case 'clipboard':
      if (action === 'read') {
        return await clipboardRead(tabId)
      }
      if (action === 'write') {
        return await clipboardWrite(tabId, text)
      }
      throw new Error(`unsupported clipboard action: ${action}`)
    case 'state':
      if (action === 'save') {
        return await saveState(tabId, name)
      }
      if (action === 'load') {
        if (savedStateData) {
          return await loadState(tabId, savedStateData)
        }

        const savedStates = await getSavedStates()
        const savedState = savedStates[name]
        if (!savedState) {
          throw new Error(`saved state not found: ${name}`)
        }
        return await loadState(tabId, savedState)
      }
      throw new Error(`unsupported state action: ${action}`)
    default:
      throw new Error(`unsupported command: ${command}`)
  }
}

async function connect() {
  if (
    state.connecting ||
    (state.socket &&
      state.socket.readyState !== WebSocket.CLOSED &&
      state.socket.readyState !== WebSocket.CLOSING)
  ) {
    return
  }

  state.connecting = true
  setConnectionStatus('connecting')

  try {
    state.token = state.token || (await getToken())
    if (!state.token) {
      setConnectionStatus('missing-token')
      setConnectionError('missing token; save it in the options page')
      return
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${state.relayPort}/ws?token=${encodeURIComponent(state.token)}&extensionId=${encodeURIComponent(chrome.runtime.id)}`,
    )

    state.socket = socket

    socket.addEventListener('open', () => {
      setConnectionStatus('connected')
      socket.send(
        JSON.stringify({
          type: 'extension.hello',
          extensionId: chrome.runtime.id,
          version: chrome.runtime.getManifest().version,
        }),
      )
    })

    socket.addEventListener('message', async (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        console.warn('received invalid JSON from server', error)
        socket.send(
          JSON.stringify({
            type: 'response',
            id: null,
            ok: false,
            error: { message: 'invalid JSON from server' },
          }),
        )
        return
      }

      if (message?.type !== 'command') {
        return
      }

      try {
        const result = await handleCommand(message)
        socket.send(
          JSON.stringify({
            type: 'response',
            id: message.id,
            ok: true,
            result,
          }),
        )
      } catch (error) {
        const err = error as ErrorWithCode
        state.lastCommandError = {
          command: String(message.command || ''),
          message: err.message,
          code: err.code || 'EXTENSION_COMMAND_ERROR',
          at: new Date().toISOString(),
        }
        persistDiagnostics()
        socket.send(
          JSON.stringify({
            type: 'response',
            id: message.id,
            ok: false,
            error: {
              message: err.message,
              code: err.code || 'EXTENSION_COMMAND_ERROR',
              ...(err.suggestedAction ? { suggestedAction: err.suggestedAction } : {}),
              ...(err.ref ? { ref: err.ref } : {}),
              ...(typeof err.expectedPageEpoch === 'number'
                ? { expectedPageEpoch: err.expectedPageEpoch }
                : {}),
              ...(typeof err.currentPageEpoch === 'number'
                ? { currentPageEpoch: err.currentPageEpoch }
                : {}),
            },
          }),
        )
      }

      try {
        const tabs = await listTabs()
        socket.send(
          JSON.stringify({
            type: 'state',
            tabs,
            activeTabId: tabs.find((tab) => tab.active)?.id || null,
            targetTabId: state.targetTabId,
          }),
        )
      } catch (error) {
        console.error('failed to publish extension state', error)
      }
    })

    socket.addEventListener('close', (event) => {
      state.socket = null
      state.connecting = false
      recordSocketClose({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })
      if (state.shouldReconnect) {
        reconnect()
      }
    })

    socket.addEventListener('error', () => {
      state.connecting = false
      setConnectionError('relay websocket error')
      try {
        socket.close()
      } catch (error) {
        console.warn('failed to close relay socket after websocket error', error)
      }
    })

    try {
      const tabs = await listTabs()
      socket.send(
        JSON.stringify({
          type: 'state',
          tabs,
          activeTabId: tabs.find((tab) => tab.active)?.id || null,
          targetTabId: state.targetTabId,
        }),
      )
    } catch (error) {
      console.error('failed to publish initial extension state', error)
    }
  } catch (error) {
    const err = error as ErrorWithCode
    setConnectionStatus('error')
    setConnectionError(err.message, err.code)
    throw error
  } finally {
    state.connecting = false
  }
}

async function reconnect() {
  if (!state.shouldReconnect) {
    return
  }

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
  }

  state.reconnectTimer = setTimeout(async () => {
    if (!state.socket || state.socket.readyState === WebSocket.CLOSED) {
      await connect()
    }
  }, 1000)
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => {})
})

chrome.runtime.onStartup.addListener(() => {
  connect().catch((error) => {
    console.error('failed to connect autobrowser extension on startup', error)
  })
})

connect().catch((error) => {
  console.error('failed to connect autobrowser extension', error)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'autobrowser.setToken') {
    saveToken(String(message.token || '')).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message }),
    )
    return true
  }

  if (message?.type === 'autobrowser.getStatus') {
    sendResponse({
      ok: true,
      connected: Boolean(state.socket && state.socket.readyState === WebSocket.OPEN),
      connectionStatus: state.connectionStatus,
      connectionError: state.connectionError,
      lastSocketClose: state.lastSocketClose,
      lastCommandError: state.lastCommandError,
      dialog: getDialogStatus(),
      token: state.token || '',
      relayPort: state.relayPort,
    })
    return false
  }

  return false
})

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSelectedFrame(state, tabId)
  state.targetTabId = clearRemovedTabId(state.targetTabId, tabId)
  clearRemovedTabHandle(state, tabId)
  clearRemovedPageEpoch(state, tabId)
  detachDebugger(tabId).catch(() => {})
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return
  }

  let needsReconnect = false

  if (changes[STORAGE_KEY]) {
    state.token = String(changes[STORAGE_KEY].newValue || '')
    needsReconnect = true
  }

  if (changes[RELAY_PORT_STORAGE_KEY]) {
    state.relayPort = normalizeRelayPort(changes[RELAY_PORT_STORAGE_KEY].newValue)
    needsReconnect = true
  }

  if (needsReconnect) {
    requestReconnect()
  }
})

Promise.all([getToken(), getRelayPort()])
  .then(([token, relayPort]) => {
    state.token = token
    state.relayPort = relayPort
    setupDebuggerEventListeners()
    return connect()
  })
  .catch((error) => {
    console.error('failed to initialize autobrowser extension', error)
    const message = error instanceof Error ? error.message : String(error)
    setConnectionStatus('error')
    setConnectionError(message, 'STARTUP_ERROR')
  })
