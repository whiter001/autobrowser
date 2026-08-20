import { describe, expect, test } from 'bun:test'
import { createNetworkDomain } from '../extension/background/network.js'
import { createExtensionState } from '../extension/background/state.js'

describe('network domain HAR export', () => {
  test('recovers a checkpoint after the network domain is recreated', async () => {
    const stored: Record<string, unknown> = {}
    const storage = {
      storageLocalSet: async (items: Record<string, unknown>) => {
        Object.assign(stored, items)
      },
      storageLocalGet: async (key: string) => ({ [key]: stored[key] }),
    }
    const state = createExtensionState(57978)
    state.network.requests.push({
      id: '1:old',
      requestId: 'old',
      tabId: 1,
      url: 'https://example.com/old',
      startedAt: '2000-01-01T00:00:00.000Z',
    })
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async () => ({}) as never,
      sendDebuggerCommand: async () => ({}) as never,
      ...storage,
    })
    await network.startHar(1)
    state.network.requests.push({
      id: '1:r1',
      requestId: 'r1',
      tabId: 1,
      url: 'https://example.com/api',
      method: 'GET',
      status: 200,
      startedAt: new Date().toISOString(),
    })
    await network.stopHar()

    const recovered = await createNetworkDomain({
      state: createExtensionState(57978),
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async () => ({}) as never,
      sendDebuggerCommand: async () => ({}) as never,
      ...storage,
    }).recoverHar()
    expect(recovered).toMatchObject({ recovered: true, requestCount: 1 })
    expect(recovered.startedAt).toBeString()
    expect(recovered.har).toBeObject()
  })

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

  test('stopHar checkpoints active capture limits before resetting them', async () => {
    const stored: Record<string, unknown> = {}
    const state = createExtensionState(57978)
    state.network.harRecording = true
    state.network.harStartedAt = '2026-04-20T15:00:00.000Z'
    state.network.harMaxRequests = null
    state.network.harMaxBodyBytes = null

    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      storageLocalSet: async (items: Record<string, unknown>) => {
        Object.assign(stored, items)
      },
      storageLocalGet: async (key: string) => ({ [key]: stored[key] }),
    })

    await network.stopHar()

    const checkpoint = stored['autobrowser.harCheckpoint'] as {
      recording: boolean
      maxRequests: number | null
      maxBodyBytes: number | null
    }
    expect(checkpoint).toMatchObject({
      recording: false,
      maxRequests: null,
      maxBodyBytes: null,
    })
    expect(state.network.harMaxRequests as number | null).toBe(1000)
    expect(state.network.harMaxBodyBytes as number | null).toBe(256 * 1024)
  })

  test('stopHar still exports HAR when checkpoint storage fails', async () => {
    const state = createExtensionState(57978)
    state.network.harRecording = true
    state.network.harStartedAt = '2026-04-20T15:00:00.000Z'
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      storageLocalSet: async () => {
        throw new Error('Resource::kQuotaBytes quota exceeded')
      },
    })

    const result = (await network.stopHar()) as {
      har?: unknown
      checkpoint?: { saved?: boolean; error?: string }
      suggestedAction?: string
    }

    expect(result.har).toBeTruthy()
    expect(result.checkpoint).toMatchObject({
      saved: false,
      error: 'Resource::kQuotaBytes quota exceeded',
    })
    expect(result.suggestedAction).toContain('HAR export succeeded')
    expect(state.network.harRecording).toBe(false)
    expect(state.network.harMaxRequests).toBe(1000)
    expect(state.network.harMaxBodyBytes).toBe(256 * 1024)
  })

  test('stopHar exports HAR with a body error comment when CDP body fetch exceeds quota', async () => {
    const state = createExtensionState(57978)
    state.network.harRecording = true
    state.network.harStartedAt = '2026-04-20T15:00:00.000Z'

    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async <TResult = unknown>(
        _tabId: number,
        method: string,
      ): Promise<TResult> => {
        if (method === 'Network.getResponseBody') {
          throw new Error('Resource::kQuotaBytes quota exceeded')
        }
        return {} as TResult
      },
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    })

    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'req-quota',
      request: { url: 'https://example.com/big.js', method: 'GET', headers: {} },
      type: 'Script',
      timestamp: 100,
      wallTime: 100,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-quota',
      timestamp: 101,
      encodedDataLength: 300000,
    })

    const result = (await network.stopHar()) as {
      har: { log: { entries: Array<{ response: { content: { comment?: string } } }> } }
    }

    expect(result.har.log.entries[0]?.response.content.comment).toContain(
      'Resource::kQuotaBytes quota exceeded',
    )
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

describe('network domain request list pagination', () => {
  function createListHarness() {
    const state = createExtensionState(57978)
    state.network.requests = [
      {
        id: '1:r1',
        requestId: 'r1',
        tabId: 1,
        url: 'https://example.com/api/a',
        method: 'GET',
        status: 200,
        resourceType: 'xhr',
      },
      {
        id: '1:r2',
        requestId: 'r2',
        tabId: 1,
        url: 'https://example.com/api/b',
        method: 'GET',
        status: 404,
        resourceType: 'xhr',
      },
      {
        id: '1:r3',
        requestId: 'r3',
        tabId: 1,
        url: 'https://example.com/static/c.css',
        method: 'GET',
        status: 200,
        resourceType: 'stylesheet',
      },
      {
        id: '2:r4',
        requestId: 'r4',
        tabId: 2,
        url: 'https://other.com/api/d',
        method: 'POST',
        status: 201,
        resourceType: 'fetch',
      },
    ]
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => {
        throw new Error('not used in this test')
      },
      sendRawDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    })
    return { network }
  }

  test('paginates after filters with pageIdx/pageSize and reports hasNextPage', () => {
    const { network } = createListHarness()

    const result = network.listRequests({ filter: '/api/', pageSize: 1, pageIdx: 1 }) as {
      total: number
      requests: Array<{ id: string }>
      pagination: Record<string, unknown>
    }

    // 过滤先于分页：/api/ 只命中 r1/r2/r4 三条，第二页是 r2
    expect(result.total).toBe(3)
    expect(result.requests.map((request) => request.id)).toEqual(['1:r2'])
    expect(result.pagination).toEqual({
      currentPage: 1,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
      startIndex: 1,
      endIndex: 2,
      invalidPage: false,
    })
  })

  test('falls back to the first page with invalidPage for an out-of-range pageIdx', () => {
    const { network } = createListHarness()

    const result = network.listRequests({ filter: '/api/', pageSize: 1, pageIdx: 9 }) as {
      requests: Array<{ id: string }>
      pagination: Record<string, unknown>
    }

    expect(result.requests.map((request) => request.id)).toEqual(['1:r1'])
    expect(result.pagination).toMatchObject({
      currentPage: 0,
      invalidPage: true,
    })
  })

  test('defaults to the first page with the default page size', () => {
    const { network } = createListHarness()

    const result = network.listRequests({}) as {
      total: number
      requests: Array<{ id: string }>
      pagination: Record<string, unknown>
    }

    expect(result.total).toBe(4)
    expect(result.requests).toHaveLength(4)
    expect(result.pagination).toMatchObject({
      currentPage: 0,
      totalPages: 1,
      invalidPage: false,
    })
  })

  test('suggests all-tabs and all-epochs when the default request list is empty', () => {
    const state = createExtensionState(57978)
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => {
        throw new Error('not used in this test')
      },
      sendRawDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    })

    const result = network.listRequests({}) as {
      total: number
      meta?: { suggestedAction?: string }
    }

    expect(result.total).toBe(0)
    expect(result.meta?.suggestedAction).toContain('--all-tabs --all-epochs')
    expect(network.listRequests({ allTabs: true })).not.toHaveProperty('meta')
  })

  test('filters request lists by target tab and keeps details opt-in', () => {
    const { network } = createListHarness()
    const filtered = network.listRequests({ tabId: 2 }) as {
      total: number
      requests: Array<Record<string, unknown>>
    }
    expect(filtered.total).toBe(1)
    expect(filtered.requests[0]).toMatchObject({ id: '2:r4', tabId: 2 })
    expect(filtered.requests[0]).not.toHaveProperty('requestHeaders')
    expect(filtered.requests[0]).not.toHaveProperty('responseBody')
  })
})

describe('network domain HAR field completion', () => {
  function createHarHarness() {
    const state = createExtensionState(57978)
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => {
        throw new Error('not used in this test')
      },
      sendRawDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    })
    return { state, network }
  }

  test('buildHarEntry maps queryString, protocol httpVersion, and ResourceTiming phases', async () => {
    const { network } = createHarHarness()

    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'req-q',
      request: {
        url: 'https://example.com/search?q=hello&page=2',
        method: 'GET',
        headers: {},
      },
      type: 'XHR',
      timestamp: 100,
      wallTime: 100,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'req-q',
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
        protocol: 'h2',
        // ResourceTiming 各阶段相对 requestTime 的秒数偏移
        timing: {
          requestTime: 1.0,
          dnsStart: 1.001,
          dnsEnd: 1.01,
          connectStart: 1.01,
          connectEnd: 1.05,
          sslStart: 1.05,
          sslEnd: 1.08,
          sendStart: 1.09,
          sendEnd: 1.1,
          receiveHeadersEnd: 1.2,
        },
      },
      timestamp: 101,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-q',
      timestamp: 102,
      encodedDataLength: 10,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const detail = network.getRequestDetail('1:req-q') as {
      harEntry: {
        time: number
        request: {
          url: string
          httpVersion: string
          queryString: Array<{ name: string; value: string }>
        }
        response: { httpVersion: string }
        timings: Record<string, number>
      }
    }

    // queryString 从 URL 的 query 参数解析
    expect(detail.harEntry.request.queryString).toEqual([
      { name: 'q', value: 'hello' },
      { name: 'page', value: '2' },
    ])
    // protocol 字段（h2）映射为 HAR 惯例的 HTTP/2
    expect(detail.harEntry.request.httpVersion).toBe('HTTP/2')
    expect(detail.harEntry.response.httpVersion).toBe('HTTP/2')
    // blocked = connectStart - requestTime；wait = receiveHeadersEnd - sendEnd（DevTools 同款近似）
    expect(detail.harEntry.timings).toEqual({
      blocked: 10,
      dns: 9,
      connect: 40,
      ssl: 30,
      send: 10,
      wait: 100,
      receive: 1000,
    })
    // time = loadingFinished(102) - requestWillBeSent(100) = 2000ms
    expect(detail.harEntry.time).toBe(2000)
  })

  test('keeps the legacy timings shape and HTTP/1.1 fallback when timing is missing', async () => {
    const { network } = createHarHarness()

    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'req-plain',
      request: { url: 'https://example.com/plain', method: 'GET', headers: {} },
      type: 'XHR',
      timestamp: 200,
      wallTime: 200,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'req-plain',
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        mimeType: 'text/plain',
      },
      timestamp: 201,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-plain',
      timestamp: 202,
      encodedDataLength: 5,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const detail = network.getRequestDetail('1:req-plain') as {
      harEntry: {
        request: { httpVersion: string; queryString: unknown[] }
        timings: Record<string, number>
      }
    }

    // 无 timing 时保持旧形状（send/wait/receive），httpVersion 回退 HTTP/1.1
    expect(detail.harEntry.request.httpVersion).toBe('HTTP/1.1')
    expect(detail.harEntry.request.queryString).toEqual([])
    expect(detail.harEntry.timings).toEqual({
      send: 0,
      wait: 1000,
      receive: 1000,
    })
  })
})
