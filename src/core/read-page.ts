/**
 * read_page 的共享协议口径。
 *
 * CLI、relay 与扩展引用同一份常量与纯函数，避免三处各写一套范围后出现
 * “CLI 放行、协议拒绝”这类漂移；也避免代理侧把分片、游标语义各理解一次。
 */

/** 单次响应最多返回的字符数（协议硬上限）。 */
export const READ_PAGE_MAX_CHARS_LIMIT = 60_000
export const READ_PAGE_MIN_CHARS = 1
export const READ_PAGE_DEFAULT_MAX_CHARS = READ_PAGE_MAX_CHARS_LIMIT

/** 单次扫描最多推进的屏数（协议硬上限）。 */
export const READ_PAGE_MAX_SCREENS_LIMIT = 60
export const READ_PAGE_MIN_SCREENS = 1
export const READ_PAGE_DEFAULT_MAX_SCREENS = READ_PAGE_MAX_SCREENS_LIMIT

/** 单次扫描的页内预算（毫秒）。 */
export const READ_PAGE_MIN_TIMEOUT_MS = 100
export const READ_PAGE_MAX_TIMEOUT_MS = 120_000
export const READ_PAGE_DEFAULT_TIMEOUT_MS = 25_000

/**
 * 单次扫描捕获的字符上限。
 *
 * 超过即标记 captureLimit：此时只能说“读到了前 N 字”，不能宣称是全文。
 */
export const READ_PAGE_CAPTURE_LIMIT_CHARS = 4_000_000

/** 每屏推进的视口比例：留 15% 重叠，避免行被切成两半导致漏字。 */
export const READ_PAGE_SCROLL_STEP_RATIO = 0.85

/** 扩展侧观察缓存：最多 8 份、总文本 8MiB、TTL 5 分钟。 */
export const READ_PAGE_CACHE_MAX_ENTRIES = 8
export const READ_PAGE_CACHE_MAX_TOTAL_CHARS = 8 * 1024 * 1024
export const READ_PAGE_CURSOR_TTL_MS = 5 * 60 * 1000

/** 页内 deadline 到期后留给 evaluate 收尾的余量，保证扩展能带着部分结果返回。 */
export const READ_PAGE_EVALUATE_ALLOWANCE_MS = 3_000

/** PDF 页数硬上限：超过即判 too_large，不再逐页解析。 */
export const READ_PAGE_PDF_MAX_PAGES = 5_000

/** PDF 视图器初始化的等待上限（毫秒），同时受命令总预算约束。 */
export const READ_PAGE_PDF_INIT_TIMEOUT_MS = 4_000

export type ReadPageStrategy = 'dom' | 'pdf'

/**
 * 扫描停止原因。
 *
 * complete 只在真正扫到底时出现；其余取值都表示“这次拿到的不是全文”，
 * 代理必须结合 complete 判断能否当作全文使用。
 */
export type ReadPageStopReason =
  | 'complete'
  | 'maxScreens'
  | 'endlessFeed'
  | 'renderFrozen'
  | 'stalled'
  | 'budgetExhausted'
  | 'documentChanged'
  | 'captureLimit'
  | 'noText'

export const READ_PAGE_STOP_REASONS: readonly ReadPageStopReason[] = [
  'complete',
  'maxScreens',
  'endlessFeed',
  'renderFrozen',
  'stalled',
  'budgetExhausted',
  'documentChanged',
  'captureLimit',
  'noText',
]

/** PDF 读取状态：ok 之外的状态都不能当作“已读到 PDF 正文”。 */
export type ReadPagePdfStatus =
  | 'ok'
  | 'loading'
  | 'no_text'
  | 'password'
  | 'too_large'
  | 'unavailable'

/** 续读游标失效（页面已变、缓存过期或目标不匹配）。 */
export const READ_PAGE_STALE_CURSOR_CODE = 'STALE_READ_CURSOR'

/** frame 里的 PDF 无法唯一定位（同名 URL 出现在多个 frame）。 */
export const READ_PAGE_AMBIGUOUS_FRAME_CODE = 'AMBIGUOUS_FRAME'

/** PDF 视图器/文档不可达。 */
export const READ_PAGE_PDF_UNAVAILABLE_CODE = 'PDF_UNAVAILABLE'

export interface ReadPageOptions {
  /** 续读游标；命中缓存时不会重新滚动扫描。 */
  cursor?: string
  /** 本次响应返回的最大字符数。 */
  maxChars?: number
  /** 本次扫描最多推进的屏数（仅首次扫描有效）。 */
  maxScreens?: number
  /** 页内扫描预算（毫秒，仅首次扫描有效）。 */
  timeoutMs?: number
  /** 是否随结果返回完整捕获文本（供 CLI 落盘；不请求则不下发，避免撑大响应）。 */
  includeCapturedText?: boolean
}

export interface ReadPageResult {
  /** 当前分片文本；--output 模式下由 CLI 落盘，响应里不再重复正文。 */
  text: string
  url: string
  strategy: ReadPageStrategy
  /** 本次返回的字符数。 */
  chars: number
  /** 本次扫描捕获的总字符数。 */
  totalChars: number
  /** 只有真正扫到底且没有截断/文档变化时才为 true。 */
  complete: boolean
  /** 本次返回的内容不是全部已捕获文本。 */
  truncated: boolean
  /** 还有已捕获内容可续读时的游标；只指向捕获缓存，不会重新扫描。 */
  nextCursor?: string
  stopReason: ReadPageStopReason
  screens: number
  scrollHeight: number
  backgroundTab: boolean
  documentStatus?: string
  /** 仅在请求 includeCapturedText 时出现。 */
  capturedText?: string
  /** PDF 读取状态；DOM 策略下不存在。 */
  pdfStatus?: ReadPagePdfStatus
  /** PDF 总页数。 */
  pages?: number
  /** PDF 实际读到的页数。 */
  pagesRead?: number
  /** 无文本层等情况的处理提示（例如建议外部 OCR）。 */
  note?: string
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** 把协议层的 maxChars 归一到合法区间。 */
export function normalizeReadPageMaxChars(value: unknown): number {
  return clampInteger(
    value,
    READ_PAGE_MIN_CHARS,
    READ_PAGE_MAX_CHARS_LIMIT,
    READ_PAGE_DEFAULT_MAX_CHARS,
  )
}

/** 把协议层的 maxScreens 归一到合法区间。 */
export function normalizeReadPageMaxScreens(value: unknown): number {
  return clampInteger(
    value,
    READ_PAGE_MIN_SCREENS,
    READ_PAGE_MAX_SCREENS_LIMIT,
    READ_PAGE_DEFAULT_MAX_SCREENS,
  )
}

/** 把协议层的 timeoutMs 归一到合法区间。 */
export function normalizeReadPageTimeoutMs(value: unknown): number {
  return clampInteger(
    value,
    READ_PAGE_MIN_TIMEOUT_MS,
    READ_PAGE_MAX_TIMEOUT_MS,
    READ_PAGE_DEFAULT_TIMEOUT_MS,
  )
}

/**
 * 文档已变（导航/换页）时，旧的捕获文本不能继续当成新页面的内容交付。
 */
export function isReadPageResumable(stopReason: ReadPageStopReason): boolean {
  return stopReason !== 'documentChanged' && stopReason !== 'endlessFeed' && stopReason !== 'noText'
}

/**
 * 按字符切片，但不切断 UTF-16 代理对。
 *
 * 返回的片段一定是完整的码点序列；代理对被切开时向前回退一个字符，
 * 避免模型收到半个 emoji 或半个 CJK 扩展字符。
 */
export function sliceReadPageText(text: string, offset: number, maxChars: number): string {
  if (!text || maxChars <= 0 || offset >= text.length) return ''
  let start = Math.max(0, Math.floor(offset))
  // 起点落在代理对中间时向后跳一个字符，避免输出半个低代理项。
  if (start > 0) {
    const code = text.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) start += 1
  }
  let end = Math.min(text.length, start + Math.floor(maxChars))
  if (end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
  }
  return text.slice(start, end)
}
