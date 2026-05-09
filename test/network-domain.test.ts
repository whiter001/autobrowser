import { describe, expect, test } from 'bun:test'
import { createNetworkDomain } from '../extension/background/network.js'
import { createExtensionState } from '../extension/background/state.js'

describe('network domain HAR export', () => {
  test('stopHar returns a complete HAR payload without extra round trips', () => {
    const state = createExtensionState(57978)
    state.network.harRecording = true
    state.network.harStartedAt = '2026-04-20T15:00:00.000Z'

    const beforeRecording = {
      id: '1:before',
      requestId: 'before',
      tabId: 1,
      url: 'https://example.com/before',
      method: 'GET',
      startedAt: '2026-04-20T14:59:59.000Z',
      durationMs: 4,
      status: 200,
      statusText: 'OK',
    }
    const firstRecorded = {
      id: '1:first',
      requestId: 'first',
      tabId: 1,
      url: 'https://example.com/first',
      method: 'POST',
      postData: '{"step":1}',
      requestHeaders: { 'content-type': 'application/json' },
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"ok":true}',
      responseMimeType: 'application/json',
      startedAt: '2026-04-20T15:00:00.500Z',
      durationMs: 12,
      waitMs: 8,
      receiveMs: 4,
      status: 201,
      statusText: 'Created',
    }
    const secondRecorded = {
      id: '1:second',
      requestId: 'second',
      tabId: 1,
      url: 'https://example.com/second',
      method: 'GET',
      startedAt: '2026-04-20T15:00:01.000Z',
      durationMs: 5,
      status: 204,
      statusText: 'No Content',
    }

    state.network.requests = [secondRecorded, beforeRecording, firstRecorded]
    state.network.requestMap = new Map(
      [beforeRecording, firstRecorded, secondRecorded].map((record) => [record.id, record]),
    )
    const emptyDebuggerCommand = async <TResult = unknown>(): Promise<TResult> => ({}) as TResult

    const network = createNetworkDomain({
      state,
      getTargetTab: async () => {
        throw new Error('not used in this test')
      },
      sendRawDebuggerCommand: emptyDebuggerCommand,
      sendDebuggerCommand: emptyDebuggerCommand,
    })

    const result = network.stopHar() as {
      recording: boolean
      startedAt: string | null
      stoppedAt: string
      requestCount: number
      har: {
        log: {
          version: string
          creator: { name: string; version: string }
          entries: Array<{
            request: { url: string; method: string }
            response: { status: number; content: { text?: string } }
          }>
        }
      }
    }

    expect(result.recording).toBe(false)
    expect(result.startedAt).toBe('2026-04-20T15:00:00.000Z')
    expect(result.stoppedAt.length).toBeGreaterThan(0)
    expect(result.requestCount).toBe(2)
    expect(result.har.log.version).toBe('1.2')
    expect(result.har.log.creator).toEqual({
      name: 'autobrowser',
      version: '0.1.0',
    })
    expect(result.har.log.entries).toHaveLength(2)
    expect(result.har.log.entries.map((entry) => entry.request.url)).toEqual([
      'https://example.com/first',
      'https://example.com/second',
    ])
    expect(result.har.log.entries[0]).toMatchObject({
      request: {
        method: 'POST',
        url: 'https://example.com/first',
      },
      response: {
        status: 201,
        content: {
          text: '{"ok":true}',
        },
      },
    })
    expect(state.network.harRecording).toBe(false)
    expect(state.network.harStartedAt).toBeNull()
  })

  test('truncates large request and response bodies before storing them', async () => {
    const state = createExtensionState(57978)
    const bigText = 'x'.repeat(300_000)
    const sendCalls: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = []

    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 } as never),
      sendRawDebuggerCommand: async <TResult = unknown>(
        tabId: number,
        method: string,
        params: Record<string, unknown> = {},
      ): Promise<TResult> => {
        sendCalls.push({ tabId, method, params })

        if (method === 'Network.getResponseBody') {
          return { body: bigText, base64Encoded: false } as TResult
        }

        return {} as TResult
      },
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    })

    await network.handleEvent(
      { tabId: 1 },
      'Network.requestWillBeSent',
      {
        requestId: 'req-1',
        request: {
          url: 'https://example.com/big',
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          postData: bigText,
        },
        type: 'Document',
        timestamp: 100,
        wallTime: 100,
      },
    )

    await network.handleEvent(
      { tabId: 1 },
      'Network.responseReceived',
      {
        requestId: 'req-1',
        response: {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          mimeType: 'application/json',
        },
        timestamp: 101,
      },
    )

    await network.handleEvent(
      { tabId: 1 },
      'Network.loadingFinished',
      {
        requestId: 'req-1',
        timestamp: 102,
        encodedDataLength: bigText.length,
      },
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendCalls.some((call) => call.method === 'Network.getResponseBody')).toBeTrue()

    const detail = network.getRequestDetail('1:req-1') as {
      request: {
        postData?: string
        postDataTruncated?: boolean
        postDataBytes?: number
        responseBody?: string
        responseBodyTruncated?: boolean
        responseBodyBytes?: number
      }
      summary: { requestBodyTruncated?: boolean; responseBodyTruncated?: boolean }
      harEntry: {
        request: { postData?: { text?: string; comment?: string } }
        response: { content: { text?: string; comment?: string } }
      }
    }

    expect(detail.request.postDataTruncated).toBeTrue()
    expect(detail.request.responseBodyTruncated).toBeTrue()
    expect(detail.request.postDataBytes).toBeGreaterThan(detail.request.postData?.length || 0)
    expect(detail.request.responseBodyBytes).toBeGreaterThan(detail.request.responseBody?.length || 0)
    expect(detail.summary.requestBodyTruncated).toBeTrue()
    expect(detail.summary.responseBodyTruncated).toBeTrue()
    expect(detail.harEntry.request.postData?.comment).toContain('truncated by autobrowser')
    expect(detail.harEntry.response.content.comment).toContain('truncated by autobrowser')
    expect(detail.harEntry.response.content.text?.length || 0).toBeLessThan(bigText.length)
  })
})
