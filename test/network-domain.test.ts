import { describe, expect, test } from 'bun:test'
import { createNetworkDomain } from '../extension/background/network.js'
import { createExtensionState } from '../extension/background/state.js'

describe('network domain HAR export', () => {
  test('stopHar returns a complete HAR payload without extra round trips', async () => {
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

    const result = (await network.stopHar()) as {
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

  test('stopHar waits for in-flight response body fetches before exporting', async () => {
    const state = createExtensionState(57978)
    state.network.harRecording = true
    state.network.harStartedAt = '2026-04-20T15:00:00.000Z'

    let resolveBody: ((value: { body: string; base64Encoded: boolean }) => void) | null = null
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      // getResponseBody 挂起直到测试手动放行，模拟 stop 时 body 抓取仍在飞行中
      sendRawDebuggerCommand: async <TResult = unknown>(
        _tabId: number,
        method: string,
      ): Promise<TResult> => {
        if (method === 'Network.getResponseBody') {
          return (await new Promise<{ body: string; base64Encoded: boolean }>((resolve) => {
            resolveBody = resolve
          })) as TResult
        }
        return {} as TResult
      },
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    })

    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'req-1',
      request: { url: 'https://example.com/slow', method: 'GET', headers: {} },
      type: 'XHR',
      timestamp: 100,
      wallTime: 100,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-1',
      timestamp: 101,
      encodedDataLength: 10,
    })

    const stopPromise = network.stopHar() as Promise<{
      har: { log: { entries: Array<{ response: { content: { text?: string } } }> } }
    }>
    // body 未放行前 stopHar 必须保持等待
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.network.pendingBodyFetches.size).toBe(1)

    resolveBody!({ body: '{"slow":true}', base64Encoded: false })
    const result = await stopPromise
    expect(result.har.log.entries[0]?.response.content.text).toBe('{"slow":true}')
    expect(state.network.pendingBodyFetches.size).toBe(0)
  })

  test('respects unlimited HAR limits during capture', async () => {
    const state = createExtensionState(57978)
    const bigText = 'x'.repeat(300_000)

    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    })

    await network.startHar(1, { maxRequests: null, maxBodyBytes: null })

    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
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
    })

    await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'req-1',
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
      },
      timestamp: 101,
    })

    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-1',
      timestamp: 102,
      encodedDataLength: bigText.length,
    })

    const detail = network.getRequestDetail('1:req-1') as {
      request: {
        postData?: string
        postDataTruncated?: boolean
        responseBodyTruncated?: boolean
      }
    }

    expect(state.network.harMaxRequests).toBeNull()
    expect(state.network.harMaxBodyBytes).toBeNull()
    expect(detail.request.postDataTruncated).toBeFalse()
    expect(detail.request.responseBodyTruncated).toBeFalse()
    expect(detail.request.postData).toBe(bigText)
  })

  test('truncates large request and response bodies before storing them', async () => {
    const state = createExtensionState(57978)
    const bigText = 'x'.repeat(300_000)
    const sendCalls: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = []

    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
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

    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
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
    })

    await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'req-1',
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
      },
      timestamp: 101,
    })

    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-1',
      timestamp: 102,
      encodedDataLength: bigText.length,
    })

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
    expect(detail.request.responseBodyBytes).toBeGreaterThan(
      detail.request.responseBody?.length || 0,
    )
    expect(detail.summary.requestBodyTruncated).toBeTrue()
    expect(detail.summary.responseBodyTruncated).toBeTrue()
    expect(detail.harEntry.request.postData?.comment).toContain('truncated by autobrowser')
    expect(detail.harEntry.response.content.comment).toContain('truncated by autobrowser')
    expect(detail.harEntry.response.content.text?.length || 0).toBeLessThan(bigText.length)
  })
})

describe('network domain routes', () => {
  function createRouteHarness() {
    const state = createExtensionState(57978)
    const sendCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const recordCall = async <TResult = unknown>(
      _tabId: number,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<TResult> => {
      sendCalls.push({ method, params })
      return {} as TResult
    }

    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: recordCall,
      sendDebuggerCommand: recordCall,
    })

    return { state, network, sendCalls }
  }

  test('routeRequest 存储自定义 mock 参数，listRoutes 原样返回', async () => {
    const { network } = createRouteHarness()

    await network.routeRequest(1, '/api/user', {
      body: { id: 1 },
      status: 201,
      contentType: 'application/vnd.api+json',
      headers: { 'x-mock': 'yes' },
    })

    const listed = network.listRoutes() as {
      routes: Array<{
        id: string
        pattern: string
        abort: boolean
        body?: unknown
        status?: number
        contentType?: string
        headers?: Record<string, string>
        createdAt?: string
      }>
    }
    expect(listed.routes).toHaveLength(1)
    expect(listed.routes[0]).toMatchObject({
      pattern: '/api/user',
      abort: false,
      body: { id: 1 },
      status: 201,
      contentType: 'application/vnd.api+json',
      headers: { 'x-mock': 'yes' },
    })
    expect(typeof listed.routes[0]?.id).toBe('string')
    expect(typeof listed.routes[0]?.createdAt).toBe('string')
  })

  test('mock 响应使用自定义 status/content-type/headers  fulfill 请求', async () => {
    const { network, sendCalls } = createRouteHarness()

    await network.routeRequest(1, '/api/user', {
      body: { id: 1 },
      status: 404,
      contentType: 'text/plain',
      headers: { 'x-mock': 'yes' },
    })

    await network.handleRequestPaused(1, {
      requestId: 'req-1',
      request: { url: 'https://example.com/api/user', method: 'GET', headers: {} },
    })

    const fulfill = sendCalls.find((call) => call.method === 'Fetch.fulfillRequest')
    expect(fulfill).toBeDefined()
    expect(fulfill?.params?.responseCode).toBe(404)
    expect(fulfill?.params?.responsePhrase).toBe('Not Found')
    const headers = fulfill?.params?.responseHeaders as Array<{ name: string; value: string }>
    // 显式 header 追加到响应头，默认 content-type 被 --content-type 覆盖
    expect(headers).toContainEqual({ name: 'content-type', value: 'text/plain' })
    expect(headers).toContainEqual({ name: 'x-mock', value: 'yes' })
  })

  test('mock 默认仍是 200 + application/json', async () => {
    const { network, sendCalls } = createRouteHarness()

    await network.routeRequest(1, '/api/user', { body: { ok: true } })

    await network.handleRequestPaused(1, {
      requestId: 'req-1',
      request: { url: 'https://example.com/api/user', method: 'GET', headers: {} },
    })

    const fulfill = sendCalls.find((call) => call.method === 'Fetch.fulfillRequest')
    expect(fulfill?.params?.responseCode).toBe(200)
    const headers = fulfill?.params?.responseHeaders as Array<{ name: string; value: string }>
    expect(headers).toEqual([{ name: 'content-type', value: 'application/json; charset=utf-8' }])
  })

  test('removeHeaders 的 route 删除指定请求头后放行', async () => {
    const { network, sendCalls } = createRouteHarness()

    await network.routeRequest(1, '/api/', { removeHeaders: ['Authorization', 'X-Debug'] })

    await network.handleRequestPaused(1, {
      requestId: 'req-2',
      request: {
        url: 'https://example.com/api/list',
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-debug': '1', Accept: '*/*' },
      },
    })

    const continued = sendCalls.find((call) => call.method === 'Fetch.continueRequest')
    expect(continued).toBeDefined()
    // 头名大小写不敏感，删除后只剩 Accept
    expect(continued?.params?.headers).toEqual([{ name: 'Accept', value: '*/*' }])
    expect(sendCalls.some((call) => call.method === 'Fetch.fulfillRequest')).toBeFalse()
  })

  test('无 removeHeaders 的 route 仍按原样放行', async () => {
    const { network, sendCalls } = createRouteHarness()

    await network.routeRequest(1, '/api/', {})

    await network.handleRequestPaused(1, {
      requestId: 'req-3',
      request: { url: 'https://example.com/api/list', method: 'GET', headers: { Accept: '*/*' } },
    })

    const continued = sendCalls.find((call) => call.method === 'Fetch.continueRequest')
    expect(continued).toBeDefined()
    expect(continued?.params?.headers).toBeUndefined()
  })
})
