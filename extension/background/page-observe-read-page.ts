import {
  isReadPageResumable,
  READ_PAGE_CACHE_MAX_ENTRIES,
  READ_PAGE_CACHE_MAX_TOTAL_CHARS,
  READ_PAGE_CAPTURE_LIMIT_CHARS,
  READ_PAGE_CURSOR_TTL_MS,
  READ_PAGE_EVALUATE_ALLOWANCE_MS,
  READ_PAGE_PDF_MAX_PAGES,
  READ_PAGE_SCROLL_STEP_RATIO,
  READ_PAGE_STALE_CURSOR_CODE,
  normalizeReadPageMaxChars,
  normalizeReadPageMaxScreens,
  normalizeReadPageTimeoutMs,
  sliceReadPageText,
  type ReadPageOptions,
  type ReadPagePdfStatus,
  type ReadPageResult,
  type ReadPageStopReason,
  type ReadPageStrategy,
} from '../../src/core/read-page.js'
import {
  createDefaultPdfBrowserApi,
  createPdfFeature,
  type PdfBrowserApi,
} from './page-observe-pdf.js'
import type { PageObserveDependencies } from './page-observe-context.js'
import { getPageEpoch, withFrameSelectorOptions } from './targeting.js'
import type { ErrorWithCode, FrameSelector, TabInput } from './types.js'

/** 页内扫描脚本的运行环境；测试可以注入轻量假 DOM。 */
export interface ReadPageScanEnvironment {
  document: any
  window: any
  location: { href: string }
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export interface ReadPageScanOptions {
  maxScreens: number
  timeoutMs: number
  captureLimit: number
  /** 每屏推进的视口比例。 */
  stepRatio: number
  /** 每次滚动后等待渲染的毫秒数。 */
  settleMs?: number
}

export interface ReadPageScanResult {
  text: string
  screens: number
  scrollHeight: number
  complete: boolean
  stopReason: ReadPageStopReason
  backgroundTab: boolean
  documentStatus: string
  url: string
}

/**
 * 页内滚动扫描：逐屏读取可见文本并累积，结束后恢复原滚动位置。
 *
 * 必须自包含：函数体会被序列化后注入页面执行，不能引用模块作用域。
 * 文本累积采用「滚动重叠区」去重：只去掉相邻两屏因滚动而重复的片段，
 * 因此正文中合法重复的行不会被误删（不做全局按行去重）。
 */
export async function scanPageText(
  env: ReadPageScanEnvironment,
  options: ReadPageScanOptions,
): Promise<ReadPageScanResult> {
  const doc = env.document
  const win = env.window
  const settleMs = typeof options.settleMs === 'number' ? options.settleMs : 120
  const captureLimit = options.captureLimit
  const maxScreens = Math.max(1, Math.floor(options.maxScreens))
  const stepRatio =
    typeof options.stepRatio === 'number' && options.stepRatio > 0 ? options.stepRatio : 0.85
  const deadlineAt = env.now() + options.timeoutMs
  const initialUrl = String(env.location?.href || '')
  const backgroundTab = doc?.hidden === true || doc?.visibilityState === 'hidden'

  const readStyle = (element: any): any => {
    try {
      if (win && typeof win.getComputedStyle === 'function') return win.getComputedStyle(element)
    } catch {
      return null
    }
    return null
  }

  // 真正的滚动容器：文档本身可滚时用文档，否则取面积最大的可见可滚动容器。
  const rootScroller = doc?.scrollingElement || doc?.documentElement || null
  const rootScrollable =
    !!rootScroller && (rootScroller.scrollHeight || 0) > (rootScroller.clientHeight || 0) + 4
  let container: any = null
  if (!rootScrollable) {
    let bestScore = 0
    const candidates = doc?.querySelectorAll ? (Array.from(doc.querySelectorAll('*')) as any[]) : []
    for (const element of candidates) {
      const style = readStyle(element)
      if (!style) continue
      const overflow = String(style.overflowY || style.overflow || '')
      if (!/auto|scroll|overlay/.test(overflow)) continue
      const clientHeight = element.clientHeight || 0
      const scrollHeight = element.scrollHeight || 0
      if (scrollHeight <= clientHeight + 4) continue
      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null
      if (!rect || rect.width <= 0 || rect.height <= 0) continue
      const score = scrollHeight * Math.min(rect.width, rect.height)
      if (score > bestScore) {
        bestScore = score
        container = element
      }
    }
  }

  const useWindow = container === null
  const getScrollTop = (): number =>
    useWindow ? Number(win?.scrollY ?? win?.pageYOffset ?? 0) : Number(container?.scrollTop || 0)
  const setScrollTop = (value: number): void => {
    if (useWindow) {
      if (typeof win?.scrollTo === 'function') win.scrollTo(0, value)
    } else if (container) {
      container.scrollTop = value
    }
  }
  const getClientHeight = (): number =>
    useWindow ? Number(win?.innerHeight || 0) : Number(container?.clientHeight || 0)
  const getScrollHeight = (): number =>
    useWindow
      ? Number(rootScroller?.scrollHeight || doc?.documentElement?.scrollHeight || 0)
      : Number(container?.scrollHeight || 0)

  const readScreenText = (): string => {
    if (doc?.body && typeof doc.body.innerText === 'string') return doc.body.innerText
    if (doc?.documentElement && typeof doc.documentElement.innerText === 'string') {
      return doc.documentElement.innerText
    }
    return ''
  }

  const capturedLines: string[] = []
  const capturedTrimmed: string[] = []
  let capturedChars = 0

  /**
   * 求 text 结尾与 pattern 开头相同的最大长度。
   *
   * 只按行首尾空白忽略差异；不做全局按行去重，正文里合法重复的行因此得以保留。
   */
  const findOverlap = (
    textTrimmed: string[],
    textLength: number,
    patternTrimmed: string[],
  ): number => {
    if (textLength === 0 || patternTrimmed.length === 0) return 0
    const first = patternTrimmed[0]
    const candidates: number[] = []
    // 从小到大收集起点：起点越小重叠越长，先命中就是最长重叠。
    for (let index = 0; index < textLength && candidates.length < 64; index += 1) {
      if (textTrimmed[index] === first) candidates.push(index)
    }
    for (const start of candidates) {
      const size = textLength - start
      if (size > patternTrimmed.length) continue
      let matched = true
      for (let offset = 0; offset < size; offset += 1) {
        if (textTrimmed[start + offset] !== patternTrimmed[offset]) {
          matched = false
          break
        }
      }
      if (matched) return size
    }
    return 0
  }

  const appendScreenText = (screenText: string): void => {
    if (!screenText) return
    const screenLines = screenText.split('\n')
    const screenTrimmed = screenLines.map((line) => line.trim())
    // 屏幕开头的空行与已捕获结尾的空行不参与重叠匹配，避免空行把重叠算偏。
    let lead = 0
    while (lead < screenLines.length && !screenTrimmed[lead]) lead += 1
    let tail = capturedTrimmed.length
    while (tail > 0 && !capturedTrimmed[tail - 1]) tail -= 1
    const pattern = screenTrimmed.slice(lead)
    const overlap = findOverlap(capturedTrimmed, tail, pattern)
    for (let index = overlap; index < pattern.length; index += 1) {
      const line = screenLines[lead + index]!
      capturedLines.push(line)
      capturedTrimmed.push(pattern[index]!)
      capturedChars += line.length + 1
    }
  }

  const originalScrollTop = getScrollTop()
  let screens = 0
  let stopReason: ReadPageStopReason = 'complete'
  let complete = false
  let documentChanged = false
  // 只统计“已经到达当前底部、等待之后页面还在长高”的次数：
  // 正常的懒加载长文也会长高，一两次不能当成无限流。
  let bottomGrowthStreak = 0

  const locationChanged = (): boolean => String(env.location?.href || '') !== initialUrl

  /**
   * 页面身份是否已经变了。
   *
   * 位置检查必须在采集之前、也必须在每次等待之后：
   * 睡眠期间发生导航时，新页面的正文会被混进旧页面的捕获结果。
   */
  const detectDocumentChange = (): boolean => {
    if (!locationChanged()) return false
    documentChanged = true
    stopReason = 'documentChanged'
    return true
  }

  try {
    // 从页首开始读：原位置在中部或底部时直接扫会漏掉前文，却宣称读完。
    // 先回到顶部并给顶部一次渲染机会，读完再恢复原位置。
    let aborted = false
    if (originalScrollTop > 0) {
      setScrollTop(0)
      await env.sleep(settleMs)
      aborted = detectDocumentChange()
    }

    while (!aborted) {
      if (env.now() >= deadlineAt) {
        stopReason = 'budgetExhausted'
        break
      }

      if (detectDocumentChange()) break

      appendScreenText(readScreenText())
      screens += 1

      if (capturedChars >= captureLimit) {
        stopReason = 'captureLimit'
        break
      }

      const position = getScrollTop()
      const height = getScrollHeight()
      const client = getClientHeight()
      const atBottom = client <= 0 ? true : position + client >= height - 2
      const step = Math.max(1, Math.floor(client * stepRatio))

      if (atBottom) {
        // 到底后再等一下：懒加载与无限流都会在这段间隙里继续长高。
        await env.sleep(Math.max(settleMs, 200))
        if (detectDocumentChange()) break
        if (getScrollHeight() > height + 1) {
          bottomGrowthStreak += 1
          if (bottomGrowthStreak >= 3) {
            stopReason = 'endlessFeed'
            break
          }
          // 还有新内容：先把它读掉，再看是不是无限流。
          setScrollTop(position + step)
          await env.sleep(settleMs)
          if (detectDocumentChange()) break
          continue
        }
        stopReason = 'complete'
        complete = true
        break
      }

      if (screens >= maxScreens) {
        stopReason = 'maxScreens'
        break
      }

      setScrollTop(position + step)
      await env.sleep(settleMs)
      if (detectDocumentChange()) break

      const nextPosition = getScrollTop()
      if (Math.abs(nextPosition - position) < 1) {
        // 滚不动：后台标签页通常是被渲染节流（renderFrozen），否则视为卡住。
        stopReason = backgroundTab ? 'renderFrozen' : 'stalled'
        break
      }
    }
  } finally {
    // 页面已经换掉时不要去滚动新页面：只恢复原文档的滚动位置。
    if (!locationChanged()) {
      setScrollTop(originalScrollTop)
    }
  }

  let text = capturedLines.join('\n')
  if (text.length > captureLimit) {
    text = text.slice(0, captureLimit)
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, text.length - 1)
    stopReason = 'captureLimit'
    complete = false
  }
  if (!text.trim()) {
    // 空文本不能证明「已读完」：没有文本就明确说明没有读到内容。
    stopReason = 'noText'
    complete = false
  }

  return {
    text,
    screens,
    scrollHeight: getScrollHeight(),
    complete,
    stopReason,
    backgroundTab,
    documentStatus: documentChanged ? 'changed' : 'stable',
    url: String(env.location?.href || ''),
  }
}

interface ReadPageCapture {
  id: string
  tabId: number
  frameKey: string
  pageEpoch: number
  tabUrl: string
  capturedText: string
  totalChars: number
  complete: boolean
  stopReason: ReadPageStopReason
  strategy: ReadPageStrategy
  screens: number
  scrollHeight: number
  backgroundTab: boolean
  documentStatus: string
  pdfStatus?: ReadPagePdfStatus
  pages?: number
  pagesRead?: number
  note?: string
  createdAt: number
}

interface ReadPageCursorRecord {
  captureId: string
  offset: number
  createdAt: number
}

function frameKeyOf(frameSelector: FrameSelector): string {
  return typeof frameSelector === 'string' && frameSelector.trim() ? frameSelector.trim() : 'top'
}

function createStaleCursorError(reason: string): ErrorWithCode {
  const error = new Error(`read_page cursor is no longer usable: ${reason}`) as ErrorWithCode
  error.code = READ_PAGE_STALE_CURSOR_CODE
  error.suggestedAction =
    'Run read_page again without --cursor to capture the current page; the previous capture no longer matches this tab.'
  return error
}

/**
 * maxChars 连一个完整码点都放不下时的错误。
 *
 * 返回空分片会让调用方拿到永远前进不了的游标，属于静默失败，必须显式报错。
 */
function createReadPageMaxCharsError(maxChars: number): ErrorWithCode {
  const error = new Error(
    `read_page cannot return a complete character with --max-chars ${maxChars}: the next character needs more than one UTF-16 unit`,
  ) as ErrorWithCode
  error.code = 'INVALID_COMMAND_ARGS'
  error.details = { field: 'maxChars', value: maxChars }
  error.suggestedAction =
    'Use --max-chars 2 or more so surrogate pairs (for example emoji) fit in one slice, then continue with the returned nextCursor.'
  return error
}

export interface ReadPageFeatureDependencies extends PageObserveDependencies {
  /** 浏览器 API 封装；测试可以注入假实现。 */
  pdfBrowser?: PdfBrowserApi
}

/**
 * 创建长文读取域：DOM 滚动扫描 + PDF 文本抽取 + 可续读的观察缓存。
 */
export function createReadPageFeature(dependencies: ReadPageFeatureDependencies) {
  const { state, getTargetTab, evaluateInTabContext, resolveFrameTarget } = dependencies
  const pdf = createPdfFeature({
    browser: dependencies.pdfBrowser ?? createDefaultPdfBrowserApi(),
  })

  const captures = new Map<string, ReadPageCapture>()
  const cursors = new Map<string, ReadPageCursorRecord>()

  function removeCapture(captureId: string): void {
    captures.delete(captureId)
    for (const [token, record] of cursors) {
      if (record.captureId === captureId) cursors.delete(token)
    }
  }

  function purgeExpired(now: number): void {
    for (const [captureId, capture] of captures) {
      if (now - capture.createdAt <= READ_PAGE_CURSOR_TTL_MS) continue
      removeCapture(captureId)
    }
    for (const [token, record] of cursors) {
      if (now - record.createdAt > READ_PAGE_CURSOR_TTL_MS) cursors.delete(token)
    }
  }

  function enforceLimits(): void {
    const totalChars = (): number => {
      let sum = 0
      for (const capture of captures.values()) sum += capture.capturedText.length
      return sum
    }
    const oldestCapture = (): string | null => {
      let oldestId: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [captureId, capture] of captures) {
        if (capture.createdAt < oldestAt) {
          oldestAt = capture.createdAt
          oldestId = captureId
        }
      }
      return oldestId
    }
    while (captures.size > READ_PAGE_CACHE_MAX_ENTRIES) {
      const oldestId = oldestCapture()
      if (!oldestId) break
      removeCapture(oldestId)
    }
    while (captures.size > 1 && totalChars() > READ_PAGE_CACHE_MAX_TOTAL_CHARS) {
      const oldestId = oldestCapture()
      if (!oldestId) break
      removeCapture(oldestId)
    }
  }

  function issueCursor(capture: ReadPageCapture, offset: number): string {
    const token = `rp_${crypto.randomUUID().replace(/-/g, '')}`
    cursors.set(token, { captureId: capture.id, offset, createdAt: Date.now() })
    return token
  }

  function storeCapture(capture: ReadPageCapture): void {
    captures.set(capture.id, capture)
    purgeExpired(Date.now())
    enforceLimits()
  }

  async function probePage(
    tabId: number,
    frameSelector: FrameSelector,
  ): Promise<{
    isPdf: boolean
    url: string
    contentType: string
    hidden: boolean
  }> {
    const { value } = await evaluateInTabContext<{
      contentType?: string
      url?: string
      hasPdfEmbed?: boolean
      hidden?: boolean
    }>(
      tabId,
      `(() => {
        let hasPdfEmbed = false;
        try {
          hasPdfEmbed = !!document.querySelector('embed[type="application/pdf"]');
        } catch (error) {
          hasPdfEmbed = false;
        }
        return {
          contentType: document.contentType || '',
          url: (location && location.href) || '',
          hasPdfEmbed,
          hidden: document.hidden === true
        };
      })()`,
      withFrameSelectorOptions(frameSelector, { timeoutMs: 3_000 }),
    )
    const contentType = String(value?.contentType || '')
    return {
      isPdf: contentType === 'application/pdf' || value?.hasPdfEmbed === true,
      url: String(value?.url || ''),
      contentType,
      hidden: value?.hidden === true,
    }
  }

  async function scanDom(
    tabId: number,
    frameSelector: FrameSelector,
    options: { maxScreens: number; timeoutMs: number },
  ): Promise<ReadPageScanResult> {
    const scanOptions = {
      maxScreens: options.maxScreens,
      timeoutMs: options.timeoutMs,
      captureLimit: READ_PAGE_CAPTURE_LIMIT_CHARS,
      stepRatio: READ_PAGE_SCROLL_STEP_RATIO,
      settleMs: 120,
    }
    const { value } = await evaluateInTabContext<ReadPageScanResult>(
      tabId,
      `(async () => {
        const env = {
          document,
          window,
          // 用 getter 实时读取：扫描途中发生跳转时必须能看到新的 location。
          location: { get href() { return (location && location.href) || '' } },
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        };
        const scan = ${scanPageText.toString()};
        return await scan(env, ${JSON.stringify(scanOptions)});
      })()`,
      // 页内 deadline 先到期，evaluate 留出余量把部分结果带回来。
      withFrameSelectorOptions(frameSelector, {
        timeoutMs: options.timeoutMs + READ_PAGE_EVALUATE_ALLOWANCE_MS,
      }),
    )
    return (
      value ?? {
        text: '',
        screens: 0,
        scrollHeight: 0,
        complete: false,
        stopReason: 'noText',
        backgroundTab: false,
        documentStatus: 'unknown',
        url: '',
      }
    )
  }

  async function readPdfPage(
    tabId: number,
    tabUrl: string,
    frameSelector: FrameSelector,
    options: { timeoutMs: number },
  ): Promise<{
    status: ReadPagePdfStatus
    text: string
    pages: number
    pagesRead: number
    truncated: boolean
    timedOut: boolean
    reason?: string
    documentChanged: boolean
  }> {
    let frameSrc: string | null = null
    if (typeof frameSelector === 'string' && frameSelector.trim()) {
      const frame = await resolveFrameTarget(tabId, frameSelector)
      frameSrc = frame.src ?? null
    }
    return await pdf.readPdf({
      tabId,
      frameSelector: typeof frameSelector === 'string' ? frameSelector : null,
      frameSrc,
      tabUrl,
      remainingMs: options.timeoutMs,
      maxPages: READ_PAGE_PDF_MAX_PAGES,
      captureLimit: READ_PAGE_CAPTURE_LIMIT_CHARS,
    })
  }

  async function readPage(
    tabId: TabInput,
    options: ReadPageOptions = {},
    frameSelector: FrameSelector = null,
  ): Promise<ReadPageResult> {
    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const frameKey = frameKeyOf(frameSelector)
    const maxChars = normalizeReadPageMaxChars(options.maxChars)
    purgeExpired(Date.now())

    if (options.cursor) {
      return await resumeCapture(
        tab.id,
        frameKey,
        options.cursor,
        maxChars,
        options.includeCapturedText === true,
      )
    }

    const timeoutMs = normalizeReadPageTimeoutMs(options.timeoutMs)
    const maxScreens = normalizeReadPageMaxScreens(options.maxScreens)
    const probe = await probePage(tab.id, frameSelector)

    let capture: ReadPageCapture
    if (probe.isPdf) {
      const outcome = await readPdfPage(tab.id, String(tab.url || ''), frameSelector, { timeoutMs })
      const stopReason: ReadPageStopReason = outcome.documentChanged
        ? 'documentChanged'
        : outcome.timedOut
          ? 'budgetExhausted'
          : outcome.truncated
            ? 'captureLimit'
            : outcome.status === 'ok'
              ? 'complete'
              : outcome.status === 'loading'
                ? 'stalled'
                : 'noText'
      const note =
        outcome.status === 'no_text'
          ? 'This PDF has no text layer. Run OCR outside autobrowser; it never OCRs or unlocks documents on its own.'
          : outcome.reason
      capture = {
        id: crypto.randomUUID(),
        tabId: tab.id,
        frameKey,
        pageEpoch,
        tabUrl: String(tab.url || ''),
        capturedText: outcome.text || '',
        totalChars: (outcome.text || '').length,
        complete:
          outcome.status === 'ok' &&
          !outcome.truncated &&
          !outcome.timedOut &&
          !outcome.documentChanged,
        stopReason,
        strategy: 'pdf',
        screens: 0,
        scrollHeight: 0,
        backgroundTab: probe.hidden,
        documentStatus: outcome.documentChanged ? 'changed' : 'stable',
        pdfStatus: outcome.status,
        pages: outcome.pages,
        pagesRead: outcome.pagesRead,
        ...(note ? { note } : {}),
        createdAt: Date.now(),
      }
    } else {
      const scan = await scanDom(tab.id, frameSelector, { maxScreens, timeoutMs })
      capture = {
        id: crypto.randomUUID(),
        tabId: tab.id,
        frameKey,
        pageEpoch,
        tabUrl: String(tab.url || ''),
        capturedText: scan.text,
        totalChars: scan.text.length,
        complete: scan.complete,
        stopReason: scan.stopReason,
        strategy: 'dom',
        screens: scan.screens,
        scrollHeight: scan.scrollHeight,
        backgroundTab: scan.backgroundTab,
        documentStatus: scan.documentStatus,
        createdAt: Date.now(),
      }
    }

    storeCapture(capture)
    return await deliverCapture(capture, 0, maxChars, options.includeCapturedText === true)
  }

  async function resumeCapture(
    tabId: number,
    frameKey: string,
    token: string,
    maxChars: number,
    includeCapturedText: boolean,
  ): Promise<ReadPageResult> {
    const record = cursors.get(token)
    const capture = record ? captures.get(record.captureId) : undefined
    if (!record || !capture) {
      throw createStaleCursorError('the capture expired or was evicted')
    }
    if (capture.tabId !== tabId) {
      throw createStaleCursorError('the cursor belongs to another tab')
    }
    if (capture.frameKey !== frameKey) {
      throw createStaleCursorError('the cursor belongs to another frame')
    }
    const currentEpoch = getPageEpoch(state, tabId)
    if (capture.pageEpoch !== currentEpoch) {
      throw createStaleCursorError('the page changed since the capture')
    }
    const currentTabUrl = String((await getTargetTab(tabId)).url || '')
    if (capture.tabUrl && currentTabUrl && capture.tabUrl !== currentTabUrl) {
      throw createStaleCursorError('the page URL changed since the capture')
    }
    return await deliverCapture(capture, record.offset, maxChars, includeCapturedText)
  }

  async function deliverCapture(
    capture: ReadPageCapture,
    offset: number,
    maxChars: number,
    includeCapturedText: boolean,
  ): Promise<ReadPageResult> {
    const text = sliceReadPageText(capture.capturedText, offset, maxChars)
    const nextOffset = offset + text.length
    const hasMore = nextOffset < capture.capturedText.length
    if (!text && hasMore) {
      // 还有文本，但当前 maxChars 连一个完整码点都放不下（例如 maxChars=1 遇到代理对）。
      // 返回空分片会让调用方拿到一个永远前进不了的游标，直接报错更诚实。
      throw createReadPageMaxCharsError(maxChars)
    }
    const resumable = isReadPageResumable(capture.stopReason)
    const nextCursor = hasMore && resumable ? issueCursor(capture, nextOffset) : undefined
    const result: ReadPageResult = {
      text,
      url: capture.tabUrl,
      strategy: capture.strategy,
      chars: text.length,
      totalChars: capture.totalChars,
      complete: capture.complete,
      truncated: hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      stopReason: capture.stopReason,
      screens: capture.screens,
      scrollHeight: capture.scrollHeight,
      backgroundTab: capture.backgroundTab,
      documentStatus: capture.documentStatus,
      ...(capture.pdfStatus ? { pdfStatus: capture.pdfStatus } : {}),
      ...(capture.pages !== undefined ? { pages: capture.pages } : {}),
      ...(capture.pagesRead !== undefined ? { pagesRead: capture.pagesRead } : {}),
      ...(capture.note ? { note: capture.note } : {}),
      ...(includeCapturedText ? { capturedText: capture.capturedText } : {}),
    }
    return result
  }

  return { readPage }
}
