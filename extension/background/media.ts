import type { CommandExecutionContext } from './command-queue.js'
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
 * 2. 用扩展自己记录的网络请求元数据（URL / MIME / tab / pageEpoch）补齐媒体源。
 *
 * 安全边界：
 * - 不读取也不执行任何网络响应正文（不 fetch、不 eval 远端文本）；
 * - 页面与网络返回的一切都只当数据看，绝不当指令执行；
 * - 唯一的副作用是 resolve 模式下的一次静音短播放（随后 pause），不导航、不刷新。
 */

/** 播放探测脚本的标记，测试用它识别"是否触发了播放" */
export const MEDIA_PLAY_PROBE_MARKER = 'autobrowser:media-resolve-play'

/** 播放探测里每个视频的最长播放时长（毫秒），总计不超过约 1 秒 */
export const MEDIA_PLAY_PROBE_MS = 600
/** 单次探测最多触发的视频数量，避免长页面被拖住 */
export const MEDIA_PLAY_PROBE_MAX_TARGETS = 2
/** 播放后等待新网络请求出现的时间上限（毫秒） */
export const MEDIA_SOURCE_WAIT_MS = 1000

const MEDIA_PLAYBACK_SUGGESTED_ACTION =
  'The browser blocked playback of the blob-backed video (background tab throttling or autoplay policy). Bring the tab to the foreground, start the video manually, then re-run the media command with resolve enabled.'

export type MediaKind =
  | 'image'
  | 'hls'
  | 'hls-variant'
  | 'mp4'
  | 'dash'
  | 'segment'
  | 'audio'
  | 'unknown'

export interface MediaSource {
  url: string
  kind: MediaKind
  contentType?: string
}

export interface MediaItem {
  /** DOM 顺序下标，从 0 开始 */
  index: number
  type: 'image' | 'video'
  /** 首选可下载 URL（视频为网络源，图片为当前候选）；没有时为 null */
  url: string | null
  /** 元素自身的 currentSrc（可能是 blob:），不可下载时仅作参考 */
  currentSrc: string | null
  sources: MediaSource[]
  /** 视频封面，图片恒为 null */
  poster: string | null
  /** 视频时长（秒），无法读取时为 null */
  duration: number | null
  /** 无法解析/无法解析出源时的原因 */
  error: string | null
  /** 给 agent 的下一步建议 */
  suggestedAction: string | null
}

export interface MediaListResult {
  media: MediaItem[]
}

export interface MediaEvaluateResult<TValue = unknown> {
  tab: TabWithId
  response: { result: unknown }
  value: TValue | null
}

export interface MediaDomainDependencies {
  state: ExtensionState
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<MediaEvaluateResult<TValue>>
}

/** 页面内采集脚本：只读 DOM 属性，不读 body 文本 */
const MEDIA_COLLECT_SCRIPT = `(() => {
  const toAbsolute = (value) => {
    if (!value) return '';
    try { return new URL(String(value), document.baseURI).href; } catch (error) { return ''; }
  };
  const isVisible = (node) => {
    try {
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (style) {
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (Number(style.opacity) === 0) return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  };
  const parseSrcset = (value) => {
    if (!value) return [];
    return String(value).split(',').map((part) => part.trim().split(/\\s+/)[0]).filter(Boolean);
  };
  const articles = Array.from(document.querySelectorAll('article'));
  const nodes = Array.from(document.querySelectorAll('img, video'));
  const selected = [];
  if (articles.length > 0) {
    const scoped = nodes.filter((node) => articles.some((article) => article.contains(node)));
    const visibleScoped = scoped.filter(isVisible);
    if (visibleScoped.length > 0) selected.push(...visibleScoped);
    else if (scoped.length > 0) selected.push(...scoped);
    else selected.push(...nodes.filter(isVisible));
  } else {
    const visible = nodes.filter(isVisible);
    if (visible.length > 0) selected.push(...visible);
    else selected.push(...nodes);
  }
  return selected.map((node, index) => {
    if (node.tagName === 'IMG') {
      const candidates = [];
      const push = (value) => {
        const url = toAbsolute(value);
        if (url && candidates.indexOf(url) === -1) candidates.push(url);
      };
      push(node.currentSrc);
      push(node.getAttribute('src'));
      for (const candidate of parseSrcset(node.getAttribute('srcset'))) push(candidate);
      return {
        index: index,
        type: 'image',
        url: candidates.length > 0 ? candidates[0] : null,
        currentSrc: node.currentSrc ? toAbsolute(node.currentSrc) : null,
        candidates: candidates,
        poster: null,
        duration: null,
        sources: []
      };
    }
    const sources = [];
    for (const source of Array.from(node.querySelectorAll('source'))) {
      const src = source.getAttribute('src');
      if (!src) continue;
      sources.push({ url: toAbsolute(src), contentType: source.getAttribute('type') || null });
    }
    const currentSrc = node.currentSrc ? toAbsolute(node.currentSrc) : null;
    const posterAttribute = node.getAttribute('poster');
    const duration = typeof node.duration === 'number' && isFinite(node.duration) ? node.duration : null;
    return {
      index: index,
      type: 'video',
      url: currentSrc || (sources.length > 0 ? sources[0].url : null),
      currentSrc: currentSrc,
      candidates: currentSrc ? [currentSrc] : [],
      poster: posterAttribute ? toAbsolute(posterAttribute) : null,
      duration: duration,
      sources: sources
    };
  });
})()`

/**
 * 播放探测脚本：静音短播 → 等待 → pause → 还原 muted/播放状态。
 * 只调用 play/pause，不做任何导航、跳转或刷新。
 */
const MEDIA_PLAY_PROBE_SCRIPT = `/* ${MEDIA_PLAY_PROBE_MARKER} */
(async () => {
  const videos = Array.from(document.querySelectorAll('video'));
  const targets = videos.filter((video) => {
    const src = video.currentSrc || video.getAttribute('src') || '';
    return !src || src.indexOf('blob:') === 0;
  });
  if (targets.length === 0) {
    return {
      attempted: false,
      played: false,
      error: 'no blob-backed video element was found in this frame'
    };
  }
  const limited = targets.slice(0, ${MEDIA_PLAY_PROBE_MAX_TARGETS});
  const errors = [];
  let played = false;
  for (const video of limited) {
    const previousMuted = video.muted;
    const wasPlaying = !video.paused;
    let started = false;
    try {
      video.muted = true;
      const promise = video.play();
      if (promise && typeof promise.then === 'function') await promise;
      started = true;
      played = true;
    } catch (error) {
      errors.push(error && error.message ? String(error.message) : String(error));
    }
    if (started) {
      try {
        await new Promise((resolve) => setTimeout(resolve, ${MEDIA_PLAY_PROBE_MS}));
      } catch (error) { /* ignore */ }
      try { video.pause(); } catch (error) { /* ignore */ }
    }
    try { video.muted = previousMuted; } catch (error) { /* ignore */ }
    if (wasPlaying) {
      try { await video.play(); } catch (error) { /* ignore */ }
    }
  }
  return {
    attempted: true,
    played: played,
    error: played
      ? null
      : errors.length > 0
        ? errors.join('; ')
        : 'the browser refused to start playback'
  };
})()`

interface RawPageMedia {
  index: number
  type: 'image' | 'video'
  url: string | null
  currentSrc: string | null
  candidates: string[]
  poster: string | null
  duration: number | null
  sources: Array<{ url: string | null; contentType: string | null }>
}

interface InternalSource {
  url: string
  kind: MediaKind
  contentType?: string
  score: number
  order: number
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
    })
  }
  return items.sort((left, right) => left.index - right.index)
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

function buildImageItem(raw: RawPageMedia): MediaItem {
  const sources: InternalSource[] = []
  let order = 0
  for (const candidate of raw.candidates) {
    const url = normalizeMediaUrl(candidate)
    if (!url) continue
    sources.push({ url, kind: 'image', score: KIND_SCORE.image, order: order++ })
  }
  if (sources.length === 0) {
    const url = normalizeMediaUrl(raw.url)
    if (url) sources.push({ url, kind: 'image', score: KIND_SCORE.image, order: 0 })
  }
  const deduped = dedupeSources(sources)
  return {
    index: raw.index,
    type: 'image',
    url: deduped[0]?.url ?? null,
    currentSrc: normalizeMediaUrl(raw.currentSrc),
    sources: deduped.map(toPublicSource),
    poster: null,
    duration: null,
    error: null,
    suggestedAction: null,
  }
}

function buildVideoItem(raw: RawPageMedia, candidates: NetworkCandidate[]): MediaItem {
  const sources: InternalSource[] = []
  let order = 0

  const currentSrc = normalizeMediaUrl(raw.currentSrc)
  // blob: 不是可下载源，只作为参考保留在 currentSrc
  if (currentSrc && !currentSrc.toLowerCase().startsWith('blob:')) {
    sources.push({
      url: currentSrc,
      kind: kindFromUrl(currentSrc),
      score: KIND_SCORE[kindFromUrl(currentSrc)],
      order: order++,
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
    })
  }

  // 没有可直取的 DOM 源（blob: / MSE / 空 src）时，用网络记录补齐
  const hasFetchableSource = sources.some((source) => isHttpUrl(source.url))
  if (!hasFetchableSource) {
    for (const candidate of candidates) {
      if (candidate.kind === 'audio') continue
      if (sources.some((source) => source.url === candidate.url)) continue
      sources.push({
        url: candidate.url,
        kind: candidate.kind,
        ...(candidate.contentType ? { contentType: candidate.contentType } : {}),
        score: KIND_SCORE[candidate.kind],
        order: candidate.order,
      })
    }
  }

  const deduped = dedupeSources(sources)
  const primary = deduped.find((source) => isHttpUrl(source.url)) ?? deduped[0]
  return {
    index: raw.index,
    type: 'video',
    url: primary?.url ?? currentSrc ?? null,
    currentSrc,
    sources: deduped.map(toPublicSource),
    poster: normalizeMediaUrl(raw.poster),
    duration: raw.duration,
    error: null,
    suggestedAction: null,
  }
}

function buildItems(rawItems: RawPageMedia[], candidates: NetworkCandidate[]): MediaItem[] {
  return rawItems.map((raw) =>
    raw.type === 'video' ? buildVideoItem(raw, candidates) : buildImageItem(raw),
  )
}

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
    context?: CommandExecutionContext,
  ): Promise<PlayProbeResult> {
    try {
      const { value } = await evaluateInTabContext<PlayProbeResult>(
        tabId,
        MEDIA_PLAY_PROBE_SCRIPT,
        frameOptions(frameSelector, context),
      )
      return {
        attempted: value?.attempted === true,
        played: value?.played === true,
        error: typeof value?.error === 'string' ? value.error : null,
      }
    } catch (error) {
      // 探测失败按"无法解析"处理，不伪造源；原始原因带给调用方
      return {
        attempted: true,
        played: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function waitForNewCandidates(
    tabId: number,
    before: Set<string>,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = collectNetworkCandidates(state, tabId)
      if (current.some((candidate) => !before.has(candidate.url))) return
      await sleep(100)
    }
  }

  /**
   * 列出目标 frame 里的图片/视频。
   *
   * @param tabId 目标 tab（需已解析成数字 id）
   * @param frameSelector 目标 frame，'top'/null 表示主文档
   * @param resolve 视频只有 blob:/无源时，是否允许一次静音短播来触发网络请求
   * @param context 命令执行上下文（用于取消检查）
   */
  async function list(
    tabId: number,
    frameSelector: FrameSelector,
    resolve = false,
    context?: CommandExecutionContext,
  ): Promise<MediaListResult> {
    context?.throwIfCancelled()
    const { value } = await evaluateInTabContext<unknown>(
      tabId,
      MEDIA_COLLECT_SCRIPT,
      frameOptions(frameSelector, context),
    )
    const rawItems = parseRawMedia(value)
    let candidates = collectNetworkCandidates(state, tabId)
    let items = buildItems(rawItems, candidates)

    const needsResolve = items.some((item) => item.type === 'video' && item.sources.length === 0)
    if (!resolve || !needsResolve) {
      return { media: items }
    }

    context?.throwIfCancelled()
    const before = new Set(candidates.map((candidate) => candidate.url))
    const probe = await runPlayProbe(tabId, frameSelector, context)
    if (probe.played) {
      await waitForNewCandidates(tabId, before, MEDIA_SOURCE_WAIT_MS)
    }

    // 播放后重新收集：播放器可能刚刚发起了新的媒体请求
    candidates = collectNetworkCandidates(state, tabId)
    items = buildItems(rawItems, candidates)

    for (const item of items) {
      if (item.type !== 'video' || item.sources.length > 0) continue
      item.error = probe.played
        ? 'no media source was observed after a short muted playback probe'
        : `unable to resolve the media stream: ${probe.error || 'playback was blocked'}`
      item.suggestedAction = MEDIA_PLAYBACK_SUGGESTED_ACTION
    }

    return { media: items }
  }

  return {
    list,
  }
}
