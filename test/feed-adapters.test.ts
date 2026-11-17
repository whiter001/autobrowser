import { describe, expect, test } from 'bun:test'
import {
  getFeedAdapterCandidates,
  isYouTubeAvatarImage,
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

describe('feed adapter host filtering', () => {
  test('keeps only adapters whose host matches the page URL', () => {
    expect(
      getFeedAdapterCandidates('https://www.youtube.com/feed/subscriptions').map((a) => a.id),
    ).toEqual(['youtube'])
    expect(getFeedAdapterCandidates('https://m.youtube.com/').map((a) => a.id)).toEqual(['youtube'])
    expect(getFeedAdapterCandidates('https://youtu.be/abc').map((a) => a.id)).toEqual(['youtube'])
    expect(getFeedAdapterCandidates('https://x.com/user/status/1').map((a) => a.id)).toEqual(['x'])
    expect(getFeedAdapterCandidates('https://mobile.twitter.com/').map((a) => a.id)).toEqual(['x'])
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

describe('feed adapter injection safety', () => {
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
    expect(adapter.isAvatar).toBeUndefined()
  })
})
