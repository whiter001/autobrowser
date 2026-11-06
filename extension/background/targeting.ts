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

/**
 * 记录当前目标标签，供后续省略 tabId 的命令沿用。
 */
export function rememberTargetTab(state: ExtensionState, tabId: number | null | undefined): void {
  state.targeting.targetTabId = typeof tabId === 'number' ? tabId : null
}

/**
 * 为标签分配并复用稳定句柄 tN。句柄一旦分配就不再变化，
 * agent 才能跨轮次引用同一个标签。
 */
export function getOrCreateTabHandle(
  state: ExtensionState,
  tabId: number | undefined,
): string | null {
  if (typeof tabId !== 'number') {
    return null
  }

  const existingHandle = state.targeting.tabHandles.get(tabId)
  if (existingHandle) {
    return existingHandle
  }

  // handle 由 Chrome tabId 单向派生，而不是由 SW 内存里的计数器顺序分配：
  // MV3 service worker 重启后内存映射虽会清空，但 tabs.query 的枚举顺序不再影响
  // 同一 tab 的 handle；tabId 在浏览器会话内不会被复用，因此已关闭 tab 的旧 handle
  // 不会静默命中另一个 tab（存在性由解析后的 tabsGet 校验，见 resolveTabHandle）。
  const handle = formatAgentTabHandle(tabId)
  state.targeting.tabHandles.set(tabId, handle)
  state.targeting.tabIdsByHandle.set(handle, tabId)
  return handle
}

/**
 * 标签关闭后回收句柄映射，避免 tN 继续指向已不存在的标签。
 */
export function clearRemovedTabHandle(state: ExtensionState, tabId: number): void {
  const handle = state.targeting.tabHandles.get(tabId)
  if (!handle) {
    return
  }

  state.targeting.tabHandles.delete(tabId)
  state.targeting.tabIdsByHandle.delete(handle)
}

/**
 * 把 tN 句柄还原成标签 ID；不是句柄时返回 null，由调用方决定报错还是回退。
 *
 * 映射表只是缓存：句柄本身由 tabId 单向派生（tN ↔ N）。MV3 service worker 被回收后
 * 内存映射清空，而 CLI 侧仍持有同一个 tN——只认映射就会把活着的标签页报成
 * STALE_TAB_HANDLE（重连窗口内的瞬时失败）。所以映射缺失时按 N 兜底，
 * 标签是否真的存在交给调用方的 tabsGet 校验：已关闭的标签页仍然落到
 * STALE_TAB_HANDLE，不会命中别的标签页（tabId 在同一浏览器会话内不复用）。
 * 跨浏览器重启后 tabId 会重新分配，此时映射由 tab 枚举重建，语义与改动前一致。
 */
export function resolveTabHandle(
  state: ExtensionState,
  tabHandle: string | null | undefined,
): number | null {
  const normalizedHandle = parseAgentTabHandle(tabHandle)
  if (!normalizedHandle) {
    return null
  }

  const mappedTabId = state.targeting.tabIdsByHandle.get(normalizedHandle)
  if (typeof mappedTabId === 'number') {
    return mappedTabId
  }

  const derivedTabId = Number(normalizedHandle.slice(1))
  return Number.isSafeInteger(derivedTabId) && derivedTabId > 0 ? derivedTabId : null
}

/**
 * 统一解析 tabId 入参：数字直接使用，tN 走句柄表，纯数字字符串按标签 ID 处理；
 * 都解析不出时返回 null，由调用方决定是否回退到当前目标。
 */
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

/** 失效 tab 句柄/已关闭 tabId 的统一错误：机器可读 code + 可执行的下一步建议，
 *  CLI/MCP 错误序列化会自动透出 code/suggestedAction */
export function createStaleTabHandleError(tabId: TabInput): ErrorWithCode {
  const error = new Error(`tab not found: ${tabId}`) as ErrorWithCode
  error.code = 'STALE_TAB_HANDLE'
  error.suggestedAction = 'Run tab list to see open tabs and refresh handles.'
  return error
}

/**
 * 组装对外稳定的标签摘要（含 handle），保证同一标签在多次响应里可被持续引用。
 */
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

/**
 * 清掉该标签选定的 frame，防止标签复用后命令继续命中旧 frame。
 */
export function clearSelectedFrame(state: ExtensionState, tabId: number): void {
  state.targeting.selectedFrames.delete(tabId)
}

/**
 * 取页面代次，没有则初始化为 1。代次是判定 @eN/@fN 引用是否过期的依据。
 */
export function getPageEpoch(state: ExtensionState, tabId: number): number {
  const currentEpoch = state.targeting.pageEpochs.get(tabId)
  if (typeof currentEpoch === 'number' && currentEpoch > 0) {
    return currentEpoch
  }

  state.targeting.pageEpochs.set(tabId, 1)
  return 1
}

function bumpPageEpoch(state: ExtensionState, tabId: number): number {
  const nextEpoch = getPageEpoch(state, tabId) + 1
  state.targeting.pageEpochs.set(tabId, nextEpoch)
  return nextEpoch
}

/**
 * DOM 质变（导航、重载）后推进代次并清空选中 frame，让旧引用立即失效。
 */
export function invalidatePageRefs(state: ExtensionState, tabId: number): number {
  clearSelectedFrame(state, tabId)
  return bumpPageEpoch(state, tabId)
}

/**
 * 标签关闭后清理其代次记录，避免句柄与代次表随标签数量无限增长。
 */
export function clearRemovedPageEpoch(state: ExtensionState, tabId: number): void {
  state.targeting.pageEpochs.delete(tabId)
}

function createStaleRefError(
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

/**
 * 元素引用带代次且已过期时抛出可读的 stale 错误，否则直接放行。
 */
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

/**
 * frame 引用的过期校验，语义与元素引用一致。
 */
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

/**
 * 计算本次命令实际作用的 frame：显式传参优先，否则取该标签已选定的 frame；
 * top/main/default 归一为 null（表示主框架）。
 */
export function resolveEffectiveFrameSelector(
  state: ExtensionState,
  tab: Pick<TabSummarySource, 'id'>,
  frameSelector: string | null | undefined,
): string | null {
  const selector =
    typeof frameSelector === 'string' && frameSelector.trim()
      ? frameSelector.trim()
      : typeof tab.id === 'number'
        ? state.targeting.selectedFrames.get(tab.id) || null
        : null

  if (!selector) {
    return null
  }

  return ['top', 'main', 'default'].includes(selector.toLowerCase()) ? null : selector
}

/**
 * 把 frame 选择器合并进命令执行选项；空值时保持原样，避免用空值覆盖已有配置。
 */
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
