/**
 * feed 可选站点适配层。
 *
 * 通用采集逻辑（author/handle/time/头像/正文媒体）对所有站点继续生效；适配层只在
 * 页面同时命中 host 与 DOM 特征时才接管对应字段，避免为了适配单个站点而重写通用逻辑。
 *
 * 注意：适配方法会被序列化后注入页面执行，因此每个方法必须是自包含的——
 * 不能引用模块作用域里的其它函数，否则页面里会抛自由变量 ReferenceError。
 */

export interface FeedSiteAdapter {
  /** 适配器 id；出现在 FeedCollectionItem.adapter，未启用时为 null。 */
  id: string
  /** 站点主域名（同时匹配其子域）；host 命中才会作为候选注入页面。 */
  hosts: string[]
  /** DOM 特征判定；host 与 DOM 都命中才启用。 */
  matches(document: any): boolean
  /** 站点专属作者名；提供时优先于通用 author 逻辑。 */
  readAuthor?(node: any): string | null
  /** 站点专属 handle；提供时优先于通用 handle 逻辑。 */
  readHandle?(node: any): string | null
  /** 站点专属发布时间；提供时以它为准（通用逻辑会从整段描述里猜日期）。 */
  readTime?(node: any): string | null
  /** 站点专属头像判定；与通用 isFeedAvatarImage 取并集。 */
  isAvatar?(image: any): boolean
}

/**
 * YouTube 作者名：取 ytd-channel-name 里第一个非空的名称行。
 *
 * 同一张卡片里频道名可能在不同布局重复出现，所以只取第一个非空名称行；
 * 不按字符重复猜测缩写，避免截短 "haha"、"快乐快乐" 这类合法名称。
 */
export function readYouTubeAuthor(node: any): string | null {
  const container = node?.querySelector?.('ytd-channel-name')
  if (!container) return null

  const normalize = (value: unknown) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const candidates: string[] = []

  // 优先按结构化子节点取名字，避免 innerText 把重复的名字拼在一起。
  const formatted = Array.from(container.querySelectorAll?.('yt-formatted-string') || []) as any[]
  for (const element of formatted) {
    const text = normalize(element?.innerText || element?.textContent)
    if (text) candidates.push(text)
  }

  if (!candidates.length) {
    const raw = String(container.innerText || container.textContent || '')
    for (const line of raw.split('\n')) {
      const text = normalize(line)
      if (text) candidates.push(text)
    }
  }

  for (const candidate of candidates) {
    if (candidate.startsWith('@')) continue
    // 订阅数/提示这类文本不是作者名。
    if (/subscribers?|subscribed|订阅|粉丝|已订阅/i.test(candidate)) continue
    return candidate
  }

  return null
}

/**
 * YouTube handle：取指向 /@name 的频道链接。
 *
 * 优先在频道名/作者节点里找，避免把描述正文里提到的其它频道当成作者。
 */
export function readYouTubeHandle(node: any): string | null {
  const scopes = [
    node?.querySelector?.('ytd-channel-name'),
    node?.querySelector?.('ytd-video-owner-renderer'),
  ]

  for (const scope of scopes) {
    if (!scope) continue
    const links = Array.from(scope.querySelectorAll?.('a[href]') || []) as any[]
    for (const link of links) {
      const href = String(link?.getAttribute?.('href') ?? link?.href ?? '')
      const path = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
      const match = path.match(/^\/@([^/?#]+)/)
      if (match) {
        try {
          return `@${decodeURIComponent(match[1])}`
        } catch {
          return `@${match[1]}`
        }
      }
    }
  }

  return null
}

/**
 * YouTube 发布时间：只从 #metadata-line 里取可靠的相对时间或明确日期。
 *
 * 相对时间（中英文都覆盖）优先；找不到就返回 null，
 * 绝不退化成从整段描述里猜一个日期出来。
 */
export function readYouTubeTime(node: any): string | null {
  const line = node?.querySelector?.('#metadata-line')
  if (!line) return null

  const normalize = (value: unknown) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const text = normalize(line.innerText || line.textContent)
  if (!text) return null

  const relative = text.match(
    /\d+\s*(?:秒钟?|秒|分钟|分|小时|天|日|周|星期|个月|月|年)\s*前|\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago|刚刚|just now/i,
  )
  if (relative) return relative[0].trim()

  const explicit = text.match(
    /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+\d{4})?\b/i,
  )
  return explicit ? explicit[0].trim() : null
}

/**
 * YouTube 头像：图片位于指向 /@name、/channel/... 或 /user/... 的频道链接里。
 *
 * 普通 /watch 视频缩略图不在频道链接内，因此不会被误判成头像。
 */
export function isYouTubeAvatarImage(image: any): boolean {
  const anchor = image?.closest?.('a[href]')
  const href = String(anchor?.getAttribute?.('href') ?? anchor?.href ?? '')
  if (!href) return false
  const path = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
  return /^\/(?:@[^/?#]+|channel\/[^/?#]+|user\/[^/?#]+)(?:[/?#]|$)/.test(path)
}

/**
 * X（Twitter）：DOM 特征用于确认确实是推文时间线页面；具体字段继续走通用逻辑。
 */
export const xFeedAdapter: FeedSiteAdapter = {
  id: 'x',
  hosts: ['x.com', 'twitter.com'],
  matches: (document: any) =>
    Boolean(document?.querySelector?.('[data-testid="tweet"], [data-testid="User-Name"]')),
}

/**
 * YouTube：DOM 特征用于确认是视频流页面；作者/handle/发布时间/头像走站点专用逻辑。
 */
export const youtubeFeedAdapter: FeedSiteAdapter = {
  id: 'youtube',
  hosts: ['youtube.com', 'youtu.be'],
  matches: (document: any) =>
    Boolean(
      document?.querySelector?.('ytd-video-renderer') || document?.querySelector?.('ytd-player'),
    ),
  readAuthor: readYouTubeAuthor,
  readHandle: readYouTubeHandle,
  readTime: readYouTubeTime,
  isAvatar: isYouTubeAvatarImage,
}

const FEED_ADAPTERS: FeedSiteAdapter[] = [xFeedAdapter, youtubeFeedAdapter]

const FEED_ADAPTER_METHODS = [
  'matches',
  'readAuthor',
  'readHandle',
  'readTime',
  'isAvatar',
] as const

function extractHostname(pageUrl: string | null | undefined): string | null {
  const raw = String(pageUrl || '').trim()
  if (!raw) return null
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    const match = raw.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)/i)
    return match?.[1]?.toLowerCase() || null
  }
}

/**
 * 按 host 过滤适配器候选。
 *
 * 这里只做 host 层面的粗筛；真正的启用条件是页面里再跑一次 matches(document)，
 * host 与 DOM 都命中才算启用，否则保持通用采集行为。
 */
export function getFeedAdapterCandidates(pageUrl: string | null | undefined): FeedSiteAdapter[] {
  const hostname = extractHostname(pageUrl)
  if (!hostname) return []
  return FEED_ADAPTERS.filter((adapter) =>
    adapter.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)),
  )
}

/**
 * 把适配器序列化成可注入页面的对象字面量。
 *
 * 方法以函数源码形式写入，页面里不依赖任何模块作用域变量。
 */
export function serializeFeedAdapter(adapter: FeedSiteAdapter): string {
  const parts = [`id: ${JSON.stringify(adapter.id)}`]
  for (const key of FEED_ADAPTER_METHODS) {
    const method = adapter[key]
    if (typeof method !== 'function') continue
    parts.push(`${key}: ${method.toString()}`)
  }
  return `{${parts.join(', ')}}`
}

export function serializeFeedAdapters(adapters: FeedSiteAdapter[]): string {
  return `[${adapters.map((adapter) => serializeFeedAdapter(adapter)).join(', ')}]`
}
