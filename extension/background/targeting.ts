import {
  getAgentFrameRefPageEpoch,
  isStaleAgentFrameRef,
  formatAgentTabHandle,
  parseAgentTabHandle,
} from '../../src/core/agent-handles.js'
import {
  getAgentElementRefPageEpoch,
  isStaleAgentElementRef,
} from '../../src/core/agent-selectors.js'
import type {
  ErrorWithCode,
  EvaluateInTabContextOptions,
  ExtensionState,
  TabInput,
  TabSummary,
} from './types.js'

interface TabSummarySource {
  id?: number
  title?: string
  url?: string
  active?: boolean
  pinned?: boolean
  status?: string
  windowId?: number
}

export function rememberTargetTab(state: ExtensionState, tabId: number | null | undefined): void {
  state.targetTabId = typeof tabId === 'number' ? tabId : null
}

export function getOrCreateTabHandle(
  state: ExtensionState,
  tabId: number | undefined,
): string | null {
  if (typeof tabId !== 'number') {
    return null
  }

  const existingHandle = state.tabHandles.get(tabId)
  if (existingHandle) {
    return existingHandle
  }

  const handle = formatAgentTabHandle(state.nextTabHandleIndex)
  state.nextTabHandleIndex += 1
  state.tabHandles.set(tabId, handle)
  state.tabIdsByHandle.set(handle, tabId)
  return handle
}

export function clearRemovedTabHandle(state: ExtensionState, tabId: number): void {
  const handle = state.tabHandles.get(tabId)
  if (!handle) {
    return
  }

  state.tabHandles.delete(tabId)
  state.tabIdsByHandle.delete(handle)
}

export function resolveTabHandle(
  state: ExtensionState,
  tabHandle: string | null | undefined,
): number | null {
  const normalizedHandle = parseAgentTabHandle(tabHandle)
  if (!normalizedHandle) {
    return null
  }

  const tabId = state.tabIdsByHandle.get(normalizedHandle)
  return typeof tabId === 'number' ? tabId : null
}

export function resolveTabInput(state: ExtensionState, tabId: TabInput): number | null {
  if (typeof tabId === 'number') {
    return tabId
  }

  if (typeof tabId === 'string') {
    const handleTabId = resolveTabHandle(state, tabId)
    if (typeof handleTabId === 'number') {
      return handleTabId
    }

    const numericTabId = Number(tabId)
    if (Number.isInteger(numericTabId) && numericTabId > 0) {
      return numericTabId
    }
  }

  return null
}

export function toTabSummary(state: ExtensionState, tab: TabSummarySource): TabSummary {
  return {
    id: typeof tab.id === 'number' ? tab.id : null,
    handle: getOrCreateTabHandle(state, tab.id),
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    status: tab.status || '',
    windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
  }
}

export function clearSelectedFrame(state: ExtensionState, tabId: number): void {
  state.selectedFrames.delete(tabId)
}

export function getPageEpoch(state: ExtensionState, tabId: number): number {
  const currentEpoch = state.pageEpochs.get(tabId)
  if (typeof currentEpoch === 'number' && currentEpoch > 0) {
    return currentEpoch
  }

  state.pageEpochs.set(tabId, 1)
  return 1
}

export function bumpPageEpoch(state: ExtensionState, tabId: number): number {
  const nextEpoch = getPageEpoch(state, tabId) + 1
  state.pageEpochs.set(tabId, nextEpoch)
  return nextEpoch
}

export function invalidatePageRefs(state: ExtensionState, tabId: number): number {
  clearSelectedFrame(state, tabId)
  return bumpPageEpoch(state, tabId)
}

export function clearRemovedPageEpoch(state: ExtensionState, tabId: number): void {
  state.pageEpochs.delete(tabId)
}

export function createStaleRefError(
  refType: 'element' | 'frame',
  selector: string | null | undefined,
  expectedPageEpoch: number | null,
  currentPageEpoch: number,
): ErrorWithCode {
  const normalizedSelector = String(selector || '').trim()
  const error = new Error(
    `${refType} ref ${normalizedSelector} is stale for page epoch ${expectedPageEpoch}; current page epoch is ${currentPageEpoch}`,
  ) as ErrorWithCode
  error.code = refType === 'frame' ? 'STALE_FRAME_REF' : 'STALE_ELEMENT_REF'
  error.suggestedAction = 'run snapshot again'
  error.ref = normalizedSelector
  error.expectedPageEpoch = expectedPageEpoch ?? undefined
  error.currentPageEpoch = currentPageEpoch
  return error
}

export function assertFreshElementRef(
  state: ExtensionState,
  tabId: number,
  selector: string | null | undefined,
): void {
  const currentPageEpoch = getPageEpoch(state, tabId)
  if (!isStaleAgentElementRef(selector, currentPageEpoch)) {
    return
  }

  throw createStaleRefError(
    'element',
    selector,
    getAgentElementRefPageEpoch(selector),
    currentPageEpoch,
  )
}

export function assertFreshFrameRef(
  state: ExtensionState,
  tabId: number,
  selector: string | null | undefined,
): void {
  const currentPageEpoch = getPageEpoch(state, tabId)
  if (isStaleAgentFrameRef(selector, currentPageEpoch)) {
    throw createStaleRefError(
      'frame',
      selector,
      getAgentFrameRefPageEpoch(selector),
      currentPageEpoch,
    )
  }

  if (isStaleAgentElementRef(selector, currentPageEpoch)) {
    throw createStaleRefError(
      'element',
      selector,
      getAgentElementRefPageEpoch(selector),
      currentPageEpoch,
    )
  }
}

export function resolveEffectiveFrameSelector(
  state: ExtensionState,
  tab: Pick<TabSummarySource, 'id'>,
  frameSelector: string | null | undefined,
): string | null {
  const selector =
    typeof frameSelector === 'string' && frameSelector.trim()
      ? frameSelector.trim()
      : typeof tab.id === 'number'
        ? state.selectedFrames.get(tab.id) || null
        : null

  if (!selector) {
    return null
  }

  return ['top', 'main', 'default'].includes(selector.toLowerCase()) ? null : selector
}

export function withFrameSelectorOptions(
  frameSelector: string | null | undefined,
  options: EvaluateInTabContextOptions = {},
): EvaluateInTabContextOptions {
  if (typeof frameSelector !== 'string' || !frameSelector.trim()) {
    return options
  }

  return {
    ...options,
    frameSelector: frameSelector.trim(),
  }
}
