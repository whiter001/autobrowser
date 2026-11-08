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
    const started = await network.startHar(1)
    const captureId = started.captureId as string
    expect(captureId).toBeString()
    expect(captureId.length).toBeGreaterThan(0)
    expect(await network.getHarStatus()).toMatchObject({
      captureId,
      captureTabId: 1,
      captureRequestCount: 0,
      requestCount: 1,
      checkpoint: { captureId, available: true, recoverable: false, requestCount: 0 },
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
    expect(await network.stopHar({ captureId })).toMatchObject({
      captureId,
      captureTabId: 1,
      checkpoint: { saved: true },
    })
    expect(await network.getHarStatus()).toMatchObject({ recording: false, captureId })

    const recreated = createNetworkDomain({
      state: createExtensionState(57978),
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async () => ({}) as never,
      sendDebuggerCommand: async () => ({}) as never,
      ...storage,
    })
    expect(await recreated.getHarStatus()).toMatchObject({
      captureId: null,
      checkpoint: {
        captureId,
        available: true,
        recoverable: true,
        captureTabId: 1,
        requestCount: 1,
      },
    })
    const recovered = await recreated.recoverHar()
    expect(recovered).toMatchObject({
      captureId,
      recovered: true,
      captureTabId: 1,
      requestCount: 1,
    })
    expect(recovered.startedAt).toBeString()
    expect(recovered.har).toBeObject()
  })

  test('guarded stop rejects stale IDs without changing recording and returns ordered unique URLs', async () => {
    const state = createExtensionState(57978)
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async () => ({}) as never,
      sendDebuggerCommand: async () => ({}) as never,
    })
    const old = await network.startHar(1)
    const { captureId } = (await network.startHar(1, { maxRequests: 3 })) as { captureId: string }
    for (const [index, url] of ['excluded', 'b', 'a', 'b'].entries()) {
      await network.handleEvent({ tabId: 1 }, 'Network.requestWillBeSent', {
        requestId: `r${index}`,
        request: { url: `https://example.com/${url}`, method: 'GET' },
      })
    }
    await expect(network.stopHar({ captureId: old.captureId as string })).rejects.toThrow(
      'does not match',
    )
    expect(await network.getHarStatus()).toMatchObject({
      recording: true,
      captureId,
      captureRequestCount: 3,
    })
    const result = await network.stopHar({ captureId, includeUrls: true })
    expect(result).toMatchObject({
      recording: false,
      captureId,
      requestCount: 3,
      urls: ['https://example.com/b', 'https://example.com/a'],
    })
    await expect(network.stopHar({ captureId })).rejects.toThrow('not recording')
    expect((await network.stopHar()).urls).toBeUndefined()
  })

  test('unknown and legacy checkpoint capture IDs remain null', async () => {
    const network = createNetworkDomain({
      state: createExtensionState(57978),
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async () => ({}) as never,
      sendDebuggerCommand: async () => ({}) as never,
      storageLocalGet: async (key) => ({ [key]: { requests: [{ url: 'https://example.com/' }] } }),
    })
    expect(await network.getHarStatus()).toMatchObject({
      captureId: null,
      checkpoint: { captureId: null },
    })
    expect(await network.recoverHar()).toMatchObject({ captureId: null })
    expect(await network.stopHar()).toMatchObject({ captureId: null })
  })

  test('legacy recording state does not expose a fabricated capture ID', async () => {
    const state = createExtensionState(57978)
    state.network.harRecording = true
    const stored: Record<string, unknown> = {}
    const network = createNetworkDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      sendRawDebuggerCommand: async () => ({}) as never,
      sendDebuggerCommand: async () => ({}) as never,
      storageLocalSet: async (items) => {
        Object.assign(stored, items)
      },
    })
    expect(await network.getHarStatus()).toMatchObject({ recording: true, captureId: null })
    await expect(network.stopHar({ captureId: 'unknown' })).rejects.toThrow('does not match')
    expect(state.network.harRecording).toBe(true)
    expect(await network.stopHar()).toMatchObject({ captureId: null })
    expect(stored['autobrowser.harCheckpoint']).toMatchObject({ captureId: null })
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
      bodyCapture: { degraded: false, reason: null },
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
