/**
 * HLS 播放列表解析与清晰度选择。
 * 这里只做纯文本解析，不发起任何网络访问，所有字节必须由调用方通过浏览器下载通道取得。
 */

export interface HlsVariant {
  /** 变体播放列表地址（已解析为绝对地址） */
  url: string
  bandwidth: number
  averageBandwidth: number | null
  width: number | null
  height: number | null
  codecs: string | null
  /** EXT-X-STREAM-INF 的 AUDIO 组名 */
  audioGroupId: string | null
  videoGroupId: string | null
  name: string | null
}

export interface HlsRendition {
  type: string
  groupId: string
  name: string
  /** 独立音轨等 rendition 的播放列表地址；为空表示轨道内嵌在变体里 */
  url: string | null
  isDefault: boolean
  autoSelect: boolean
  language: string | null
}

export interface HlsMasterPlaylist {
  variants: HlsVariant[]
  renditions: HlsRendition[]
}

export interface HlsSegment {
  url: string
  duration: number
  /** EXT-X-MAP 指定的初始化分片地址 */
  initUrl: string | null
  /** 该分片前是否出现 EXT-X-DISCONTINUITY */
  discontinuity: boolean
}

export interface HlsMediaPlaylist {
  segments: HlsSegment[]
  endList: boolean
  targetDuration: number
  totalDuration: number
  /** 是否出现 EXT-X-KEY 且 METHOD 非 NONE */
  encrypted: boolean
  /** 是否出现 EXT-X-BYTERANGE（分片字节范围下载暂不支持） */
  byteRange: boolean
}

const STREAM_INF_TAG = '#EXT-X-STREAM-INF:'
const MEDIA_TAG = '#EXT-X-MEDIA:'

/** 把相对地址按播放列表自身地址解析为绝对地址，保留 query。 */
export function resolveHlsUrl(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).toString()
  } catch {
    return uri
  }
}

/**
 * 解析 HLS 属性列表，例如 BANDWIDTH=1000,CODECS="a,b",RESOLUTION=640x360。
 * 值里的逗号可能出现在引号内（CODECS 常见），所以不能直接按逗号切分。
 */
export function parseHlsAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  let index = 0
  while (index < input.length) {
    while (index < input.length && /[\s,]/.test(input[index]!)) index += 1
    if (index >= input.length) break
    const equals = input.indexOf('=', index)
    if (equals === -1) break
    const key = input.slice(index, equals).trim().toUpperCase()
    index = equals + 1
    let value = ''
    if (input[index] === '"') {
      index += 1
      const end = input.indexOf('"', index)
      value = end === -1 ? input.slice(index) : input.slice(index, end)
      index = end === -1 ? input.length : end + 1
    } else {
      const end = input.indexOf(',', index)
      value = (end === -1 ? input.slice(index) : input.slice(index, end)).trim()
      index = end === -1 ? input.length : end + 1
    }
    attributes[key] = value
  }
  return attributes
}

function parseResolution(value: string | undefined): {
  width: number | null
  height: number | null
} {
  if (!value) return { width: null, height: null }
  const match = /^(\d+)x(\d+)$/i.exec(value.trim())
  if (!match) return { width: null, height: null }
  return { width: Number(match[1]), height: Number(match[2]) }
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

/** 解析主播放列表（EXT-X-STREAM-INF + EXT-X-MEDIA）。 */
export function parseHlsMasterPlaylist(text: string, baseUrl: string): HlsMasterPlaylist {
  const variants: HlsVariant[] = []
  const renditions: HlsRendition[] = []
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line.startsWith(STREAM_INF_TAG)) {
      const attributes = parseHlsAttributes(line.slice(STREAM_INF_TAG.length))
      const resolution = parseResolution(attributes['RESOLUTION'])
      let uri = ''
      // URI 行紧跟在 EXT-X-STREAM-INF 之后，中间可能夹着空行
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        const candidate = lines[scan]!.trim()
        if (!candidate || candidate.startsWith('#')) continue
        uri = candidate
        index = scan
        break
      }
      variants.push({
        url: uri ? resolveHlsUrl(uri, baseUrl) : '',
        bandwidth: parseNumber(attributes['BANDWIDTH']) ?? 0,
        averageBandwidth: parseNumber(attributes['AVERAGE-BANDWIDTH']),
        width: resolution.width,
        height: resolution.height,
        codecs: attributes['CODECS'] ?? null,
        audioGroupId: attributes['AUDIO'] ?? null,
        videoGroupId: attributes['VIDEO'] ?? null,
        name: attributes['NAME'] ?? null,
      })
      continue
    }
    if (line.startsWith(MEDIA_TAG)) {
      const attributes = parseHlsAttributes(line.slice(MEDIA_TAG.length))
      const uri = attributes['URI']
      renditions.push({
        type: (attributes['TYPE'] ?? '').toUpperCase(),
        groupId: attributes['GROUP-ID'] ?? '',
        name: attributes['NAME'] ?? '',
        url: uri ? resolveHlsUrl(uri, baseUrl) : null,
        isDefault: (attributes['DEFAULT'] ?? '').toUpperCase() === 'YES',
        autoSelect: (attributes['AUTOSELECT'] ?? '').toUpperCase() === 'YES',
        language: attributes['LANGUAGE'] ?? null,
      })
    }
  }

  return { variants, renditions }
}

/** 解析媒体播放列表（EXTINF / EXT-X-MAP / EXT-X-ENDLIST / EXT-X-KEY 等）。 */
export function parseHlsMediaPlaylist(text: string, baseUrl: string): HlsMediaPlaylist {
  const segments: HlsSegment[] = []
  const lines = text.split(/\r?\n/)
  let initUrl: string | null = null
  let pendingDuration = 0
  let pendingDiscontinuity = false
  let endList = false
  let targetDuration = 0
  let encrypted = false
  let byteRange = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseNumber(line.slice('#EXTINF:'.length).split(',')[0] ?? '') ?? 0
      continue
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseHlsAttributes(line.slice('#EXT-X-MAP:'.length))
      const uri = attributes['URI']
      if (uri) initUrl = resolveHlsUrl(uri, baseUrl)
      continue
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true
      continue
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true
      continue
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseNumber(line.slice('#EXT-X-TARGETDURATION:'.length)) ?? 0
      continue
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseHlsAttributes(line.slice('#EXT-X-KEY:'.length))
      const method = (attributes['METHOD'] ?? '').toUpperCase()
      if (method && method !== 'NONE') encrypted = true
      continue
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRange = true
      continue
    }
    if (line.startsWith('#')) continue

    segments.push({
      url: resolveHlsUrl(line, baseUrl),
      duration: pendingDuration,
      initUrl,
      discontinuity: pendingDiscontinuity,
    })
    pendingDuration = 0
    pendingDiscontinuity = false
  }

  return {
    segments,
    endList,
    targetDuration,
    totalDuration: segments.reduce((sum, segment) => sum + segment.duration, 0),
    encrypted,
    byteRange,
  }
}

function variantScore(variant: HlsVariant): number {
  return variant.averageBandwidth ?? variant.bandwidth
}

/**
 * 按 quality 选择变体：best/worst 走码率排序，`720`/`720p` 走分辨率高度选择。
 * 高度选择优先挑不高于目标的最大高度；没有更低档时才回退到最接近的更高档。
 */
export function selectHlsVariant(
  master: HlsMasterPlaylist,
  quality: string | undefined,
): HlsVariant {
  if (master.variants.length === 0) {
    throw new Error('HLS 主播放列表里没有可用的清晰度')
  }
  const normalized = (quality ?? 'best').trim().toLowerCase()
  if (normalized === 'best' || normalized === 'highest') {
    return [...master.variants].sort(
      (left, right) =>
        variantScore(right) - variantScore(left) || (right.height ?? 0) - (left.height ?? 0),
    )[0]!
  }
  if (normalized === 'worst' || normalized === 'lowest') {
    return [...master.variants].sort(
      (left, right) =>
        variantScore(left) - variantScore(right) || (left.height ?? 0) - (right.height ?? 0),
    )[0]!
  }

  const height = Number.parseInt(normalized.replace(/p$/i, ''), 10)
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`不支持的清晰度参数: ${quality}`)
  }
  const withHeight = master.variants.filter((variant) => variant.height !== null)
  if (withHeight.length === 0) {
    throw new Error('HLS 主播放列表没有提供分辨率信息，无法按高度选择清晰度')
  }
  const notHigher = withHeight.filter((variant) => variant.height! <= height)
  const candidates = notHigher.length > 0 ? notHigher : withHeight
  const bestHeight = candidates.reduce((max, variant) => Math.max(max, variant.height ?? 0), 0)
  const matching = candidates.filter((variant) => variant.height === bestHeight)
  return [...matching].sort((left, right) => variantScore(right) - variantScore(left))[0]!
}

/**
 * 选取变体对应的独立音轨 rendition。
 * 没有独立音轨（组缺失或 rendition 没有 URI）时返回 null，表示音视频在同一条流里。
 */
export function selectHlsAudioRendition(
  master: HlsMasterPlaylist,
  variant: HlsVariant,
): HlsRendition | null {
  if (!variant.audioGroupId) return null
  const group = master.renditions.filter(
    (rendition) => rendition.type === 'AUDIO' && rendition.groupId === variant.audioGroupId,
  )
  const withUrl = group.filter((rendition) => rendition.url)
  if (withUrl.length === 0) return null
  return (
    withUrl.find((rendition) => rendition.isDefault) ??
    withUrl.find((rendition) => rendition.autoSelect) ??
    withUrl[0]!
  )
}
