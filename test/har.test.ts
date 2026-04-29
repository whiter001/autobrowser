import { describe, expect, test } from 'bun:test'
import {
  HAR_CREATOR,
  HAR_LOG_VERSION,
  buildHarPayload,
  compareHarRecords,
} from '../src/core/har.js'

describe('HAR helpers', () => {
  test('sorts records by startedAt and then stable id fallback', () => {
    const records = [
      { requestId: 'b', startedAt: '2026-04-20T15:00:01.000Z' },
      { id: 'a', startedAt: '2026-04-20T15:00:00.000Z' },
      { requestId: 'c', startedAt: '2026-04-20T15:00:01.000Z' },
      { id: 'd' },
      { requestId: 'a', startedAt: '2026-04-20T15:00:01.000Z' },
    ]

    expect([...records].sort((left, right) => compareHarRecords(left, right))).toEqual([
      { id: 'd' },
      { id: 'a', startedAt: '2026-04-20T15:00:00.000Z' },
      { requestId: 'a', startedAt: '2026-04-20T15:00:01.000Z' },
      { requestId: 'b', startedAt: '2026-04-20T15:00:01.000Z' },
      { requestId: 'c', startedAt: '2026-04-20T15:00:01.000Z' },
    ])
  })

  test('builds HAR payloads with shared creator metadata', () => {
    expect(buildHarPayload([{ request: { url: 'https://example.com' } }])).toEqual({
      log: {
        version: HAR_LOG_VERSION,
        creator: HAR_CREATOR,
        entries: [{ request: { url: 'https://example.com' } }],
      },
    })
  })
})
