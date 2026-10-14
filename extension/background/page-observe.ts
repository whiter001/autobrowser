import { AGENT_FRAME_REF_ATTRIBUTE, AGENT_FRAME_REF_PREFIX } from '../../src/core/agent-handles.js'
import { AGENT_ELEMENT_REF_ATTRIBUTE } from '../../src/core/agent-selectors.js'
import { parseSearchQueryRegex } from '../../src/core/search.js'
import { buildDeepDomTraversalHelpersSource } from './deep-dom.js'
import { createElementNotFoundError } from './page-input.js'
import {
  collapseWhitespace,
  boundPageText,
  createPageNameIndex,
  getPageObservationState,
  parsePageContextElementRefIndex,
  splitWhitespaceTokens,
} from './page-context-helpers.js'
import {
  getPageEpoch,
  resolveEffectiveFrameSelector,
  withFrameSelectorOptions,
} from './targeting.js'
import type {
  EvaluateInTabContextOptions,
  ExtensionState,
  FrameSelector,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  ScreenshotCaptureOptions,
  TabInput,
  TabWithId,
} from './types.js'

const SCREENSHOT_ANNOTATION_OVERLAY_ID = 'autobrowser-screenshot-annotations'
const SCREENSHOT_ANNOTATION_MAX_ELEMENTS = 200
const AGENT_SNAPSHOT_MAX_ELEMENTS = 200
const SNAPSHOT_MAX_JSON_BYTES = 200_000
const FEED_MAX_ITEMS = 200
const FEED_MAX_SCROLLS = 40
const SEARCH_LINE_MAX_LENGTH = 240
const SEARCH_MAX_LIMIT = 200

// command-spec 路径下这些字段是可选的，undefined 时 Math.floor 会得到 NaN，
// 导致 limit 变成 NaN 而静默返回 0 条；这里统一兜底到与 CLI 一致的默认值
function normalizeFeedCount(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(0, Math.floor(value))
}

// 同一算法用于页内构造与扩展防御；逐字段/条目计费，不反复序列化整个增长中的结果。
function truncateSnapshotToByteLimit(
  result: Record<string, unknown>,
  maxBytes = 200_000,
): Record<string, unknown> {
  const encoder = new TextEncoder()
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length
  if (size(result) <= maxBytes) return result
  const output: Record<string, unknown> = {}
  let remaining = maxBytes - 2048
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) continue
    const bounded =
      typeof value === 'string' ? boundPageText(value, key === 'text' ? 5000 : 1024) : value
    const cost = size(bounded) + size(key) + 2
    if (cost <= remaining) {
      output[key] = bounded
      remaining -= cost
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (!Array.isArray(value)) continue
    const kept: unknown[] = []
    remaining -= size(key) + 4
    for (const item of value) {
      const cost = size(item) + 1
      if (cost > remaining) break
      kept.push(item)
      remaining -= cost
    }
    output[key] = kept
  }
  output.truncated = true
  output.totalElements =
    result.totalElements ?? (Array.isArray(result.elements) ? result.elements.length : 0)
  output.returnedElements = Array.isArray(output.elements) ? output.elements.length : 0
  output.suggestedAction =
    'Narrow snapshot with selector/roles; use changed:true to receive undisclosed elements.'
  return output
}

const PAGE_CONTEXT_TEXT_HELPERS_SOURCE = [
  collapseWhitespace.toString(),
  splitWhitespaceTokens.toString(),
].join('\n')

const PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE = buildDeepDomTraversalHelpersSource()

const PAGE_CONTEXT_FIND_HELPERS_SOURCE = [
  PAGE_CONTEXT_TEXT_HELPERS_SOURCE,
  PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE,
  parsePageContextElementRefIndex.toString(),
  computeStableRefIndexes.toString(),
  getPageObservationState.toString(),
  createPageNameIndex.toString(),
  boundPageText.toString(),
].join('\n')

/**
 * 稳定 ref 分配（纯函数，通过 toString() 嵌入页面上下文执行，不能引用模块级闭包变量）。
 * 已有 ref 沿用；全页 refNodes 只用于提升 document/epoch 持久高水位，
 * 新节点从该高水位 +1 分配。snapshot/find 共用状态，删除最大编号或全部节点均不回收编号。
 */
export function computeStableRefIndexes<
  TNode extends {
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
  },
>(
  refNodes: TNode[],
  candidates: TNode[],
  attribute: string,
  prefix: string,
  parseIndex: (value: string | null) => number | null,
  highWater: Record<string, number> = {},
): Map<TNode, number> {
  let nextIndex = highWater[prefix] || 0
  for (const node of refNodes) {
    const parsed = parseIndex(node.getAttribute(attribute))
    if (parsed !== null) nextIndex = Math.max(nextIndex, parsed)
  }

  const indexes = new Map<TNode, number>()
  for (const node of candidates) {
    const existing = parseIndex(node.getAttribute(attribute))
    if (existing !== null) {
      nextIndex = Math.max(nextIndex, existing)
      indexes.set(node, existing)
      continue
    }
    nextIndex += 1
    node.setAttribute(attribute, prefix + nextIndex)
    indexes.set(node, nextIndex)
  }
  highWater[prefix] = nextIndex
  return indexes
}

const PAGE_CONTEXT_SNAPSHOT_HELPERS_SOURCE = [
  PAGE_CONTEXT_FIND_HELPERS_SOURCE,
  truncateSnapshotToByteLimit.toString(),
].join('\n')

export interface SearchMatchLine {
  line: number
  text: string
  matched: boolean
  /** 该行文本超过行宽上限被截断 */
  truncated: boolean
}

export interface SearchWindow {
  startLine: number
  endLine: number
  lines: SearchMatchLine[]
}

export interface SearchPageTextResult {
  pageEpoch: number
  query: string
  /** 查询是否为 /pattern/flags 正则形式（false 表示纯文本子串匹配） */
  regex: boolean
  /** 用户输入的原始模式（正则形式去掉首尾斜杠） */
  pattern: string
  context: number
  limit: number
  readyState: string
  totalMatches: number
  returned: number
  /** 窗口、行数、字节或单行宽度发生截断 */
  truncated: boolean
  startLine: number
  nextStartLine?: number
  windows: SearchWindow[]
  modal?: {
    open: boolean
    type: string
    message: string
    defaultPrompt: string
  }
}

export interface SearchPageTextOptions {
  query?: string
  context?: number
  limit?: number
  startLine?: number
}

/** 纯函数通过 toString 注入，不能引用模块闭包。续取按原始行号裁窗口，避免上下文重复。 */
export function computeSearchPageTextMatches(
  rawText: string,
  query: string,
  pattern: string,
  regexFlags: string,
  context: number,
  limit: number,
  lineMax: number,
  readyState: string,
  startLine = 1,
): Omit<SearchPageTextResult, 'pageEpoch'> {
  const escapeRegExpSource = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const literal = !/^\/(.+)\/([a-zA-Z]*)$/.test(query)
  const regex = new RegExp(literal ? escapeRegExpSource(pattern) : pattern, regexFlags)
  context = Number.isFinite(context) ? Math.min(50, Math.max(0, Math.floor(context))) : 3
  limit = Number.isFinite(limit) ? Math.min(200, Math.max(0, Math.floor(limit))) : 20
  startLine = Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : 1
  lineMax = Number.isFinite(lineMax) ? Math.min(240, Math.max(0, Math.floor(lineMax))) : 240
  const lines = rawText.split('\n')
  const matchedLines = new Set<number>()
  const merged: Array<{ startLine: number; endLine: number }> = []
  for (let index = 0; index < lines.length; index += 1) {
    regex.lastIndex = 0
    if (!regex.test(lines[index]!)) continue
    matchedLines.add(index + 1)
    const from = Math.max(startLine, index + 1 - context)
    const to = Math.min(lines.length, index + 1 + context)
    if (to < from) continue
    const last = merged[merged.length - 1]
    if (last && from <= last.endLine + 1) last.endLine = to
    else merged.push({ startLine: from, endLine: to })
  }
  const encoder = new TextEncoder()
  // 回显也计入预算，超大查询不能挤占全部行预算。
  const echo = (text: string) => text.slice(0, 1024)
  const windows: SearchWindow[] = []
  const result: Omit<SearchPageTextResult, 'pageEpoch'> = {
    query: echo(query),
    regex: !literal,
    pattern: echo(pattern),
    context,
    limit,
    startLine,
    readyState: echo(readyState),
    totalMatches: matchedLines.size,
    returned: 0,
    truncated: query.length > 1024 || pattern.length > 1024,
    windows,
  }
  let remaining = 100_000 - encoder.encode(JSON.stringify(result)).length - 1024
  let count = 0
  outer: for (const range of merged) {
    if (windows.length >= limit) {
      result.truncated = true
      // limit=0 是显式不取内容，不给出无法前进的续读游标。
      if (limit > 0) result.nextStartLine = range.startLine
      break
    }
    const window: SearchWindow = { startLine: range.startLine, endLine: range.startLine, lines: [] }
    remaining -= 100
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      const text = lines[line - 1]!
      const item = {
        line,
        text: text.slice(0, lineMax),
        matched: matchedLines.has(line),
        truncated: text.length > lineMax,
      }
      const cost = encoder.encode(JSON.stringify(item)).length + 1
      if (count >= 200 || cost > remaining) {
        result.truncated = true
        result.nextStartLine = line
        break outer
      }
      if (window.lines.length === 0) windows.push(window)
      window.lines.push(item)
      window.endLine = line
      count += 1
      remaining -= cost
      if (item.truncated) result.truncated = true
    }
  }
  result.returned = windows.length
  return result
}

const SEARCH_TEXT_MATCH_HELPERS_SOURCE = computeSearchPageTextMatches.toString()

interface ScreenshotAnnotationResult {
  count?: number
}

export interface SemanticTargetMatch extends Record<string, unknown> {
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

export interface SemanticTargetResult extends Record<string, unknown> {
  found: boolean
  reason?: string
  pageEpoch?: number
  match?: SemanticTargetMatch
  candidates?: SemanticTargetMatch[]
}

export interface FindSemanticTargetOptions {
  strategy: string
  role: string
  query: string
  name: string
  exact: boolean
  /** first / last / nth=N，缺省为 first */
  position?: string
  /** >0 时返回按质量排序的 Top-N 候选列表，而不是单个目标 */
  candidates?: number
  /** 写操作要求唯一目标；显式 position 仍可选择多匹配中的一项。 */
  requireUnique?: boolean
}

export type FeedDedupeStrategy = 'url' | 'text' | 'none'

export interface FeedCollectionItem extends Record<string, unknown> {
  index: number
  pageEpoch: number
  selector: string
  author: string | null
  handle: string | null
  time: string | null
  text: string
  url: string | null
  mediaUrls: string[]
}

export interface FeedCollectionResult extends Record<string, unknown> {
  pageEpoch: number
  selector: string
  limit: number
  dedupe: FeedDedupeStrategy
  maxScrolls: number
  pauseMs: number
  stallRounds: number
  scrolls: number
  stopReason: 'limit' | 'maxScrolls' | 'stalled'
  count: number
  items: FeedCollectionItem[]
}

export interface CollectFeedOptions {
  selector: string
  limit: number
  dedupe: FeedDedupeStrategy
  maxScrolls: number
  pauseMs: number
  stallRounds: number
}

export interface SnapshotTabOptions {
  /** CSS selector 或 @eN ref：只截取该元素子树 */
  selector?: string
  /** 只返回匹配这些 role 的元素；空数组表示不过滤（保持默认行为） */
  roles?: string[]
  /** 增量模式：只返回相对上次快照新增/变化的元素，并带 unchangedCount 汇总 */
  changed?: boolean
}

interface PageObserveDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  resolveElementSelectorForTab: (
    tabId: TabInput,
    selector: string,
  ) => Promise<ResolvedSelectorTarget>
  resolveFrameTarget: (tabId: TabInput, selector: string) => Promise<ResolvedFrameTarget>
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<{
    tab: TabWithId
    response: { result: unknown }
    value: TValue | null
  }>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
}

export function createPageObserveDomain({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  evaluateInTabContext,
  sendDebuggerCommand,
}: PageObserveDependencies) {
  // 增量快照缓存：按 tab + roles + 子树 selector 缓存最近一次快照的元素签名，随 pageEpoch 变化作废。
  // 签名集合由 roles 过滤与子树范围共同决定，只按 tab 键控会让 role 子集快照覆盖全量签名，
  // 之后不带 roles 的全量 --changed 用子集签名 diff 全量元素，导致非目标角色被误判为 changed。
  const snapshotSignatureCache = new Map<
    string,
    { pageEpoch: number; documentId?: string; signatures: string[] }
  >()

  const snapshotCacheKey = (
    tabId: number,
    roles: string[],
    selector?: string,
    frame?: FrameSelector,
  ) => JSON.stringify([tabId, [...roles].sort(), selector?.trim() || '', frame || 'top'])

  async function pollUntil<TResult>(
    timeout: number,
    step: () => Promise<TResult | null>,
    timeoutMessage: string,
  ): Promise<TResult> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const result = await step()
      if (result !== null) {
        return result
      }

      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    throw new Error(timeoutMessage)
  }

  function waitForDebuggerEvent<TResult>(
    tabId: number,
    timeout: number,
    enable: () => Promise<void>,
    matches: (source: { tabId?: number }, method: string, params?: unknown) => boolean,
    buildResult: () => TResult,
    timeoutMessage: string,
  ): Promise<TResult> {
    return new Promise((resolve, reject) => {
      // 统一在一处收敛 listener/timeout 清理，避免新增等待类型时遗漏解除订阅。
      const cleanup = () => {
        chrome.debugger.onEvent.removeListener(listener)
        clearTimeout(timeoutId)
      }

      const listener = (source: { tabId?: number }, method: string, params?: unknown) => {
        if (source.tabId === tabId && matches(source, method, params)) {
          cleanup()
          resolve(buildResult())
        }
      }

      const timeoutId = setTimeout(() => {
        cleanup()
        reject(new Error(timeoutMessage))
      }, timeout)

      chrome.debugger.onEvent.addListener(listener)
      enable().catch((error) => {
        cleanup()
        reject(error)
      })
    })
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

    // 不将用户输入当作 RegExp 执行，避免 ReDoS 和意外语义；子串匹配已覆盖绝大多数 URL 等待场景。
    return false
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

${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

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
          for (const element of deepQuerySelectorAll(document, selector)) {
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

    // 元素截图只裁元素区域，与整页截图语义冲突，提前报明确错误而不是静默二选一
    if (options.element && options.full) {
      throw new Error('screenshot element capture cannot be combined with --full')
    }

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

      if (options.element) {
        const { resolvedSelector } = await resolveElementSelectorForTab(tab.id, options.element)
        const { value: elementRect } = await evaluateInTabContext<{
          x: number
          y: number
          width: number
          height: number
        }>(
          tab.id,
          `(() => {
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

            const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          })()`,
          withFrameSelectorOptions(effectiveFrameSelector),
        )

        if (!elementRect) {
          throw createElementNotFoundError(options.element)
        }

        // frame 内元素的 rect 是 frame 视口坐标，clip 走主页面坐标系，要叠回 frame 偏移
        let frameOffsetX = 0
        let frameOffsetY = 0
        if (effectiveFrameSelector) {
          const frame = await resolveFrameTarget(tab.id, effectiveFrameSelector)
          frameOffsetX = frame.left
          frameOffsetY = frame.top
        }

        Object.assign(captureOptions, {
          clip: {
            x: Math.max(0, elementRect.x + frameOffsetX),
            y: Math.max(0, elementRect.y + frameOffsetY),
            width: Math.max(1, elementRect.width),
            height: Math.max(1, elementRect.height),
            // scale 取 1：输出像素 = CSS 尺寸 × devicePixelRatio，与 frame clip 的既有行为一致
            scale: 1,
          },
        })
      } else if (effectiveFrameSelector) {
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
        ...(options.element ? { element: options.element } : {}),
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

  async function snapshotTab(
    tabId: TabInput,
    frameSelector: FrameSelector,
    options: SnapshotTabOptions = {},
  ) {
    // 子树截取：目标可以是 CSS selector 或 @eN ref，先解析成当前页面可用的 selector
    const targetSelector = options.selector
    const resolvedTarget = targetSelector?.trim()
      ? await resolveElementSelectorForTab(tabId, targetSelector.trim())
      : null
    const tab = resolvedTarget ? resolvedTarget.tab : await getTargetTab(tabId)
    const openDialog = state.session.dialogs.get(tab.id)
    if (openDialog) {
      // 页面被未处理的 JS 对话框阻塞：不执行 DOM 遍历（会挂起），直接返回 modal 描述
      return {
        pageEpoch: getPageEpoch(state, tab.id),
        title: null,
        url: null,
        readyState: 'blocked',
        text: '',
        elements: [],
        frames: [],
        headings: [],
        buttons: [],
        modal: {
          open: true,
          type: openDialog.type,
          message: boundPageText(openDialog.message, 1024),
          defaultPrompt: boundPageText(openDialog.defaultPrompt, 1024),
        },
      }
    }
    const pageEpoch = getPageEpoch(state, tab.id)
    const roles = options.roles ?? []
    const changedMode = Boolean(options.changed)
    // 增量模式：pageEpoch 未变时用上次缓存的签名做页内 diff，否则退化为全量
    const effectiveFrameSelector = resolveEffectiveFrameSelector(state, tab, frameSelector)
    const cacheKey = snapshotCacheKey(tab.id, roles, options.selector, effectiveFrameSelector)
    const cached = changedMode ? snapshotSignatureCache.get(cacheKey) : undefined
    const previousSignatures = cached && cached.pageEpoch === pageEpoch ? cached.signatures : []
    const refAttribute = AGENT_ELEMENT_REF_ATTRIBUTE
    const frameAttribute = AGENT_FRAME_REF_ATTRIBUTE
    const frameRefPrefix = AGENT_FRAME_REF_PREFIX
    const { value } = await evaluateInTabContext(
      tab.id,
      `(() => {
        const refAttribute = ${JSON.stringify(refAttribute)};
        const frameAttribute = ${JSON.stringify(frameAttribute)};
        const frameRefPrefix = ${JSON.stringify(frameRefPrefix)};
        const pageEpoch = ${pageEpoch};
        const targetRootSelector = ${JSON.stringify(resolvedTarget?.resolvedSelector || null)};
        const roles = ${JSON.stringify(roles)};
        const changedMode = ${changedMode};
        const previousSignatures = ${JSON.stringify(previousSignatures)};

${PAGE_CONTEXT_SNAPSHOT_HELPERS_SOURCE}

        const scope = targetRootSelector ? deepQuerySelector(document, targetRootSelector) : document;
        if (!scope) {
          return { found: false, pageEpoch };
        }

        const observation = getPageObservationState(document, pageEpoch);
        const documentId = observation.id;
        const sameDocument = documentId === ${JSON.stringify(cached?.documentId || null)};
        const previousSet = new Set(sameDocument ? previousSignatures : []);
        const deepElements = deepCollectElements(scope);
        const nameIndex = createPageNameIndex(deepElements);
        let fieldsTruncated = false;
        const bounded = (value, limit = 1024) => {
          const text = String(value ?? '');
          const result = boundPageText(text, limit);
          if (result.length < text.length) fieldsTruncated = true;
          return result;
        };
        const isPassword = (node) => node instanceof HTMLInputElement && node.type.toLowerCase() === 'password';
        // 密码值不参与名称兜底、文本或签名；保留显式可访问名称以便定位。
        const readValue = (node) => !isPassword(node) && typeof node.value === 'string' ? node.value : null;
        const readText = (node) => isPassword(node) ? '' : collapseWhitespace(bounded(node.innerText || node.textContent || '', 2048));
        const getAssociatedLabel = (node) => {
          const label = nameIndex.labels.get(node.id);
          return label ? readText(label) : '';
        };
        const getAriaLabelledByText = (node) => splitWhitespaceTokens(node.getAttribute('aria-labelledby'))
          .map((id) => nameIndex.ids.get(id)).filter(Boolean).map(readText).filter(Boolean).join(' ');

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

        const names = new Map();
        const getName = (node) => {
          if (!names.has(node)) names.set(node,
            node.getAttribute('aria-label')?.trim() || getAriaLabelledByText(node) ||
            getAssociatedLabel(node) || node.getAttribute('alt')?.trim() ||
            node.getAttribute('title')?.trim() || node.getAttribute('placeholder')?.trim() ||
            readValue(node)?.trim() || readText(node));
          return names.get(node);
        };

        const toNodeSummary = (node) => ({
          tag: bounded(node.tagName),
          text: bounded(readText(node), 120),
          id: bounded(node.id) || null,
          className: typeof node.className === "string" ? bounded(node.className) : null,
          ref: node.getAttribute(refAttribute)
            ? '@' + bounded(node.getAttribute(refAttribute), 100) + '#p' + pageEpoch
            : null,
        });

        // 元素/frame 的 document/epoch 高水位与 find 共用；删除节点不回收编号，
        // 子树和角色过滤不清理其它节点的 ref，也不会降低高水位。

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

        // 合并成单个选择器，一次遍历取齐全部候选（deepQuerySelectorAll 内部已去重）
        const actionableSelector = selectors.join(',');
        const candidates = deepQuerySelectorAll(scope, actionableSelector);
        // Element.querySelectorAll 不含根自身，子树根命中选择器时补进候选
        if (scope instanceof HTMLElement && scope.matches(actionableSelector)) {
          candidates.unshift(scope);
        }

        const encoder = new TextEncoder();
        const size = (value) => encoder.encode(JSON.stringify(value)).length;
        // 输出预留 80KB 给内部签名、删除项与截断诊断；每个条目仅序列化一次计费。
        const result = {
          pageEpoch, documentId,
          title: bounded(document.title), url: bounded(location.href),
          readyState: bounded(document.readyState),
          text: bounded(scope === document ? document.body?.innerText || '' : isPassword(scope) ? '' : scope.innerText || '', 5000),
          elements: [], frames: [], headings: [], buttons: [],
        };
        let remaining = 120000 - size(result);
        let truncated = false;
        const append = (list, item, limit) => {
          const cost = size(item) + 1;
          if (list.length >= limit || cost > remaining) { truncated = true; return false; }
          list.push(item); remaining -= cost; return true;
        };
        const signatureOf = (item) => {
          const text = JSON.stringify(item);
          let a = 2166136261, b = 5381;
          for (let i = 0; i < text.length; i++) {
            a = Math.imul(a ^ text.charCodeAt(i), 16777619);
            b = Math.imul(b, 33) ^ text.charCodeAt(i);
          }
          return item.ref + '~' + (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
        };
        const signatures = [];
        const retained = [];
        const currentRefs = new Set();
        let totalElements = 0, unchangedCount = 0;
        // 第一趟集中读布局（含 frame）；ref 属性可能被页面 CSS 使用，不能逐节点读写交错。
        const selectedElements = [];
        for (const element of candidates) {
          if (!(element instanceof HTMLElement)) continue;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' ||
              style.visibility === 'hidden' || Number(style.opacity || '1') === 0) continue;
          const role = inferRole(element);
          if (roles.length > 0 && (!role || !roles.includes(role))) continue;
          selectedElements.push({ element, rect, role });
        }
        const selectedFrames = [];
        for (const frame of deepQuerySelectorAll(scope, 'iframe')) {
          if (!(frame instanceof HTMLIFrameElement)) continue;
          const rect = frame.getBoundingClientRect(), style = getComputedStyle(frame);
          if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' ||
              style.visibility === 'hidden' || Number(style.opacity || '1') === 0) continue;
          selectedFrames.push({ frame, rect });
        }
        // 第二趟批量分配 ref，再用已读 rect 构造条目。
        const elementIndexes = computeStableRefIndexes(deepQuerySelectorAll(document, '[' + refAttribute + ']'),
          selectedElements.map(({ element }) => element), refAttribute, 'e', parsePageContextElementRefIndex, observation.highWater);
        for (const { element, rect, role } of selectedElements) {
          const index = elementIndexes.get(element);
          const item = {
            ref: '@e' + index + '#p' + pageEpoch,
            tag: bounded(element.tagName.toLowerCase()), role: role ? bounded(role) : null,
            text: bounded(readText(element), 240), name: bounded(getName(element), 240),
            value: readValue(element) === null ? null : bounded(readValue(element)),
            placeholder: bounded(element.getAttribute('placeholder')) || null,
            type: element instanceof HTMLInputElement ? bounded(element.type || 'text') : null,
            href: element instanceof HTMLAnchorElement ? bounded(element.href) || null : null,
            disabled: 'disabled' in element ? Boolean(element.disabled) : false,
            checked: 'checked' in element ? Boolean(element.checked) : null,
            x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width), height: Math.round(rect.height),
          };
          totalElements++;
          currentRefs.add(item.ref);
          const signature = signatureOf(item);
          if (changedMode && previousSet.has(signature)) {
            unchangedCount++;
            if (retained.length < 1000) retained.push(signature);
          } else if (append(result.elements, item, ${AGENT_SNAPSHOT_MAX_ELEMENTS})) signatures.push(signature);
        }
        const parseFrameRefIndex = (value) => {
          const match = /^f(\\d+)$/.exec(String(value || '').trim());
          return match ? Number(match[1]) : null;
        };
        computeStableRefIndexes(deepQuerySelectorAll(document, '[' + frameAttribute + ']'), [],
          frameAttribute, 'f', parseFrameRefIndex, observation.highWater);
        for (const { frame, rect } of selectedFrames) {
          const index = computeStableRefIndexes([], [frame], frameAttribute, 'f',
            parseFrameRefIndex, observation.highWater).get(frame);
          if (!append(result.frames, {
            ref: frameRefPrefix + index + '#p' + pageEpoch,
            name: bounded(frame.name) || null, title: bounded(frame.title) || null,
            src: bounded(frame.src || frame.getAttribute('src')) || null,
            x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width), height: Math.round(rect.height),
          }, ${AGENT_SNAPSHOT_MAX_ELEMENTS})) break;
        }
        for (const node of deepQuerySelectorAll(scope, 'h1,h2,h3')) {
          if (!append(result.headings, toNodeSummary(node), 20)) break;
        }
        for (const node of deepQuerySelectorAll(scope, "button,[role='button'],input[type='button'],input[type='submit']")) {
          if (!append(result.buttons, toNodeSummary(node), 20)) break;
        }
        const removedRefs = sameDocument ? previousSignatures.map((s) => s.split('~')[0]).filter((ref) => !currentRefs.has(ref)) : [];
        Object.assign(result, { signatures: [...signatures, ...retained].slice(0, 1000) });
        if (changedMode) Object.assign(result, { unchangedCount, full: !sameDocument, removedRefs });
        if (truncated || fieldsTruncated) Object.assign(result, {
          truncated: true, totalElements, returnedElements: result.elements.length,
          suggestedAction: 'Narrow snapshot with selector/roles; use changed:true for undisclosed elements.',
        });
        return truncateSnapshotToByteLimit(result);
      })()`,
      withFrameSelectorOptions(effectiveFrameSelector || 'top'),
    )

    // 子树目标不存在时与其它命令保持一致：抛带引导的 STALE_REFERENCE
    if (value && (value as { found?: boolean }).found === false) {
      throw createElementNotFoundError(targetSelector?.trim() || '')
    }

    // 增量缓存更新：只认本次收集集的签名；found 检查之后再写，失败不污染缓存
    if (value && typeof value === 'object') {
      const { signatures, documentId, ...result } = value as Record<string, unknown>
      const delivered = truncateSnapshotToByteLimit(result, SNAPSHOT_MAX_JSON_BYTES)
      if (Array.isArray(signatures)) {
        const refs = new Set(
          (Array.isArray(delivered.elements) ? delivered.elements : []).map(
            (item: { ref?: string }) => item.ref,
          ),
        )
        const previous = new Set(cached?.documentId === documentId ? previousSignatures : [])
        snapshotSignatureCache.set(cacheKey, {
          pageEpoch,
          documentId: typeof documentId === 'string' ? documentId : undefined,
          signatures: signatures
            .filter(
              (signature): signature is string =>
                typeof signature === 'string' &&
                (refs.has(signature.split('~')[0]) || previous.has(signature)),
            )
            .slice(0, 1000),
        })
      }
      return delivered
    }

    return value
  }

  async function findSemanticTarget(
    tabId: TabInput,
    options: FindSemanticTargetOptions,
    frameSelector: FrameSelector,
  ): Promise<SemanticTargetResult> {
    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const strategy = String(options.strategy || '').trim()
    const role = String(options.role || '').trim()
    const query = String(options.query || '').trim()
    const name = String(options.name || '').trim()
    const exact = options.exact === true
    const position = String(options.position || 'first').trim()
    const candidatesCount =
      typeof options.candidates === 'number' &&
      Number.isFinite(options.candidates) &&
      options.candidates > 0
        ? Math.min(200, Math.floor(options.candidates))
        : 0

    if (
      !['role', 'text', 'label', 'placeholder', 'alt', 'title', 'test-id', 'exact-name'].includes(
        strategy,
      )
    ) {
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
        const position = ${JSON.stringify(position)};
        const candidatesCount = ${candidatesCount};
        const actionableSelector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role],[tabindex]:not([tabindex="-1"])';

${PAGE_CONTEXT_FIND_HELPERS_SOURCE}

        const deepElements = deepCollectElements(document);
        const nameIndex = createPageNameIndex(deepElements);
        const observation = getPageObservationState(document, pageEpoch);
        computeStableRefIndexes(deepElements, [], refAttribute, 'e', parsePageContextElementRefIndex, observation.highWater);
        const requireUnique = ${options.requireUnique === true && !options.position};

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

        const isPassword = (node) => node instanceof HTMLInputElement && node.type.toLowerCase() === 'password';
        // 与 snapshot 一致：密码不参与名称或文本兜底，也不读取 value getter。
        const readValue = (node) => !isPassword(node) && typeof node.value === 'string' ? normalizeText(node.value) : '';
        const readText = (node) => isPassword(node) ? '' : normalizeText(node?.innerText || node?.textContent || '');

        const getAssociatedLabelText = (node) => {
          // 原生 labels 已包含 for 关联；按节点身份合并双来源，保留不同 label 的同文语义。
          const labels = new Set();
          if ('labels' in node && node.labels) {
            for (const label of node.labels) labels.add(label);
          }
          if (node.id) {
            const externalLabel = nameIndex.labels.get(node.id);
            if (externalLabel) labels.add(externalLabel);
          }
          return normalizeText(Array.from(labels, readText).filter(Boolean).join(' '));
        };

        const getAriaLabelledByText = (node) => {
          const labelledBy = normalizeText(node.getAttribute('aria-labelledby'));
          if (!labelledBy) {
            return '';
          }

          return normalizeText(
            splitWhitespaceTokens(labelledBy)
              .map((id) => nameIndex.ids.get(id))
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

        const names = new Map();
        const getAccessibleName = (node) => {
          if (!names.has(node)) names.set(node,
            normalizeText(node.getAttribute('aria-label')) || getAriaLabelledByText(node) ||
            getAssociatedLabelText(node) || normalizeText(node.getAttribute('alt')) ||
            normalizeText(node.getAttribute('title')) || normalizeText(node.getAttribute('placeholder')) ||
            readValue(node) || readText(node));
          return names.get(node);
        };

        const uniqueCandidates = (selectors) =>
          deepQuerySelectorAll(document, selectors.join(',')).filter(isVisible);

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

        // 惰性计算：broadTextCandidates 需要逐节点 isVisible（强制同步布局），
        // 只有 text 策略的兜底分支才真正用到
        let broadTextCandidates = null;
        const getBroadTextCandidates = () => {
          if (!broadTextCandidates) {
            broadTextCandidates = deepElements.filter(
              (node) => node instanceof HTMLElement && isVisible(node),
            );
          }
          return broadTextCandidates;
        };

        const pickActionableNode = (node) => {
          if (!(node instanceof HTMLElement)) {
            return null;
          }

          return node.matches(actionableSelector) ? node : node.closest(actionableSelector) || node;
        };

        const ensureRef = (node) => {
          const index = computeStableRefIndexes([], [node], refAttribute, 'e',
            parsePageContextElementRefIndex, observation.highWater).get(node);
          return '@e' + index + '#p' + pageEpoch;
        };

        // 排序键：精确匹配优先于模糊，可交互优先于纯文本兜底；值越小越靠前
        const interactiveSet = new Set(interactiveCandidates);
        const isExactText = (candidate, needle) => {
          const normalizedCandidate = normalizeText(candidate).toLowerCase();
          const normalizedNeedle = normalizeText(needle).toLowerCase();
          return Boolean(normalizedNeedle) && normalizedCandidate === normalizedNeedle;
        };
        const rankMatch = (candidate) =>
          (candidate.exact ? 0 : 2) + (interactiveSet.has(candidate.node) ? 0 : 1);

        const toTargetDescriptor = (node) => {
          const actionable = pickActionableNode(node);
          const rect = actionable.getBoundingClientRect();
          return {
            ref: ensureRef(actionable),
            tag: boundPageText(String(actionable.tagName || '').toLowerCase()),
            role: boundPageText(inferRole(actionable)) || null,
            text: boundPageText(readText(actionable), 240),
            name: boundPageText(getAccessibleName(actionable), 240),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };

        // 按 DOM 顺序收集全部匹配，first/last/nth 都基于这个序列取值
        const matches = [];

        if (strategy === 'role') {
          for (const node of interactiveCandidates) {
            if (inferRole(node) !== role) {
              continue;
            }
            if (name && !matchesText(getAccessibleName(node), name)) {
              continue;
            }
            matches.push({
              node,
              exact: !name || isExactText(getAccessibleName(node), name),
            });
          }
        }

        if (strategy === 'text') {
          for (const node of interactiveCandidates) {
            if (matchesText(getAccessibleName(node), query) || matchesText(readText(node), query)) {
              matches.push({
                node,
                exact:
                  isExactText(getAccessibleName(node), query) || isExactText(readText(node), query),
              });
            }
          }
          if (matches.length === 0) {
            for (const node of getBroadTextCandidates()) {
              if (matchesText(readText(node), query)) {
                matches.push({ node, exact: isExactText(readText(node), query) });
              }
            }
          }
        }

        if (strategy === 'exact-name') {
          for (const node of interactiveCandidates) {
            if (isExactText(getAccessibleName(node), query) || isExactText(readText(node), query)) {
              matches.push({ node, exact: true });
            }
          }
          if (matches.length === 0) {
            for (const node of getBroadTextCandidates()) {
              if (isExactText(readText(node), query)) {
                matches.push({ node, exact: true });
              }
            }
          }
        }

        if (strategy === 'label') {
          for (const node of uniqueCandidates(['input:not([type="hidden"])', 'textarea', 'select'])) {
            if (
              matchesText(getAssociatedLabelText(node), query) ||
              matchesText(getAccessibleName(node), query)
            ) {
              matches.push({
                node,
                exact:
                  isExactText(getAssociatedLabelText(node), query) ||
                  isExactText(getAccessibleName(node), query),
              });
            }
          }
        }

        if (strategy === 'placeholder') {
          for (const node of uniqueCandidates(['input:not([type="hidden"])', 'textarea'])) {
            const placeholderText = normalizeText(node.getAttribute('placeholder'));
            if (placeholderText && matchesText(placeholderText, query)) {
              matches.push({ node, exact: isExactText(placeholderText, query) });
            }
          }
        }

        if (strategy === 'alt') {
          for (const node of uniqueCandidates(['[alt]'])) {
            const altText = normalizeText(node.getAttribute('alt'));
            if (altText && matchesText(altText, query)) {
              matches.push({ node, exact: isExactText(altText, query) });
            }
          }
        }

        if (strategy === 'title') {
          for (const node of getBroadTextCandidates()) {
            const titleText = normalizeText(node.getAttribute('title'));
            if (titleText && matchesText(titleText, query)) {
              matches.push({ node, exact: isExactText(titleText, query) });
            }
          }
        }

        if (strategy === 'test-id') {
          for (const node of uniqueCandidates(['[data-testid]'])) {
            const testId = normalizeText(node.getAttribute('data-testid'));
            if (testId && matchesText(testId, query)) {
              matches.push({ node, exact: isExactText(testId, query) });
            }
          }
        }

        if (requireUnique && matches.length > 1) {
          return { found: false, code: 'AMBIGUOUS_TARGET',
            reason: 'Multiple targets matched (' + matches.length + ').',
            candidates: matches.slice(0, 10).map((candidate) => toTargetDescriptor(candidate.node)),
          };
        }
        if (candidatesCount > 0) {
          const sorted = matches.slice().sort((a, b) => rankMatch(a) - rankMatch(b));
          return {
            found: true,
            pageEpoch,
            candidates: sorted
              .slice(0, candidatesCount)
              .map((candidate) => toTargetDescriptor(candidate.node)),
          };
        }

        let selected = null;
        if (matches.length > 0) {
          if (position === 'last') {
            selected = matches[matches.length - 1].node;
          } else if (position === 'first') {
            selected = matches[0].node;
          } else {
            const nthIndex = position.startsWith('nth=') ? Number(position.slice(4)) : NaN;
            if (!Number.isInteger(nthIndex) || nthIndex < 1 || nthIndex > matches.length) {
              return {
                found: false,
                reason:
                  'nth position out of range: ' +
                  position +
                  ' (only ' +
                  matches.length +
                  (matches.length === 1 ? ' match' : ' matches') +
                  ' found)',
              };
            }
            selected = matches[nthIndex - 1].node;
          }
        }

        if (!selected) {
          return {
            found: false,
            reason:
              strategy === 'role'
                ? 'no role match found: ' + role + (name ? ' (' + name + ')' : '')
                : 'no ' + strategy + ' match found: ' + query,
          };
        }

        return {
          found: true,
          pageEpoch,
          match: toTargetDescriptor(selected),
        };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value?.code === 'AMBIGUOUS_TARGET') {
      throw Object.assign(new Error(value.reason), {
        code: 'AMBIGUOUS_TARGET',
        candidates: value.candidates,
        details: { candidates: value.candidates },
        suggestedAction:
          'Refine name with exact:true, inspect candidates, or explicitly set position (first/last/nth=N).',
      })
    }
    if (!value?.found || (!value?.match?.ref && !Array.isArray(value.candidates))) {
      throw new Error(value?.reason || `failed to find ${strategy} target`)
    }

    return value
  }

  async function searchPageText(
    tabId: TabInput,
    options: SearchPageTextOptions = {},
    frameSelector: FrameSelector,
  ): Promise<SearchPageTextResult> {
    const query = String(options.query ?? '').trim()
    const context =
      typeof options.context === 'number' && Number.isFinite(options.context)
        ? Math.min(50, Math.max(0, Math.floor(options.context)))
        : 3
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.min(SEARCH_MAX_LIMIT, Math.max(0, Math.floor(options.limit)))
        : 20
    const startLine =
      typeof options.startLine === 'number' && Number.isFinite(options.startLine)
        ? Math.max(1, Math.floor(options.startLine))
        : 1
    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const openDialog = state.session.dialogs.get(tab.id)
    if (openDialog || !query) {
      return {
        pageEpoch,
        query: boundPageText(query, 1024),
        regex: false,
        pattern: '',
        context,
        limit,
        startLine,
        readyState: openDialog ? 'blocked' : 'complete',
        totalMatches: 0,
        returned: 0,
        truncated: query.length > 1024,
        windows: [],
        ...(openDialog
          ? {
              modal: {
                open: true,
                type: openDialog.type,
                message: boundPageText(openDialog.message, 1024),
                defaultPrompt: boundPageText(openDialog.defaultPrompt, 1024),
              },
            }
          : {}),
      }
    }
    const spec = parseSearchQueryRegex(query)
    const { value } = await evaluateInTabContext<Partial<SearchPageTextResult>>(
      tab.id,
      `(() => {
        const query = ${JSON.stringify(query)};
        const pattern = ${JSON.stringify(spec.pattern)};
        const regexFlags = ${JSON.stringify(spec.flags)};
        const context = ${context};
        const limit = ${limit};
        const lineMax = ${SEARCH_LINE_MAX_LENGTH};
        const readyState = document.readyState;
        const rawText = document.body?.innerText ?? '';
${SEARCH_TEXT_MATCH_HELPERS_SOURCE}
        return computeSearchPageTextMatches(rawText, query, pattern, regexFlags,
          context, limit, lineMax, readyState, ${startLine});
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    const matches = value ?? {}
    return {
      pageEpoch,
      query: matches.query ?? boundPageText(query, 1024),
      regex: !spec.literal,
      pattern: matches.pattern ?? boundPageText(spec.pattern, 1024),
      context,
      limit,
      startLine,
      ...(matches.nextStartLine !== undefined ? { nextStartLine: matches.nextStartLine } : {}),
      readyState: matches.readyState ?? 'complete',
      totalMatches: matches.totalMatches ?? 0,
      returned: matches.returned ?? 0,
      truncated: matches.truncated ?? false,
      windows: matches.windows ?? [],
    }
  }

  async function collectFeed(
    tabId: TabInput,
    options: CollectFeedOptions,
    frameSelector: FrameSelector,
  ): Promise<FeedCollectionResult> {
    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const selector = String(options.selector || '').trim() || 'article'
    const limit = Math.min(FEED_MAX_ITEMS, normalizeFeedCount(options.limit, 30))
    const maxScrolls = Math.min(FEED_MAX_SCROLLS, normalizeFeedCount(options.maxScrolls, 20))
    const pauseMs = normalizeFeedCount(options.pauseMs, 900)
    const stallRounds = normalizeFeedCount(options.stallRounds, 3)
    const dedupe = options.dedupe

    const { value } = await evaluateInTabContext<FeedCollectionResult>(
      tab.id,
      `(async () => {
        const selector = ${JSON.stringify(selector)};
        const limit = ${limit};
        const maxScrolls = ${maxScrolls};
        const pauseMs = ${pauseMs};
        const stallRounds = ${stallRounds};
        const dedupe = ${JSON.stringify(dedupe)};
        const pageEpoch = ${pageEpoch};

${PAGE_CONTEXT_TEXT_HELPERS_SOURCE}
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

        const normalize = (value) => collapseWhitespace(value || '').trim();

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

        const readText = (node) => normalize(node.querySelector("[data-testid='tweetText']")?.innerText || node.innerText || node.textContent || '');

        const parseAuthorHandle = (value) => {
          const raw = normalize(value);
          if (!raw) {
            return { author: null, handle: null };
          }

          const handleMatch = raw.match(/@[A-Za-z0-9_]+/);
          if (!handleMatch) {
            return { author: raw, handle: null };
          }

          const author = normalize(raw.slice(0, handleMatch.index).replace(/[·•|-–—]+$/, ''));
          return {
            author: author || null,
            handle: handleMatch[0],
          };
        };

        const readTime = (node) => {
          const timeNode = node.querySelector('time');
          return normalize(timeNode?.dateTime || timeNode?.getAttribute('datetime') || '') || null;
        };

        const readUrl = (node) => {
          const link = node.querySelector("a[href*='/status/']");
          return link && typeof link.href === 'string' ? link.href : null;
        };

        const readMediaUrls = (node) => {
          const sources = [
            ...Array.from(node.querySelectorAll('img[src]')).map((img) => img.currentSrc || img.src || img.getAttribute('src')),
            ...Array.from(node.querySelectorAll('video[src]')).map((video) => video.currentSrc || video.src || video.getAttribute('src')),
            ...Array.from(node.querySelectorAll('video source[src]')).map((source) => source.currentSrc || source.src || source.getAttribute('src')),
          ];

          return Array.from(new Set(sources.map((source) => normalize(source)).filter(Boolean)));
        };

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const items = [];
        const seen = new Set();
        let stopReason = 'limit';

        const collectVisibleItems = () => {
          let added = 0;

          for (const node of deepQuerySelectorAll(document, selector)) {
            if (items.length >= limit) {
              break;
            }

            if (!(node instanceof HTMLElement) || !isVisible(node)) {
              continue;
            }

            const text = readText(node);
            const url = readUrl(node);
            const authorInfo = parseAuthorHandle(node.querySelector("[data-testid='User-Name']")?.innerText || '');
            const mediaUrls = readMediaUrls(node);
            const dedupeKey = dedupe === 'none'
              ? null
              : dedupe === 'url'
                ? normalize(url || '')
                : normalize([authorInfo.author || '', authorInfo.handle || '', text].join('|'));

            if (dedupeKey) {
              if (seen.has(dedupeKey)) {
                continue;
              }

              seen.add(dedupeKey);
            }

            items.push({
              index: items.length + 1,
              pageEpoch,
              selector,
              author: authorInfo.author,
              handle: authorInfo.handle,
              time: readTime(node),
              text: text.slice(0, 2400),
              url,
              mediaUrls,
            });
            added += 1;
          }

          return added;
        };

        const scrollAndWait = async () => {
          const beforeScrollY = window.scrollY || 0;
          window.scrollBy(0, Math.max(200, Math.floor((window.innerHeight || 0) * 0.9)));
          await sleep(pauseMs);
          return (window.scrollY || 0) !== beforeScrollY;
        };

        let scrolls = 0;
        let stalledRounds = 0;

        while (items.length < limit && scrolls < maxScrolls) {
          const added = collectVisibleItems();
          if (items.length >= limit) {
            stopReason = 'limit';
            break;
          }

          if (added === 0) {
            stalledRounds += 1;
          } else {
            stalledRounds = 0;
          }

          if (stalledRounds > stallRounds) {
            stopReason = 'stalled';
            break;
          }

          const moved = await scrollAndWait();
          scrolls += 1;

          // 仅在本轮 added > 0 时才追加：避免与上面 added===0 分支双重计数
          if (!moved && added > 0) {
            stalledRounds += 1;
            if (stalledRounds > stallRounds) {
              stopReason = 'stalled';
              break;
            }
          }
        }

        if (items.length < limit && scrolls >= maxScrolls && stopReason === 'limit') {
          stopReason = 'maxScrolls';
        }

        collectVisibleItems();

        return {
          pageEpoch,
          selector,
          limit,
          dedupe,
          maxScrolls,
          pauseMs,
          stallRounds,
          scrolls,
          stopReason,
          count: items.length,
          items,
        };
      })()`,
      // 滚动采集可能远超默认 25s（maxScrolls * pauseMs），显式放宽 evaluate 上限避免被掐断
      withFrameSelectorOptions(frameSelector, { timeoutMs: maxScrolls * pauseMs + 60_000 }),
    )

    // evaluate 抛异常时上层已 throw；这里只对空结果做结构兜底
    if (value && Array.isArray(value.items)) {
      return value
    }

    return {
      pageEpoch,
      selector,
      limit,
      dedupe,
      maxScrolls,
      pauseMs,
      stallRounds,
      scrolls: 0,
      stopReason: 'stalled',
      count: 0,
      items: [],
    }
  }

  async function waitForLoadEvent(tabId: TabInput, timeout = 30000) {
    const tab = await getTargetTab(tabId)
    // 页面可能早已加载完成，之后不会再触发 load 事件，先查 readyState 避免空等到超时
    const { value: readyState } = await evaluateInTabContext<string>(tab.id, 'document.readyState')
    if (readyState === 'complete') {
      return { waited: true, condition: 'load' }
    }

    return await waitForDebuggerEvent(
      tab.id,
      timeout,
      async () => {
        await sendDebuggerCommand(tab.id, 'Page.enable', {})
      },
      (_, method) => method === 'Page.loadEventFired',
      () => ({ waited: true, condition: 'load' }),
      'wait load timeout',
    )
  }

  async function waitForNetworkIdle(tabId: TabInput, timeout = 30000) {
    const tab = await getTargetTab(tabId)
    return await waitForDebuggerEvent(
      tab.id,
      timeout,
      async () => {
        await Promise.all([
          sendDebuggerCommand(tab.id, 'Page.enable', {}),
          sendDebuggerCommand(tab.id, 'Page.setLifecycleEventsEnabled', { enabled: true }),
        ])
      },
      (_, method, params) => {
        const lifecycleParams = params as { name?: string } | undefined
        return method === 'Page.lifecycleEvent' && lifecycleParams?.name === 'networkidle'
      },
      () => ({ waited: true, condition: 'networkidle' }),
      'wait networkidle timeout',
    )
  }

  async function waitForSelectorState(
    tabId: TabInput,
    selector: string,
    state = 'visible',
    timeout = 30000,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const hidden = state === 'hidden'

    const getVisibleSignature = async () => {
      const { value } = await evaluateInTabContext<{ signature: string } | null>(
        tab.id,
        `(() => {
${PAGE_CONTEXT_TEXT_HELPERS_SOURCE}
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

          const visibleNodes = Array.from(deepQuerySelectorAll(document, ${JSON.stringify(resolvedSelector)})).filter((node) => {
            if (!(node instanceof HTMLElement)) {
              return false;
            }

            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              return false;
            }

            const style = node.ownerDocument.defaultView.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
          });

          if (visibleNodes.length === 0) {
            return null;
          }

          const fingerprint = visibleNodes
            .slice(0, 5)
            .map((node) => {
              const text = collapseWhitespace(node.innerText || node.textContent || '').slice(0, 80);
              const rect = node.getBoundingClientRect();
              const href = typeof node.href === 'string' ? node.href : node.getAttribute('href') || '';
              return [text, href, Math.round(rect.top), Math.round(rect.left), Math.round(rect.width), Math.round(rect.height)].join('~');
            })
            .join('|');

          return { signature: String(visibleNodes.length) + ':' + fingerprint };
        })()`,
        withFrameSelectorOptions(frameSelector),
      )

      return value?.signature || null
    }

    if (state === 'stable') {
      let previousSignature: string | null = null
      let stableRounds = 0

      return await pollUntil(
        timeout,
        async () => {
          const signature = await getVisibleSignature()

          if (!signature) {
            previousSignature = null
            stableRounds = 0
            return null
          }

          if (signature === previousSignature) {
            stableRounds += 1
          } else {
            previousSignature = signature
            stableRounds = 0
          }

          return stableRounds >= 1
            ? { waited: true, condition: 'selector-stable', selector, state }
            : null
        },
        `wait stable timeout: ${selector}`,
      )
    }

    if (state === 'new') {
      let baselineSignature: string | null = null

      return await pollUntil(
        timeout,
        async () => {
          const signature = await getVisibleSignature()

          if (!signature) {
            return null
          }

          if (baselineSignature === null) {
            baselineSignature = signature
            return null
          }

          return signature !== baselineSignature
            ? { waited: true, condition: 'selector-new', selector, state }
            : null
        },
        `wait new timeout: ${selector}`,
      )
    }

    return await pollUntil(
      timeout,
      async () => {
        const { value } = await evaluateInTabContext(
          tab.id,
          `(() => {
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

            const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
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

        return value === true ? { waited: true, condition: 'selector', selector, state } : null
      },
      `wait selector timeout: ${selector}`,
    )
  }

  async function waitForUrl(
    tabId: TabInput,
    urlPattern: string,
    timeout = 30000,
    frameSelector: FrameSelector,
  ) {
    return await pollUntil(
      timeout,
      async () => {
        const { value } = await evaluateInTabContext<string>(
          tabId,
          'window.location.href',
          withFrameSelectorOptions(frameSelector),
        )
        const currentUrl = value || ''
        if (!matchesUrlPattern(currentUrl, urlPattern)) {
          return null
        }

        return {
          waited: true,
          condition: 'url',
          url: currentUrl,
          pattern: urlPattern,
        }
      },
      `wait url timeout: ${urlPattern}`,
    )
  }

  async function waitForText(
    tabId: TabInput,
    text: string,
    timeout = 30000,
    frameSelector: FrameSelector,
    gone = false,
  ) {
    return await pollUntil(
      timeout,
      async () => {
        // 匹配在页面内完成，每轮 poll 只回传布尔值，避免整页 innerText 经 CDP 回传。
        // gone 时条件取反：body 不存在也视为"已消失"，与 textGone 语义对齐
        const { value } = await evaluateInTabContext<boolean>(
          tabId,
          gone
            ? `document.body ? !document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}) : true`
            : `document.body ? document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}) : false`,
          withFrameSelectorOptions(frameSelector),
        )
        return value === true
          ? { waited: true, condition: gone ? 'text-gone' : 'text', text }
          : null
      },
      `wait ${gone ? 'text-gone' : 'text'} timeout: ${text}`,
    )
  }

  async function waitForExpression(
    tabId: TabInput,
    expression: string,
    timeout = 30000,
    frameSelector: FrameSelector,
  ) {
    return await pollUntil(
      timeout,
      async () => {
        const { value } = await evaluateInTabContext(
          tabId,
          `((async () => {
            try {
              return Boolean(await Promise.resolve(Function('return (' + ${JSON.stringify(expression)} + ')')()));
            } catch (error) {
              return false;
            }
          })())`,
          // 单次 poll 的 evaluate 上限比 wait 自身超时更长：长 wait 不会被默认 25s 掐断，
          // 整体超时由 pollUntil 自己兜底并给出明确的 wait timeout 错误
          withFrameSelectorOptions(frameSelector, { timeoutMs: timeout + 5000 }),
        )

        return value === true ? { waited: true, condition: 'fn', expression } : null
      },
      `wait fn timeout: ${expression}`,
    )
  }

  async function waitWithTimeout(_tabId: TabInput, ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { waited: true, condition: 'time', ms }
  }

  return {
    collectFeed,
    captureScreenshot,
    findSemanticTarget,
    searchPageText,
    snapshotTab,
    waitForExpression,
    waitForLoadEvent,
    waitForNetworkIdle,
    waitForSelectorState,
    waitForText,
    waitForUrl,
    waitWithTimeout,
  }
}
