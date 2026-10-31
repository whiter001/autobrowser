import { describe, expect, test } from 'bun:test'
import {
  createMediaDomain,
  MEDIA_PLAY_PROBE_MARKER,
  type MediaEvaluateResult,
} from '../extension/background/media.js'
import { createExtensionState } from '../extension/background/state.js'
import type {
  ExtensionState,
  NetworkRequestRecord,
  TabInput,
  TabWithId,
} from '../extension/background/types.js'

interface HarnessOptions {
  page?: unknown
  requests?: Array<Partial<NetworkRequestRecord>>
  sessionRequests?: Array<Partial<NetworkRequestRecord>>
  probe?: {
    played?: boolean
    error?: string | null
    onProbe?: (state: ExtensionState) => void
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
      probe.onProbe?.(state)
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
}

describe('media domain', () => {
  test('collects images and drops data:/about: candidates', async () => {
    const { domain } = createHarness({
      page: [
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
        },
      ],
    })

    const result = await domain.list(1, 'top', false)
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
  })

  test('collects direct mp4 videos with poster and duration', async () => {
    const { domain } = createHarness({
      page: [
        {
          index: 0,
          type: 'video',
          url: 'https://cdn.example.com/v.mp4',
          currentSrc: 'https://cdn.example.com/v.mp4',
          candidates: ['https://cdn.example.com/v.mp4'],
          poster: 'https://cdn.example.com/p.jpg',
          duration: 12.5,
          sources: [],
        },
      ],
    })

    const result = await domain.list(1, 'top', false)
    const [item] = result.media
    expect(item.type).toBe('video')
    expect(item.url).toBe('https://cdn.example.com/v.mp4')
    expect(item.currentSrc).toBe('https://cdn.example.com/v.mp4')
    expect(item.sources).toEqual([{ url: 'https://cdn.example.com/v.mp4', kind: 'mp4' }])
    expect(item.poster).toBe('https://cdn.example.com/p.jpg')
    expect(item.duration).toBe(12.5)
  })

  test('resolves a blob video from the hls request of the current page', async () => {
    const { domain } = createHarness({
      page: [BLOB_VIDEO],
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

    const result = await domain.list(1, 'top', false)
    const [item] = result.media
    expect(item.currentSrc).toBe('blob:https://example.com/9f0c')
    expect(item.url).toBe('https://cdn.example.com/hls/master.m3u8')
    expect(item.sources[0]).toMatchObject({
      url: 'https://cdn.example.com/hls/master.m3u8',
      kind: 'hls',
    })
  })

  test('prefers the master playlist over variant playlists and segments', async () => {
    const { domain } = createHarness({
      page: [BLOB_VIDEO],
      requests: [
        {
          id: '1:r1',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/hls/master.m3u8',
          responseMimeType: 'application/vnd.apple.mpegurl',
        },
        {
          id: '1:r2',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/hls/720p/index.m3u8',
          responseMimeType: 'application/vnd.apple.mpegurl',
        },
        {
          id: '1:r3',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/hls/segment-1.m4s',
          responseMimeType: 'video/mp4',
        },
      ],
    })

    const result = await domain.list(1, 'top', false)
    const [item] = result.media
    expect(item.sources[0]?.url).toBe('https://cdn.example.com/hls/master.m3u8')
    expect(item.sources[0]?.kind).toBe('hls')
    const segment = item.sources.find((source) => source.url.endsWith('.m4s'))
    expect(segment?.kind).toBe('segment')
    expect(item.sources.indexOf(segment!)).toBeGreaterThan(0)
  })

  test('treats the earliest m3u8 request as the master playlist', async () => {
    const { domain } = createHarness({
      page: [BLOB_VIDEO],
      requests: [
        {
          id: '1:r1',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/hls/12345/index.m3u8',
          responseMimeType: 'application/vnd.apple.mpegurl',
        },
        {
          id: '1:r2',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://cdn.example.com/hls/12345/720p.m3u8',
          responseMimeType: 'application/vnd.apple.mpegurl',
        },
      ],
    })

    const result = await domain.list(1, 'top', false)
    const [item] = result.media
    expect(item.sources[0]?.url).toBe('https://cdn.example.com/hls/12345/index.m3u8')
    expect(item.sources[0]?.kind).toBe('hls')
    expect(item.sources[1]?.kind).toBe('hls-variant')
  })

  test('ignores requests from other tabs and other page epochs', async () => {
    const { domain } = createHarness({
      page: [BLOB_VIDEO],
      requests: [
        {
          id: '2:r1',
          tabId: 2,
          pageEpoch: 1,
          url: 'https://other-tab.example.com/v.mp4',
          responseMimeType: 'video/mp4',
        },
        {
          id: '1:old',
          tabId: 1,
          pageEpoch: 0,
          url: 'https://old-epoch.example.com/v.mp4',
          responseMimeType: 'video/mp4',
        },
        {
          id: '1:r1',
          tabId: 1,
          pageEpoch: 1,
          url: 'https://current.example.com/v.mp4',
          responseMimeType: 'video/mp4',
        },
      ],
    })

    const result = await domain.list(1, 'top', false)
    const [item] = result.media
    expect(item.sources.map((source) => source.url)).toEqual(['https://current.example.com/v.mp4'])
  })

  test('dedupes the same url coming from the dom and from the network', async () => {
    const { domain } = createHarness({
      page: [
        {
          index: 0,
          type: 'video',
          url: 'https://cdn.example.com/v.mp4',
          currentSrc: 'https://cdn.example.com/v.mp4',
          candidates: ['https://cdn.example.com/v.mp4'],
          poster: null,
          duration: null,
          sources: [],
        },
      ],
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

    const result = await domain.list(1, 'top', false)
    const [item] = result.media
    expect(item.sources).toHaveLength(1)
    expect(item.sources[0]).toMatchObject({ url: 'https://cdn.example.com/v.mp4', kind: 'mp4' })
  })

  test('reads media requests from session.requests as well', async () => {
    const { domain } = createHarness({
      page: [BLOB_VIDEO],
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

    const result = await domain.list(1, 'top', false)
    const [item] = result.media
    expect(item.sources[0]?.url).toBe('https://cdn.example.com/hls/master.m3u8')
  })

  test('does not play anything when resolve is disabled', async () => {
    const { domain, expressions } = createHarness({
      page: [BLOB_VIDEO],
      probe: { played: true },
    })

    const result = await domain.list(1, 'top', false)
    expect(expressions).toHaveLength(1)
    expect(expressions[0]).not.toContain(MEDIA_PLAY_PROBE_MARKER)
    expect(result.media[0].sources).toHaveLength(0)
  })

  test('reads the dom instead of the page text', async () => {
    const { domain, expressions } = createHarness({ page: [] })
    await domain.list(1, 'top', false)
    expect(expressions[0]).toContain('querySelectorAll')
    expect(expressions[0]).not.toContain('innerText')
    expect(expressions[0]).not.toContain('textContent')
  })

  test('resolve plays muted and picks up the network source afterwards', async () => {
    const { domain, expressions } = createHarness({
      page: [BLOB_VIDEO],
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

    const result = await domain.list(1, 'top', true)
    expect(expressions).toHaveLength(2)
    expect(expressions[1]).toContain(MEDIA_PLAY_PROBE_MARKER)
    expect(expressions[1]).toContain('video.pause()')
    expect(expressions[1]).toContain('video.muted = true')
    const [item] = result.media
    expect(item.sources[0]?.url).toBe('https://cdn.example.com/hls/master.m3u8')
    expect(item.error).toBeNull()
  })

  test('reports an explicit error when playback is blocked', async () => {
    const { domain, expressions } = createHarness({
      page: [BLOB_VIDEO],
      probe: {
        played: false,
        error: 'NotAllowedError: play() failed because the user did not interact with the document',
      },
    })

    const result = await domain.list(1, 'top', true)
    expect(expressions).toHaveLength(2)
    const [item] = result.media
    expect(item.sources).toHaveLength(0)
    expect(item.error).toContain('unable to resolve the media stream')
    expect(item.error).toContain('NotAllowedError')
    expect(item.suggestedAction).toBeString()
  })
})
