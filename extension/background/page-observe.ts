import { AGENT_FRAME_REF_ATTRIBUTE, AGENT_FRAME_REF_PREFIX } from '../../src/core/agent-handles.js'
import { AGENT_ELEMENT_REF_ATTRIBUTE } from '../../src/core/agent-selectors.js'
import { parseSearchQueryRegex } from '../../src/core/search.js'
import { buildDeepDomTraversalHelpersSource } from './deep-dom.js'
import { createElementNotFoundError } from './page-input.js'
import {
  collapseWhitespace,
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

const PAGE_CONTEXT_TEXT_HELPERS_SOURCE = [
  collapseWhitespace.toString(),
  splitWhitespaceTokens.toString(),
].join('\n')

const PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE = buildDeepDomTraversalHelpersSource()

const PAGE_CONTEXT_FIND_HELPERS_SOURCE = [
  PAGE_CONTEXT_TEXT_HELPERS_SOURCE,
  PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE,
  parsePageContextElementRefIndex.toString(),
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
  /** 合并后的匹配窗口数超过 limit，返回结果被截断 */
  truncated: boolean
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
}

/**
 * 纯函数：把页面可见文本按行切分，找出匹配行并组装上下文窗口。
 * 通过 toString() 嵌入页面上下文执行，因此不能引用任何模块级闭包变量。
 */
export function computeSearchPageTextMatches(
  rawText: string,
  query: string,
  pattern: string,
  regexFlags: string,
  context: number,
  limit: number,
  lineMax: number,
  readyState: string,
): Omit<SearchPageTextResult, 'pageEpoch'> {
  const escapeRegExpSource = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 查询解析规则与 src/core/search.ts 的 parseSearchQueryRegex 保持一致：
  // /pattern/flags 形式按正则处理，其余文本当作大小写不敏感的子串匹配
  const literal = !/^\/(.+)\/([a-zA-Z]*)$/.test(query)
  const source = literal ? escapeRegExpSource(pattern) : pattern
  const regex = new RegExp(source, regexFlags)
  const lines = rawText.split('\n')
  const lineCount = lines.length
  const matchedLines: number[] = []
  for (let index = 0; index < lineCount; index += 1) {
    regex.lastIndex = 0
    if (regex.test(lines[index])) {
      matchedLines.push(index + 1)
    }
  }
  const totalMatches = matchedLines.length

  // 相邻或重叠的上下文窗口合并成同一个窗口，避免连续命中时返回重复片段
  const mergedWindows: Array<{ startLine: number; endLine: number }> = []
  for (const matchLine of matchedLines) {
    const windowStart = Math.max(1, matchLine - context)
    const windowEnd = Math.min(lineCount, matchLine + context)
    const last = mergedWindows[mergedWindows.length - 1]
    if (last && windowStart <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, windowEnd)
    } else {
      mergedWindows.push({ startLine: windowStart, endLine: windowEnd })
    }
  }

  const windows = mergedWindows.slice(0, limit).map(({ startLine, endLine }) => ({
    startLine,
    endLine,
    lines: Array.from({ length: endLine - startLine + 1 }, (_, offset) => {
      const lineNumber = startLine + offset
      const text = lines[lineNumber - 1] ?? ''
      return {
        line: lineNumber,
        text: text.slice(0, lineMax),
        matched: regex.test(text),
        truncated: text.length > lineMax,
      }
    }),
  }))

  return {
    query,
    regex: !literal,
    pattern,
    context,
    limit,
    readyState,
    totalMatches,
    returned: windows.length,
    truncated: mergedWindows.length > limit,
    windows,
  }
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
  const snapshotSignatureCache = new Map<string, { pageEpoch: number; signatures: string[] }>()

  // 缓存键：同一 tab 上不同 roles / 子树产生的签名集合互不兼容，必须分开缓存
  const snapshotCacheKey = (tabId: number, roles: string[], selector?: string) =>
    `${tabId}|${[...roles].sort().join(',')}|${selector?.trim() || ''}`

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
          message: openDialog.message,
          defaultPrompt: openDialog.defaultPrompt,
        },
      }
    }
    const pageEpoch = getPageEpoch(state, tab.id)
    const roles = options.roles ?? []
    const changedMode = Boolean(options.changed)
    // 增量模式：pageEpoch 未变时用上次缓存的签名做页内 diff，否则退化为全量
    const cacheKey = snapshotCacheKey(tab.id, roles, options.selector)
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

${PAGE_CONTEXT_TEXT_HELPERS_SOURCE}
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

        const scope = targetRootSelector ? deepQuerySelector(document, targetRootSelector) : document;
        if (!scope) {
          return { found: false, pageEpoch };
        }

        const deepElements = deepCollectElements(scope);
        const deepLabels = deepElements.filter(
          (element) =>
            element instanceof HTMLElement &&
            String(element.tagName || '').toLowerCase() === 'label' &&
            element.getAttribute('for'),
        );

        const readText = (node) => collapseWhitespace(node.innerText || node.textContent || '');

        const getAssociatedLabel = (node) => {
          if (!(node instanceof HTMLElement) || !node.id) {
            return '';
          }

          const label = deepLabels.find((candidate) => candidate.getAttribute('for') === node.id);
          return label ? readText(label) : '';
        };

        const getAriaLabelledByText = (node) => {
          const labelledBy = node.getAttribute('aria-labelledby');
          if (!labelledBy) {
            return '';
          }

          return splitWhitespaceTokens(labelledBy)
            .map((id) => deepGetElementById(scope, id))
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

        // 两种 ref 属性合并成一趟遍历清理，减少全 DOM 扫描次数。
        // 子树截取时仍整页清理：refs 在子树内重新编号，不清理子树外的旧 ref 会造成同号冲突
        for (const element of deepQuerySelectorAll(document, '[' + refAttribute + '],[' + frameAttribute + ']')) {
          element.removeAttribute(refAttribute);
          element.removeAttribute(frameAttribute);
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

        // 合并成单个选择器，一次遍历取齐全部候选（deepQuerySelectorAll 内部已去重）
        const actionableSelector = selectors.join(',');
        const candidates = deepQuerySelectorAll(scope, actionableSelector);
        // Element.querySelectorAll 不含根自身，子树根命中选择器时补进候选
        if (scope instanceof HTMLElement && scope.matches(actionableSelector)) {
          candidates.unshift(scope);
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

          // role 过滤在可见性检查之后、ref 编号之前：ref 按过滤后的集合重新编号
          const role = inferRole(element);
          if (roles.length > 0 && (!role || !roles.includes(role))) {
            continue;
          }

          const refValue = 'e' + (elements.length + 1);
          element.setAttribute(refAttribute, refValue);

          const text = readText(element).slice(0, 240);
          const name = getName(element).slice(0, 240);

          elements.push({
            ref: '@' + refValue + '#p' + pageEpoch,
            tag: element.tagName.toLowerCase(),
            role,
            text,
            name,
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
        for (const frameElement of deepQuerySelectorAll(scope, 'iframe')) {
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

        // 轻量指纹：ref + role + text + name，页内计算，供扩展做增量 diff 缓存
        const signatureOf = (el) => [el.ref, el.role || '', el.text, el.name].join('~');
        const signatures = elements.map(signatureOf);
        let visibleElements = elements;
        let unchangedCount = 0;
        let full = true;
        if (changedMode && previousSignatures.length > 0) {
          const previousSet = new Set(previousSignatures);
          visibleElements = elements.filter((el) => !previousSet.has(signatureOf(el)));
          unchangedCount = elements.length - visibleElements.length;
          full = false;
        }

        return {
          pageEpoch,
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          text: (scope === document ? document.body?.innerText || '' : scope.innerText || '').slice(0, 5000),
          elements: visibleElements,
          frames,
          headings: deepQuerySelectorAll(scope, "h1,h2,h3").slice(0, 20).map(toNodeSummary),
          buttons: deepQuerySelectorAll(scope, "button,[role='button'],input[type='button'],input[type='submit']").slice(0, 20).map(toNodeSummary),
          signatures,
          ...(changedMode ? { unchangedCount, full } : {}),
        };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    // 子树目标不存在时与其它命令保持一致：抛带引导的 STALE_REFERENCE
    if (value && (value as { found?: boolean }).found === false) {
      throw createElementNotFoundError(targetSelector?.trim() || '')
    }

    // 增量缓存更新：只认本次收集集的签名；found 检查之后再写，失败不污染缓存
    if (
      value &&
      typeof value === 'object' &&
      Array.isArray((value as Record<string, unknown>).signatures)
    ) {
      snapshotSignatureCache.set(cacheKey, {
        pageEpoch,
        signatures: (value as Record<string, unknown>).signatures as string[],
      })
    }

    // signatures 是内部透传字段，剥掉后再返回，避免泄漏进 JSONL export 与 meta 包络
    if (value && typeof value === 'object') {
      const { signatures: _omitted, ...result } = value as { signatures?: unknown } & Record<
        string,
        unknown
      >
      return result
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
      typeof options.candidates === 'number' && options.candidates > 0 ? options.candidates : 0

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
            const externalLabel = deepQuerySelectorAll(document, 'label[for]').find(
              (label) => label.getAttribute('for') === node.id,
            );
            if (externalLabel) {
              labels.push(readText(externalLabel));
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
              .map((id) => deepGetElementById(document, id))
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
            for (const node of deepQuerySelectorAll(document, selector)) {
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
          const currentRef = normalizeText(node.getAttribute(refAttribute));
          if (currentRef) {
            return '@' + currentRef + '#p' + pageEpoch;
          }

          let maxIndex = 0;
          for (const element of deepQuerySelectorAll(document, '[' + refAttribute + ']')) {
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
            tag: String(actionable.tagName || '').toLowerCase(),
            role: inferRole(actionable),
            text: readText(actionable).slice(0, 240),
            name: getAccessibleName(actionable).slice(0, 240),
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
        ? Math.max(0, Math.floor(options.context))
        : 3
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.min(SEARCH_MAX_LIMIT, Math.max(0, Math.floor(options.limit)))
        : 20

    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const openDialog = state.session.dialogs.get(tab.id)
    if (openDialog) {
      // 页面被未处理的 JS 对话框阻塞：不执行 DOM 遍历（会挂起），直接返回 modal 描述
      return {
        pageEpoch,
        query,
        regex: false,
        pattern: '',
        context,
        limit,
        readyState: 'blocked',
        totalMatches: 0,
        returned: 0,
        truncated: false,
        windows: [],
        modal: {
          open: true,
          type: openDialog.type,
          message: openDialog.message,
          defaultPrompt: openDialog.defaultPrompt,
        },
      }
    }

    if (!query) {
      // 空查询：防御性直接返回，避免无意义的页面求值
      return {
        pageEpoch,
        query,
        regex: false,
        pattern: '',
        context,
        limit,
        readyState: 'complete',
        totalMatches: 0,
        returned: 0,
        truncated: false,
        windows: [],
      }
    }

    const spec = parseSearchQueryRegex(query)
    const { value } = await evaluateInTabContext<Partial<SearchPageTextResult>>(
      tab.id,
      `(() => {
        const pageEpoch = ${pageEpoch};
        const query = ${JSON.stringify(query)};
        const pattern = ${JSON.stringify(spec.pattern)};
        const regexFlags = ${JSON.stringify(spec.flags)};
        const context = ${context};
        const limit = ${limit};
        const lineMax = ${SEARCH_LINE_MAX_LENGTH};
        const readyState = document.readyState;
        const rawText = document.body?.innerText ?? '';

${SEARCH_TEXT_MATCH_HELPERS_SOURCE}

        return computeSearchPageTextMatches(
          rawText,
          query,
          pattern,
          regexFlags,
          context,
          limit,
          lineMax,
          readyState,
        );
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    const matches = value ?? {}
    return {
      pageEpoch,
      query,
      regex: !spec.literal,
      pattern: spec.pattern,
      context,
      limit,
      // 直接回显页面报告的 readyState，与注入表达式里读的 document.readyState 保持一致
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
      withFrameSelectorOptions(frameSelector),
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
          withFrameSelectorOptions(frameSelector),
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
