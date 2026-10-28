import { describe, expect, test } from 'bun:test'
import {
  createPageObserveDomain,
  feedItemDedupeKey,
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
