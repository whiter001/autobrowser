import { describe, expect, test } from 'bun:test'
import { buildNetworkRequestsJsonl } from '../src/cli/network-export.js'

describe('network jsonl export', () => {
  test('flattens request summaries into jsonl records', () => {
    const result = buildNetworkRequestsJsonl(
      {
        total: 2,
        pageEpoch: 6,
        requests: [
          {
            id: '1:req-1',
            requestId: 'req-1',
            tabId: 11,
            url: 'https://example.com/api/list?page=2&cursor=abc',
            method: 'GET',
            status: 200,
            resourceType: 'xhr',
            requestBody: '{"page":2}',
            responseBody: '{"items":[1,2]}',
            responseHeaders: {
              link: '<https://example.com/api/list?page=3>; rel="next"',
              'x-next-page': '3',
            },
          },
          {
            id: '1:req-2',
            requestId: 'req-2',
            tabId: 11,
            url: 'https://example.com/api/detail',
            method: 'POST',
            status: 201,
            resourceType: 'fetch',
          },
        ],
      },
      {
        filter: '/api/',
        method: 'GET',
      },
    )

    const lines = result.content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(result.recordCount).toBe(3)
    expect(lines[0]).toMatchObject({
      kind: 'requests',
      total: 2,
      pageEpoch: 6,
      filters: {
        filter: '/api/',
        method: 'GET',
      },
    })
    expect(lines[1]).toMatchObject({
      kind: 'request',
      pageEpoch: 6,
      id: '1:req-1',
      requestId: 'req-1',
      tabId: 11,
      url: 'https://example.com/api/list?page=2&cursor=abc',
      method: 'GET',
      status: 200,
      resourceType: 'xhr',
      requestBody: '{"page":2}',
      responseBody: '{"items":[1,2]}',
      pagination: {
        source: 'query',
        query: {
          page: '2',
          cursor: 'abc',
        },
      },
    })
    expect(lines[2]).toMatchObject({
      kind: 'request',
      pageEpoch: 6,
      id: '1:req-2',
      requestId: 'req-2',
      tabId: 11,
      url: 'https://example.com/api/detail',
      method: 'POST',
      status: 201,
      resourceType: 'fetch',
    })
  })
})
