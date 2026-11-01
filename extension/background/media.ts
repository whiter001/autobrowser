import type { CommandExecutionContext } from './command-queue.js'
import { buildMediaCollectScript, buildMediaPlayProbeScript, type MediaScope } from './media-dom.js'
import { getPageEpoch } from './targeting.js'
import type {
  EvaluateInTabContextOptions,
  ExtensionState,
  FrameSelector,
  NetworkRequestRecord,
  TabInput,
  TabWithId,
} from './types.js'

/**
 * 扩展页面媒体发现模块。
 *
 * 只做两件事：
 * 1. 在目标 frame 内读取 DOM 上的图片/视频元素（属性级读取，不读 body 文本）；
 * 2. 播放探测期间的网络请求元数据仅作为未验证诊断，不补入可下载源。
 *
 * 安全边界：
 * - 不读取也不执行任何网络响应正文（不 fetch、不 eval 远端文本）；
 * - 页面与网络返回的一切都只当数据看，绝不当指令执行；
 * - 唯一的副作用是 resolve 模式下的一次静音短播放（随后 pause），不导航、不刷新。
 */

/** 播放后等待新网络请求出现的时间上限（毫秒） */
const MEDIA_SOURCE_WAIT_MS = 1000

/** 单次 list 最多逐个探测的视频数量，避免长页面被拖住 */
const MEDIA_RESOLVE_MAX_VIDEOS = 3

const MEDIA_AMBIGUOUS_SOURCES_ERROR =
  'multiple videos in scope have no fetchable source, so the observed network candidates cannot be attributed to one of them'

const MEDIA_AMBIGUOUS_SOURCES_SUGGESTED_ACTION =
  'Narrow the scope with --selector or expose a direct DOM source manually. --resolve only provides unverified network diagnostics.'

const MEDIA_SCOPED_SOURCE_ERROR =
  'this video has no direct source, and the network requests observed on this tab may belong to media outside the selected scope'

const MEDIA_SCOPED_SOURCE_SUGGESTED_ACTION =
  'Expose a direct DOM source manually; --resolve only provides unverified network diagnostics, not downloadable sources.'

type MediaKind = 'image' | 'hls' | 'hls-variant' | 'mp4' | 'dash' | 'segment' | 'audio' | 'unknown'

interface MediaSource {
  url: string
  kind: MediaKind
  contentType?: string
}

/** 主来源：dom=DOM 属性或 CSS，none=没有可用源 */
type MediaPrimarySource = 'dom' | 'none'

interface MediaItem {
  /** DOM 顺序下标，从 0 开始 */
  index: number
  type: 'image' | 'video'
  /** 首选 DOM URL；blob: 仅作参考，没有源时为 null，网络诊断绝不进入此字段。 */
  url: string | null
  /** 元素自身的 currentSrc（可能是 blob:），不可下载时仅作参考 */
  currentSrc: string | null
  sources: MediaSource[]
  /** 未验证的 tab-wide 网络诊断，不可作为下载输入。 */
  observedSources: Array<MediaSource & { unverified: true }>
  /** 视频封面，图片恒为 null */
  poster: string | null
  /** 视频时长（秒），无法读取时为 null */
  duration: number | null
  /** 无法解析/无法解析出源时的原因 */
  error: string | null
  /** 给 agent 的下一步建议 */
  suggestedAction: string | null
  /** 来源链接：最近 article 内首个 /status/ 链接；没有则为 null */
  permalink: string | null
  /** 主来源：dom / none */
  primarySource: MediaPrimarySource
  /** 该条目是否来自 CSS background-image */
  background: boolean
}

interface MediaListResult {
  media: MediaItem[]
  /** 本次发现无已知缺口；不保证尚未渲染的媒体不存在 */
  complete: boolean
  warnings: string[]
  /** 采集时间（ISO8601） */
  observedAt: string
  /** 采集时的页面 epoch */
  pageEpoch: number
  /** 采集时的页面 URL */
  pageUrl: string | null
  /** 本次采集的作用域 */
  scope: MediaScope
  includeBackground: boolean
}

interface MediaListOptions {
  /** 是否允许静音短播以暴露网络源 */
  resolve?: boolean
  /** 限定采集范围的 CSS 选择器 */
  selector?: string | null
  /** 是否采集 CSS background-image */
  includeBackground?: boolean
}

export interface MediaEvaluateResult<TValue = unknown> {
  tab: TabWithId
  response: { result: unknown }
  value: TValue | null
}

interface MediaDomainDependencies {
  state: ExtensionState
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<MediaEvaluateResult<TValue>>
}

interface RawPageMedia {
  index: number
  type: 'image' | 'video'
  url: string | null
  currentSrc: string | null
  candidates: string[]
  poster: string | null
  duration: number | null
  sources: Array<{ url: string | null; contentType: string | null }>
  permalink: string | null
  background: boolean
  /** 无源视频列表中的诊断序号；探测定位仅使用 probeKey token。 */
  probeIndex: number | null
  /** 视频身份标识：探测时用来确认定位到的仍是同一个视频 */
  probeKey: string | null
}

interface RawPageResult {
  items: RawPageMedia[]
  scope: MediaScope
  pageUrl: string | null
}

interface InternalSource {
  url: string
  kind: MediaKind
  contentType?: string
  score: number
  order: number
  origin: 'dom' | 'network'
}

interface NetworkCandidate {
  url: string
  kind: MediaKind
  contentType?: string
  order: number
}

interface PlayProbeResult {
  attempted: boolean
  played: boolean
  error: string | null
}

// 来源优先级：master m3u8 与直接 mp4 最高，分片最低，保证分片/变体不会盖掉 master
const KIND_SCORE: Record<MediaKind, number> = {
  image: 100,
  hls: 100,
  mp4: 90,
  dash: 80,
  'hls-variant': 70,
  audio: 60,
  unknown: 55,
  segment: 10,
}

const HLS_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'video/mpegurl',
])

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.mkv'])
const SEGMENT_EXTENSIONS = new Set(['.ts', '.m4s', '.aac', '.vtt', '.cmfv', '.cmfa'])

// 常见视频 CDN：URL 本身不带媒体后缀时靠 host 识别
const VIDEO_CDN_HOST_TOKENS = [
  'googlevideo.com',
  'akamaized.net',
  'edgesuite.net',
  'vimeocdn.com',
  'video.twimg.com',
  'jwplayer.com',
  'jwplatform.com',
  'b-cdn.net',
  'bilivideo.com',
]

// 强提示：master/manifest 视为 master playlist
const MASTER_PLAYLIST_HINT = /(?:^|[^a-z])(master|manifest)(?:[^a-z]|$)/i
// 强提示：media/variant/清晰度后缀视为分片（变体）playlist
const VARIANT_PLAYLIST_HINT =
  /(?:media[_-]?playlist|variant|chunklist|chunk|\d{3,4}p)(?:[^a-z0-9]|$)/i

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 过滤掉 data:/about:/javascript:/空 URL，其余（含 blob:）保留 */
function normalizeMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const url = value.trim()
  if (!url) return null
  const lower = url.toLowerCase()
  if (lower.startsWith('data:')) return null
  if (lower.startsWith('about:')) return null
  if (lower.startsWith('javascript:')) return null
  return url
}

function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

function extensionOf(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase()
    const dot = path.lastIndexOf('.')
    return dot < 0 ? '' : path.slice(dot)
  } catch {
    return ''
  }
}

function kindFromContentType(contentType: string | null | undefined): MediaKind | null {
  if (!contentType) return null
  const mime = contentType.split(';')[0].trim().toLowerCase()
  if (!mime) return null
  if (HLS_CONTENT_TYPES.has(mime)) return 'hls'
  if (mime === 'application/dash+xml') return 'dash'
  if (mime === 'video/mp2t') return 'segment'
  if (mime.startsWith('video/')) return 'mp4'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('image/')) return 'image'
  return null
}

function kindFromUrl(url: string): MediaKind {
  const extension = extensionOf(url)
  if (extension === '.m3u8') return 'hls'
  if (extension === '.mpd') return 'dash'
  if (SEGMENT_EXTENSIONS.has(extension)) return 'segment'
  if (VIDEO_EXTENSIONS.has(extension)) return 'mp4'
  return 'unknown'
}

function isKnownVideoCdn(url: string): boolean {
  let host = ''
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return false
  }
  return VIDEO_CDN_HOST_TOKENS.some((token) => host.includes(token))
}

/** 把一条网络请求判定为媒体请求；不是媒体返回 null */
function classifyMediaRequest(
  record: NetworkRequestRecord,
  url: string,
): { kind: MediaKind; contentType?: string } | null {
  const mime =
    typeof record.responseMimeType === 'string'
      ? record.responseMimeType.split(';')[0].trim().toLowerCase()
      : ''
  const extension = extensionOf(url)

  if (extension === '.m3u8') {
    return { kind: 'hls', contentType: mime || 'application/vnd.apple.mpegurl' }
  }
  if (extension === '.mpd') {
    return { kind: 'dash', contentType: mime || 'application/dash+xml' }
  }
  if (SEGMENT_EXTENSIONS.has(extension)) {
    return { kind: 'segment', ...(mime ? { contentType: mime } : {}) }
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { kind: 'mp4', ...(mime ? { contentType: mime } : {}) }
  }
  if (HLS_CONTENT_TYPES.has(mime)) return { kind: 'hls', contentType: mime }
  if (mime === 'application/dash+xml') return { kind: 'dash', contentType: mime }
  if (mime === 'video/mp2t') return { kind: 'segment', contentType: mime }
  if (mime.startsWith('video/')) return { kind: 'mp4', contentType: mime }
  if (mime.startsWith('audio/')) return { kind: 'audio', contentType: mime }
  if (record.resourceType === 'Media') {
    return { kind: 'unknown', ...(mime ? { contentType: mime } : {}) }
  }
  if (isKnownVideoCdn(url)) {
    return { kind: 'unknown', ...(mime ? { contentType: mime } : {}) }
  }
  return null
}

function requestRecordKey(record: NetworkRequestRecord): string {
  return [record.id ?? '', record.tabId ?? '', record.requestId ?? '', record.url ?? ''].join('|')
}

/**
 * 请求记录来源：session.requests 与 network.requests 都可能承载记录，
 * 两个来源都读并按 id 去重（当前实现只落在 network.requests）。
 */
function getRequestRecords(state: ExtensionState): NetworkRequestRecord[] {
  const sessionRequests = (state.session as { requests?: unknown }).requests
  const fromSession = Array.isArray(sessionRequests)
    ? sessionRequests.filter(
        (item): item is NetworkRequestRecord => Boolean(item) && typeof item === 'object',
      )
    : []
  const fromNetwork = Array.isArray(state.network?.requests) ? state.network.requests : []
  if (fromSession.length === 0) return fromNetwork

  const seen = new Set(fromSession.map(requestRecordKey))
  const merged = [...fromSession]
  for (const record of fromNetwork) {
    if (!record) continue
    const key = requestRecordKey(record)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(record)
  }
  return merged
}

/**
 * 收集当前 tab、当前 pageEpoch 的媒体请求。
 * 跨 tab / 跨 epoch 的请求一律排除，避免把上一个页面的流算进来。
 */
function collectNetworkCandidates(state: ExtensionState, tabId: number): NetworkCandidate[] {
  const records = getRequestRecords(state)
  const epoch = getPageEpoch(state, tabId)
  const candidates: NetworkCandidate[] = []

  records.forEach((record, index) => {
    if (!record) return
    if (record.tabId !== tabId) return
    if (record.pageEpoch !== epoch) return
    const url = normalizeMediaUrl(record.url)
    if (!url || !isHttpUrl(url)) return
    const classified = classifyMediaRequest(record, url)
    if (!classified) return
    candidates.push({
      url,
      kind: classified.kind,
      ...(classified.contentType ? { contentType: classified.contentType } : {}),
      order: index,
    })
  })

  refineHlsKinds(candidates)
  return candidates
}

/**
 * 区分 master playlist 与分片（变体）playlist。
 * 不读取 playlist 正文（远端文本一律不当指令、更不当数据源），
 * 只用 URL 特征 + 请求先后顺序判断：master 先被请求。
 */
function refineHlsKinds(candidates: NetworkCandidate[]): void {
  const playlists = candidates.filter((candidate) => candidate.kind === 'hls')
  if (playlists.length === 0) return

  const masters = playlists.filter((candidate) => MASTER_PLAYLIST_HINT.test(candidate.url))
  if (masters.length > 0) {
    for (const candidate of playlists) {
      if (!MASTER_PLAYLIST_HINT.test(candidate.url)) candidate.kind = 'hls-variant'
    }
    return
  }

  const strongVariants = playlists.filter((candidate) => VARIANT_PLAYLIST_HINT.test(candidate.url))
  if (strongVariants.length === playlists.length) {
    for (const candidate of playlists) candidate.kind = 'hls-variant'
    return
  }

  // 无明确特征：最早请求的 m3u8 视为 master，其余视为变体 playlist
  const earliest = playlists.reduce((left, right) => (left.order <= right.order ? left : right))
  for (const candidate of playlists) {
    if (candidate !== earliest) candidate.kind = 'hls-variant'
  }
}

function parseRawScope(value: unknown): MediaScope {
  if (!value || typeof value !== 'object') {
    return { selector: null, mode: 'default', matchedCount: 0 }
  }
  const record = value as Record<string, unknown>
  const selector = typeof record.selector === 'string' ? record.selector : null
  const mode = record.mode === 'selector' ? 'selector' : 'default'
  const matchedCount =
    typeof record.matchedCount === 'number' && Number.isFinite(record.matchedCount)
      ? record.matchedCount
      : 0
  return { selector, mode, matchedCount }
}

function parseRawMedia(value: unknown): RawPageMedia[] {
  if (!Array.isArray(value)) return []
  const items: RawPageMedia[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const type = record.type === 'video' ? 'video' : record.type === 'image' ? 'image' : null
    if (!type) continue
    const candidates = Array.isArray(record.candidates)
      ? record.candidates.filter((item): item is string => typeof item === 'string')
      : []
    const sources = Array.isArray(record.sources)
      ? record.sources
          .filter(
            (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
          )
          .map((item) => ({
            url: typeof item.url === 'string' ? item.url : null,
            contentType: typeof item.contentType === 'string' ? item.contentType : null,
          }))
      : []
    items.push({
      index: typeof record.index === 'number' ? record.index : items.length,
      type,
      url: typeof record.url === 'string' ? record.url : null,
      currentSrc: typeof record.currentSrc === 'string' ? record.currentSrc : null,
      candidates,
      poster: typeof record.poster === 'string' ? record.poster : null,
      duration:
        typeof record.duration === 'number' && Number.isFinite(record.duration)
          ? record.duration
          : null,
      sources,
      permalink: typeof record.permalink === 'string' ? record.permalink : null,
      background: record.background === true,
      probeIndex: typeof record.probeIndex === 'number' ? record.probeIndex : null,
      probeKey: typeof record.probeKey === 'string' ? record.probeKey : null,
    })
  }
  return items.sort((left, right) => left.index - right.index)
}

function parseRawPageResult(value: unknown): RawPageResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    // 兼容旧结构：直接返回媒体数组
    return {
      items: parseRawMedia(value),
      scope: { selector: null, mode: 'default', matchedCount: 0 },
      pageUrl: null,
    }
  }
  const record = value as Record<string, unknown>
  return {
    items: parseRawMedia(record.items),
    scope: parseRawScope(record.scope),
    pageUrl: typeof record.pageUrl === 'string' ? record.pageUrl : null,
  }
}

/** 同 URL 只保留一条，保留信息更全（分数更高 / 带 contentType）的那条 */
function dedupeSources(sources: InternalSource[]): InternalSource[] {
  const byUrl = new Map<string, InternalSource>()
  for (const source of sources) {
    const existing = byUrl.get(source.url)
    if (!existing) {
      byUrl.set(source.url, source)
      continue
    }
    const useSource = source.score > existing.score
    byUrl.set(source.url, {
      url: existing.url,
      kind: useSource ? source.kind : existing.kind,
      contentType: source.contentType || existing.contentType,
      score: Math.max(existing.score, source.score),
      order: Math.min(existing.order, source.order),
      // DOM 提供的地址优先：它明确属于这个元素，网络候选只是推断
      origin: existing.origin === 'dom' || source.origin === 'dom' ? 'dom' : 'network',
    })
  }
  return [...byUrl.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.order !== right.order) return left.order - right.order
    return left.url.localeCompare(right.url)
  })
}

function toPublicSource(source: InternalSource): MediaSource {
  return {
    url: source.url,
    kind: source.kind,
    ...(source.contentType ? { contentType: source.contentType } : {}),
  }
}

/** 视频是否已经能从 DOM 直接拿到可下载的源 */
function hasFetchableDomSource(raw: RawPageMedia): boolean {
  if (raw.currentSrc && isHttpUrl(raw.currentSrc)) return true
  return raw.sources.some((source) => Boolean(source.url) && isHttpUrl(source.url!))
}

/** 网络候选里只有视频类请求才可能属于某个视频 */
function isVideoCandidate(candidate: NetworkCandidate): boolean {
  return candidate.kind !== 'image' && candidate.kind !== 'audio'
}

function buildImageItem(raw: RawPageMedia): MediaItem {
  const sources: InternalSource[] = []
  let order = 0
  for (const candidate of raw.candidates) {
    const url = normalizeMediaUrl(candidate)
    if (!url) continue
    sources.push({
      url,
      kind: 'image',
      score: KIND_SCORE.image,
      order: order++,
      origin: 'dom',
    })
  }
  if (sources.length === 0) {
    const url = normalizeMediaUrl(raw.url)
    if (url) sources.push({ url, kind: 'image', score: KIND_SCORE.image, order: 0, origin: 'dom' })
  }
  const deduped = dedupeSources(sources)
  return {
    index: raw.index,
    type: 'image',
    url: deduped[0]?.url ?? null,
    currentSrc: normalizeMediaUrl(raw.currentSrc),
    sources: deduped.map(toPublicSource),
    observedSources: [],
    poster: null,
    duration: null,
    error: null,
    suggestedAction: null,
    permalink: raw.permalink,
    primarySource: deduped.length > 0 ? 'dom' : 'none',
    background: raw.background,
  }
}

function buildVideoItem(raw: RawPageMedia, networkCandidates: NetworkCandidate[]): MediaItem {
  const sources: InternalSource[] = []
  let order = 0

  const currentSrc = normalizeMediaUrl(raw.currentSrc)
  // blob: 不是可下载源，只作为参考保留在 currentSrc
  if (currentSrc && !currentSrc.toLowerCase().startsWith('blob:')) {
    const kind = kindFromUrl(currentSrc)
    sources.push({
      url: currentSrc,
      kind,
      score: KIND_SCORE[kind],
      order: order++,
      origin: 'dom',
    })
  }
  for (const source of raw.sources) {
    const url = normalizeMediaUrl(source.url)
    if (!url) continue
    const kind = kindFromContentType(source.contentType) || kindFromUrl(url)
    sources.push({
      url,
      kind,
      ...(source.contentType ? { contentType: source.contentType } : {}),
      score: KIND_SCORE[kind],
      order: order++,
      origin: 'dom',
    })
  }

  // 播放期间的并发流量也不能证明归属；仅提供未验证诊断，绝不提升为可下载源。
  const observedSources = networkCandidates.filter(isVideoCandidate).map((candidate) => ({
    url: candidate.url,
    kind: candidate.kind,
    ...(candidate.contentType ? { contentType: candidate.contentType } : {}),
    unverified: true as const,
  }))

  const deduped = dedupeSources(sources)
  const primary = deduped.find((source) => isHttpUrl(source.url)) ?? deduped[0]
  const primarySource: MediaPrimarySource = primary ? 'dom' : 'none'
  return {
    index: raw.index,
    type: 'video',
    url: primary?.url ?? currentSrc ?? null,
    currentSrc,
    sources: deduped.map(toPublicSource),
    observedSources,
    poster: normalizeMediaUrl(raw.poster),
    duration: raw.duration,
    error: null,
    suggestedAction: null,
    permalink: raw.permalink,
    primarySource,
    background: false,
  }
}

interface ProbeOutcome {
  observed: NetworkCandidate[]
  probe: PlayProbeResult
}

/**
 * 创建媒体采集域：发现页面视频/音频源、播放探测与下载。
 */
export function createMediaDomain({ state, evaluateInTabContext }: MediaDomainDependencies) {
  function frameOptions(
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ): EvaluateInTabContextOptions {
    const frame = typeof frameSelector === 'string' ? frameSelector.trim() : ''
    return {
      ...(frame ? { frameSelector: frame } : {}),
      ...(context ? { commandContext: context } : {}),
    }
  }

  async function runPlayProbe(
    tabId: number,
    frameSelector: FrameSelector,
    selector: string | null,
    probeKey: string | null,
    context?: CommandExecutionContext,
  ): Promise<PlayProbeResult> {
    try {
      const { value } = await evaluateInTabContext<PlayProbeResult>(
        tabId,
        buildMediaPlayProbeScript({ selector, ...(probeKey ? { probeKey } : {}) }),
        frameOptions(frameSelector, context),
      )
      return {
        attempted: value?.attempted === true,
        played: value?.played === true,
        error: typeof value?.error === 'string' ? value.error : null,
      }
    } catch (error) {
      context?.throwIfCancelled()
      if ((error as { code?: string })?.code === 'COMMAND_CANCELLED') throw error
      return {
        attempted: true,
        played: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 仅记录实际播放期间新增的未验证诊断；时间相关性不代表元素归属。 */
  async function probeVideoForSource(
    tabId: number,
    frameSelector: FrameSelector,
    selector: string | null,
    probeKey: string | null,
    context?: CommandExecutionContext,
  ): Promise<ProbeOutcome> {
    const epoch = getPageEpoch(state, tabId)
    const check = () => {
      context?.throwIfCancelled()
      if (getPageEpoch(state, tabId) !== epoch) {
        throw Object.assign(new Error('page changed during media probe'), {
          code: 'STALE_MEDIA_STATE',
        })
      }
    }
    const before = new Set(collectNetworkCandidates(state, tabId).map((item) => item.url))
    const probe = await runPlayProbe(tabId, frameSelector, selector, probeKey, context)
    check()
    if (!probe.played) return { observed: [], probe }
    const deadline = Date.now() + MEDIA_SOURCE_WAIT_MS
    while (Date.now() < deadline) {
      check()
      if (collectNetworkCandidates(state, tabId).some((item) => !before.has(item.url))) break
      await sleep(100)
    }
    check()
    return {
      observed: collectNetworkCandidates(state, tabId).filter(
        (candidate) => !before.has(candidate.url),
      ),
      probe,
    }
  }

  /**
   * 列出目标 frame 里的图片/视频。
   *
   * @param tabId 目标 tab（需已解析成数字 id）
   * @param frameSelector 目标 frame，'top'/null 表示主文档
   * @param options resolve / selector / includeBackground
   * @param context 命令执行上下文（用于取消检查）
   */
  async function list(
    tabId: number,
    frameSelector: FrameSelector,
    options: MediaListOptions = {},
    context?: CommandExecutionContext,
  ): Promise<MediaListResult> {
    context?.throwIfCancelled()
    const resolve = options.resolve === true
    const selector =
      typeof options.selector === 'string' && options.selector.trim()
        ? options.selector.trim()
        : null
    const includeBackground = options.includeBackground === true
    const observedAt = new Date().toISOString()
    const pageEpoch = getPageEpoch(state, tabId)

    const { value, tab } = await evaluateInTabContext<unknown>(
      tabId,
      buildMediaCollectScript({ selector, includeBackground }),
      frameOptions(frameSelector, context),
    )
    const raw = parseRawPageResult(value)
    const rawItems = raw.items
    const tabUrl = typeof tab?.url === 'string' ? tab.url : null
    const pageUrl = raw.pageUrl ?? tabUrl

    const assertFresh = () => {
      context?.throwIfCancelled()
      if (getPageEpoch(state, tabId) !== pageEpoch) {
        throw Object.assign(new Error('page changed during media collection; collect again'), {
          code: 'STALE_MEDIA_STATE',
        })
      }
    }
    assertFresh()
    const scopedBySelector = selector !== null
    const unresolved = rawItems.filter(
      (item) => item.type === 'video' && !hasFetchableDomSource(item),
    )
    const outcomes = new Map<number, ProbeOutcome>()
    if (resolve) {
      let probed = 0
      for (const target of unresolved) {
        if (probed >= MEDIA_RESOLVE_MAX_VIDEOS) break
        if (target.probeIndex === null) continue
        assertFresh()
        probed += 1
        const outcome = await probeVideoForSource(
          tabId,
          frameSelector,
          selector,
          target.probeKey,
          context,
        )
        assertFresh()
        outcomes.set(target.index, outcome)
      }
    }

    const items = rawItems.map((raw) =>
      raw.type === 'video'
        ? buildVideoItem(raw, outcomes.get(raw.index)?.observed ?? [])
        : buildImageItem(raw),
    )

    const ambiguous = unresolved.length > 1
    for (const item of items) {
      if (item.type !== 'video' || item.sources.some((source) => isHttpUrl(source.url))) continue
      const outcome = outcomes.get(item.index)
      if (resolve) {
        item.error = !outcome
          ? 'video was not probed (resolve limit or missing target identity)'
          : outcome.probe.played
            ? 'no verified DOM source; observed network candidates are unverified and not downloadable'
            : `unable to resolve the media stream: ${outcome.probe.error || 'playback was blocked'}`
        item.suggestedAction =
          'Narrow the scope with --selector, or expose a direct DOM source manually and collect again.'
      } else if (ambiguous) {
        item.error = MEDIA_AMBIGUOUS_SOURCES_ERROR
        item.suggestedAction = MEDIA_AMBIGUOUS_SOURCES_SUGGESTED_ACTION
      } else if (scopedBySelector) {
        item.error = MEDIA_SCOPED_SOURCE_ERROR
        item.suggestedAction = MEDIA_SCOPED_SOURCE_SUGGESTED_ACTION
      }
    }

    const warnings: string[] = []
    if (raw.scope.mode === 'selector' && raw.scope.matchedCount === 0) {
      warnings.push(`Scope selector ${raw.scope.selector || selector} matched no elements.`)
    }
    if (items.length === 0) warnings.push('No media was discovered in the current scope.')
    if (
      resolve &&
      unresolved.filter((item) => item.probeIndex !== null).length > MEDIA_RESOLVE_MAX_VIDEOS
    ) {
      warnings.push(
        `Resolve limit reached: at most ${MEDIA_RESOLVE_MAX_VIDEOS} videos are probed per list.`,
      )
    }
    for (const item of items) {
      if (item.error) warnings.push(`Media ${item.index}: ${item.error}`)
      else if (!item.url || item.primarySource === 'none' || !isHttpUrl(item.url)) {
        warnings.push(`Media ${item.index}: no resolved HTTP(S) source was discovered.`)
      }
      const probe = outcomes.get(item.index)?.probe
      const probeError =
        probe?.error || (probe && !probe.played ? 'playback was blocked or not attempted' : null)
      if (probeError && !item.error?.includes(probeError)) {
        warnings.push(`Media ${item.index} playback probe: ${probeError}`)
      }
    }

    assertFresh()
    return {
      media: items,
      complete: warnings.length === 0,
      warnings,
      observedAt,
      pageEpoch,
      pageUrl,
      scope: raw.scope,
      includeBackground,
    }
  }

  return {
    list,
  }
}
