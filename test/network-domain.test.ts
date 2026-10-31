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
    expect(await network.startHar(1)).toMatchObject({ captureTabId: 1 })
    expect(await network.getHarStatus()).toMatchObject({
      captureTabId: 1,
      captureRequestCount: 0,
      requestCount: 1,
      checkpoint: { available: true, recoverable: false, requestCount: 0 },
    })
    state.network.requests.push({
      id: '1:r1',
      requestId: 'r1',
      tabId: 1,
      url: 'https://example.com/api',
      method: 'GET',
      status: 200,
      startedAt: new Date().toISOString(),
    })
    expect(await network.stopHar()).toMatchObject({
      captureTabId: 1,
      checkpoint: { saved: true },
    })

    const recreated = createNetworkDomain({
      state: createExtensionState(57978),
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async () => ({}) as never,
      sendDebuggerCommand: async () => ({}) as never,
      ...storage,
    })
    expect(await recreated.getHarStatus()).toMatchObject({
      checkpoint: { available: true, recoverable: true, captureTabId: 1, requestCount: 1 },
    })
    const recovered = await recreated.recoverHar()
    expect(recovered).toMatchObject({ recovered: true, captureTabId: 1, requestCount: 1 })
    expect(recovered.startedAt).toBeString()
    expect(recovered.har).toBeObject()
  })

  test('capture include and exclude patterns filter HAR without deleting global history', async () => {
    const state = createExtensionState(57978)
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async () => ({}) as never,
      sendDebuggerCommand: async () => ({}) as never,
    })
    expect(
      await network.startHar(1, {
        includePattern: 'video.twimg.com',
        excludePattern: '/audio/',
      }),
    ).toMatchObject({ includePattern: 'video.twimg.com', excludePattern: '/audio/' })

    const urls = [
      'https://video.twimg.com/video/1.m4s',
      'https://video.twimg.com/audio/1.m4s',
      'https://example.com/page.js',
    ]
    for (const [index, url] of urls.entries()) {
      await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
        requestId: `r${index}`,
        request: { url, method: 'GET', headers: {} },
      })
    }

    const result = (await network.stopHar()) as {
      requestCount: number
      har: { log: { entries: Array<{ request: { url: string } }> } }
    }
    expect(result.requestCount).toBe(1)
    expect(result.har.log.entries.map((entry) => entry.request.url)).toEqual([urls[0]])
    expect(state.network.requests.map((record) => record.url)).toEqual(urls)
    expect(network.listRequests({ allTabs: true, allEpochs: true })).toMatchObject({ total: 3 })
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
    expect(await network.getHarStatus()).toMatchObject({
      checkpoint: {
        available: false,
        recoverable: false,
        error: 'Resource::kQuotaBytes quota exceeded',
      },
    })
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

describe('network domain fetch interception', () => {
  const URL_A = 'https://example.com/api/user'

  function createInterceptionHarness(options: { deferFulfill?: boolean } = {}) {
    const state = createExtensionState(57978)
    const sendCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const fulfillGates: Array<() => void> = []
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async <TResult = unknown>(
        _tabId: number,
        method: string,
        params?: Record<string, unknown>,
      ): Promise<TResult> => {
        sendCalls.push({ method, params })
        // 挂起 fulfill：模拟 CDP 命令发出到返回之间又来了别的事件
        if (options.deferFulfill && method === 'Fetch.fulfillRequest') {
          await new Promise<void>((resolve) => fulfillGates.push(resolve))
        }
        return {} as TResult
      },
      sendDebuggerCommand: async <TResult = unknown>(): Promise<TResult> => ({}) as TResult,
    })

    const releaseFulfill = () => {
      for (const open of fulfillGates.splice(0)) open()
    }

    const sendNetworkRequest = (request: {
      requestId: string
      url?: string
      method?: string
      postData?: string
      headers?: Record<string, string>
      timestamp?: number
      redirectResponse?: Record<string, unknown>
    }) =>
      network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
        requestId: request.requestId,
        request: {
          url: request.url || URL_A,
          method: request.method || 'POST',
          headers: request.headers ?? {},
          ...(request.postData === undefined ? {} : { postData: request.postData }),
        },
        ...(request.redirectResponse ? { redirectResponse: request.redirectResponse } : {}),
        type: 'XHR',
        timestamp: request.timestamp ?? 100,
        wallTime: 100,
      })

    const pauseFetch = (request: {
      requestId: string
      networkId?: string
      redirectedRequestId?: string
      url?: string
      method?: string
      postData?: string
      headers?: Record<string, string>
      timestamp?: number
    }) =>
      network.handleRequestPaused(1, {
        requestId: request.requestId,
        redirectedRequestId: request.redirectedRequestId,
        ...(request.networkId === undefined ? {} : { networkId: request.networkId }),
        resourceType: 'XHR',
        request: {
          url: request.url || URL_A,
          method: request.method || 'POST',
          headers: request.headers ?? {},
          ...(request.postData === undefined ? {} : { postData: request.postData }),
        },
        timestamp: request.timestamp ?? 100,
      })

    return { state, network, sendCalls, sendNetworkRequest, pauseFetch, releaseFulfill }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  test('Network 先到时，Fetch 事件不覆盖已记录的时间戳/请求头/请求体', async () => {
    const { state, network, sendCalls, sendNetworkRequest, pauseFetch } =
      createInterceptionHarness()

    await sendNetworkRequest({
      requestId: 'net-1',
      postData: 'network=1',
      headers: { 'content-type': 'application/json', 'x-network': 'yes' },
      timestamp: 100,
    })
    const startedAt = state.network.requests[0]?.startedAt
    await pauseFetch({
      requestId: 'int-1',
      networkId: 'net-1',
      postData: 'fetch=1',
      headers: { 'content-type': 'application/json' },
      timestamp: 100.5,
    })

    expect(state.network.requests).toHaveLength(1)
    expect(state.network.requests[0]).toMatchObject({
      id: '1:net-1',
      requestId: 'net-1',
      startedAt,
      requestWillBeSentAt: 100,
      postData: 'network=1',
      requestHeaders: { 'content-type': 'application/json', 'x-network': 'yes' },
    })
    // Fetch.* 只能用它自己的 requestId
    expect(sendCalls.at(-1)).toEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: 'int-1' },
    })
    expect(network.listRequests()).toMatchObject({ total: 1 })
  })

  test('Fetch 先到时用 networkId 建记录，随后的 Network 事件并入同一对象并补齐缺失字段', async () => {
    const { state, network, sendNetworkRequest, pauseFetch } = createInterceptionHarness()

    await pauseFetch({
      requestId: 'int-2',
      networkId: 'net-2',
      postData: 'a=1',
      headers: { 'x-fetch': '1' },
      timestamp: 99,
    })
    const created = state.network.requests[0]
    expect(created).toMatchObject({ id: '1:net-2', requestId: 'net-2', postData: 'a=1' })

    await sendNetworkRequest({ requestId: 'net-2', headers: {}, timestamp: 100 })

    expect(state.network.requests).toHaveLength(1)
    // 同一个对象：异步 body 抓取、route 决策都不会因换 key 而丢失
    expect(state.network.requests[0]).toBe(created)
    expect(created).toMatchObject({
      postData: 'a=1',
      requestHeaders: { 'x-fetch': '1' },
      requestWillBeSentAt: 100,
      startedAt: created?.startedAt,
    })
    expect(network.listRequests()).toMatchObject({ total: 1 })
  })

  test('CDP 复用同一个 id 时，拦截记录不会写进已结束的旧记录', async () => {
    const { state, network, sendNetworkRequest, pauseFetch } = createInterceptionHarness()

    await sendNetworkRequest({
      requestId: 'net-r',
      postData: 'old=1',
      headers: { 'x-old': '1' },
      timestamp: 100,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'net-r',
      timestamp: 101,
    })
    const finished = state.network.requests[0]

    await pauseFetch({
      requestId: 'int-r',
      networkId: 'net-r',
      postData: 'new=1',
      headers: { 'x-new': '1' },
      timestamp: 200,
    })

    expect(state.network.requests).toHaveLength(1)
    expect(state.network.requests[0]).not.toBe(finished)
    expect(state.network.requests[0]).toMatchObject({
      id: '1:net-r',
      postData: 'new=1',
      requestHeaders: { 'x-new': '1' },
    })
    expect(finished).toMatchObject({ postData: 'old=1', requestHeaders: { 'x-old': '1' } })
  })

  test('没有 networkId 时回退用 Fetch 的 requestId 建记录', async () => {
    const { state, sendCalls, pauseFetch } = createInterceptionHarness()

    await pauseFetch({ requestId: 'int-9', headers: { 'x-fetch': '1' } })

    expect(state.session.downloads).toHaveLength(0)
    expect(state.network.requests).toHaveLength(1)
    expect(state.network.requests[0]).toMatchObject({ id: '1:int-9', requestId: 'int-9' })
    expect(sendCalls.find((call) => call.method === 'Fetch.continueRequest')?.params).toEqual({
      requestId: 'int-9',
    })
  })

  const ORDERS = ['network-first', 'fetch-first'] as const
  const ROUTES = [
    { kind: 'continue', route: { body: undefined }, method: 'Fetch.continueRequest', status: 200 },
    { kind: 'mock', route: { body: { ok: true } }, method: 'Fetch.fulfillRequest', status: 200 },
    { kind: 'abort', route: { abort: true }, method: 'Fetch.failRequest', status: 0 },
  ] as const

  for (const order of ORDERS) {
    for (const routeCase of ROUTES) {
      test(`${order} 的 ${routeCase.kind} 路由在 HAR 里只留一条记录`, async () => {
        const { state, network, sendCalls, sendNetworkRequest, pauseFetch } =
          createInterceptionHarness()

        await network.routeRequest(1, '/api/user', { ...routeCase.route })
        await network.startHar(1)

        const fetchEvent = {
          requestId: 'int-a',
          networkId: 'net-a',
          postData: 'a=1',
          headers: { 'x-fetch': '1' },
        }
        const networkEvent = {
          requestId: 'net-a',
          postData: 'a=1',
          headers: { 'x-network': '1' },
        }
        // 真正按顺序触发：两个 handler 都是 async，先调用就已经开始建立记录
        if (order === 'network-first') {
          await sendNetworkRequest(networkEvent)
          await pauseFetch(fetchEvent)
        } else {
          await pauseFetch(fetchEvent)
          await sendNetworkRequest(networkEvent)
        }

        const intercepted = sendCalls.find((call) => call.method === routeCase.method)
        // 拦截命令必须用 Fetch 自己的 requestId，不能用 networkId
        expect(intercepted?.params?.requestId).toBe('int-a')

        if (routeCase.kind === 'mock') {
          await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'net-a',
            response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json' },
            timestamp: 101,
          })
        }
        if (routeCase.kind === 'abort') {
          await network.handleEvent({ tabId: 1 }, 'Network.loadingFailed', {
            requestId: 'net-a',
            errorText: 'net::ERR_FAILED',
          })
        }
        if (routeCase.kind === 'continue') {
          await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'net-a',
            response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json' },
            timestamp: 101,
          })
          await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
            requestId: 'net-a',
            timestamp: 102,
            encodedDataLength: 10,
          })
        }

        const result = (await network.stopHar()) as {
          requestCount: number
          har: {
            log: {
              entries: Array<{
                request: { url: string }
                response: { status: number; content: { text?: string } }
              }>
            }
          }
        }

        expect(state.network.requests).toHaveLength(1)
        expect(result.requestCount).toBe(1)
        expect(result.har.log.entries).toHaveLength(1)
        expect(result.har.log.entries[0]?.request.url).toBe(URL_A)
        expect(result.har.log.entries[0]?.response.status).toBe(routeCase.status)
        // mock 响应不会被后续 Network 事件清掉
        expect(result.har.log.entries[0]?.response.content.text).toBe(
          routeCase.kind === 'mock' ? '{\n  "ok": true\n}\n' : undefined,
        )
      })
    }
  }

  test('HAR 窗口上限不淘汰全局记录，迟到的 mock 回写仍落在原记录上', async () => {
    const { state, network, sendCalls, pauseFetch, sendNetworkRequest, releaseFulfill } =
      createInterceptionHarness({ deferFulfill: true })
    state.network.harMaxRequests = 1
    await network.routeRequest(1, '/api/user', { body: { mocked: true } })

    const paused = pauseFetch({ requestId: 'int-m', networkId: 'net-m' })
    await flush()
    expect(state.network.requests.map((record) => record.id)).toEqual(['1:net-m'])

    // harMaxRequests 只约束 capture 导出窗口，新请求只追加，不挤出旧记录
    await sendNetworkRequest({ requestId: 'net-other', url: 'https://example.com/other' })
    expect(state.network.requests.map((record) => record.id)).toEqual(['1:net-m', '1:net-other'])

    releaseFulfill()
    await paused

    expect(sendCalls.some((call) => call.method === 'Fetch.fulfillRequest')).toBeTrue()
    expect(state.network.requests.map((record) => record.id)).toEqual(['1:net-m', '1:net-other'])
    expect(state.network.requestMap.get('1:net-m')?.status).toBe(200)
    expect(state.network.requestMap.size).toBe(2)
  })

  test('mock 回写晚到时不污染复用同一 networkId 的新代次记录', async () => {
    const { state, network, pauseFetch, sendNetworkRequest, releaseFulfill } =
      createInterceptionHarness({ deferFulfill: true })
    await network.routeRequest(1, '/api/old', { body: { mocked: true } })

    const paused = pauseFetch({
      requestId: 'int-1',
      networkId: 'net-x',
      url: 'https://example.com/api/old',
    })
    await flush()
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'net-x',
      timestamp: 101,
    })
    // 同一 networkId 被复用到一个新请求（URL/方法都不同）
    await pauseFetch({
      requestId: 'int-2',
      networkId: 'net-x',
      url: 'https://example.com/api/new',
      method: 'GET',
    })
    await sendNetworkRequest({
      requestId: 'net-x',
      url: 'https://example.com/api/new',
      method: 'GET',
    })

    const current = state.network.requests[0]
    expect(state.network.requests).toHaveLength(1)
    expect(current).toMatchObject({
      id: '1:net-x',
      url: 'https://example.com/api/new',
      method: 'GET',
    })

    releaseFulfill()
    await paused

    expect(state.network.requests[0]).toBe(current)
    expect(current.status).toBeUndefined()
    expect(current.responseBody).toBeUndefined()
  })

  for (const order of ORDERS) {
    for (const sameUrl of [true, false]) {
      for (const deferFulfill of [false, true]) {
        test(`${order} redirect ${sameUrl ? '同' : '不同'} URL 保留每跳身份（延迟 mock=${deferFulfill}）`, async () => {
          const { state, network, pauseFetch, sendNetworkRequest, releaseFulfill, sendCalls } =
            createInterceptionHarness({ deferFulfill })
          const firstUrl = 'https://example.com/same'
          const nextUrl = sameUrl ? firstUrl : 'https://example.com/next'
          await sendNetworkRequest({ requestId: 'chain', url: firstUrl, method: 'GET' })
          await pauseFetch({
            requestId: 'fetch-first',
            networkId: 'chain',
            url: firstUrl,
            method: 'GET',
          })
          const { route } = await network.routeRequest(1, nextUrl, {
            body: 'NEXT_HOP',
            status: 201,
          })
          const redirect = () =>
            sendNetworkRequest({
              requestId: 'chain',
              url: nextUrl,
              method: 'GET',
              timestamp: 101,
              redirectResponse: {
                status: 302,
                statusText: 'Found',
                headers: { location: nextUrl },
              },
            })
          if (order === 'network-first') await redirect()
          const paused = pauseFetch({
            requestId: 'fetch-next',
            redirectedRequestId: 'fetch-first',
            networkId: 'chain',
            url: nextUrl,
            method: 'GET',
          })
          const current = state.network.requestMap.get('1:chain')
          if (!current) throw new Error('Expected current redirect hop in requestMap')
          if (!deferFulfill) await paused
          if (order === 'fetch-first') await redirect()
          releaseFulfill()
          await paused

          expect(state.network.requests).toHaveLength(2)
          const [previous, next] = state.network.requests
          expect(next).toBe(current)
          expect(previous).toMatchObject({
            url: firstUrl,
            method: 'GET',
            status: 302,
            routeAction: 'continue',
            routeId: null,
            redirectArchived: true,
            hopSequence: 0,
          })
          expect(previous?.responseBody).toBeUndefined()
          expect(next).toMatchObject({
            id: '1:chain',
            url: nextUrl,
            method: 'GET',
            status: 201,
            routeAction: 'mock',
            routeId: route.id,
            responseBody: 'NEXT_HOP',
            hopSequence: 1,
          })
          expect(next?.redirectArchived).toBeUndefined()
          expect(
            sendCalls.find((call) => call.method === 'Fetch.fulfillRequest')?.params?.requestId,
          ).toBe('fetch-next')
          expect(state.network.requestMap.size).toBe(2)
          expect(state.network.requestIndex.size).toBe(2)
          state.network.requests.forEach((record, index) => {
            expect(state.network.requestMap.get(record.id!)).toBe(record)
            expect(state.network.requestIndex.get(record.id!)).toBe(index)
          })
        })
      }
    }
    for (const fragments of [
      ['#fetch', ''],
      ['', '#network'],
      ['#fetch', '#network'],
    ]) {
      test(`${order} fragment ${JSON.stringify(fragments)} 不丢 mock、不改对外 URL、不重复记录`, async () => {
        const { state, network, pauseFetch, sendNetworkRequest } = createInterceptionHarness()
        await network.routeRequest(1, '/api/user', { body: 'FRAGMENT_MOCK' })
        const fetchUrl = URL_A + fragments[0]
        const networkUrl = URL_A + fragments[1]
        const fetch = () =>
          pauseFetch({ requestId: 'fetch-fragment', networkId: 'fragment', url: fetchUrl })
        const sent = () => sendNetworkRequest({ requestId: 'fragment', url: networkUrl })
        if (order === 'network-first') await sent()
        else await fetch()
        const original = state.network.requests[0]
        if (order === 'network-first') await fetch()
        else await sent()
        expect(state.network.requests).toHaveLength(1)
        expect(state.network.requests[0]).toBe(original)
        expect(original).toMatchObject({
          url: order === 'network-first' ? networkUrl : fetchUrl,
          status: 200,
          routeAction: 'mock',
          responseBody: 'FRAGMENT_MOCK',
        })
        expect(state.network.requestMap.size).toBe(1)
        expect(state.network.requestMap.get('1:fragment')).toBe(original)
        expect([...state.network.requestIndex.entries()]).toEqual([['1:fragment', 0]])
      })
    }
  }

  test('redirect 下一跳的 Fetch 事件先到时不并入上一跳记录', async () => {
    const { state, network, pauseFetch, sendNetworkRequest } = createInterceptionHarness()
    await network.routeRequest(1, '/api/new', { body: { mocked: true } })
    await network.startHar(1)

    await sendNetworkRequest({
      requestId: 'chain',
      url: 'https://example.com/api/old',
      method: 'POST',
      postData: 'a=1',
      timestamp: 100,
    })
    // 第一跳同样被 Fetch 拦截（无路由命中 → 放行），确保它的 route 决策不丢
    await pauseFetch({
      requestId: 'int-1',
      networkId: 'chain',
      url: 'https://example.com/api/old',
      method: 'POST',
      postData: 'a=1',
      timestamp: 100,
    })
    // 下一跳先被 Fetch 拦截命中 mock，之后才收到它的 requestWillBeSent
    await pauseFetch({
      requestId: 'int-2',
      networkId: 'chain',
      url: 'https://example.com/api/new',
      method: 'GET',
    })
    await sendNetworkRequest({
      requestId: 'chain',
      url: 'https://example.com/api/new',
      method: 'GET',
      timestamp: 101,
      redirectResponse: {
        status: 302,
        statusText: 'Found',
        headers: { location: '/api/new' },
        mimeType: 'text/plain',
      },
    })

    expect(state.network.requests).toHaveLength(2)
    const [previousHop, currentHop] = state.network.requests
    expect(previousHop).toMatchObject({
      url: 'https://example.com/api/old',
      method: 'POST',
      postData: 'a=1',
      status: 302,
      routeAction: 'continue',
    })
    expect(previousHop?.responseBody).toBeUndefined()
    expect(currentHop).toMatchObject({
      id: '1:chain',
      url: 'https://example.com/api/new',
      method: 'GET',
      status: 200,
      routeAction: 'mock',
    })
    expect(String(currentHop?.responseBody)).toContain('mocked')

    const result = (await network.stopHar()) as {
      har: { log: { entries: Array<{ response: { status: number; content: { text?: string } } }> } }
    }
    expect(result.har.log.entries.map((entry) => entry.response.status)).toEqual([302, 200])
  })

  test('中断请求的残留拦截标记不会吞掉同 networkId 的新代次', async () => {
    const { state, network, pauseFetch, sendNetworkRequest } = createInterceptionHarness()
    await network.routeRequest(1, '/api/old', { abort: true })

    await pauseFetch({
      requestId: 'int-a',
      networkId: 'chain',
      url: 'https://example.com/api/old',
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFailed', {
      requestId: 'chain',
      errorText: 'net::ERR_ABORTED',
    })
    expect(state.network.requests[0]).toMatchObject({
      routeAction: 'abort',
      errorText: 'net::ERR_ABORTED',
    })

    // 新代次只带来了 requestWillBeSent，没有对应的 Fetch 事件
    await sendNetworkRequest({
      requestId: 'chain',
      url: 'https://example.com/api/new',
      method: 'GET',
      timestamp: 200,
    })

    expect(state.network.requests).toHaveLength(1)
    expect(state.network.requests[0]).toMatchObject({
      id: '1:chain',
      url: 'https://example.com/api/new',
      method: 'GET',
    })
    expect(state.network.requests[0]).not.toHaveProperty('errorText')
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
    return { network, state }
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

  test('lists the newest request first when sort=newest without touching stored order', () => {
    const { network, state } = createListHarness()

    const first = network.listRequests({ sort: 'newest', pageSize: 2 }) as {
      total: number
      requests: Array<{ id: string }>
      pagination: Record<string, unknown>
    }
    // newest 在过滤之后、分页之前反转：第一页是最新两条，total 仍是过滤后的总数
    expect(first.total).toBe(4)
    expect(first.requests.map((request) => request.id)).toEqual(['2:r4', '1:r3'])
    expect(first.pagination).toEqual({
      currentPage: 0,
      totalPages: 2,
      hasNextPage: true,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: 2,
      invalidPage: false,
    })

    const second = network.listRequests({ sort: 'newest', pageSize: 2, pageIdx: 1 }) as {
      total: number
      requests: Array<{ id: string }>
      pagination: Record<string, unknown>
    }
    expect(second.total).toBe(4)
    expect(second.requests.map((request) => request.id)).toEqual(['1:r2', '1:r1'])
    expect(second.pagination).toMatchObject({ currentPage: 1, hasNextPage: false })

    // 与过滤组合时先过滤再反转
    expect(
      (
        network.listRequests({ sort: 'newest', filter: '/api/' }) as {
          requests: Array<{ id: string }>
        }
      ).requests.map((request) => request.id),
    ).toEqual(['2:r4', '1:r2', '1:r1'])

    // 排序只影响返回结果，不改变已存储的记录顺序
    expect(state.network.requests.map((request) => request.id)).toEqual([
      '1:r1',
      '1:r2',
      '1:r3',
      '2:r4',
    ])
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
        // CDP ResourceTiming：requestTime 是秒基准，其余字段已是相对请求开始的毫秒偏移
        timing: {
          requestTime: 1_700_000_000.123,
          dnsStart: 1,
          dnsEnd: 10,
          connectStart: 10,
          connectEnd: 50,
          sslStart: 50,
          sslEnd: 80,
          sendStart: 90,
          sendEnd: 100,
          receiveHeadersEnd: 200,
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
    // 阶段值本身就是毫秒偏移：blocked 取首个有效偏移，阶段差直接相减（不再乘 1000）
    expect(detail.harEntry.timings).toEqual({
      blocked: 1,
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

  test('marks ResourceTiming phases that CDP did not report as -1', async () => {
    const { network } = createHarHarness()

    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'req-partial',
      request: { url: 'https://example.com/partial', method: 'GET', headers: {} },
      type: 'XHR',
      timestamp: 100,
      wallTime: 100,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'req-partial',
      response: {
        status: 200,
        headers: {},
        mimeType: 'application/json',
        // 只有请求起点可用，其余阶段（以及 sendEnd 之前的收尾时间）都缺失
        timing: { requestTime: 1_700_000_000.5, sendStart: 90 },
      },
      timestamp: 101,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-partial',
      timestamp: 102,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const detail = (await network.getRequestDetail('1:req-partial')) as {
      harEntry: { timings: Record<string, number> }
    }

    // 缺失阶段用 HAR 的 -1 表示不可用，不伪造 0；
    // wait/receive 仍可退回事件时间戳近似（responseReceived 101 → loadingFinished 102）
    expect(detail.harEntry.timings).toEqual({
      blocked: 90,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: -1,
      wait: 1000,
      receive: 1000,
    })
  })

  test('ignores out-of-order ResourceTiming phases instead of clamping them', async () => {
    const { network } = createHarHarness()

    await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'req-broken',
      request: { url: 'https://example.com/broken', method: 'GET', headers: {} },
      type: 'XHR',
      timestamp: 100,
      wallTime: 100,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'req-broken',
      response: {
        status: 200,
        headers: {},
        mimeType: 'text/plain',
        // dnsEnd 早于 dnsStart：属于不可用数据，不能算成 0
        timing: {
          requestTime: 1_700_000_000.5,
          dnsStart: 40,
          dnsEnd: 10,
          sendStart: 90,
          sendEnd: 100,
          receiveHeadersEnd: 200,
        },
      },
      timestamp: 101,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-broken',
      timestamp: 102,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const detail = (await network.getRequestDetail('1:req-broken')) as {
      harEntry: { timings: Record<string, number> }
    }

    expect(detail.harEntry.timings).toMatchObject({ blocked: 40, dns: -1, send: 10, wait: 100 })
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
    // CDP ResourceTiming：毫秒偏移（requestTime 为秒基准）
    timing: { requestTime: 1_700_000_000, sendStart: 1, sendEnd: 11, receiveHeadersEnd: 110 },
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

  test('maxRequests 只限制 capture 导出窗口，全局历史与旧记录查询不受影响', async () => {
    const { state, network, request, checkIndexes } = harness()
    await network.startHar(1, { maxRequests: 2 })
    await request('https://example.com/start', 100)
    await request('https://example.com/middle', 101, moved)
    const firstId = state.network.requests[0]!.id!
    await request('https://example.com/start', 102, found)
    checkIndexes()
    // 全局缓冲保留全部 3 跳，旧记录仍可按 id 查到
    expect(state.network.requests.map((record) => record.status)).toEqual([301, 302, undefined])
    expect((await network.getRequestDetail(firstId)).request).toMatchObject({
      id: firstId,
      status: 301,
    })
    await network.handleEvent({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'chain',
      timestamp: 103,
      response: { status: 200, statusText: 'OK', mimeType: 'text/plain' },
    })
    await network.handleEvent({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'chain',
      timestamp: 104,
    })
    const result = (await network.stopHar()) as {
      requestCount: number
      har: { log: { entries: Array<{ response: { status: number } }> } }
    }
    // 导出只取窗口内最新 2 条
    expect(result.requestCount).toBe(2)
    expect(result.har.log.entries.map((entry) => entry.response.status)).toEqual([302, 200])
    expect(state.network.requests).toHaveLength(3)
    expect((await network.getRequestDetail(firstId)).request).toMatchObject({ status: 301 })
    checkIndexes()
  })

  test('repeated redirect loops keep distinct hop ids', async () => {
    const { state, network, request, checkIndexes } = harness()
    await request('https://example.com/start', 100)
    const ids = new Set<string>()
    for (let hop = 1; hop <= 12; hop += 1) {
      await request('https://example.com/start', 100 + hop, moved)
      // 归档记录就地替换上一跳，再追加新的当前跳
      const archivedId = state.network.requests.at(-2)!.id!
      expect(ids.has(archivedId)).toBe(false)
      ids.add(archivedId)
      expect((await network.getRequestDetail('chain')).request).toMatchObject({ id: '1:chain' })
      checkIndexes()
    }
    expect(ids.size).toBe(12)
    expect(state.network.requests).toHaveLength(13)
  })

  for (const terminal of ['Network.loadingFinished', 'Network.loadingFailed']) {
    test(`窗口外请求的迟到事件不破坏全局历史与导出窗口 (${terminal})`, async () => {
      const { state, network, request, checkIndexes } = harness()
      await network.startHar(1, { maxRequests: 1 })
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
      // 窗口外的记录留在全局历史里，不会被 HAR 上限淘汰
      expect(state.network.requests.map((record) => record.id)).toEqual(['1:chain', '1:new'])
      expect(state.network.inFlightByTab.get(1)?.has('chain')).toBe(false)
      checkIndexes()
      const result = (await network.stopHar()) as {
        requestCount: number
        har: { log: { entries: Array<{ request: { url: string } }> } }
      }
      expect(result.requestCount).toBe(1)
      expect(result.har.log.entries.map((entry) => entry.request.url)).toEqual([
        'https://example.com/new',
      ])
    })
  }

  for (const reject of [false, true]) {
    test(`窗口外请求的 pending body 仍写回全局记录 (${reject ? 'failure' : 'success'})`, async () => {
      const state = createExtensionState(57978)
      state.network.harRecording = true
      state.network.harMaxRequests = 1
      let finish!: () => void
      const pending = new Promise<{ body: string }>((resolve, rejectBody) => {
        finish = () => (reject ? rejectBody(new Error('cdp failed')) : resolve({ body: 'old' }))
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
      const result = (await network.stopHar()) as {
        requestCount: number
        har: { log: { entries: unknown[] } }
      }
      expect(state.network.requests.map((record) => record.id)).toEqual(['1:old', '1:new'])
      expect([...state.network.requestMap.keys()]).toEqual(['1:old', '1:new'])
      expect([...state.network.requestIndex.entries()]).toEqual([
        ['1:old', 0],
        ['1:new', 1],
      ])
      expect(state.network.requestMap.get('1:old')).toMatchObject(
        reject ? { responseBodyError: 'cdp failed' } : { responseBody: 'old' },
      )
      // 全局保留两条，导出窗口只取最新一条
      expect(result.requestCount).toBe(1)
      expect(result.har.log.entries).toHaveLength(1)
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

  test('har maxRequests 不裁剪跨 tab 历史，stop 只导出窗口内最新 N 条且历史仍可查', async () => {
    const { state, network, calls, request, flush } = harness()
    // 已有多个 tab 的历史：capture 之前产生
    await request('t1-old-1', 1)
    await request('t1-old-2', 1)
    await request('t2-old-1', 2)
    const historyBefore = state.network.requests.map((record) => record.id)
    expect(historyBefore).toHaveLength(3)

    await network.startHar(1, { maxRequests: 2 })
    await request('t1-new-1', 1)
    await request('t2-new-1', 2)
    await request('t1-new-2', 1)
    await request('t1-new-3', 1)

    // 新请求只追加：全局历史一条不丢，窗口上限不参与缓冲裁剪
    expect(state.network.requests.map((record) => record.id)).toEqual([
      ...historyBefore,
      '1:t1-new-1',
      '2:t2-new-1',
      '1:t1-new-2',
      '1:t1-new-3',
    ])
    expect(network.listRequests({ allTabs: true, allEpochs: true })).toMatchObject({ total: 7 })

    // 放行所有 body 抓取，避免 stop 等待；每轮释放后可能继续 pump 出新任务
    let resolvedCalls = 0
    for (let round = 0; round < 10 && state.network.pendingBodyFetches.size > 0; round += 1) {
      for (const call of calls.slice(resolvedCalls)) call.resolve({ body: 'body' })
      resolvedCalls = calls.length
      await flush()
    }
    expect(state.network.pendingBodyFetches.size).toBe(0)

    const result = (await network.stopHar()) as {
      requestCount: number
      har: { log: { entries: Array<{ request: { url: string } }> } }
    }
    // capture 绑定 tab 1：只导出该 tab 窗口内最新 2 条
    expect(result.requestCount).toBe(2)
    expect(result.har.log.entries.map((entry) => entry.request.url).sort()).toEqual([
      'https://example.com/t1-new-2',
      'https://example.com/t1-new-3',
    ])

    // stop 之后跨 tab 历史仍完整可查
    expect(state.network.requests).toHaveLength(7)
    expect(state.network.requestMap.size).toBe(7)
    expect(network.listRequests({ allTabs: true, allEpochs: true })).toMatchObject({ total: 7 })
    expect(state.network.requestMap.get('1:t1-old-1')).toMatchObject({ id: '1:t1-old-1' })
    expect(state.network.requestMap.get('2:t2-old-1')).toMatchObject({ id: '2:t2-old-1' })
  })

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

  test('maxRequests only narrows the export window; queued body fetches keep running', async () => {
    const { state, network, calls, request, flush } = harness()
    await network.startHar(1, { maxRequests: 5 })
    for (let i = 0; i < 10; i += 1) await request(`r${i}`)
    expect(calls).toHaveLength(4)
    for (const call of calls.slice()) call.resolve({ body: 'body' })
    await flush()
    await flush()
    // 窗口外的排队抓取不再因“淘汰”被跳过
    expect(calls.map((call) => call.requestId)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
    ])
    for (const call of calls.slice(4)) call.resolve({ body: 'body' })
    await flush()
    await flush()
    expect(calls).toHaveLength(10)
    for (const call of calls.slice(8)) call.resolve({ body: 'body' })
    await flush()
    const result = (await network.stopHar()) as {
      requestCount: number
      har: { log: { entries: unknown[] } }
    }
    // 全局保留 10 条（body 都已写回），HAR 只导出窗口内最新 5 条
    expect(state.network.requests).toHaveLength(10)
    expect(state.network.requests.every((record) => record.responseBody === 'body')).toBe(true)
    expect(result.requestCount).toBe(5)
    expect(result.har.log.entries).toHaveLength(5)
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
