import { describe, expect, test } from 'bun:test'
import {
  bilibiliFeedAdapter,
  getFeedAdapterCandidates,
  isYouTubeAvatarImage,
  readBilibiliAuthor,
  readBilibiliAuthorUrl,
  readBilibiliPromoted,
  readBilibiliTime,
  readBilibiliTrackingUrl,
  readBilibiliUrl,
  readYouTubeAuthor,
  readYouTubeHandle,
  readYouTubeTime,
  serializeFeedAdapter,
  serializeFeedAdapters,
  xFeedAdapter,
  youtubeFeedAdapter,
} from '../extension/background/feed-adapters.js'
import { readFeedItemMedia } from '../extension/background/page-observe-feed.js'

/**
 * 轻量 fake DOM：只实现适配层用到的接口（选择器匹配、文本、closest）。
 */
class FakeElement {
  tag: string
  attrs: Record<string, string>
  ownText: string
  children: FakeElement[] = []
  parent: FakeElement | null = null

  constructor(tag: string, attrs: Record<string, string> = {}, ownText = '') {
    this.tag = tag
    this.attrs = attrs
    this.ownText = ownText
  }

  append(child: FakeElement): FakeElement {
    child.parent = this
    this.children.push(child)
    return child
  }

  get parentElement(): FakeElement | null {
    return this.parent
  }

  get innerText(): string {
    return [this.ownText, ...this.children.map((child) => child.innerText)]
      .filter((text) => text !== '')
      .join('\n')
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)].join('')
  }

  get src(): string {
    return this.attrs.src ?? ''
  }

  get currentSrc(): string {
    return this.attrs.src ?? ''
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null
  }

  descendants(): FakeElement[] {
    const result: FakeElement[] = []
    for (const child of this.children) {
      result.push(child, ...child.descendants())
    }
    return result
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((element) => matchesSelector(element, selector))
  }

  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this
    return this.parent?.closest(selector) ?? null
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => matchesSimpleSelector(element, part.trim()))
}

function matchesSimpleSelector(element: FakeElement, selector: string): boolean {
  if (selector === '*') return true
  const parsed = selector.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]*\])*)$/)
  if (!parsed) return false
  const [, tag, rest = ''] = parsed
  if (tag && element.tag !== tag) return false

  const tokens = rest.match(/[.#][\w-]+|\[[^\]]*\]/g) || []
  for (const token of tokens) {
    if (token.startsWith('#')) {
      if (element.getAttribute('id') !== token.slice(1)) return false
      continue
    }
    if (token.startsWith('.')) {
      const classes = (element.getAttribute('class') || '').split(/\s+/)
      if (!classes.includes(token.slice(1))) return false
      continue
    }
    const inner = token.slice(1, -1)
    const separator = inner.indexOf('=')
    if (separator < 0) {
      if (element.getAttribute(inner) === null) return false
      continue
    }
    const name = inner.slice(0, separator).trim()
    const value = inner
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (element.getAttribute(name) !== value) return false
  }
  return true
}

function createFakeDocument(root: FakeElement): any {
  return {
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  }
}

/** 构造一张 YouTube 风格卡片：频道名 + 频道链接 + 元信息行。 */
function createYouTubeCard(
  options: {
    channelName?: string | null
    channelNameRepeat?: boolean
    handle?: string | null
    metadata?: string | null
    subscriberOnly?: boolean
  } = {},
): FakeElement {
  const card = new FakeElement('ytd-video-renderer')
  const channel = card.append(new FakeElement('ytd-channel-name'))
  const handle = options.handle ?? null

  if (handle) {
    const link = channel.append(new FakeElement('a', { href: handle }))
    link.append(new FakeElement('yt-formatted-string', {}, options.channelName ?? 'Tech Channel'))
    if (options.channelNameRepeat) {
      link.append(new FakeElement('yt-formatted-string', {}, options.channelName ?? 'Tech Channel'))
    }
  } else if (options.subscriberOnly) {
    channel.append(new FakeElement('yt-formatted-string', {}, '1.2M subscribers'))
  } else if (options.channelName !== null) {
    channel.append(
      new FakeElement('yt-formatted-string', {}, options.channelName ?? 'Tech Channel'),
    )
  }

  if (options.metadata !== null) {
    const metadata = card.append(new FakeElement('div', { id: 'metadata-line' }))
    metadata.append(new FakeElement('span', {}, options.metadata ?? ''))
  }

  return card
}

/** 构造一张 B 站风格卡片：标题 + owner（含空头像 SVG）+ 日期 + 封面。 */
function createBilibiliCard(
  options: {
    title?: string
    author?: string | null
    authorUrl?: string | null
    date?: string | null
    videoUrl?: string | null
    cover?: string | null
  } = {},
): FakeElement {
  const card = new FakeElement('div', { class: 'bili-video-card' })
  const info = card.append(new FakeElement('div', { class: 'bili-video-card__info' }))
  const videoUrl = options.videoUrl ?? 'https://www.bilibili.com/video/BV1xx411c7mD'

  const title = info.append(new FakeElement('h3', { class: 'bili-video-card__info--tit' }))
  title.append(new FakeElement('a', { href: videoUrl }, options.title ?? '示例视频'))

  const owner = info.append(new FakeElement('div', { class: 'bili-video-card__info--owner' }))
  // 头像图标是空的 SVG，通用作者逻辑会先命中它。
  owner.append(new FakeElement('svg', { class: 'author-ico' }))
  if (options.author !== null) {
    owner.append(
      new FakeElement(
        'a',
        { href: options.authorUrl ?? 'https://space.bilibili.com/123456' },
        options.author ?? '老番茄',
      ),
    )
  }

  if (options.date !== null) {
    info.append(
      new FakeElement(
        'span',
        { class: 'bili-video-card__info--date' },
        options.date ?? '· 2024-05-01',
      ),
    )
  }

  if (options.cover) {
    const cover = card.append(new FakeElement('a', { href: videoUrl }))
    cover.append(new FakeElement('img', { src: options.cover }))
  }

  return card
}

/** 构造一张 B 站广告卡：只有 cm.bilibili.com 跟踪链接，没有 BV 视频链接。 */
function createBilibiliAdCard(): FakeElement {
  const card = new FakeElement('div', { class: 'bili-video-card' })
  const info = card.append(new FakeElement('div', { class: 'bili-video-card__info' }))

  const title = info.append(new FakeElement('h3', { class: 'bili-video-card__info--tit' }))
  title.append(new FakeElement('a', { href: 'https://www.bilibili.com/ad/promo' }, '广告推广标题'))

  const owner = info.append(new FakeElement('div', { class: 'bili-video-card__info--owner' }))
  owner.append(new FakeElement('span', {}, '某品牌旗舰店'))

  const ad = info.append(new FakeElement('span', { class: 'bili-video-card__info--ad' }))
  ad.append(
    new FakeElement('a', { href: 'https://cm.bilibili.com/x/abc123?utm_source=feed' }, '广告'),
  )

  return card
}

describe('feed adapter host filtering', () => {
  test('keeps only adapters whose host matches the page URL', () => {
    expect(
      getFeedAdapterCandidates('https://www.youtube.com/feed/subscriptions').map((a) => a.id),
    ).toEqual(['youtube'])
    expect(getFeedAdapterCandidates('https://m.youtube.com/').map((a) => a.id)).toEqual(['youtube'])
    expect(getFeedAdapterCandidates('https://youtu.be/abc').map((a) => a.id)).toEqual(['youtube'])
    expect(getFeedAdapterCandidates('https://x.com/user/status/1').map((a) => a.id)).toEqual(['x'])
    expect(getFeedAdapterCandidates('https://mobile.twitter.com/').map((a) => a.id)).toEqual(['x'])
    expect(getFeedAdapterCandidates('https://www.bilibili.com/').map((a) => a.id)).toEqual([
      'bilibili',
    ])
    expect(getFeedAdapterCandidates('https://space.bilibili.com/123').map((a) => a.id)).toEqual([
      'bilibili',
    ])
    expect(getFeedAdapterCandidates('https://notbilibili.com/').map((a) => a.id)).toEqual([])
  })

  test('falls back to no adapter for unknown hosts', () => {
    expect(getFeedAdapterCandidates('https://example.com/feed')).toEqual([])
    expect(getFeedAdapterCandidates('https://notyoutube.com/')).toEqual([])
    expect(getFeedAdapterCandidates(null)).toEqual([])
    expect(serializeFeedAdapters(getFeedAdapterCandidates('https://example.com/feed'))).toBe('[]')
  })
})

describe('feed adapter DOM matching', () => {
  test('requires the DOM features before enabling the adapter', () => {
    const youtubeBody = new FakeElement('body')
    youtubeBody.append(new FakeElement('ytd-video-renderer'))
    const youtubePage = createFakeDocument(youtubeBody)
    expect(youtubeFeedAdapter.matches(youtubePage)).toBe(true)

    const plainBody = new FakeElement('body')
    plainBody.append(new FakeElement('article'))
    const nonYoutubePage = createFakeDocument(plainBody)
    expect(youtubeFeedAdapter.matches(nonYoutubePage)).toBe(false)

    const xBody = new FakeElement('body')
    xBody.append(new FakeElement('div', { 'data-testid': 'User-Name' }))
    const xPage = createFakeDocument(xBody)
    expect(xFeedAdapter.matches(xPage)).toBe(true)
    expect(xFeedAdapter.matches(nonYoutubePage)).toBe(false)
  })

  test('requires the bilibili DOM features before enabling the adapter', () => {
    const cardBody = new FakeElement('body')
    cardBody.append(new FakeElement('div', { class: 'bili-video-card' }))
    expect(bilibiliFeedAdapter.matches(createFakeDocument(cardBody))).toBe(true)

    const playerBody = new FakeElement('body')
    playerBody.append(new FakeElement('div', { class: 'bpx-player-primary-area' }))
    expect(bilibiliFeedAdapter.matches(createFakeDocument(playerBody))).toBe(true)

    const plainBody = new FakeElement('body')
    plainBody.append(new FakeElement('article'))
    expect(bilibiliFeedAdapter.matches(createFakeDocument(plainBody))).toBe(false)
  })
})

describe('youtube adapter extraction', () => {
  test('reads the channel name without repeating it', () => {
    const card = createYouTubeCard({ channelName: 'Tech Channel' })
    expect(readYouTubeAuthor(card)).toBe('Tech Channel')

    const repeated = createYouTubeCard({ channelName: 'Tech Channel', channelNameRepeat: true })
    expect(readYouTubeAuthor(repeated)).toBe('Tech Channel')
    expect(readYouTubeAuthor(createYouTubeCard({ channelName: 'haha' }))).toBe('haha')
    expect(readYouTubeAuthor(createYouTubeCard({ channelName: '快乐快乐' }))).toBe('快乐快乐')

    const subscriberOnly = createYouTubeCard({ subscriberOnly: true })
    expect(readYouTubeAuthor(subscriberOnly)).toBeNull()

    const emptyInnerText = {
      querySelector: () => ({
        querySelectorAll: () => [{ innerText: '', textContent: 'Tech Channel' }],
      }),
    }
    expect(readYouTubeAuthor(emptyInnerText)).toBe('Tech Channel')

    const noChannel = new FakeElement('ytd-video-renderer')
    expect(readYouTubeAuthor(noChannel)).toBeNull()
  })

  test('reads the channel handle from /@name links', () => {
    expect(readYouTubeHandle(createYouTubeCard({ handle: '/@techchannel' }))).toBe('@techchannel')
    expect(
      readYouTubeHandle(createYouTubeCard({ handle: 'https://www.youtube.com/@techchannel' })),
    ).toBe('@techchannel')
    expect(
      readYouTubeHandle(
        createYouTubeCard({
          handle: 'https://www.youtube.com/@%E4%B8%AD%E6%96%87%E9%A2%91%E9%81%93',
        }),
      ),
    ).toBe('@中文频道')
    expect(readYouTubeHandle(createYouTubeCard({ handle: null }))).toBeNull()

    const descriptionMention = new FakeElement('ytd-video-renderer')
    descriptionMention.append(new FakeElement('a', { href: '/@mentioned_in_description' }))
    expect(readYouTubeHandle(descriptionMention)).toBeNull()
  })

  test('reads the publish time from the metadata line only', () => {
    expect(readYouTubeTime(createYouTubeCard({ metadata: '1.2M views  3 months ago' }))).toBe(
      '3 months ago',
    )
    expect(readYouTubeTime(createYouTubeCard({ metadata: '12万次观看 3 个月前' }))).toBe('3 个月前')
    expect(readYouTubeTime(createYouTubeCard({ metadata: 'Premiered Oct 5, 2024' }))).toBe(
      'Oct 5, 2024',
    )
    expect(readYouTubeTime(createYouTubeCard({ metadata: '2024年10月5日' }))).toBe('2024年10月5日')
    // 没有可靠时间就返回 null，不从其它数字里猜
    expect(readYouTubeTime(createYouTubeCard({ metadata: '1.2M views  12K comments' }))).toBeNull()
    expect(readYouTubeTime(createYouTubeCard({ metadata: null }))).toBeNull()
  })

  test('detects channel avatars and keeps video thumbnails as body media', () => {
    const card = new FakeElement('ytd-video-renderer')
    const channelLink = card.append(new FakeElement('a', { href: '/@techchannel' }))
    const avatar = channelLink.append(
      new FakeElement('img', { src: 'https://yt3.googleusercontent.com/avatar.jpg' }),
    )
    const watchLink = card.append(new FakeElement('a', { href: '/watch?v=abc123' }))
    const thumbnail = watchLink.append(
      new FakeElement('img', { src: 'https://i.ytimg.com/vi/abc123/hq.jpg' }),
    )

    expect(isYouTubeAvatarImage(avatar)).toBe(true)
    expect(isYouTubeAvatarImage(thumbnail)).toBe(false)

    const media = readFeedItemMedia(card, youtubeFeedAdapter.isAvatar)
    expect(media.avatarUrls).toEqual(['https://yt3.googleusercontent.com/avatar.jpg'])
    expect(media.mediaUrls).toEqual(['https://i.ytimg.com/vi/abc123/hq.jpg'])
  })
})

describe('bilibili adapter extraction', () => {
  test('reads the author from the owner area and ignores the empty avatar icon', () => {
    expect(readBilibiliAuthor(createBilibiliCard())).toBe('老番茄')
    expect(readBilibiliAuthor(createBilibiliCard({ author: null }))).toBeNull()

    const dateOnlyOwner = new FakeElement('div', { class: 'bili-video-card__info--owner' })
    dateOnlyOwner.append(new FakeElement('span', {}, '· 2024-05-01'))
    const dateOnlyCard = new FakeElement('div', { class: 'bili-video-card' })
    dateOnlyCard.append(dateOnlyOwner)
    expect(readBilibiliAuthor(dateOnlyCard)).toBeNull()
  })

  test('reads the publish time from the date area only', () => {
    expect(readBilibiliTime(createBilibiliCard())).toBe('2024-05-01')
    expect(readBilibiliTime(createBilibiliCard({ date: '· 8月6日' }))).toBe('8月6日')
    expect(readBilibiliTime(createBilibiliCard({ date: '· 8-6' }))).toBe('8-6')
    expect(readBilibiliTime(createBilibiliCard({ date: null }))).toBeNull()
    expect(readBilibiliTime(createBilibiliCard({ author: '刚刚', date: null }))).toBeNull()
  })

  test('prefers the BV video link and never uses a tracking link as identity', () => {
    expect(readBilibiliUrl(createBilibiliCard())).toBe(
      'https://www.bilibili.com/video/BV1xx411c7mD',
    )
    expect(readBilibiliUrl(createBilibiliAdCard())).toBeNull()
    expect(
      readBilibiliUrl(
        createBilibiliCard({
          videoUrl: 'https://cm.bilibili.com/x?next=https://www.bilibili.com/video/BV1xx411c7mD',
        }),
      ),
    ).toBeNull()
    expect(
      readBilibiliUrl(
        createBilibiliCard({ videoUrl: 'javascript://www.bilibili.com/video/BV1xx411c7mD' }),
      ),
    ).toBeNull()
  })

  test('reports the author space url and the ad tracking url separately', () => {
    expect(readBilibiliAuthorUrl(createBilibiliCard())).toBe('https://space.bilibili.com/123456')
    expect(readBilibiliAuthorUrl(createBilibiliAdCard())).toBeNull()
    expect(readBilibiliTrackingUrl(createBilibiliCard())).toBeNull()
    expect(readBilibiliTrackingUrl(createBilibiliAdCard())).toBe(
      'https://cm.bilibili.com/x/abc123?utm_source=feed',
    )
    expect(
      readBilibiliAuthorUrl(
        createBilibiliCard({ authorUrl: 'https://space.bilibili.com.evil.test/123456' }),
      ),
    ).toBeNull()
    expect(
      readBilibiliTrackingUrl(
        createBilibiliCard({ videoUrl: 'https://cm.bilibili.com.evil.test/x/abc' }),
      ),
    ).toBeNull()
    expect(
      readBilibiliAuthorUrl(
        createBilibiliCard({ authorUrl: 'javascript://space.bilibili.com/123456' }),
      ),
    ).toBeNull()
    expect(
      readBilibiliTrackingUrl(createBilibiliCard({ videoUrl: 'javascript://cm.bilibili.com/x' })),
    ).toBeNull()
    expect(
      readBilibiliPromoted(createBilibiliCard({ videoUrl: 'javascript://cm.bilibili.com/x' })),
    ).toBe(false)
  })

  test('marks only explicit ad cards as promoted', () => {
    expect(readBilibiliPromoted(createBilibiliCard())).toBe(false)
    expect(readBilibiliPromoted(createBilibiliCard({ title: '广告' }))).toBe(false)
    expect(readBilibiliPromoted(createBilibiliAdCard())).toBe(true)
  })
})

describe('feed adapter injection safety', () => {
  test('the bilibili adapter can be injected without free variables', () => {
    const source = serializeFeedAdapter(bilibiliFeedAdapter)
    const build = new Function(`return ${source}`) as () => any
    const adapter = build()

    expect(adapter.id).toBe('bilibili')
    expect(adapter.readAuthor(createBilibiliCard())).toBe('老番茄')
    expect(adapter.readHandle(createBilibiliCard())).toBeNull()
    expect(adapter.readTime(createBilibiliCard())).toBe('2024-05-01')
    expect(adapter.readUrl(createBilibiliCard())).toBe(
      'https://www.bilibili.com/video/BV1xx411c7mD',
    )
    expect(adapter.readAuthorUrl(createBilibiliCard())).toBe('https://space.bilibili.com/123456')
    expect(adapter.readTrackingUrl(createBilibiliCard())).toBeNull()
    expect(adapter.readPromoted(createBilibiliCard())).toBe(false)

    const adCard = createBilibiliAdCard()
    expect(adapter.readPromoted(adCard)).toBe(true)
    expect(adapter.readUrl(adCard)).toBeNull()
    expect(adapter.readTrackingUrl(adCard)).toBe('https://cm.bilibili.com/x/abc123?utm_source=feed')
  })

  test('serialized adapters are self contained and run without free variables', () => {
    const source = serializeFeedAdapter(youtubeFeedAdapter)
    const card = createYouTubeCard({
      channelName: 'Tech Channel',
      handle: '/@techchannel',
      metadata: '3 months ago',
    })

    // 用注入页面同样的方式重建对象：源码里不能引用模块作用域变量
    const build = new Function(`return ${source}`) as () => any
    const adapter = build()

    expect(adapter.id).toBe('youtube')
    expect(adapter.readAuthor(card)).toBe('Tech Channel')
    expect(adapter.readHandle(card)).toBe('@techchannel')
    expect(adapter.readTime(card)).toBe('3 months ago')

    const body = new FakeElement('body')
    body.append(card)
    expect(adapter.matches(createFakeDocument(body))).toBe(true)
  })

  test('candidates without site specific methods keep the generic behaviour', () => {
    const source = serializeFeedAdapter(xFeedAdapter)
    const build = new Function(`return ${source}`) as () => any
    const adapter = build()

    expect(adapter.id).toBe('x')
    expect(adapter.readAuthor).toBeUndefined()
    expect(adapter.readHandle).toBeUndefined()
    expect(adapter.readTime).toBeUndefined()
    expect(adapter.readUrl).toBeUndefined()
    expect(adapter.readAuthorUrl).toBeUndefined()
    expect(adapter.readTrackingUrl).toBeUndefined()
    expect(adapter.readPromoted).toBeUndefined()
    expect(adapter.isAvatar).toBeUndefined()
  })
})
