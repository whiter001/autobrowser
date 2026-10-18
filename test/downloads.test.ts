import { describe, expect, test } from 'bun:test'
import { createDownloadsDomain } from '../extension/background/downloads.js'
import { createExtensionState } from '../extension/background/state.js'
import type { ExtensionState } from '../extension/background/types.js'

type SearchDownloads = (query: { id: number }) => Promise<Array<Record<string, unknown>>>

function createDownloadsHarness(searchDownloads?: SearchDownloads) {
  const state = createExtensionState(57978)
  const downloads = createDownloadsDomain(state, searchDownloads ? { searchDownloads } : undefined)
  return { state, downloads }
}

describe('downloads buffer tracking', () => {
  test('onCreated 记录完整快照，onChanged 只合并 Chrome 真实 delta 的字段', async () => {
    const searchCalls: Array<{ id: number }> = []
    const { state, downloads } = createDownloadsHarness(async (query) => {
      searchCalls.push(query)
      return [
        {
          id: 1,
          url: 'https://example.com/file.zip',
          filename: '/tmp/file.zip',
          state: 'complete',
          bytesReceived: 1000,
          totalBytes: 1000,
          danger: 'safe',
          startTime: '2026-01-01T00:00:00.000Z',
          endTime: '2026-01-01T00:00:01.000Z',
        },
      ]
    })

    downloads.handleCreated({
      id: 1,
      url: 'https://example.com/file.zip',
      filename: '/tmp/file.zip',
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: 1000,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })
    // DownloadDelta 没有 bytesReceived（Chrome 从不下发该字段），进度只能靠 search 快照补齐
    await downloads.handleChanged({
      id: 1,
      state: { current: 'complete' },
      endTime: { current: '2026-01-01T00:00:01.000Z' },
    })

    expect(searchCalls).toEqual([{ id: 1 }])
    expect(state.session.downloads).toHaveLength(1)
    expect(state.session.downloads[0]).toEqual({
      id: 1,
      url: 'https://example.com/file.zip',
      filename: '/tmp/file.zip',
      state: 'complete',
      bytesReceived: 1000,
      totalBytes: 1000,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.000Z',
    })
  })

  test('下载进行中不触发 search，终态才刷新一次', async () => {
    const searchCalls: Array<{ id: number }> = []
    const { downloads } = createDownloadsHarness(async (query) => {
      searchCalls.push(query)
      return [{ id: 2, state: 'complete', bytesReceived: 5, totalBytes: 5 }]
    })

    downloads.handleCreated({
      id: 2,
      url: 'https://example.com/live.zip',
      filename: '/tmp/live.zip',
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: 5,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })
    await downloads.handleChanged({ id: 2, filename: { current: '/tmp/live (1).zip' } })
    await downloads.handleChanged({ id: 2, state: { current: 'complete' } })

    expect(searchCalls).toEqual([{ id: 2 }])
  })

  test('中断下载同样刷新快照，并保留 delta 给出的失败原因', async () => {
    const searchCalls: Array<{ id: number }> = []
    const { state, downloads } = createDownloadsHarness(async (query) => {
      searchCalls.push(query)
      return [
        {
          id: 3,
          state: 'interrupted',
          bytesReceived: 64,
          totalBytes: 100,
          error: 'NETWORK_FAILED',
          endTime: '2026-01-01T00:00:02.000Z',
        },
      ]
    })

    downloads.handleCreated({
      id: 3,
      url: 'https://example.com/broken.zip',
      filename: '/tmp/broken.zip',
      state: 'in_progress',
      bytesReceived: 10,
      totalBytes: 100,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })
    await downloads.handleChanged({
      id: 3,
      state: { current: 'interrupted' },
      error: { current: 'NETWORK_FAILED' },
      endTime: { current: '2026-01-01T00:00:02.000Z' },
    })

    expect(searchCalls).toEqual([{ id: 3 }])
    expect(state.session.downloads[0]).toMatchObject({
      id: 3,
      state: 'interrupted',
      error: 'NETWORK_FAILED',
      bytesReceived: 64,
      endTime: '2026-01-01T00:00:02.000Z',
    })
  })

  test('快照晚到时不覆盖更新的 delta 结果', async () => {
    let releaseStaleSnapshot!: (items: Array<Record<string, unknown>>) => void
    let searchCalls = 0
    const { state, downloads } = createDownloadsHarness(() => {
      searchCalls += 1
      if (searchCalls === 1) {
        return new Promise<Array<Record<string, unknown>>>((resolve) => {
          releaseStaleSnapshot = resolve
        })
      }
      return Promise.resolve([{ id: 4, state: 'interrupted', bytesReceived: 60, totalBytes: 100 }])
    })

    downloads.handleCreated({
      id: 4,
      url: 'https://example.com/race.zip',
      filename: '/tmp/race.zip',
      state: 'in_progress',
      bytesReceived: 10,
      totalBytes: 100,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })
    const completing = downloads.handleChanged({ id: 4, state: { current: 'complete' } })
    // 之后又收到中断事件：陈旧的 complete 快照不能把新状态改回去
    await downloads.handleChanged({
      id: 4,
      state: { current: 'interrupted' },
      error: { current: 'SERVER_UNREACHABLE' },
    })
    expect(state.session.downloads[0]).toMatchObject({
      state: 'interrupted',
      error: 'SERVER_UNREACHABLE',
      bytesReceived: 60,
    })

    releaseStaleSnapshot([{ id: 4, state: 'complete', bytesReceived: 100, totalBytes: 100 }])
    await completing

    expect(state.session.downloads[0]).toMatchObject({
      state: 'interrupted',
      error: 'SERVER_UNREACHABLE',
      bytesReceived: 60,
    })
  })

  test('快照查询期间的 filename delta 不会让进度永久丢失', async () => {
    const snapshots = [
      // 第一次查询：拿到的是 delta 到达之前的旧 filename
      {
        id: 6,
        state: 'complete',
        bytesReceived: 800,
        totalBytes: 1000,
        filename: '/tmp/first.zip',
      },
      {
        id: 6,
        state: 'complete',
        bytesReceived: 800,
        totalBytes: 1000,
        filename: '/tmp/final.zip',
      },
    ]
    let searchCalls = 0
    let releaseStale!: () => void
    const { state, downloads } = createDownloadsHarness(() => {
      searchCalls += 1
      if (searchCalls === 1) {
        return new Promise((resolve) => {
          releaseStale = () => resolve([snapshots[0]])
        })
      }
      return Promise.resolve([snapshots[1]])
    })

    downloads.handleCreated({
      id: 6,
      url: 'https://example.com/rename.zip',
      filename: '/tmp/first.zip',
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: 1000,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })
    const completing = downloads.handleChanged({ id: 6, state: { current: 'complete' } })
    // 查询还在飞行中时 Chrome 又改了文件名（重名自动改名）
    await downloads.handleChanged({ id: 6, filename: { current: '/tmp/final.zip' } })
    releaseStale()
    await completing

    expect(searchCalls).toBe(2)
    expect(state.session.downloads[0]).toMatchObject({
      id: 6,
      state: 'complete',
      bytesReceived: 800,
      totalBytes: 1000,
      filename: '/tmp/final.zip',
    })
  })

  test('迟到的快照不会复活已被缓冲淘汰或 clear 掉的下载', async () => {
    const gates: Array<() => void> = []
    const { state, downloads } = createDownloadsHarness(
      () =>
        new Promise((resolve) => {
          gates.push(() =>
            resolve([{ id: 1, state: 'complete', bytesReceived: 10, totalBytes: 10 }]),
          )
        }),
    )

    downloads.handleCreated({
      id: 1,
      url: 'https://example.com/evicted.zip',
      filename: '/tmp/evicted.zip',
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: 10,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })
    const completing = downloads.handleChanged({ id: 1, state: { current: 'complete' } })
    for (let id = 2; id <= 210; id += 1) {
      downloads.handleCreated({
        id,
        url: `https://example.com/${id}`,
        filename: `/tmp/${id}`,
        state: 'complete',
        bytesReceived: 1,
        totalBytes: 1,
        danger: 'safe',
        startTime: '2026-01-01T00:00:00.000Z',
      })
    }

    for (const release of gates.splice(0)) release()
    await completing

    expect(state.session.downloads).toHaveLength(200)
    expect(state.session.downloads.some((item) => item.id === 1)).toBeFalse()

    downloads.handleCreated({
      id: 2,
      url: 'https://example.com/cleared.zip',
      filename: '/tmp/cleared.zip',
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: 10,
      danger: 'safe',
      startTime: '2026-01-01T00:00:02.000Z',
    })
    const second = downloads.handleChanged({ id: 2, state: { current: 'complete' } })
    expect(downloads.clearDownloads()).toMatchObject({ cleared: 200 })
    for (const release of gates.splice(0)) release()
    await second

    expect(state.session.downloads).toHaveLength(0)
  })

  test('FIFO 回收后的同 id 不重用写入 token：旧 rev2 快照不能污染重建的两次 delta', async () => {
    const releases: Array<(items: Array<Record<string, unknown>>) => void> = []
    const { state, downloads } = createDownloadsHarness(
      () => new Promise((resolve) => releases.push(resolve)),
    )
    downloads.handleCreated({ id: 1, filename: '/tmp/old', bytesReceived: 1 })
    // 旧实现捕获 rev2；淘汰后 filename + danger 两次写入也会得到 rev2（ABA）。
    const completing = downloads.handleChanged({ id: 1, state: { current: 'complete' } })
    for (let id = 2; id <= 201; id += 1) downloads.handleCreated({ id })
    expect(state.session.downloads.some((item) => item.id === 1)).toBeFalse()
    await downloads.handleChanged({ id: 1, filename: { current: '/tmp/new' } })
    await downloads.handleChanged({ id: 1, danger: { current: 'safe' } })
    const rebuilt = state.session.downloads.at(-1)
    releases[0]!([
      { id: 1, filename: '/tmp/stale', danger: 'dangerous', state: 'complete', bytesReceived: 999 },
    ])
    await Promise.resolve()
    expect(releases).toHaveLength(2)
    expect(state.session.downloads.at(-1)).toBe(rebuilt)
    expect(rebuilt).toMatchObject({
      id: 1,
      filename: '/tmp/new',
      danger: 'safe',
      state: 'in_progress',
      bytesReceived: 0,
    })
    // 重新捕获当前 token 的补偿查询仍可补齐最新进度。
    releases[1]!([
      { id: 1, filename: '/tmp/fresh', danger: 'safe', state: 'complete', bytesReceived: 42 },
    ])
    await completing
    expect(state.session.downloads.at(-1)).toMatchObject({
      id: 1,
      filename: '/tmp/fresh',
      danger: 'safe',
      state: 'complete',
      bytesReceived: 42,
    })
    expect(state.session.downloads).toHaveLength(200)
    expect(new Set(state.session.downloads.map((item) => item.id)).size).toBe(200)
  })

  test('快照原地合并，不清空重插，缓冲顺序与对象身份保持不变', async () => {
    const { state, downloads } = createDownloadsHarness(async () => [
      {
        id: 2,
        state: 'complete',
        bytesReceived: 900,
        totalBytes: 1000,
        filename: '/tmp/2-final.zip',
      },
    ])

    for (const id of [1, 2, 3]) {
      downloads.handleCreated({
        id,
        url: `https://example.com/${id}`,
        filename: `/tmp/${id}`,
        state: 'in_progress',
        bytesReceived: 0,
        totalBytes: 1000,
        danger: 'safe',
        startTime: `2026-01-01T00:00:0${id}.000Z`,
      })
    }
    const [first, , last] = state.session.downloads

    await downloads.handleChanged({ id: 2, state: { current: 'complete' } })

    expect(state.session.downloads.map((item) => item.id)).toEqual([1, 2, 3])
    expect(state.session.downloads[0]).toBe(first)
    expect(state.session.downloads[2]).toBe(last)
    expect(state.session.downloads[1]).toMatchObject({
      bytesReceived: 900,
      totalBytes: 1000,
      filename: '/tmp/2-final.zip',
    })
  })

  test('search 不可用或失败时保留 delta 已合并的结果', async () => {
    const { state, downloads } = createDownloadsHarness(async () => {
      throw new Error('No downloads permission')
    })

    downloads.handleCreated({
      id: 5,
      url: 'https://example.com/no-api.zip',
      filename: '/tmp/no-api.zip',
      state: 'in_progress',
      bytesReceived: 7,
      totalBytes: 100,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })
    await downloads.handleChanged({ id: 5, state: { current: 'complete' } })

    expect(state.session.downloads).toHaveLength(1)
    expect(state.session.downloads[0]).toMatchObject({ state: 'complete', bytesReceived: 7 })
  })

  test('onChanged creates a skeleton record when it arrives before onCreated', () => {
    const { state, downloads } = createDownloadsHarness()

    downloads.handleChanged({
      id: 7,
      url: { current: 'https://example.com/late.zip' },
      state: { current: 'complete' },
      error: { current: null },
    })

    expect(state.session.downloads).toHaveLength(1)
    expect(state.session.downloads[0]).toMatchObject({
      id: 7,
      url: 'https://example.com/late.zip',
      state: 'complete',
      error: null,
    })
    expect(typeof state.session.downloads[0]?.startTime).toBe('string')
  })

  test('records interrupted downloads with their error reason', () => {
    const { state, downloads } = createDownloadsHarness()

    downloads.handleCreated({
      id: 3,
      url: 'https://example.com/broken.zip',
      filename: '/tmp/broken.zip',
      state: 'in_progress',
      bytesReceived: 10,
      totalBytes: 100,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })
    downloads.handleChanged({
      id: 3,
      state: { current: 'interrupted' },
      error: { current: 'NETWORK_FAILED' },
      endTime: { current: '2026-01-01T00:00:02.000Z' },
    })

    expect(state.session.downloads[0]).toMatchObject({
      id: 3,
      state: 'interrupted',
      error: 'NETWORK_FAILED',
      endTime: '2026-01-01T00:00:02.000Z',
    })
  })

  test('evicts the oldest records beyond the 200-item buffer', () => {
    const { state, downloads } = createDownloadsHarness()

    for (let id = 1; id <= 210; id += 1) {
      downloads.handleCreated({
        id,
        url: `https://example.com/${id}`,
        filename: `/tmp/${id}`,
        state: 'complete',
        bytesReceived: 1,
        totalBytes: 1,
        danger: 'safe',
        startTime: `2026-01-01T00:00:${String(id).padStart(2, '0')}.000Z`,
      })
    }

    expect(state.session.downloads).toHaveLength(200)
    // FIFO：最旧的 10 条被淘汰，剩下的是 id 11..210
    expect(state.session.downloads[0]?.id).toBe(11)
    expect(state.session.downloads[199]?.id).toBe(210)
  })

  test('listDownloads paginates with paginateList semantics', () => {
    const { downloads } = createDownloadsHarness()

    for (let id = 1; id <= 5; id += 1) {
      downloads.handleCreated({
        id,
        url: `https://example.com/${id}`,
        filename: `/tmp/${id}`,
        state: 'complete',
        bytesReceived: 1,
        totalBytes: 1,
        danger: 'safe',
        startTime: `2026-01-01T00:00:0${id}.000Z`,
      })
    }

    const page = downloads.listDownloads(1, 2) as unknown as {
      downloads: Array<{ id: number }>
      total: number
      pagination: Record<string, unknown>
    }
    expect(page.downloads.map((item) => item.id)).toEqual([3, 4])
    expect(page.total).toBe(5)
    expect(page.pagination).toEqual({
      currentPage: 1,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
      startIndex: 2,
      endIndex: 4,
      invalidPage: false,
    })

    // 越界 pageIdx 回退第一页并标记 invalidPage
    const invalid = downloads.listDownloads(9, 2) as unknown as {
      downloads: Array<{ id: number }>
      pagination: { invalidPage: boolean; currentPage: number }
    }
    expect(invalid.downloads.map((item) => item.id)).toEqual([1, 2])
    expect(invalid.pagination).toMatchObject({ currentPage: 0, invalidPage: true })
  })

  test('clearDownloads empties the buffer and reports the count', () => {
    const { state, downloads } = createDownloadsHarness()

    downloads.handleCreated({
      id: 1,
      url: 'https://example.com/a',
      filename: '/tmp/a',
      state: 'complete',
      bytesReceived: 1,
      totalBytes: 1,
      danger: 'safe',
      startTime: '2026-01-01T00:00:00.000Z',
    })

    expect(downloads.clearDownloads()).toEqual({ cleared: 1 })
    expect(state.session.downloads).toHaveLength(0)
    expect(downloads.clearDownloads()).toEqual({ cleared: 0 })
  })

  test('registerChromeListeners skips silently when chrome.downloads is unavailable', () => {
    const { downloads } = createDownloadsHarness()
    const originalChrome = (globalThis as Record<string, unknown>).chrome

    try {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: { downloads: undefined },
      })
      // 不应抛错
      expect(() => downloads.registerChromeListeners()).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: originalChrome,
      })
    }
  })

  test('registerChromeListeners wires onCreated/onChanged when downloads API exists', () => {
    const { state, downloads } = createDownloadsHarness()
    const originalChrome = (globalThis as Record<string, unknown>).chrome
    const listeners: Array<(item: unknown) => void> = []

    try {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: {
          downloads: {
            onCreated: {
              addListener: (listener: (item: unknown) => void) => listeners.push(listener),
            },
            onChanged: {
              addListener: (listener: (delta: unknown) => void) => listeners.push(listener),
            },
          },
        },
      })

      downloads.registerChromeListeners()
      expect(listeners).toHaveLength(2)

      // 模拟真实 chrome 事件流：onCreated 建骨架，onChanged 推进状态
      ;(listeners[0] as (item: unknown) => void)({
        id: 9,
        url: 'https://example.com/live.zip',
        filename: '/tmp/live.zip',
        state: 'in_progress',
        bytesReceived: 0,
        totalBytes: 500,
        danger: 'safe',
        startTime: '2026-01-01T00:00:00.000Z',
      })
      ;(listeners[1] as (delta: unknown) => void)({
        id: 9,
        state: { current: 'complete' },
        endTime: { current: '2026-01-01T00:00:03.000Z' },
      })

      expect(state.session.downloads).toHaveLength(1)
      expect(state.session.downloads[0]).toMatchObject({ id: 9, state: 'complete' })
    } finally {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: originalChrome,
      })
    }
  })
})

describe('downloads state initialization', () => {
  test('createExtensionState seeds an empty downloads buffer and default dialogAutoAccept', () => {
    const state: ExtensionState = createExtensionState(57978)
    expect(state.session.downloads).toEqual([])
    expect(state.session.dialogAutoAccept).toBe(true)
  })
})
