import { describe, expect, spyOn, test } from 'bun:test'
import { createNetworkDomain } from '../extension/background/network.js'
import { createExtensionState } from '../extension/background/state.js'

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

  test('quota exhaustion opens the body circuit, drains queued work and resets on a new capture', async () => {
    const { state, network, calls, request, flush } = harness()
    await network.startHar(1)
    for (let index = 0; index < 8; index += 1) await request(`quota-${index}`)
    expect(calls).toHaveLength(4)

    calls[0]!.reject(new Error('Resource::kQuotaBytes quota exceeded'))
    await flush()
    expect(calls).toHaveLength(4)
    expect(await network.getHarStatus()).toMatchObject({
      bodyCapture: {
        degraded: true,
        reason: 'Resource::kQuotaBytes quota exceeded',
        droppedQueued: 4,
        active: 3,
        queued: 0,
      },
    })

    for (const call of calls.slice(1)) call.resolve({ body: 'remaining' })
    await flush()
    expect(state.network.pendingBodyFetches.size).toBe(0)
    const stopped = await network.stopHar()
    expect(stopped).toMatchObject({ bodyCapture: { degraded: true, droppedQueued: 4 } })

    await network.startHar(1)
    expect(await network.getHarStatus()).toMatchObject({
      bodyCapture: { degraded: false, reason: null, droppedQueued: 0 },
    })
  })

  test('a late quota error from an old capture does not poison its replacement', async () => {
    const { network, calls, request, flush } = harness()
    await network.startHar(1)
    await request('old-capture')
    await network.startHar(1)
    calls[0]!.reject(new Error('Resource::kQuotaBytes quota exceeded'))
    await flush()

    expect(await network.getHarStatus()).toMatchObject({
      bodyCapture: { degraded: false, reason: null },
    })
  })

  test('ordinary body failures do not open the circuit', async () => {
    const { network, calls, request, flush } = harness()
    await network.startHar(1)
    await request('ordinary-error')
    calls[0]!.reject(new Error('ordinary CDP failure'))
    await flush()

    expect(await network.getHarStatus()).toMatchObject({
      bodyCapture: { degraded: false, reason: null },
    })
  })

  test('capture limits evict queued body work before it consumes another CDP slot', async () => {
    const { state, network, calls, request, flush } = harness()
    await network.startHar(1, { maxRequests: 1 })
    for (let index = 0; index < 4; index += 1) await request(`active-${index}`)
    await request('outside-window')
    await request('latest')

    expect(calls).toHaveLength(4)
    expect(state.network.requestMap.get('1:outside-window')).toMatchObject({
      responseBodyError: expect.stringContaining('outside the HAR capture request window'),
    })
    for (const call of calls.slice()) call.resolve({ body: 'active' })
    await flush()
    expect(calls.map((call) => call.requestId)).toEqual([
      'active-0',
      'active-1',
      'active-2',
      'active-3',
      'latest',
    ])
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
    const oldCapture = await network.startHar(1, { maxRequests: 10, maxBodyBytes: 3 })
    await request('same')
    const oldRecord = state.network.requestMap.get('1:same')!
    const oldStop = network.stopHar({ captureId: oldCapture.captureId as string })
    const newCapture = await network.startHar(1, { maxRequests: 20, maxBodyBytes: 8 })
    await request('same')
    calls[0]!.resolve({ body: 'old content' })
    const oldResult = await oldStop
    expect(oldResult.captureId).toBe(oldCapture.captureId)
    expect(oldRecord.responseBody).toBe('old')
    expect(oldResult.har).toMatchObject({
      log: { entries: [{ response: { content: { text: 'old' } } }] },
    })
    expect(state.network.harRecording).toBe(true)
    expect(state.network.harMaxBodyBytes).toBe(8)
    expect(state.network.requestMap.get('1:same')?.responseBody).toBeUndefined()
    expect(stored['autobrowser.harCheckpoint']).toMatchObject({
      recording: true,
      captureId: newCapture.captureId,
      maxBodyBytes: 8,
    })
    calls[1]!.resolve({ body: 'new content' })
    const newResult = await network.stopHar({ captureId: newCapture.captureId as string })
    expect(newResult).toMatchObject({ captureId: newCapture.captureId, requestCount: 1 })
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
    // 滑出窗口的排队任务直接结束，不再消耗后续 CDP 槽位。
    expect(calls.map((call) => call.requestId)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r5',
      'r6',
      'r7',
      'r8',
    ])
    for (const call of calls.slice(4)) call.resolve({ body: 'body' })
    await flush()
    await flush()
    expect(calls).toHaveLength(9)
    for (const call of calls.slice(8)) call.resolve({ body: 'body' })
    await flush()
    const result = (await network.stopHar()) as {
      requestCount: number
      har: { log: { entries: unknown[] } }
    }
    // 全局保留 10 条元数据；窗口外 body 只记录缺失原因，不再实际抓取。
    expect(state.network.requests).toHaveLength(10)
    expect(
      state.network.requests.every(
        (record) => record.responseBody === 'body' || typeof record.responseBodyError === 'string',
      ),
    ).toBe(true)
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
