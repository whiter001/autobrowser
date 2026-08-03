import { describe, expect, test } from 'bun:test'
import { createDownloadsDomain } from '../extension/background/downloads.js'
import { createExtensionState } from '../extension/background/state.js'
import type { ExtensionState } from '../extension/background/types.js'

function createDownloadsHarness() {
  const state = createExtensionState(57978)
  const downloads = createDownloadsDomain(state)
  return { state, downloads }
}

describe('downloads buffer tracking', () => {
  test('onCreated inserts a record and onChanged merges progress fields by id', () => {
    const { state, downloads } = createDownloadsHarness()

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
    downloads.handleChanged({
      id: 1,
      bytesReceived: { current: 400 },
      state: { current: 'in_progress' },
    })
    downloads.handleChanged({
      id: 1,
      bytesReceived: { current: 1000 },
      state: { current: 'complete' },
      endTime: { current: '2026-01-01T00:00:01.000Z' },
    })

    expect(state.session.downloads).toHaveLength(1)
    // 合并只覆盖 delta 出现的字段，url/filename 等保持 onCreated 的原始值
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
