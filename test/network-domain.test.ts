import { describe, expect, spyOn, test } from 'bun:test'
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

    const detail = (await network.getRequestDetail('1:req-1')) as {
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

    expect(sendCalls.some((call) => call.method === 'Network.getResponseBody')).toBeFalse()

    const detail = (await network.getRequestDetail('1:req-1')) as {
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

    const detail = (await network.getRequestDetail('1:req-q')) as {
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

    const detail = (await network.getRequestDetail('1:req-plain')) as {
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

describe('network redirect hops', () => {
  function harness(maxRequests: number | null = null, deferredBody = false) {
    const state = createExtensionState(57978)
    state.network.harMaxRequests = maxRequests
    let resolveBody!: (body: { body: string }) => void
    const body = new Promise<{ body: string }>((resolve) => {
      resolveBody = resolve
    })
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendDebuggerCommand: async () => ({}) as never,
      sendRawDebuggerCommand: async () =>
        (deferredBody ? await body : { body: 'final body' }) as never,
    })
    const request = async (
      url: string,
      timestamp: number,
      redirectResponse?: Record<string, unknown>,
      tabId = 1,
    ) => {
      await network.handleEvent({ tabId }, 'Network.requestWillBeSent', {
        requestId: 'chain',
        timestamp,
        request: {
          url,
          method: redirectResponse ? 'GET' : 'POST',
          ...(redirectResponse ? {} : { postData: 'original=body' }),
        },
        redirectResponse,
      })
    }
    const checkIndexes = () => {
      expect(state.network.requestMap.size).toBe(state.network.requests.length)
      expect(state.network.requestIndex.size).toBe(state.network.requests.length)
      state.network.requests.forEach((record, index) => {
        expect(state.network.requestMap.get(record.id!)).toBe(record)
        expect(state.network.requestIndex.get(record.id!)).toBe(index)
      })
    }
    return { state, network, request, resolveBody, checkIndexes }
  }

  const moved = {
    status: 301,
    statusText: 'Moved Permanently',
    headers: { Location: '/middle' },
    mimeType: 'text/html',
    protocol: 'h2',
    timing: { sendStart: 1, sendEnd: 1.01, receiveHeadersEnd: 1.1 },
  }
  const found = {
    status: 302,
    statusText: 'Found',
    headers: { location: '/start' },
    mimeType: 'text/plain',
    protocol: 'http/1.1',
  }

  test('archives 301 -> 302 -> 200 including repeated URLs, fresh GET state and complete HAR', async () => {
    const { state, network, request, resolveBody, checkIndexes } = harness(null, true)
    await network.startHar(1, { maxRequests: null })
    await request('https://example.com/start', 100)
    await request('https://example.com/middle', 101, moved)
    expect((await network.getRequestDetail('chain')).request).toMatchObject({
      id: '1:chain',
      method: 'GET',
    })
    expect((await network.getRequestDetail('chain')).request).not.toHaveProperty('status')
    expect(
      ((await network.getRequestDetail('chain')).request as Record<string, unknown>).postData,
    ).toBeUndefined()
    await request('https://example.com/start', 102, found)
    checkIndexes()
    const [first, second, current] = state.network.requests
    expect(new Set(state.network.requests.map((record) => record.id)).size).toBe(3)
    expect(state.network.requests.map((record) => record.requestId)).toEqual([
      'chain',
      'chain',
      'chain',
    ])
    expect(first).toMatchObject({
      status: 301,
      postData: 'original=body',
      durationMs: 1000,
      protocol: 'h2',
      timing: moved.timing,
      responseMimeType: 'text/html',
    })
    expect(second).toMatchObject({ status: 302, durationMs: 1000 })
    expect(current?.id).toBe('1:chain')
    expect(current?.responseBody).toBeUndefined()
    expect((await network.getRequestDetail(first!.id!)).request).toBe(first)
    expect((await network.getRequestDetail(second!.id!, 1)).request).toBe(second)
    expect((await network.getRequestDetail('chain', 1)).request).toBe(current)
    expect((await network.getRequestDetail('1:chain')).request).toBe(current)
    await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'chain',
      timestamp: 103,
      response: { status: 200, statusText: 'OK', mimeType: 'text/plain' },
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'chain',
      timestamp: 104,
    })
    // 模拟同毫秒收到全部事件，验证排序不依赖随机归档 id。
    for (const record of state.network.requests) record.startedAt = state.network.harStartedAt
    const stopping = network.stopHar()
    expect(state.network.pendingBodyFetches.size).toBe(1)
    resolveBody({ body: 'final body' })
    const result = (await stopping) as {
      har: {
        log: {
          entries: Array<{
            request: { url: string; method: string; postData?: unknown }
            response: {
              status: number
              redirectURL: string
              content: { text?: string }
              httpVersion: string
            }
            time: number
          }>
        }
      }
    }
    const entries = result.har.log.entries
    expect(entries.map((entry) => entry.response.status)).toEqual([301, 302, 200])
    expect(entries.map((entry) => entry.request.url)).toEqual([
      'https://example.com/start',
      'https://example.com/middle',
      'https://example.com/start',
    ])
    expect(entries.map((entry) => entry.response.redirectURL)).toEqual(['/middle', '/start', ''])
    expect(entries.map((entry) => entry.response.content.text)).toEqual([
      undefined,
      undefined,
      'final body',
    ])
    expect(entries.map((entry) => entry.time)).toEqual([1000, 1000, 2000])
    expect(entries[0]?.response.httpVersion).toBe('HTTP/2')
    expect(entries[1]?.request.postData).toBeUndefined()
    expect(entries[2]?.request.postData).toBeUndefined()
    expect(state.network.pendingBodyFetches.size).toBe(0)
    expect(state.network.inFlightByTab.get(1)?.size).toBe(0)
    checkIndexes()
  })

  test('raw ids select the current hop but retain cross-tab ambiguity', async () => {
    const { network, request } = harness()
    await request('https://example.com/start', 100)
    await request('https://example.com/middle', 101, moved)
    await request('https://other.example/start', 100, undefined, 2)
    await expect(network.getRequestDetail('chain')).rejects.toThrow('ambiguous across tabs')
    expect((await network.getRequestDetail('chain', 1)).request).toMatchObject({
      id: '1:chain',
      url: 'https://example.com/middle',
    })
    expect((await network.getRequestDetail('2:chain')).request).toMatchObject({ tabId: 2 })
  })

  test('maxRequests trims archived hops without breaking current lookup or indexes', async () => {
    const { state, network, request, checkIndexes } = harness(2)
    await request('https://example.com/start', 100)
    await request('https://example.com/middle', 101, moved)
    const evictedId = state.network.requests[0]!.id!
    await request('https://example.com/start', 102, found)
    checkIndexes()
    expect(state.network.requests.map((record) => record.status)).toEqual([302, undefined])
    await expect(network.getRequestDetail(evictedId)).rejects.toThrow('not found')
    expect((await network.getRequestDetail('chain')).request).toMatchObject({
      id: '1:chain',
      url: 'https://example.com/start',
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'chain',
      timestamp: 103,
    })
    await network.stopHar()
    expect((await network.getRequestDetail('chain')).request).toMatchObject({
      responseBody: 'final body',
    })
    checkIndexes()
  })

  test('repeated redirect loops keep distinct hop ids after trimming', async () => {
    const { state, network, request, checkIndexes } = harness(2)
    await request('https://example.com/start', 100)
    const ids = new Set<string>()
    for (let hop = 1; hop <= 12; hop += 1) {
      await request('https://example.com/start', 100 + hop, moved)
      const archivedId = state.network.requests[0]!.id!
      expect(ids.has(archivedId)).toBe(false)
      ids.add(archivedId)
      expect((await network.getRequestDetail('chain')).request).toMatchObject({ id: '1:chain' })
      checkIndexes()
    }
    expect(ids.size).toBe(12)
  })

  for (const terminal of ['Network.loadingFinished', 'Network.loadingFailed']) {
    test(`late events for trimmed requests do not evict retained hops (${terminal})`, async () => {
      const { state, network, request, checkIndexes } = harness(1)
      await request('https://example.com/old', 100)
      await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
        requestId: 'new',
        request: { url: 'https://example.com/new' },
      })
      await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
        requestId: 'chain',
        response: { status: 200 },
      })
      await network.handleEvent({ tabId: 1 }, terminal, { requestId: 'chain' })
      expect(state.network.requests.map((record) => record.id)).toEqual(['1:new'])
      expect(state.network.inFlightByTab.get(1)?.has('chain')).toBe(false)
      expect(state.network.pendingBodyFetches.size).toBe(0)
      checkIndexes()
    })
  }

  for (const reject of [false, true]) {
    test(`trimmed pending body cannot resurrect an evicted record (${reject ? 'failure' : 'success'})`, async () => {
      const state = createExtensionState(57978)
      state.network.harRecording = true
      state.network.harMaxRequests = 1
      let finish!: () => void
      const pending = new Promise<{ body: string }>((resolve, rejectBody) => {
        finish = () => (reject ? rejectBody(new Error('evicted')) : resolve({ body: 'old' }))
      })
      const network = createNetworkDomain({
        state,
        getTargetTab: async () => ({ id: 1 }) as never,
        sendDebuggerCommand: async () => ({}) as never,
        sendRawDebuggerCommand: async () => (await pending) as never,
      })
      await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
        requestId: 'old',
        request: { url: 'https://example.com/old' },
      })
      await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'old' })
      await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
        requestId: 'new',
        request: { url: 'https://example.com/new' },
      })
      finish()
      await network.stopHar()
      expect(state.network.requests.map((record) => record.id)).toEqual(['1:new'])
      expect([...state.network.requestMap.keys()]).toEqual(['1:new'])
      expect([...state.network.requestIndex.entries()]).toEqual([['1:new', 0]])
    })
  }
})

describe('network body scheduler', () => {
  function harness() {
    const state = createExtensionState(57978)
    const calls: Array<{
      tabId: number
      requestId: string
      resolve: (body: { body: string }) => void
      reject: (error: Error) => void
    }> = []
    const stored: Record<string, unknown> = {}
    const network = createNetworkDomain({
      state,
      getTargetTab: async (tabId) => ({ id: Number(tabId || 1) }) as never,
      sendDebuggerCommand: async () => ({}) as never,
      sendRawDebuggerCommand: async <TResult = unknown>(
        tabId: number,
        method: string,
        params?: Record<string, unknown>,
      ): Promise<TResult> => {
        expect(method).toBe('Network.getResponseBody')
        return (await new Promise<{ body: string }>((resolve, reject) => {
          calls.push({ tabId, requestId: String(params?.requestId), resolve, reject })
        })) as TResult
      },
      storageLocalSet: async (items) => {
        Object.assign(stored, items)
      },
      storageLocalGet: async (key) => ({ [key]: stored[key] }),
    })
    const request = async (requestId: string, tabId = 1, finish = true) => {
      await network.handleEvent({ tabId }, 'Network.requestWillBeSent', {
        requestId,
        request: { url: `https://example.com/${requestId}` },
      })
      if (finish) await network.handleEvent({ tabId }, 'Network.loadingFinished', { requestId })
    }
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    }
    return { state, network, calls, stored, request, flush }
  }

  test('metadata remains automatic without HAR; detail lazily fetches and deduplicates body', async () => {
    const { state, network, calls, request } = harness()
    await request('lazy')
    expect(calls).toHaveLength(0)
    expect(network.listRequests()).toMatchObject({ total: 1 })
    expect(state.network.inFlightByTab.get(1)?.size).toBe(0)
    const first = network.getRequestDetail('lazy')
    const second = network.getRequestDetail('lazy')
    expect(calls).toHaveLength(1)
    calls[0]!.resolve({ body: 'on demand' })
    expect((await first).request).toMatchObject({ responseBody: 'on demand' })
    expect((await second).request).toMatchObject({ responseBody: 'on demand' })
    await network.getRequestDetail('lazy')
    expect(calls).toHaveLength(1)
  })

  test('historical pages, unfinished requests and CDP failures explain missing bodies', async () => {
    const { state, network, calls, request } = harness()
    await request('old')
    state.targeting.pageEpochs.set(1, 2)
    expect((await network.getRequestDetail('old')).request).toMatchObject({
      responseBodyError: expect.stringContaining('historical page epoch'),
    })
    expect(calls).toHaveLength(0)
    await request('loading', 1, false)
    expect((await network.getRequestDetail('loading')).request).toMatchObject({
      responseBodyError: expect.stringContaining('not finished'),
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'loading' })
    const detail = network.getRequestDetail('loading')
    calls[0]!.reject(new Error('No resource with given identifier found'))
    const result = await detail
    expect(result.request).toMatchObject({
      responseBodyError: 'No resource with given identifier found',
    })
    expect(result.harEntry).toMatchObject({
      response: { content: { comment: expect.stringContaining('body unavailable') } },
    })
  })

  test('HAR and detail share four real CDP slots and release them only on settle', async () => {
    const { network, calls, request, flush } = harness()
    await network.startHar(1)
    for (let i = 0; i < 6; i += 1) await request(`r${i}`)
    await request('detail', 2)
    const detail = network.getRequestDetail('detail', 2)
    expect(calls).toHaveLength(4)
    calls[0]!.resolve({ body: 'zero' })
    await flush()
    expect(calls).toHaveLength(5)
    calls[1]!.reject(new Error('one failed'))
    await flush()
    expect(calls).toHaveLength(6)
    calls[2]!.resolve({ body: 'two' })
    await flush()
    expect(calls).toHaveLength(7)
    for (const call of calls.slice(3)) call.resolve({ body: 'rest' })
    await detail
    expect(await network.stopHar()).toMatchObject({ requestCount: 6 })
  })

  test('stop waits only its capture and excludes unrelated tab detail and post-stop metadata', async () => {
    const { network, calls, request } = harness()
    await network.startHar(1)
    await request('own')
    await request('other', 2)
    expect(calls).toHaveLength(1)
    const detail = network.getRequestDetail('other', 2)
    const stopped = network.stopHar()
    await request('after-stop')
    expect(calls).toHaveLength(2)
    calls[0]!.resolve({ body: 'own body' })
    const result = await stopped
    expect(result).toMatchObject({ requestCount: 1 })
    expect(result.har).toMatchObject({
      log: { entries: [{ response: { content: { text: 'own body' } } }] },
    })
    calls[1]!.resolve({ body: 'other body' })
    await detail
  })

  test('old stop keeps its records and limits; same-key new capture and checkpoint stay isolated', async () => {
    const { state, network, calls, request, stored } = harness()
    await network.startHar(1, { maxRequests: 10, maxBodyBytes: 3 })
    await request('same')
    const oldRecord = state.network.requestMap.get('1:same')!
    const oldStop = network.stopHar()
    await network.startHar(1, { maxRequests: 20, maxBodyBytes: 8 })
    await request('same')
    calls[0]!.resolve({ body: 'old content' })
    const oldResult = await oldStop
    expect(oldRecord.responseBody).toBe('old')
    expect(oldResult.har).toMatchObject({
      log: { entries: [{ response: { content: { text: 'old' } } }] },
    })
    expect(state.network.harRecording).toBe(true)
    expect(state.network.harMaxBodyBytes).toBe(8)
    expect(state.network.requestMap.get('1:same')?.responseBody).toBeUndefined()
    expect(stored['autobrowser.harCheckpoint']).toMatchObject({ recording: true, maxBodyBytes: 8 })
    calls[1]!.resolve({ body: 'new content' })
    const newResult = await network.stopHar()
    expect(newResult).toMatchObject({ requestCount: 1 })
    expect(newResult.har).toMatchObject({
      log: { entries: [{ response: { content: { text: 'new cont' } } }] },
    })
  })

  test('starting a new capture without stop excludes old pending work and late loadingFinished', async () => {
    const { state, network, calls, request } = harness()
    await request('before-capture', 1, false)
    await network.startHar(1, { maxBodyBytes: 2 })
    await request('old')
    await request('old-unfinished', 1, false)
    const oldRecord = state.network.requestMap.get('1:old')!
    await network.startHar(2, { maxBodyBytes: 7 })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'old-unfinished',
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'before-capture',
    })
    await request('new', 2)
    expect(calls).toHaveLength(2)
    calls[1]!.resolve({ body: 'new content' })
    const result = await network.stopHar()
    expect(result).toMatchObject({ requestCount: 1 })
    expect(result.har).toMatchObject({
      log: { entries: [{ response: { content: { text: 'new con' } } }] },
    })
    expect(state.network.pendingBodyFetches.size).toBe(1)
    calls[0]!.resolve({ body: 'old content' })
    await Promise.all(state.network.pendingBodyFetches)
    expect(oldRecord.responseBody).toBe('ol')
  })

  test('queued evictions skip CDP and active evictions never resurrect records', async () => {
    const { state, network, calls, request, flush } = harness()
    await network.startHar(1, { maxRequests: 5 })
    for (let i = 0; i < 10; i += 1) await request(`r${i}`)
    expect(calls).toHaveLength(4)
    for (const call of calls.slice()) call.resolve({ body: 'evicted' })
    await flush()
    expect(calls.map((call) => call.requestId)).not.toContain('r4')
    expect(state.network.requests.map((record) => record.id)).toEqual([
      '1:r5',
      '1:r6',
      '1:r7',
      '1:r8',
      '1:r9',
    ])
    for (const call of calls.slice(4)) call.resolve({ body: 'retained' })
    await flush()
    for (const call of calls.slice(8)) call.resolve({ body: 'retained' })
    await network.stopHar()
    expect(state.network.requests.every((record) => record.responseBody === 'retained')).toBe(true)
  })

  test('redirect archives never fetch the next hop body, including queued stale work', async () => {
    const { state, network, calls, request, flush } = harness()
    await network.startHar(1)
    for (let i = 0; i < 4; i += 1) await request(`busy${i}`)
    await request('chain')
    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'chain',
      request: { url: 'https://example.com/next' },
      redirectResponse: { status: 302, headers: { location: '/next' } },
    })
    const archived = state.network.requests.find((record) => record.redirectArchived)!
    expect((await network.getRequestDetail(archived.id!)).request).toMatchObject({
      responseBodyError: expect.stringContaining('redirect hop'),
    })
    for (const call of calls) call.resolve({ body: 'busy' })
    await flush()
    expect(calls).toHaveLength(4)
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'chain' })
    expect(calls).toHaveLength(5)
    calls[4]!.resolve({ body: 'next hop' })
    await network.stopHar()
    expect(archived.responseBody).toBeUndefined()
    expect(state.network.requestMap.get('1:chain')?.responseBody).toBe('next hop')
  })

  test('queue is capped at 1000; logical timeout bounds stop without freeing stuck CDP slots', async () => {
    const timers: Array<() => void> = []
    const original = globalThis.setTimeout
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      if (delay === 10_000) {
        timers.push(callback)
        return original(() => {}, 60_000)
      }
      return original(callback, delay)
    }) as typeof setTimeout)
    try {
      const { state, network, calls, request, flush } = harness()
      await network.startHar(1, { maxRequests: null })
      for (let i = 0; i < 1005; i += 1) await request(`r${i}`)
      expect(calls).toHaveLength(4)
      expect(state.network.pendingBodyFetches.size).toBe(1004)
      expect(state.network.requestMap.get('1:r1004')?.responseBodyError).toContain('queue is full')
      const stopped = network.stopHar()
      for (const timeout of timers.slice()) timeout()
      expect((await stopped).requestCount).toBe(1005)
      expect(state.network.pendingBodyFetches.size).toBe(0)
      expect(calls).toHaveLength(4)
      expect(state.network.requestMap.get('1:r0')?.responseBodyError).toContain('timed out')
      await network.startHar(1, { maxRequests: null })
      await request('new')
      expect(calls).toHaveLength(4)
      const detail = network.getRequestDetail('r0')
      await detail
      expect(calls).toHaveLength(4)
      calls[0]!.resolve({ body: 'late discarded' })
      await flush()
      expect(calls).toHaveLength(5)
      expect(calls[4]?.requestId).toBe('new')
      expect(state.network.requestMap.get('1:r0')?.responseBody).toBeUndefined()
      for (const call of calls.slice(1)) call.resolve({ body: 'done' })
      await network.stopHar()
    } finally {
      timerSpy.mockRestore()
    }
  })
})
