import { describe, expect, test } from 'bun:test'
import { createMediaDomain, type MediaEvaluateResult } from '../extension/background/media.js'
import { MEDIA_PLAY_PROBE_MARKER } from '../extension/background/media-dom.js'
import { createExtensionState } from '../extension/background/state.js'
import type {
  ExtensionState,
  NetworkRequestRecord,
  TabInput,
  TabWithId,
} from '../extension/background/types.js'

interface HarnessOptions {
  page?: unknown
  onCollect?: (state: ExtensionState) => void
  requests?: Array<Partial<NetworkRequestRecord>>
  sessionRequests?: Array<Partial<NetworkRequestRecord>>
  probe?: {
    played?: boolean
    error?: string | null
    onProbe?: (state: ExtensionState, probeIndex: number) => void
  }
}

function createHarness(options: HarnessOptions = {}) {
  const state = createExtensionState(57978)
  for (const request of options.requests ?? []) {
    state.network.requests.push(request as NetworkRequestRecord)
  }
  if (options.sessionRequests) {
    ;(state.session as { requests?: unknown }).requests = options.sessionRequests
  }

  const expressions: string[] = []
  const probe = options.probe ?? {}

  const evaluateInTabContext = async <TValue = unknown>(
    tabId: TabInput,
    expression: string,
  ): Promise<MediaEvaluateResult<TValue>> => {
    expressions.push(expression)
    if (expression.includes(MEDIA_PLAY_PROBE_MARKER)) {
      // 按调用顺序模拟逐个探测的副作用，不依赖脚本注入数组下标。
      const probeIndex =
        expressions.filter((item) => item.includes(MEDIA_PLAY_PROBE_MARKER)).length - 1
      probe.onProbe?.(state, probeIndex)
      return {
        tab: { id: Number(tabId) } as TabWithId,
        response: { result: null },
        value: {
          attempted: true,
          played: probe.played === true,
          error: probe.error ?? null,
        } as TValue,
      }
    }
    options.onCollect?.(state)
    return {
      tab: { id: Number(tabId) } as TabWithId,
      response: { result: null },
      value: (options.page ?? null) as TValue | null,
    }
  }

  const domain = createMediaDomain({ state, evaluateInTabContext })
  return { state, domain, expressions }
}

const BLOB_VIDEO = {
  index: 0,
  type: 'video',
  url: 'blob:https://example.com/9f0c',
  currentSrc: 'blob:https://example.com/9f0c',
  candidates: ['blob:https://example.com/9f0c'],
  poster: null,
  duration: null,
  sources: [],
  permalink: null,
  background: false,
  probeIndex: 0,
}

describe('media domain completeness', () => {
  const image = {
    index: 0,
    type: 'image',
    url: 'https://example.com/a.jpg',
    candidates: ['https://example.com/a.jpg'],
  }

  test('normal nonempty media is complete with no warnings', async () => {
    const { domain } = createHarness({ page: { items: [image] } })
    const result = await domain.list(1, 'top')
    expect(result.complete).toBe(true)
    expect(result.warnings).toEqual([])
  })

  test('empty media and unmatched scope report both gaps', async () => {
    const { domain } = createHarness({
      page: { items: [], scope: { selector: '#missing', mode: 'selector', matchedCount: 0 } },
    })
    const result = await domain.list(1, 'top', { selector: '#missing' })
    expect(result.complete).toBe(false)
    expect(result.warnings.join('\n')).toContain('matched no elements')
    expect(result.warnings.join('\n')).toContain('No media')
  })

  test('empty media in a matched scope is still incomplete', async () => {
    const { domain } = createHarness({
      page: { items: [], scope: { selector: 'article', mode: 'selector', matchedCount: 1 } },
    })
    const result = await domain.list(1, 'top', { selector: 'article' })
    expect(result.complete).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('No media')
  })

  test('an unresolved video without resolve enabled is incomplete even without an item error', async () => {
    const { domain } = createHarness({ page: { items: [BLOB_VIDEO] } })
    const result = await domain.list(1, 'top')
    expect(result.media[0]?.error).toBeNull()
    expect(result.complete).toBe(false)
    expect(result.warnings[0]).toContain('no resolved HTTP(S) source')
  })

  test('an image with no source is incomplete', async () => {
    const { domain } = createHarness({ page: { items: [{ ...image, url: null, candidates: [] }] } })
    const result = await domain.list(1, 'top')
    expect(result.complete).toBe(false)
    expect(result.warnings[0]).toContain('Media 0')
  })

  test('resolve errors are exposed as readable warnings', async () => {
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      probe: { error: 'autoplay blocked' },
    })
    const result = await domain.list(1, 'top', { resolve: true })
    expect(result.complete).toBe(false)
    expect(result.warnings.join('\n')).toContain('autoplay blocked')
  })

  test('playback failure remains a known gap even when a historical source exists', async () => {
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      requests: [{ tabId: 1, pageEpoch: 1, url: 'https://example.com/v.mp4' }],
      probe: { played: false },
    })
    const result = await domain.list(1, 'top', { resolve: true })
    expect(result.media[0]?.url).not.toBe('https://example.com/v.mp4')
    expect(result.media[0]?.sources).toEqual([])
    expect(result.media[0]?.observedSources).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.warnings.join('\n')).toContain('playback was blocked')
  })

  test('ambiguous and scoped unresolved sources are incomplete', async () => {
    for (const options of [{ selector: 'article' }, {}]) {
      const { domain } = createHarness({
        page: {
          items: options.selector
            ? [BLOB_VIDEO]
            : [BLOB_VIDEO, { ...BLOB_VIDEO, index: 1, probeIndex: 1 }],
        },
      })
      const result = await domain.list(1, 'top', options)
      expect(result.complete).toBe(false)
      expect(result.warnings.join('\n')).toContain(result.media[0]!.error!)
    }
  })

  test('successful playback with only observed sources remains incomplete', async () => {
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      probe: {
        played: true,
        onProbe: (state) => {
          state.network.requests.push({
            tabId: 1,
            pageEpoch: 1,
            url: 'https://example.com/v.mp4',
          } as NetworkRequestRecord)
        },
      },
    })
    const result = await domain.list(1, 'top', { resolve: true })
    expect(result.complete).toBe(false)
    expect(result.warnings.join('\n')).toContain('unverified')
    expect(result.media[0]!.sources).toEqual([])
    expect(result.media[0]!.observedSources).toMatchObject([
      { url: 'https://example.com/v.mp4', unverified: true },
    ])
  })

  test('resolve count limit is reported and excess videos remain unresolved', async () => {
    const { domain, expressions } = createHarness({
      page: {
        items: Array.from({ length: 4 }, (_, index) => ({
          ...BLOB_VIDEO,
          index,
          probeIndex: index,
        })),
      },
      probe: {
        played: true,
        onProbe: (state, index) => {
          state.network.requests.push({
            tabId: 1,
            pageEpoch: 1,
            url: `https://example.com/${index}.mp4`,
          } as NetworkRequestRecord)
        },
      },
    })
    const result = await domain.list(1, 'top', { resolve: true })
    expect(
      expressions.filter((expression) => expression.includes(MEDIA_PLAY_PROBE_MARKER)),
    ).toHaveLength(3)
    expect(result.complete).toBe(false)
    expect(result.warnings.join('\n')).toContain('Resolve limit reached')
    expect(result.media[3]?.sources).toEqual([])
    expect(result.media[3]?.suggestedAction).not.toContain('--resolve')
  })
})

describe('media domain', () => {
  test('collects images and drops data:/about: candidates', async () => {
    const { domain } = createHarness({
      page: {
        items: [
          {
            index: 0,
            type: 'image',
            url: 'https://example.com/a.jpg',
            currentSrc: 'https://example.com/a.jpg',
            candidates: [
              'https://example.com/a.jpg',
              'data:image/png;base64,AAAA',
              'about:blank',
              'https://example.com/b.jpg',
            ],
            poster: null,
            duration: null,
            sources: [],
            permalink: null,
            background: false,
            probeIndex: null,
          },
        ],
      },
    })

    const result = await domain.list(1, 'top', {})
    expect(result.media).toHaveLength(1)
    const [item] = result.media
    expect(item.type).toBe('image')
    expect(item.index).toBe(0)
    expect(item.url).toBe('https://example.com/a.jpg')
    expect(item.sources.map((source) => source.url)).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.jpg',
    ])
    expect(item.sources.every((source) => source.kind === 'image')).toBe(true)
    expect(item.poster).toBeNull()
    expect(item.duration).toBeNull()
    expect(item.error).toBeNull()
    expect(item.primarySource).toBe('dom')
  })

  test('keeps every direct DOM source downloadable without claiming network candidates', async () => {
    const { domain } = createHarness({
      page: {
        items: [
          {
            ...BLOB_VIDEO,
            currentSrc: 'https://example.com/current.mp4',
            sources: [{ url: 'https://example.com/alternate.webm', contentType: 'video/webm' }],
          },
        ],
      },
      requests: [{ tabId: 1, pageEpoch: 1, url: 'https://example.com/outside.mp4' }],
    })
    const result = await domain.list(1, 'top', { resolve: true })
    expect(result.media[0]!.sources.map((source) => source.url)).toEqual([
      'https://example.com/current.mp4',
      'https://example.com/alternate.webm',
    ])
    expect(result.media[0]!.observedSources).toEqual([])
    expect(result.complete).toBe(true)
  })

  test('collects direct mp4 videos with poster and duration', async () => {
    const { domain } = createHarness({
      page: {
        items: [
          {
            index: 0,
            type: 'video',
            url: 'https://cdn.example.com/v.mp4',
            currentSrc: 'https://cdn.example.com/v.mp4',
            candidates: ['https://cdn.example.com/v.mp4'],
            poster: 'https://cdn.example.com/p.jpg',
            duration: 12.5,
            sources: [],
            permalink: null,
            background: false,
            probeIndex: null,
          },
        ],
      },
    })

    const result = await domain.list(1, 'top', {})
    const [item] = result.media
    expect(item.type).toBe('video')
    expect(item.url).toBe('https://cdn.example.com/v.mp4')
    expect(item.currentSrc).toBe('https://cdn.example.com/v.mp4')
    expect(item.sources).toEqual([{ url: 'https://cdn.example.com/v.mp4', kind: 'mp4' }])
    expect(item.poster).toBe('https://cdn.example.com/p.jpg')
    expect(item.duration).toBe(12.5)
    expect(item.primarySource).toBe('dom')
  })

  for (const selector of [undefined, 'article']) {
    test(`never claims historical traffic, scope=${selector ?? 'default'}`, async () => {
      const { domain } = createHarness({
        page: { items: [BLOB_VIDEO] },
        requests: [{ tabId: 1, pageEpoch: 1, url: 'https://cdn.example.com/history/master.m3u8' }],
      })
      const result = await domain.list(1, 'top', { selector })
      expect(result.media[0]!.sources).toEqual([])
      expect(result.media[0]!.observedSources).toEqual([])
      expect(result.media[0]!.url).not.toBe('https://cdn.example.com/history/master.m3u8')
      expect(result.complete).toBe(false)
    })

    for (const played of [false, true]) {
      test(`concurrent outside traffic is diagnostic only, played=${played}, scope=${selector}`, async () => {
        const { domain } = createHarness({
          page: { items: [BLOB_VIDEO] },
          probe: {
            played,
            onProbe: (state) => {
              for (const [tabId, pageEpoch, name] of [
                [1, 1, 'outside'],
                [2, 1, 'other-tab'],
                [1, 0, 'old'],
              ] as const) {
                state.network.requests.push({
                  tabId,
                  pageEpoch,
                  url: `https://cdn.example.com/${name}.mp4`,
                } as NetworkRequestRecord)
              }
            },
          },
        })
        const result = await domain.list(1, 'top', { selector, resolve: true })
        const item = result.media[0]!
        expect(item.sources).toEqual([])
        expect(item.url).not.toBe('https://cdn.example.com/outside.mp4')
        expect(item.observedSources.map((source) => source.url)).toEqual(
          played ? ['https://cdn.example.com/outside.mp4'] : [],
        )
        expect(item.observedSources.every((source) => source.unverified)).toBe(true)
        expect(result.complete).toBe(false)
        expect(result.warnings.length).toBeGreaterThan(0)
      })
    }
  }

  test('epoch change during collection fails even without probing', async () => {
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      onCollect: (state) => {
        state.targeting.pageEpochs.set(1, 2)
      },
    })
    await expect(domain.list(1, 'top')).rejects.toMatchObject({ code: 'STALE_MEDIA_STATE' })
  })

  test('epoch change during probe fails instead of mixing pages', async () => {
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      probe: {
        played: true,
        onProbe: (state) => {
          state.targeting.pageEpochs.set(1, 2)
        },
      },
    })
    await expect(domain.list(1, 'top', { resolve: true })).rejects.toMatchObject({
      code: 'STALE_MEDIA_STATE',
    })
  })

  test('cancellation during probe is propagated', async () => {
    const error = Object.assign(new Error('cancelled'), { code: 'COMMAND_CANCELLED' })
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      probe: {
        onProbe: () => {
          throw error
        },
      },
    })
    await expect(domain.list(1, 'top', { resolve: true })).rejects.toBe(error)
  })

  test('dedupes the same url coming from the dom and from the network', async () => {
    const { domain } = createHarness({
      page: {
        items: [
          {
            index: 0,
            type: 'video',
            url: 'https://cdn.example.com/v.mp4',
            currentSrc: 'https://cdn.example.com/v.mp4',
            candidates: ['https://cdn.example.com/v.mp4'],
            poster: null,
            duration: null,
            sources: [],
            permalink: null,
            background: false,
            probeIndex: null,
          },
        ],
      },
      requests: [
        {
          id: '1:r1',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/v.mp4',
          responseMimeType: 'video/mp4',
        },
      ],
    })

    const result = await domain.list(1, 'top', {})
    const [item] = result.media
    expect(item.sources).toHaveLength(1)
    expect(item.sources[0]).toMatchObject({ url: 'https://cdn.example.com/v.mp4', kind: 'mp4' })
    expect(item.primarySource).toBe('dom')
  })

  test('does not claim historical media requests from session.requests either', async () => {
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      sessionRequests: [
        {
          id: '1:r1',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/hls/master.m3u8',
          responseMimeType: 'application/vnd.apple.mpegurl',
        },
      ],
    })

    const result = await domain.list(1, 'top', {})
    const [item] = result.media
    expect(item.sources).toEqual([])
    expect(item.observedSources).toEqual([])
  })

  test('does not play anything when resolve is disabled', async () => {
    const { domain, expressions } = createHarness({
      page: { items: [BLOB_VIDEO] },
      probe: { played: true },
    })

    const result = await domain.list(1, 'top', {})
    expect(expressions).toHaveLength(1)
    expect(expressions[0]).not.toContain(MEDIA_PLAY_PROBE_MARKER)
    expect(result.media[0].sources).toHaveLength(0)
  })

  test('reads the dom instead of the page text', async () => {
    const { domain, expressions } = createHarness({ page: { items: [] } })
    await domain.list(1, 'top', {})
    expect(expressions[0]).toContain('querySelectorAll')
    expect(expressions[0]).not.toContain('innerText')
    expect(expressions[0]).not.toContain('textContent')
  })

  test('resolve plays muted and picks up the network source afterwards', async () => {
    const { domain, expressions } = createHarness({
      page: { items: [BLOB_VIDEO] },
      probe: {
        played: true,
        onProbe: (state) => {
          state.network.requests.push({
            id: '1:r1',
            tabId: 1,
            pageEpoch: 1,
            url: 'https://cdn.example.com/hls/master.m3u8',
            responseMimeType: 'application/vnd.apple.mpegurl',
          })
        },
      },
    })

    const result = await domain.list(1, 'top', { resolve: true })
    expect(expressions).toHaveLength(2)
    expect(expressions[1]).toContain(MEDIA_PLAY_PROBE_MARKER)
    expect(expressions[1]).toContain('video.pause()')
    expect(expressions[1]).toContain('video.muted = true')
    const [item] = result.media
    expect(item.sources).toEqual([])
    expect(item.observedSources[0]?.url).toBe('https://cdn.example.com/hls/master.m3u8')
    expect(item.error).toContain('unverified')
  })

  test('reports an explicit error when playback is blocked', async () => {
    const { domain, expressions } = createHarness({
      page: { items: [BLOB_VIDEO] },
      probe: {
        played: false,
        error: 'NotAllowedError: play() failed because the user did not interact with the document',
      },
    })

    const result = await domain.list(1, 'top', { resolve: true })
    expect(expressions).toHaveLength(2)
    const [item] = result.media
    expect(item.sources).toHaveLength(0)
    expect(item.error).toContain('unable to resolve the media stream')
    expect(item.error).toContain('NotAllowedError')
    expect(item.suggestedAction).toBeString()
  })

  test('reports the collection scope and provenance metadata', async () => {
    const { domain } = createHarness({
      page: {
        items: [
          {
            index: 0,
            type: 'image',
            url: 'https://example.com/a.jpg',
            currentSrc: 'https://example.com/a.jpg',
            candidates: ['https://example.com/a.jpg'],
            poster: null,
            duration: null,
            sources: [],
            permalink: 'https://example.com/user/status/123',
            background: false,
            probeIndex: null,
          },
        ],
        scope: { selector: 'article[data-role="tweet"]', mode: 'selector', matchedCount: 1 },
        pageUrl: 'https://example.com/user/status/123',
      },
    })

    const result = await domain.list(1, 'top', { selector: 'article[data-role="tweet"]' })
    expect(result.scope).toEqual({
      selector: 'article[data-role="tweet"]',
      mode: 'selector',
      matchedCount: 1,
    })
    expect(result.pageUrl).toBe('https://example.com/user/status/123')
    expect(result.pageEpoch).toBe(1)
    expect(Number.isNaN(Date.parse(result.observedAt))).toBe(false)
    expect(result.media[0].permalink).toBe('https://example.com/user/status/123')
  })

  test('reports the default scope when no selector is given', async () => {
    const { domain } = createHarness({
      page: {
        items: [],
        scope: { selector: null, mode: 'default', matchedCount: 4 },
        pageUrl: 'https://example.com/feed',
      },
    })

    const result = await domain.list(1, 'top', {})
    expect(result.scope).toEqual({ selector: null, mode: 'default', matchedCount: 4 })
    expect(result.pageUrl).toBe('https://example.com/feed')
  })

  test('passes the selector to the page script', async () => {
    const { domain, expressions } = createHarness({ page: { items: [] } })
    await domain.list(1, 'top', { selector: 'article[data-role="tweet"]' })
    expect(expressions[0]).toContain(JSON.stringify('article[data-role="tweet"]'))
  })

  test('keeps background images out unless they are requested', async () => {
    const backgroundItem = {
      index: 0,
      type: 'image',
      url: 'https://example.com/bg.jpg',
      currentSrc: null,
      candidates: ['https://example.com/bg.jpg'],
      poster: null,
      duration: null,
      sources: [],
      permalink: null,
      background: true,
      probeIndex: null,
    }
    const { domain } = createHarness({
      page: { items: [backgroundItem] },
    })

    const withoutBackground = await domain.list(1, 'top', {})
    expect(withoutBackground.media[0].background).toBe(true)
    expect(withoutBackground.media[0].primarySource).toBe('dom')
  })

  test('does not share network candidates between multiple source-less videos', async () => {
    const secondBlobVideo = {
      ...BLOB_VIDEO,
      index: 1,
      url: 'blob:https://example.com/1a2b',
      currentSrc: 'blob:https://example.com/1a2b',
      candidates: ['blob:https://example.com/1a2b'],
      probeIndex: 1,
    }
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO, secondBlobVideo] },
      requests: [
        {
          id: '1:r1',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/hls/master.m3u8',
          responseMimeType: 'application/vnd.apple.mpegurl',
        },
      ],
    })

    const result = await domain.list(1, 'top', {})
    expect(result.media).toHaveLength(2)
    for (const item of result.media) {
      expect(item.sources).toHaveLength(0)
      expect(item.error).toContain('cannot be attributed')
      expect(item.suggestedAction).toContain('--selector')
    }
  })

  test('does not claim historical tab-wide candidates for a scoped source-less video', async () => {
    // 作用域外的推荐视频也会产生网络请求，"作用域内唯一"不等于"网络请求唯一所有者"
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      requests: [
        {
          id: '1:r1',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/recommend/master.m3u8',
          responseMimeType: 'application/vnd.apple.mpegurl',
        },
      ],
    })

    const result = await domain.list(1, 'top', { selector: 'article[data-role="tweet"]' })
    const [item] = result.media
    expect(item.sources).toHaveLength(0)
    expect(item.sources.map((source) => source.url)).not.toContain(
      'https://cdn.example.com/recommend/master.m3u8',
    )
    expect(item.error).toContain('outside the selected scope')
    expect(item.suggestedAction).toContain('--resolve')
  })

  test('scoped resolve only claims candidates observed while that video played', async () => {
    const { domain } = createHarness({
      page: { items: [BLOB_VIDEO] },
      requests: [
        {
          id: '1:r1',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/recommend/master.m3u8',
          responseMimeType: 'application/vnd.apple.mpegurl',
        },
      ],
      probe: {
        played: true,
        onProbe: (state) => {
          state.network.requests.push({
            id: '1:r2',
            tabId: 1,
            pageEpoch: 1,
            url: 'https://cdn.example.com/target/master.m3u8',
            responseMimeType: 'application/vnd.apple.mpegurl',
          })
        },
      },
    })

    const result = await domain.list(1, 'top', {
      resolve: true,
      selector: 'article[data-role="tweet"]',
    })
    const [item] = result.media
    expect(item.sources).toEqual([])
    expect(item.observedSources.map((source) => source.url)).toEqual([
      'https://cdn.example.com/target/master.m3u8',
    ])
    expect(item.error).toContain('unverified')
    expect(result.complete).toBe(false)
  })

  test('resolve probes each source-less video by token and keeps new requests diagnostic only', async () => {
    const secondBlobVideo = {
      ...BLOB_VIDEO,
      index: 1,
      url: 'blob:https://example.com/1a2b',
      currentSrc: 'blob:https://example.com/1a2b',
      candidates: ['blob:https://example.com/1a2b'],
      probeIndex: 1,
      probeKey: 'document-token:second',
    }
    const { domain, expressions } = createHarness({
      page: { items: [{ ...BLOB_VIDEO, probeKey: 'document-token:first' }, secondBlobVideo] },
      probe: {
        played: true,
        onProbe: (state, probeIndex) => {
          state.network.requests.push({
            id: `1:r${probeIndex}`,
            tabId: 1,
            pageEpoch: 1,
            url: `https://cdn.example.com/hls/video-${probeIndex}.m3u8`,
            responseMimeType: 'application/vnd.apple.mpegurl',
          })
        },
      },
    })

    const result = await domain.list(1, 'top', { resolve: true })
    const probes = expressions.filter((expression) => expression.includes(MEDIA_PLAY_PROBE_MARKER))
    expect(probes).toHaveLength(2)
    expect(probes[0]).toContain('const expectedIdentity = "document-token:first";')
    expect(probes[1]).toContain('const expectedIdentity = "document-token:second";')
    expect(probes.every((expression) => !expression.includes('probeVideoIndex'))).toBe(true)
    expect(result.media.every((item) => item.sources.length === 0)).toBe(true)
    expect(result.media[0].observedSources.map((source) => source.url)).toEqual([
      'https://cdn.example.com/hls/video-0.m3u8',
    ])
    expect(result.media[1].observedSources.map((source) => source.url)).toEqual([
      'https://cdn.example.com/hls/video-1.m3u8',
    ])
  })

  test('resolve does not play videos outside the requested scope', async () => {
    const { domain, expressions } = createHarness({
      page: { items: [BLOB_VIDEO] },
      probe: {
        played: true,
        onProbe: (state) => {
          state.network.requests.push({
            id: '1:r1',
            tabId: 1,
            pageEpoch: 1,
            url: 'https://cdn.example.com/hls/master.m3u8',
            responseMimeType: 'application/vnd.apple.mpegurl',
          })
        },
      },
    })

    await domain.list(1, 'top', { resolve: true, selector: 'article[data-role="tweet"]' })
    const probe = expressions.find((expression) => expression.includes(MEDIA_PLAY_PROBE_MARKER))!
    expect(probe).toContain(JSON.stringify('article[data-role="tweet"]'))
    // 探测脚本必须重新按同一个作用域解析视频，而不是遍历整页
    expect(probe).toContain('mediaProbeTargets')
  })
})
