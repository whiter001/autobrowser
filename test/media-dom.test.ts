import { describe, expect, test } from 'bun:test'
import {
  buildMediaCollectScript,
  buildMediaPlayProbeScript,
  MEDIA_PLAY_PROBE_MARKER,
} from '../extension/background/media-dom.js'

/**
 * 页面内脚本的最小 DOM 替身。
 * 只实现脚本真正用到的那部分 DOM API，用来验证"作用域限定/背景图/来源链接"这些
 * 只能在页面里发生的行为。
 */
class FakeElement {
  tagName: string
  attributes: Record<string, string>
  children: FakeElement[] = []
  parentElement: FakeElement | null = null
  document: FakeDocument | null = null
  get ownerDocument(): FakeDocument {
    return this.document ?? this.parentElement!.ownerDocument
  }
  get isConnected(): boolean {
    try {
      return this.ownerDocument.documentElement.contains(this)
    } catch {
      return false
    }
  }
  currentSrc: string | null = null
  duration: number | null = null
  computed: Record<string, string>
  played = 0
  paused = true
  muted = false
  playError: string | null = null

  constructor(options: {
    tag: string
    attrs?: Record<string, string>
    children?: FakeElement[]
    currentSrc?: string | null
    duration?: number | null
    style?: Record<string, string>
    playError?: string | null
  }) {
    this.tagName = options.tag.toUpperCase()
    this.attributes = options.attrs ?? {}
    this.currentSrc = options.currentSrc ?? null
    this.duration = options.duration ?? null
    this.computed = {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      backgroundImage: 'none',
      ...options.style,
    }
    this.playError = options.playError ?? null
    for (const child of options.children ?? []) this.append(child)
  }

  append(child: FakeElement): FakeElement {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 100, height: 100 }
  }

  contains(node: FakeElement): boolean {
    let current: FakeElement | null = node
    while (current) {
      if (current === this) return true
      current = current.parentElement
    }
    return false
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = []
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }

  async play(): Promise<void> {
    this.played += 1
    if (this.playError) throw new Error(this.playError)
  }

  pause(): void {
    this.paused = true
  }
}

class FakeDocument {
  documentElement: FakeElement
  baseURI = 'https://example.com/'

  constructor(root: FakeElement) {
    this.documentElement = root
    root.document = this
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = []
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child)
        visit(child)
      }
    }
    visit(this.documentElement)
    return found
  }
}

function matchesSelector(node: FakeElement, selector: string): boolean {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesCompound(node, part))
}

function matchesCompound(node: FakeElement, compound: string): boolean {
  const pattern = /^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)$/
  const matched = pattern.exec(compound)
  if (!matched) return false
  const [, tag, attributes] = matched
  if (tag && node.tagName !== tag.toUpperCase()) return false
  for (const attribute of attributes.match(/\[[^\]]+\]/g) ?? []) {
    const body = attribute.slice(1, -1)
    const [name, expected] = body.split('=')
    const value = node.getAttribute(name)
    if (value === null) return false
    if (expected !== undefined && value !== expected.replace(/^['"]|['"]$/g, '')) return false
  }
  return true
}

function createWindow() {
  return {
    getComputedStyle: (node: FakeElement) => node.computed,
  }
}

function runCollectScript(options: {
  selector: string | null
  includeBackground: boolean
  document: FakeDocument
}): {
  items: Array<Record<string, unknown>>
  scope: { selector: string | null; mode: string; matchedCount: number }
  pageUrl: string
} {
  const script = buildMediaCollectScript({
    selector: options.selector,
    includeBackground: options.includeBackground,
  })
  const runner = new Function(
    'document',
    'window',
    'location',
    // 探测脚本以注释开头，必须加括号避免 ASI 把 return 截断
    `return (${script})`,
  ) as (
    document: FakeDocument,
    window: ReturnType<typeof createWindow>,
    location: { href: string },
  ) => {
    items: Array<Record<string, unknown>>
    scope: { selector: string | null; mode: string; matchedCount: number }
    pageUrl: string
  }
  return runner(options.document, createWindow(), { href: 'https://example.com/feed' })
}

function runProbeScript(options: {
  selector: string | null
  document: FakeDocument
  probeKey?: string
}): Promise<{ attempted: boolean; played: boolean; error: string | null }> {
  const script = buildMediaPlayProbeScript({
    selector: options.selector,
    ...(options.probeKey ? { probeKey: options.probeKey } : {}),
  })
  expect(script).toContain(MEDIA_PLAY_PROBE_MARKER)
  const runner = new Function(
    'document',
    'window',
    'location',
    // 探测脚本以注释开头，必须加括号避免 ASI 把 return 截断
    `return (${script})`,
  ) as (
    document: FakeDocument,
    window: ReturnType<typeof createWindow>,
    location: { href: string },
  ) => Promise<{ attempted: boolean; played: boolean; error: string | null }>
  return runner(options.document, createWindow(), { href: 'https://example.com/feed' })
}

function createTweetFixture() {
  const target = new FakeElement({ tag: 'article', attrs: { 'data-role': 'tweet' } })
  const permalink = new FakeElement({
    tag: 'a',
    attrs: { href: '/ada/status/123456' },
  })
  target.append(permalink)
  const targetImage = new FakeElement({
    tag: 'img',
    attrs: { src: 'https://cdn.example.com/target.jpg' },
    currentSrc: 'https://cdn.example.com/target.jpg',
  })
  target.append(targetImage)

  const reply = new FakeElement({ tag: 'article', attrs: { 'data-role': 'reply' } })
  const replyImage = new FakeElement({
    tag: 'img',
    attrs: { src: 'https://cdn.example.com/reply.jpg' },
    currentSrc: 'https://cdn.example.com/reply.jpg',
  })
  reply.append(replyImage)

  const recommend = new FakeElement({ tag: 'section', attrs: { 'data-role': 'recommend' } })
  const recommendImage = new FakeElement({
    tag: 'img',
    attrs: { src: 'https://cdn.example.com/recommend.jpg' },
    currentSrc: 'https://cdn.example.com/recommend.jpg',
  })
  recommend.append(recommendImage)

  const root = new FakeElement({ tag: 'body' })
  root.append(target)
  root.append(reply)
  root.append(recommend)
  return { root, target, targetImage, reply, replyImage, recommend, recommendImage }
}

describe('media page script', () => {
  test('missing explicit selector never falls back to page backgrounds', () => {
    const root = new FakeElement({
      tag: 'body',
      style: { backgroundImage: 'url(https://cdn.example.com/outside.jpg)' },
    })
    root.append(new FakeElement({ tag: 'img', attrs: { src: '/outside.jpg' } }))
    const document = new FakeDocument(root)
    for (const includeBackground of [false, true]) {
      const result = runCollectScript({ selector: 'article', includeBackground, document })
      expect(result.items).toEqual([])
      expect(result.scope.matchedCount).toBe(0)
    }
  })

  for (const currentSrc of ['', 'blob:https://example.com/same']) {
    for (const mutation of ['reorder', 'delete', 'replace', 'outside']) {
      test(`probe uses element identity with ${currentSrc || 'empty src'} after ${mutation}`, async () => {
        const root = new FakeElement({ tag: 'body' })
        const article = root.append(new FakeElement({ tag: 'article' }))
        const first = article.append(new FakeElement({ tag: 'video', currentSrc }))
        const second = article.append(new FakeElement({ tag: 'video', currentSrc }))
        const document = new FakeDocument(root)
        const collected = runCollectScript({
          selector: 'article',
          includeBackground: false,
          document,
        })
        const key = collected.items[0]!.probeKey as string
        if (mutation === 'reorder') article.children = [second, first]
        else {
          article.children = [second]
          first.parentElement = null
          first.document = document
          if (mutation === 'replace') article.append(new FakeElement({ tag: 'video', currentSrc }))
          if (mutation === 'outside') root.append(first)
        }
        const result = await runProbeScript({
          selector: 'article',
          probeKey: key,
          document,
        })
        expect(result.played).toBe(mutation === 'reorder')
        expect(first.played).toBe(mutation === 'reorder' ? 1 : 0)
        expect(second.played).toBe(0)
        expect(
          article.children.filter((node) => node !== first).every((node) => node.played === 0),
        ).toBe(true)
      })
    }
  }

  test('tokens cannot resolve an identically ordered element in a new document', async () => {
    const makeDocument = () => {
      const root = new FakeElement({ tag: 'body' })
      const video = root.append(new FakeElement({ tag: 'video' }))
      return { document: new FakeDocument(root), video }
    }
    const old = makeDocument()
    const key = runCollectScript({
      selector: 'video',
      includeBackground: false,
      document: old.document,
    }).items[0]!.probeKey as string
    const next = makeDocument()
    runCollectScript({ selector: 'video', includeBackground: false, document: next.document })
    const result = await runProbeScript({
      selector: 'video',
      probeKey: key,
      document: next.document,
    })
    expect(result.played).toBe(false)
    expect(next.video.played).toBe(0)
  })

  test('limits DOM media collection to the matched container', () => {
    const fixture = createTweetFixture()
    const document = new FakeDocument(fixture.root)

    const result = runCollectScript({
      selector: 'article[data-role="tweet"]',
      includeBackground: false,
      document,
    })

    expect(result.scope).toEqual({
      selector: 'article[data-role="tweet"]',
      mode: 'selector',
      matchedCount: 1,
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.url).toBe('https://cdn.example.com/target.jpg')
  })

  test('scope excludes reply and recommendation media', () => {
    const fixture = createTweetFixture()
    const document = new FakeDocument(fixture.root)

    const scoped = runCollectScript({
      selector: 'article[data-role="tweet"]',
      includeBackground: false,
      document,
    })
    const urls = scoped.items.map((item) => item.url)
    expect(urls).not.toContain('https://cdn.example.com/reply.jpg')
    expect(urls).not.toContain('https://cdn.example.com/recommend.jpg')
  })

  test('includes the container itself when it is an image or video', () => {
    const image = new FakeElement({
      tag: 'img',
      attrs: { src: 'https://cdn.example.com/only.jpg' },
      currentSrc: 'https://cdn.example.com/only.jpg',
    })
    const root = new FakeElement({ tag: 'body' })
    root.append(image)
    const document = new FakeDocument(root)

    const result = runCollectScript({
      selector: 'img',
      includeBackground: false,
      document,
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.url).toBe('https://cdn.example.com/only.jpg')
  })

  test('reports the default scope when no selector is given', () => {
    const fixture = createTweetFixture()
    const document = new FakeDocument(fixture.root)

    const result = runCollectScript({ selector: null, includeBackground: false, document })
    expect(result.scope.mode).toBe('default')
    expect(result.scope.selector).toBeNull()
    expect(result.scope.matchedCount).toBe(2)
    expect(result.pageUrl).toBe('https://example.com/feed')
  })

  test('reads the permalink from the nearest article', () => {
    const fixture = createTweetFixture()
    const document = new FakeDocument(fixture.root)

    const result = runCollectScript({
      selector: 'article[data-role="tweet"]',
      includeBackground: false,
      document,
    })
    expect(result.items[0]?.permalink).toBe('https://example.com/ada/status/123456')
  })

  test('reports the owning scope root for media from multiple articles', () => {
    const root = new FakeElement({ tag: 'body' })
    for (const [index, testId] of ['target', 'reply'].entries()) {
      const article = new FakeElement({
        tag: 'article',
        attrs: { id: `article-${index}`, 'data-testid': testId },
      })
      article.append(new FakeElement({ tag: 'a', attrs: { href: `/ada/status/${index + 1}` } }))
      article.append(
        new FakeElement({
          tag: 'img',
          attrs: { src: `https://cdn.example.com/${testId}.jpg` },
          currentSrc: `https://cdn.example.com/${testId}.jpg`,
        }),
      )
      root.append(article)
    }
    const document = new FakeDocument(root)

    const result = runCollectScript({ selector: 'article', includeBackground: false, document })
    expect(result.items.map((item) => item.scopeRoot)).toEqual([
      {
        index: 0,
        tagName: 'article',
        id: 'article-0',
        dataTestId: 'target',
        permalink: 'https://example.com/ada/status/1',
      },
      {
        index: 1,
        tagName: 'article',
        id: 'article-1',
        dataTestId: 'reply',
        permalink: 'https://example.com/ada/status/2',
      },
    ])
  })

  test('derives large candidates from X thumbnails without changing currentSrc', () => {
    const article = new FakeElement({ tag: 'article' })
    article.append(
      new FakeElement({
        tag: 'img',
        attrs: { src: 'https://pbs.twimg.com/media/a?format=jpg&name=small' },
        currentSrc: 'https://pbs.twimg.com/media/a?format=jpg&name=small',
      }),
    )
    article.append(
      new FakeElement({
        tag: 'img',
        attrs: { src: 'https://cdn.example.com/a.jpg?name=small' },
        currentSrc: 'https://cdn.example.com/a.jpg?name=small',
      }),
    )
    const document = new FakeDocument(new FakeElement({ tag: 'body', children: [article] }))

    const result = runCollectScript({ selector: 'article', includeBackground: false, document })
    expect(result.items[0]?.currentSrc).toBe('https://pbs.twimg.com/media/a?format=jpg&name=small')
    expect(result.items[0]?.highResolutionCandidates).toEqual([
      'https://pbs.twimg.com/media/a?format=jpg&name=large',
    ])
    expect(result.items[1]?.highResolutionCandidates).toEqual([])
  })

  test('reports a null permalink when the article has no status link', () => {
    const article = new FakeElement({ tag: 'article' })
    article.append(new FakeElement({ tag: 'a', attrs: { href: '/ada/profile' } }))
    const image = new FakeElement({
      tag: 'img',
      attrs: { src: 'https://cdn.example.com/a.jpg' },
      currentSrc: 'https://cdn.example.com/a.jpg',
    })
    article.append(image)
    const root = new FakeElement({ tag: 'body' })
    root.append(article)
    const document = new FakeDocument(root)

    const result = runCollectScript({ selector: null, includeBackground: false, document })
    expect(result.items[0]?.permalink).toBeNull()
  })

  test('collects CSS background-image urls only when requested', () => {
    const article = new FakeElement({ tag: 'article' })
    const background = new FakeElement({
      tag: 'div',
      style: { backgroundImage: 'url("https://cdn.example.com/bg.jpg")' },
    })
    article.append(background)
    const root = new FakeElement({ tag: 'body' })
    root.append(article)
    const document = new FakeDocument(root)

    const without = runCollectScript({ selector: null, includeBackground: false, document })
    expect(without.items).toHaveLength(0)

    const withBackground = runCollectScript({
      selector: null,
      includeBackground: true,
      document,
    })
    expect(withBackground.items).toHaveLength(1)
    expect(withBackground.items[0]?.url).toBe('https://cdn.example.com/bg.jpg')
    expect(withBackground.items[0]?.background).toBe(true)
  })

  test('reads inline background-image when computed style is unavailable', () => {
    const article = new FakeElement({ tag: 'article' })
    const background = new FakeElement({
      tag: 'div',
      attrs: { style: 'background-image: url(https://cdn.example.com/inline.jpg)' },
      style: { backgroundImage: 'none' },
    })
    article.append(background)
    const root = new FakeElement({ tag: 'body' })
    root.append(article)
    const document = new FakeDocument(root)

    const result = runCollectScript({ selector: null, includeBackground: true, document })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.url).toBe('https://cdn.example.com/inline.jpg')
  })

  test('probe refuses to play a different video than the one collected', async () => {
    const article = new FakeElement({ tag: 'article' })
    const first = new FakeElement({ tag: 'video', currentSrc: 'blob:https://example.com/first' })
    const second = new FakeElement({ tag: 'video', currentSrc: 'blob:https://example.com/second' })
    article.append(first)
    article.append(second)
    const root = new FakeElement({ tag: 'body' })
    root.append(article)
    const document = new FakeDocument(root)

    const result = await runProbeScript({
      selector: 'article',
      document,
      probeKey: 'blob:https://example.com/second',
    })

    expect(result.played).toBe(false)
    expect(result.error).toContain('changed since the media list was collected')
    expect(first.played).toBe(0)
    expect(second.played).toBe(0)
  })

  test('probe plays only the scoped video', async () => {
    const article = new FakeElement({ tag: 'article' })
    const scopedVideo = new FakeElement({
      tag: 'video',
      currentSrc: 'blob:https://example.com/scoped',
    })
    article.append(scopedVideo)
    const outsideVideo = new FakeElement({
      tag: 'video',
      currentSrc: 'blob:https://example.com/outside',
    })
    const root = new FakeElement({ tag: 'body' })
    root.append(article)
    root.append(outsideVideo)
    const document = new FakeDocument(root)

    const collected = runCollectScript({ selector: 'article', includeBackground: false, document })
    const result = await runProbeScript({
      selector: 'article',
      document,
      probeKey: collected.items[0]!.probeKey as string,
    })

    expect(result.played).toBe(true)
    expect(scopedVideo.played).toBe(1)
    expect(outsideVideo.played).toBe(0)
  })
})
