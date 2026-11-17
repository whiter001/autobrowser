import { describe, expect, test } from 'bun:test'
import {
  feedItemDedupeKey,
  isFeedAvatarMarker,
  isFeedAvatarUrl,
  parseFeedRepostBy,
  readFeedItemAuthor,
  readFeedItemMedia,
  readFeedItemTimelineContext,
  readFeedItemTime,
  readFeedItemUrl,
} from '../extension/background/page-observe-feed.js'
import {
  createPageObserveDomain,
  type FeedCollectionResult,
} from '../extension/background/page-observe.js'
import type { ExtensionState, TabWithId } from '../extension/background/types.js'

const item = { url: null, author: 'Ada', handle: '@ada', text: 'hello' }

describe('feed dedupe keys', () => {
  test('uses URL when available and falls back to author, handle and text without one', () => {
    expect(feedItemDedupeKey('url', { ...item, url: 'https://example.com/status/1' })).toBe(
      'https://example.com/status/1',
    )
    expect(feedItemDedupeKey('url', item)).toBe('Ada|@ada|hello')
    expect(feedItemDedupeKey('text', { ...item, url: 'https://example.com/status/1' })).toBe(
      'Ada|@ada|hello',
    )
    expect(feedItemDedupeKey('none', item)).toBeNull()
  })
})

describe('feed generic field extraction', () => {
  test('prefers the heading link used by article cards', () => {
    const title = { href: 'https://www.cnblogs.com/alice/p/123', innerText: 'Article title' }
    const node = {
      querySelector: (selector: string) => (selector.includes('h1 a[href]') ? title : null),
      querySelectorAll: () => [],
    }

    expect(readFeedItemUrl(node)).toBe('https://www.cnblogs.com/alice/p/123')
  })

  test('falls back to the first non-empty HTTP link instead of an avatar', () => {
    const links = [
      { href: 'https://example.com/alice', innerText: '' },
      { href: 'javascript:void(0)', innerText: 'Recommend' },
      { href: 'https://example.com/articles/123', innerText: 'Article title' },
    ]
    const node = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => (selector === 'a[href]' ? links : []),
    }

    expect(readFeedItemUrl(node)).toBe('https://example.com/articles/123')
  })

  test('reads semantic author names and bold author prefixes', () => {
    const semantic = {
      querySelector: () => ({ innerText: 'codigger' }),
      querySelectorAll: () => [],
    }
    const bold = {
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === 'b' ? [{ innerText: 'Next蔡蔡', nextSibling: { textContent: '：正文' } }] : [],
    }

    expect(readFeedItemAuthor(semantic)).toBe('codigger')
    expect(readFeedItemAuthor(bold)).toBe('Next蔡蔡')
  })

  test('skips empty author icons and keeps the first author candidate with text', () => {
    // B 站卡片里第一个 author 语义节点是空的头像 SVG，作者名在后面的 owner 节点上。
    const emptyIcon = { tagName: 'svg', innerText: '', textContent: '' }
    const owner = { tagName: 'a', innerText: '老番茄', textContent: '老番茄' }
    const node = {
      querySelector: (selector: string) => (selector.includes('author') ? emptyIcon : null),
      querySelectorAll: (selector: string) =>
        selector.includes('author') ? [emptyIcon, owner] : [],
    }

    expect(readFeedItemAuthor(node)).toBe('老番茄')
  })

  test('skips script and style candidates before reading the author text', () => {
    const script = { tagName: 'SCRIPT', innerText: '', textContent: 'console.log(1)' }
    const style = { tagName: 'STYLE', innerText: '', textContent: '.a{color:red}' }
    const owner = { tagName: 'span', innerText: '某某UP主', textContent: '某某UP主' }
    const node = {
      querySelector: () => script,
      querySelectorAll: (selector: string) =>
        selector.includes('author') ? [script, style, owner] : [],
    }

    expect(readFeedItemAuthor(node)).toBe('某某UP主')
  })

  test('falls back to the bold author when every explicit candidate is empty', () => {
    const emptyIcon = { tagName: 'svg', innerText: '', textContent: '' }
    const node = {
      querySelector: () => emptyIcon,
      querySelectorAll: (selector: string) =>
        selector.includes('author')
          ? [emptyIcon]
          : selector === 'b'
            ? [{ innerText: 'Next蔡蔡', nextSibling: { textContent: '：正文' } }]
            : [],
    }

    expect(readFeedItemAuthor(node)).toBe('Next蔡蔡')
  })

  test('reads full and short dates from card text when no time element exists', () => {
    const node = { querySelector: () => null, innerText: 'Title\ncodigger\n2026-11-09 09:06\n0 0' }
    expect(readFeedItemTime(node)).toBe('2026-11-09 09:06')

    node.innerText = 'Title\nNext蔡蔡：正文\n添加评论\n02-10'
    expect(readFeedItemTime(node)).toBe('02-10')
  })
})

interface FakeElementOptions {
  parent?: any
  innerText?: string
  textContent?: string
}

/** 轻量 DOM 替身：只需要 getAttribute / parentElement / 文本这些采集用到的接口。 */
function createFakeElement(
  attributes: Record<string, string> = {},
  options: FakeElementOptions = {},
): any {
  const element: any = {
    attributes,
    innerText: options.innerText ?? '',
    textContent: options.textContent ?? options.innerText ?? '',
    parentElement: options.parent ?? null,
    getAttribute: (name: string) => attributes[name] ?? null,
  }
  element.src = attributes.src ?? ''
  element.currentSrc = attributes.src ?? ''
  return element
}

interface FakeCardOptions {
  images?: any[]
  videos?: any[]
  sources?: any[]
  socialContext?: any
  fallbacks?: any[]
  innerText?: string
}

/** 卡片替身：querySelector 只认 socialContext，querySelectorAll 按选择器返回对应集合。 */
function createFakeCard(options: FakeCardOptions = {}): any {
  return {
    innerText: options.innerText ?? '',
    textContent: options.innerText ?? '',
    querySelector: (selector: string) =>
      selector.includes('socialContext') ? (options.socialContext ?? null) : null,
    querySelectorAll: (selector: string) => {
      if (selector === 'img[src]') return options.images ?? []
      if (selector === 'video[src]') return options.videos ?? []
      if (selector === 'video source[src]') return options.sources ?? []
      return options.fallbacks ?? []
    },
  }
}

describe('feed media classification', () => {
  test('detects X profile image URLs and avatar semantic markers', () => {
    expect(isFeedAvatarUrl('https://pbs.twimg.com/profile_images/123/avatar.jpg')).toBe(true)
    expect(isFeedAvatarUrl('https://pbs.twimg.com/media/abc.jpg')).toBe(false)
    expect(isFeedAvatarMarker('Tweet-User-Avatar')).toBe(true)
    expect(isFeedAvatarMarker('profile-image')).toBe(true)
    // 只是"资料卡片"而不是头像图片，不能把整张卡片判成头像
    expect(isFeedAvatarMarker('profile-card')).toBe(false)
  })

  test('keeps avatars out of mediaUrls and body media out of avatarUrls', () => {
    const avatar = createFakeElement({
      src: 'https://pbs.twimg.com/profile_images/123/avatar.jpg',
    })
    const body = createFakeElement({ src: 'https://pbs.twimg.com/media/abc.jpg' })
    const media = readFeedItemMedia(createFakeCard({ images: [avatar, body] }))

    expect(media.avatarUrls).toEqual(['https://pbs.twimg.com/profile_images/123/avatar.jpg'])
    expect(media.mediaUrls).toEqual(['https://pbs.twimg.com/media/abc.jpg'])
  })

  test('treats avatar semantic containers as avatars', () => {
    const wrapper = createFakeElement({ class: 'Tweet-User-Avatar' })
    const avatar = createFakeElement({ src: 'https://example.com/a.png' }, { parent: wrapper })
    const media = readFeedItemMedia(createFakeCard({ images: [avatar] }))

    expect(media.avatarUrls).toEqual(['https://example.com/a.png'])
    expect(media.mediaUrls).toEqual([])
  })

  test('falls back to body media for plain sites without avatar semantics', () => {
    // 普通站点的图片没有任何头像语义，必须留在正文媒体里，不能整张丢掉
    const plain = createFakeElement({ src: 'https://example.com/photo.png' })
    const video = createFakeElement({ src: 'https://example.com/clip.mp4' })
    const media = readFeedItemMedia(
      createFakeCard({ images: [plain], videos: [video], sources: [] }),
    )

    expect(media.avatarUrls).toEqual([])
    expect(media.mediaUrls).toEqual([
      'https://example.com/photo.png',
      'https://example.com/clip.mp4',
    ])
  })
})

describe('feed timeline context and repost author', () => {
  test('reads and normalizes the X socialContext element', () => {
    const socialContext = createFakeElement(
      { 'data-testid': 'socialContext' },
      { innerText: '  Hongbo Zhang   已转帖 ' },
    )
    expect(readFeedItemTimelineContext(createFakeCard({ socialContext }))).toBe(
      'Hongbo Zhang 已转帖',
    )
  })

  test('falls back to repost semantic containers without grabbing the whole card', () => {
    const fallback = createFakeElement(
      { class: 'repost-context' },
      { innerText: 'Hongbo Zhang reposted' },
    )
    const card = createFakeCard({ fallbacks: [fallback], innerText: 'Hongbo Zhang reposted 正文' })
    expect(readFeedItemTimelineContext(card)).toBe('Hongbo Zhang reposted')
  })

  test('ignores repost action buttons and their wrappers instead of treating them as context', () => {
    const action = createFakeElement(
      { 'data-testid': 'retweet', role: 'button' },
      { innerText: '3 次转帖。转帖' },
    )
    action.tagName = 'BUTTON'
    const card = createFakeCard({ fallbacks: [action], innerText: '普通帖子 3 次转帖。转帖' })
    expect(readFeedItemTimelineContext(card)).toBeNull()

    const wrapper = createFakeElement({ class: 'retweet-action' }, { innerText: '3 次转帖。转帖' })
    wrapper.querySelector = (selector: string) => (selector.includes('button') ? action : null)
    const wrappedCard = createFakeCard({
      fallbacks: [wrapper],
      innerText: '普通帖子 3 次转帖。转帖',
    })
    expect(readFeedItemTimelineContext(wrappedCard)).toBeNull()
  })

  test('returns null when the card has no timeline context', () => {
    expect(readFeedItemTimelineContext(createFakeCard())).toBeNull()
  })

  test('extracts the repost author from Chinese and English contexts', () => {
    expect(parseFeedRepostBy('Hongbo Zhang 已转帖')).toBe('Hongbo Zhang')
    expect(parseFeedRepostBy('Hongbo Zhang reposted')).toBe('Hongbo Zhang')
    expect(parseFeedRepostBy('王已转帖')).toBe('王')
    expect(parseFeedRepostBy('王转帖')).toBe('王')
    // 不是转帖上下文，或识别不出人名时给 null
    expect(parseFeedRepostBy('3 小时前')).toBeNull()
    expect(parseFeedRepostBy('3 次转帖。转帖')).toBeNull()
    expect(parseFeedRepostBy('已转帖')).toBeNull()
    expect(parseFeedRepostBy(null)).toBeNull()
  })
})

function createFeedHarness(changeEpoch: boolean) {
  const state = {
    targeting: { pageEpochs: new Map([[7, 1]]) },
  } as unknown as ExtensionState
  const result: FeedCollectionResult = {
    pageEpoch: 1,
    selector: 'article',
    limit: 30,
    dedupe: 'url',
    maxScrolls: 20,
    pauseMs: 900,
    stallRounds: 3,
    scrolls: 1,
    stopReason: 'stalled',
    count: 1,
    items: [],
  }
  const domain = createPageObserveDomain({
    state,
    getTargetTab: async () => ({ id: 7 }) as TabWithId,
    evaluateInTabContext: async () => {
      if (changeEpoch) state.targeting.pageEpochs.set(7, 2)
      return { value: result }
    },
  } as never)
  return { domain, result }
}

describe('feed page epoch validation', () => {
  test('returns collection only when the page epoch is unchanged', async () => {
    const { domain, result } = createFeedHarness(false)
    expect(
      await domain.collectFeed(
        7,
        {
          selector: 'article',
          limit: 30,
          dedupe: 'url',
          maxScrolls: 20,
          pauseMs: 900,
          stallRounds: 3,
        },
        null,
      ),
    ).toBe(result)
  })

  test('discards stale collection after navigation with STALE_FEED_STATE', async () => {
    const { domain } = createFeedHarness(true)
    await expect(
      domain.collectFeed(
        7,
        {
          selector: 'article',
          limit: 30,
          dedupe: 'url',
          maxScrolls: 20,
          pauseMs: 900,
          stallRounds: 3,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'STALE_FEED_STATE' })
  })
})
