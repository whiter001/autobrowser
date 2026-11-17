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
  /** 站点专属条目链接；提供时以它为准（广告跟踪链接不能当条目身份）。 */
  readUrl?(node: any): string | null
  /** 作者主页地址；没有作者主页语义时返回 null。 */
  readAuthorUrl?(node: any): string | null
  /** 广告跟踪链接；与条目链接分开上报。 */
  readTrackingUrl?(node: any): string | null
  /** 是否是广告推广条目。 */
  readPromoted?(node: any): boolean
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
 * B 站作者名：取 .bili-video-card__info--owner 里的第一个非空行。
 *
 * owner 容器里常挂着头像 SVG、昵称和分隔符，按行取第一个有文本的行；
 * 整块都空就返回 null，不从标题或描述里猜作者。
 */
export function readBilibiliAuthor(node: any): string | null {
  const owner = node?.querySelector?.('.bili-video-card__info--owner')
  if (!owner) return null

  const normalize = (value: unknown) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const stripSeparator = (value: string) => value.replace(/^[\s·•|,，\-–—]+/, '').trim()

  const raw =
    owner.innerText !== undefined && owner.innerText !== null
      ? String(owner.innerText)
      : String(owner.textContent ?? '')
  for (const line of raw.split('\n')) {
    const rawLine = normalize(line)
    // owner 中日期行以 · 开头，不能把日期当作作者。
    if (/^[·•|]/.test(rawLine)) continue
    const text = stripSeparator(rawLine)
    if (text) return text
  }
  return null
}

/**
 * B 站发布时间：只从卡片自己的日期区域读取，并去掉前导的 "·" 等分隔符。
 *
 * 识别不出就返回 null，绝不从标题或描述里猜日期。
 */
export function readBilibiliTime(node: any): string | null {
  const normalize = (value: unknown) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const stripSeparator = (value: string) => value.replace(/^[\s·•|,，\-–—]+/, '').trim()

  const pattern =
    /\d{4}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月\s*\d{1,2}\s*日|\b\d{1,2}-\d{1,2}\b|\d{1,2}\s*个?月前|\d{1,2}\s*天前|\d{1,2}\s*小时前|\d{1,2}\s*分钟前|\d{1,2}\s*秒前|刚刚/

  const dateNode = node?.querySelector?.('.bili-video-card__info--date')
  const owner = node?.querySelector?.('.bili-video-card__info--owner')
  const scopes = [dateNode, owner].filter(Boolean)
  for (const scope of scopes) {
    const raw =
      scope.innerText !== undefined && scope.innerText !== null
        ? String(scope.innerText)
        : String(scope.textContent ?? '')
    for (const line of raw.split('\n')) {
      const rawLine = normalize(line)
      // owner 同时含昵称时，只接受带日期分隔符的行，避免把“刚刚”等昵称当时间。
      if (scope === owner && !/^[·•|]/.test(rawLine)) continue
      const cleaned = stripSeparator(rawLine)
      if (!cleaned) continue
      const match = cleaned.match(pattern)
      if (match) return match[0].trim()
    }
  }
  return null
}

/**
 * B 站条目链接：只认 BV 视频链接，规范成 https://www.bilibili.com/video/<BV>。
 *
 * 只有广告跟踪链接时返回 null，让去重回退到作者+正文，
 * 不能把超长跟踪参数当成条目身份。
 */
export function readBilibiliUrl(node: any): string | null {
  const links = Array.from(node?.querySelectorAll?.('a[href]') || []) as any[]
  for (const link of links) {
    const href = String(link?.getAttribute?.('href') ?? link?.href ?? '')
    let url: URL
    try {
      url = new URL(href, 'https://www.bilibili.com')
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    if (url.hostname === 'cm.bilibili.com') continue
    if (url.hostname !== 'bilibili.com' && url.hostname !== 'www.bilibili.com') continue
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/)
    if (match) return `https://www.bilibili.com/video/${match[1]}`
  }
  return null
}

/**
 * B 站作者主页：space.bilibili.com/<uid>。
 *
 * 先在作者区域里找，找不到再看整张卡片；只取数字 uid，不猜作者昵称当主页。
 */
export function readBilibiliAuthorUrl(node: any): string | null {
  const scopes = [node?.querySelector?.('.bili-video-card__info--owner'), node]
  for (const scope of scopes) {
    if (!scope) continue
    const links = Array.from(scope.querySelectorAll?.('a[href]') || []) as any[]
    for (const link of links) {
      const href = String(link?.getAttribute?.('href') ?? link?.href ?? '')
      let url: URL
      try {
        url = new URL(href, 'https://www.bilibili.com')
      } catch {
        continue
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      if (url.hostname !== 'space.bilibili.com') continue
      const match = url.pathname.match(/^\/(\d+)(?:\/|$)/)
      if (match) return `https://space.bilibili.com/${match[1]}`
    }
  }
  return null
}

/**
 * B 站广告跟踪链接：cm.bilibili.com 的跳转地址。
 *
 * 它只进 trackingUrl，不作为条目链接。
 */
export function readBilibiliTrackingUrl(node: any): string | null {
  const links = Array.from(node?.querySelectorAll?.('a[href]') || []) as any[]
  for (const link of links) {
    const href = String(link?.getAttribute?.('href') ?? link?.href ?? '')
    let url: URL
    try {
      url = new URL(href, 'https://www.bilibili.com')
    } catch {
      continue
    }
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname === 'cm.bilibili.com'
    )
      return url.href
  }
  return null
}

/**
 * B 站广告判定：cm.bilibili.com 跟踪链接或明确的"广告"标记。
 *
 * 描述正文里出现"广告"两个字不算，必须是独立标记或广告域名。
 */
export function readBilibiliPromoted(node: any): boolean {
  const links = Array.from(node?.querySelectorAll?.('a[href]') || []) as any[]
  for (const link of links) {
    const href = String(link?.getAttribute?.('href') ?? link?.href ?? '')
    try {
      const url = new URL(href, 'https://www.bilibili.com')
      if (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname === 'cm.bilibili.com'
      )
        return true
    } catch {
      // 非法 URL 不参与广告判断。
    }
  }

  const elements = Array.from(node?.querySelectorAll?.('*') || []) as any[]
  for (const element of elements) {
    const className = String(element?.getAttribute?.('class') || '')
    const text = String(element?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const isMarkerText = text === '广告' || text === 'AD' || text === 'Ads'
    const isMarkerClass = /(?:^|[-_ ])(?:ad|ads|advert|advertisement|promoted)(?:[-_ ]|$)/i.test(
      className,
    )
    if (isMarkerText && isMarkerClass) return true
  }
  return false
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

/**
 * B 站：DOM 特征用于确认是推荐流/播放页；作者、时间、链接与广告语义走站点专用逻辑。
 */
export const bilibiliFeedAdapter: FeedSiteAdapter = {
  id: 'bilibili',
  hosts: ['bilibili.com'],
  matches: (document: any) =>
    Boolean(document?.querySelector?.('.bili-video-card, .bpx-player-primary-area')),
  readAuthor: readBilibiliAuthor,
  // B 站没有 handle 概念，明确置 null，不让通用逻辑从昵称里伪造 @handle。
  readHandle: () => null,
  readTime: readBilibiliTime,
  readUrl: readBilibiliUrl,
  readAuthorUrl: readBilibiliAuthorUrl,
  readTrackingUrl: readBilibiliTrackingUrl,
  readPromoted: readBilibiliPromoted,
}

const FEED_ADAPTERS: FeedSiteAdapter[] = [xFeedAdapter, youtubeFeedAdapter, bilibiliFeedAdapter]

const FEED_ADAPTER_METHODS = [
  'matches',
  'readAuthor',
  'readHandle',
  'readTime',
  'readUrl',
  'readAuthorUrl',
  'readTrackingUrl',
  'readPromoted',
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
