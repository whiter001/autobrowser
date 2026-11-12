import { describe, expect, test } from 'bun:test'
import { createCommandRouter } from '../extension/background/command-router.js'
import { createStaleTabHandleError } from '../extension/background/targeting.js'
import type { DialogState } from '../extension/background/types.js'

// tab-target 命令的元数据：mock getTargetTab 返回 { id: 1 }，无 url/title
const TAB_META = {
  tabHandle: 't1',
  tabId: 1,
  frame: null,
  pageEpoch: 1,
  url: null,
  title: null,
}
// 无页面上下文命令（status/script/batch 等）的元数据全为 null
export const EMPTY_META = {
  tabHandle: null,
  tabId: null,
  frame: null,
  pageEpoch: null,
  url: null,
  title: null,
}

// meta 现在总是带 target 解析结果，按命令是否显式指定 tabId/handle 与是否发生兜底选择区分：
// explicit=true 显式指定；explicit=false 且首次 fallback 时带 note
function metaWithTarget(
  target: { tabId: number; handle: string; explicit: boolean; note?: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...TAB_META, target, ...extra }
}

export function explicitTabMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return metaWithTarget({ tabId: 1, handle: 't1', explicit: true }, extra)
}

export function fallbackTabMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return metaWithTarget(
    { tabId: 1, handle: 't1', explicit: false, note: 'fell back to last non-active tab' },
    extra,
  )
}

export function ambientTabMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return metaWithTarget({ tabId: 1, handle: 't1', explicit: false }, extra)
}

// 单页内完整返回时的分页信息（console/errors/network requests 响应的固定字段）
export function singlePageInfo(count: number): Record<string, unknown> {
  return {
    currentPage: 0,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
    startIndex: 0,
    endIndex: count,
    invalidPage: false,
  }
}

export function createMinimalRouter(overrides?: {
  getTargetTab?: (tabId?: unknown) => Promise<{ id: number }>
  createTab?: (url: string) => Promise<{ id: number; url: string }>
  snapshotTab?: (tabId: unknown, frameSelector: unknown, options?: unknown) => Promise<unknown>
  navigateTo?: (tabId: unknown, url: string) => Promise<unknown>
  listTabs?: () => Promise<unknown[]>
  findSemanticTarget?: (tabId: unknown, options: unknown, frame: unknown) => Promise<unknown>
  download?: (args: Record<string, unknown>) => Promise<unknown>
  mediaList?: (tabId: number, frame: unknown, options: unknown) => Promise<unknown>
  waitSelector?: (tabId: unknown, frame: unknown) => Promise<void>
  getRequestDetail?: () => Promise<unknown>
  stopHar?: (options?: { captureId?: string; includeUrls?: boolean }) => Promise<unknown>
  clickSelector?: (tabId: unknown, selector: unknown) => Promise<unknown>
  typeIntoSelector?: (tabId: unknown, selector: unknown) => Promise<unknown>
  evaluateScript?: (tabId: unknown, script: unknown) => Promise<unknown>
  sendDebuggerCommand?: (
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>
}) {
  const cdpCalls: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = []
  const snapshotCalls: Array<{ tabId: unknown; frameSelector: unknown; options?: unknown }> = []
  const feedCalls: Array<{
    tabId: unknown
    options: unknown
    frameSelector: unknown
  }> = []
  const navigateCalls: Array<{ tabId: unknown; url: string }> = []
  const waitTimeoutCalls: number[] = []
  const waitUrlCalls: Array<{ url: unknown; timeout: unknown }> = []
  const waitSelectorCalls: Array<{ selector: unknown; state: unknown; timeout: unknown }> = []
  const screenshotCalls: Array<{ tabId: unknown; options: unknown }> = []
  const waitTextCalls: Array<{ text: unknown; gone?: unknown }> = []
  const typeCalls: Array<{ tabId: unknown; selector: unknown; value: unknown; submit?: unknown }> =
    []
  const evalCalls: Array<{ tabId: unknown; script: unknown; maxResultBytes?: number }> = []
  const cookieGetCalls: Array<{ tabId: unknown; filters: unknown }> = []
  const clickCalls: Array<{ tabId: unknown; selector: unknown }> = []
  const listRequestsCalls: Array<Record<string, unknown>> = []
  const searchCalls: Array<{
    tabId: unknown
    options: unknown
    frameSelector: unknown
  }> = []
  const downloadsCalls: Array<{ method: string; args: unknown[] }> = []
  const dropCalls: Array<{ args: unknown[] }> = []
  const mouseCalls: Array<{ method: string; args: unknown[] }> = []
  const elementToolCalls: Array<{ method: string; args: unknown[] }> = []
  const tracingCalls: Array<{ action: string; tabId: unknown }> = []
  const videoCalls: Array<{ action: string; args: unknown[] }> = []
  const webmcpCalls: Array<{ action: string; args: unknown[] }> = []

  const state = {
    targeting: {
      targetTabId: null as number | null,
      tabIdsByHandle: new Map<string, number>(),
      tabHandles: new Map<number, string>(),
      selectedFrames: new Map<number, string>(),
      pageEpochs: new Map<number, number>(),
    },
    session: {
      dialogs: new Map<number, DialogState>(),
      lastDialog: null as Record<string, unknown> | null,
      consoleMessages: [] as unknown[],
      pageErrors: [] as unknown[],
      emulation: new Map<number, Record<string, unknown>>(),
      actionLog: [] as Array<Record<string, unknown>>,
      autoSnapshot: false,
    },
  }

  const router = createCommandRouter({
    state,
    extensionControl: {
      info: async () => ({
        extensionId: 'test-extension',
        version: '0.1.3',
        buildTime: null,
        commit: null,
        userAgent: 'test-browser',
      }),
      reload: () => ({ reloading: true, reconnectExpected: true }),
      reconnect: () => ({ reconnecting: true, reconnectExpected: true }),
    },
    pageInput: {
      navigateTo:
        overrides?.navigateTo ??
        (async (tabId: unknown, url: string) => {
          navigateCalls.push({ tabId, url })
          if (url.startsWith('chrome://')) {
            const error = new Error('cannot access chrome:// and edge:// urls') as Error & {
              code?: string
            }
            error.code = 'EXTENSION_COMMAND_ERROR'
            throw error
          }
          return { navigated: true, url }
        }),
      evaluateScript: async (
        tabId: unknown,
        script: unknown,
        _frame: unknown,
        _timeout: unknown,
        _element: unknown,
        maxResultBytes?: number,
      ) => {
        evalCalls.push({ tabId, script, maxResultBytes })
        if (overrides?.evaluateScript) return overrides.evaluateScript(tabId, script)
        return undefined
      },
      generateLocator: async (...args: unknown[]) => {
        elementToolCalls.push({ method: 'locator', args })
      },
      highlightElement: async (...args: unknown[]) => {
        elementToolCalls.push({ method: 'highlight', args })
      },
      clickSelector: async (_tabId: unknown, selector: unknown) => {
        clickCalls.push({ tabId: _tabId, selector })
        if (overrides?.clickSelector) return overrides.clickSelector(_tabId, selector)
        // 模拟元素缺失时带引导字段的错误，验证 batch 错误序列化不丢字段
        if (selector === '#missing') {
          const error = new Error(`element not found: ${selector}`) as Error & {
            code?: string
            suggestedAction?: string
            ref?: string
          }
          error.code = 'ELEMENT_NOT_FOUND'
          error.suggestedAction = 'check the selector and selected frame'
          error.ref = String(selector)
          throw error
        }
        return { found: true, selector }
      },
      doubleClickSelector: async () => undefined,
      fillSelector: async () => undefined,
      fillFields: async (_tabId: unknown, fields: unknown) => ({
        results: (fields as Array<{ selector: string }>).map((field) => ({
          selector: field.selector,
          ok: true,
        })),
        succeeded: Array.isArray(fields) ? fields.length : 0,
        failed: 0,
      }),
      typeIntoSelector: async (
        _tabId: unknown,
        selector: unknown,
        value: unknown,
        _frame: unknown,
        submit?: unknown,
      ) => {
        typeCalls.push({ tabId: _tabId, selector, value, submit })
        if (overrides?.typeIntoSelector) return overrides.typeIntoSelector(_tabId, selector)
        return { found: true, selector, typed: true, ...(submit ? { submitted: true } : {}) }
      },
      hoverElement: async () => undefined,
      pressKey: async () => undefined,
      insertTextSequentially: async () => undefined,
      insertTextOnce: async () => undefined,
      keyDownOnly: async () => undefined,
      keyUpOnly: async () => undefined,
      focusElement: async () => undefined,
      selectOption: async () => undefined,
      checkElement: async () => undefined,
      scrollElement: async () => undefined,
      scrollIntoViewSelector: async () => undefined,
      dragElement: async () => undefined,
      dropData: async (...args: unknown[]) => {
        dropCalls.push({ args })
      },
      mouseMove: async (...args: unknown[]) => {
        mouseCalls.push({ method: 'move', args })
      },
      mouseButton: async (...args: unknown[]) => {
        mouseCalls.push({ method: 'button', args })
      },
      mouseWheel: async (...args: unknown[]) => {
        mouseCalls.push({ method: 'wheel', args })
      },
      uploadFiles: async () => undefined,
      navigateBack: async () => undefined,
      navigateForward: async () => undefined,
      reloadPage: async () => undefined,
      switchToFrame: async (tabId: number, selector: string) => {
        if (['top', 'main', 'default'].includes(selector))
          state.targeting.selectedFrames.delete(tabId)
        else state.targeting.selectedFrames.set(tabId, selector)
        return { found: true }
      },
      checkIsState: async () => undefined,
      getAttribute: async () => ({ value: undefined }),
    } as never,
    pageObserve: {
      snapshotTab: async (tabId: unknown, frameSelector: unknown, options?: unknown) => {
        snapshotCalls.push({ tabId, frameSelector, options })
        if (overrides?.snapshotTab) return overrides.snapshotTab(tabId, frameSelector, options)
        return { snapshotId: `snapshot-${snapshotCalls.length}` }
      },
      collectFeed: async (tabId: unknown, options: unknown, frameSelector: unknown) => {
        feedCalls.push({ tabId, options, frameSelector })
        return {
          pageEpoch: 1,
          selector: 'article',
          limit: 30,
          dedupe: 'url',
          maxScrolls: 20,
          pauseMs: 900,
          stallRounds: 3,
          scrolls: 0,
          stopReason: 'stalled',
          count: 0,
          items: [],
        }
      },
      captureScreenshot: async (tabId: unknown, options: unknown) => {
        screenshotCalls.push({ tabId, options })
        return { captured: true }
      },
      findSemanticTarget:
        overrides?.findSemanticTarget ??
        (async () => ({ match: null, reason: 'not used in test' })),
      searchPageText: async (tabId: unknown, options: unknown, frameSelector: unknown) => {
        searchCalls.push({ tabId, options, frameSelector })
        return {
          pageEpoch: 1,
          query: '',
          regex: false,
          pattern: '',
          context: 3,
          limit: 20,
          readyState: 'complete',
          totalMatches: 0,
          returned: 0,
          truncated: false,
          windows: [],
        }
      },
      waitWithTimeout: async (_tabId: unknown, ms: number) => {
        waitTimeoutCalls.push(ms)
      },
      waitForSelectorState: async (
        _tabId: unknown,
        selector: unknown,
        state: unknown,
        timeout: unknown,
        frame: unknown,
      ) => {
        waitSelectorCalls.push({ selector, state, timeout })
        await overrides?.waitSelector?.(_tabId, frame)
        return {
          waited: true,
          condition: 'selector-stable',
          selector,
          state,
        }
      },
      waitForUrl: async (_tabId: unknown, url: unknown, timeout: unknown) => {
        waitUrlCalls.push({ url, timeout })
        return { waited: true, condition: 'url', url }
      },
      waitForText: async (
        _tabId: unknown,
        text: unknown,
        _timeout: unknown,
        _frame: unknown,
        gone?: unknown,
      ) => {
        waitTextCalls.push({ text, gone })
        return { waited: true, condition: gone ? 'text-gone' : 'text', text }
      },
      waitForLoadEvent: async () => undefined,
      waitForNetworkIdle: async () => undefined,
      waitForExpression: async () => undefined,
    } as never,
    session: {
      getDialogStatus: () => ({}),
      getDialogAutoAccept: () => true,
      setDialogAutoAccept: (enabled: boolean) => ({ autoAccept: enabled }),
      handleDialog: async () => undefined,
      cookiesGet: async (tabId: unknown, filters: unknown) => {
        cookieGetCalls.push({ tabId, filters })
      },
      cookiesSet: async () => undefined,
      cookiesClear: async () => undefined,
      cookiesDelete: async (_tabId: unknown, name: string) => ({ deleted: 1, name }),
      storageGet: async () => undefined,
      storageSet: async () => undefined,
      storageDelete: async (_tabId: unknown, key: string, _frame: unknown, session: boolean) => ({
        key,
        deleted: true,
        session,
      }),
      storageClear: async () => undefined,
      setViewport: async () => undefined,
      setOffline: async () => undefined,
      setHeaders: async () => undefined,
      setGeo: async () => undefined,
      setMedia: async () => undefined,
      setPermission: async (_tabId: unknown, name: string, reset: boolean) => ({
        permission: name,
        setting: reset ? 'default' : 'granted',
      }),
      setUserAgent: async (_tabId: unknown, userAgent: string | null) => ({ userAgent }),
      setTimezone: async (_tabId: unknown, timezone: string | null) => ({ timezone }),
      setLocale: async (_tabId: unknown, locale: string | null) => ({ locale }),
      generatePdf: async () => undefined,
      clipboardRead: async () => undefined,
      clipboardWrite: async () => undefined,
      saveState: async () => undefined,
      loadState: async () => undefined,
      loadStateByName: async () => undefined,
    } as never,
    network: {
      routeRequest: async (_tabId: unknown, url: string, options: unknown) => ({
        route: { id: 'route_1', pattern: url, ...(options as Record<string, unknown>) },
        routes: [],
      }),
      unrouteRequest: async () => undefined,
      listRoutes: () => ({ routes: [{ id: 'route_1', pattern: '**/api/*', abort: true }] }),
      listRequests: (args: Record<string, unknown>) => {
        listRequestsCalls.push(args)
        return {}
      },
      getRequestDetail: overrides?.getRequestDetail ?? (() => ({})),
      startHar: async () => undefined,
      stopHar: overrides?.stopHar ?? (() => undefined),
    } as never,
    downloads: {
      listDownloads: (...args: unknown[]) => {
        downloadsCalls.push({ method: 'list', args })
        return {
          downloads: [],
          total: 0,
          pagination: singlePageInfo(0),
        }
      },
      clearDownloads: () => {
        downloadsCalls.push({ method: 'clear', args: [] })
        return { cleared: 0 }
      },
    } as never,
    mediaDomain: { list: overrides?.mediaList ?? (async () => ({ media: [] })) },
    fileTransfer: { download: overrides?.download ?? (async () => ({})) },
    initScripts: {
      addScript: async (source: string) => ({
        script: { id: 'script_1', preview: source },
        scripts: [{ id: 'script_1', preview: source }],
      }),
      listScripts: () => ({ scripts: [{ id: 'script_1', preview: 'window.x = 1' }] }),
      removeScript: async (id: string) => ({ removed: id, scripts: [] }),
      removeAllScripts: async () => ({ removed: ['script_1'], scripts: [] }),
    } as never,
    tracing: {
      start: async (tabId: unknown) => {
        tracingCalls.push({ action: 'start', tabId })
        return { recording: true }
      },
      status: async (tabId: unknown) => {
        tracingCalls.push({ action: 'status', tabId })
        return { recording: false }
      },
      stop: async (tabId: unknown) => {
        tracingCalls.push({ action: 'stop', tabId })
        return { recording: false, data: '{"events":[]}', base64Encoded: false }
      },
    },
    video: {
      start: async (...args: unknown[]) => {
        videoCalls.push({ action: 'start', args })
        return { recording: true }
      },
      status: async (...args: unknown[]) => {
        videoCalls.push({ action: 'status', args })
        return { recording: true }
      },
      stop: async (...args: unknown[]) => {
        videoCalls.push({ action: 'stop', args })
        return { recording: false, data: 'VklERU8=', chapters: [] }
      },
      chapter: async (...args: unknown[]) => {
        videoCalls.push({ action: 'chapter', args })
        return { added: true }
      },
      showActions: async (...args: unknown[]) => {
        videoCalls.push({ action: 'show-actions', args })
        return { showActions: true }
      },
      hideActions: async (...args: unknown[]) => {
        videoCalls.push({ action: 'hide-actions', args })
        return { showActions: false }
      },
      handleAction: async (...args: unknown[]) => {
        videoCalls.push({ action: 'handle-action', args })
      },
    },
    webmcp: {
      list: async (...args: unknown[]) => {
        webmcpCalls.push({ action: 'list', args })
        return { tools: [], untrusted: true }
      },
      call: async (...args: unknown[]) => {
        webmcpCalls.push({ action: 'call', args })
        return { result: {}, untrusted: true }
      },
    },
    listTabs: (overrides?.listTabs ?? (async () => [])) as never,
    getTargetTab: (overrides?.getTargetTab ?? (async () => ({ id: 1 }))) as never,
    createTab: overrides?.createTab,
    sendDebuggerCommand: async (
      tabId: number,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      cdpCalls.push({ tabId, method, params })
      if (overrides?.sendDebuggerCommand)
        return await overrides.sendDebuggerCommand(tabId, method, params)
      return { answered: true }
    },
  } as never)

  return {
    router,
    state,
    cdpCalls,
    snapshotCalls,
    feedCalls,
    navigateCalls,
    waitTimeoutCalls,
    waitUrlCalls,
    waitSelectorCalls,
    screenshotCalls,
    waitTextCalls,
    typeCalls,
    evalCalls,
    cookieGetCalls,
    clickCalls,
    listRequestsCalls,
    searchCalls,
    downloadsCalls,
    dropCalls,
    mouseCalls,
    elementToolCalls,
    tracingCalls,
    videoCalls,
    webmcpCalls,
  }
}

describe('command router media readiness', () => {
  test('rejects a stale media epoch before re-listing', async () => {
    let listed = false
    const { router } = createMinimalRouter({
      mediaList: async () => {
        listed = true
        return { media: [] }
      },
    })
    await expect(
      router.handleCommand({ command: 'media', args: { action: 'list', mediaEpoch: 2 } }),
    ).rejects.toMatchObject({ code: 'STALE_MEDIA_STATE' })
    expect(listed).toBe(false)
  })
  for (const frame of ['#original', 'top']) {
    for (const removed of [false, true]) {
      test(`implicit media frame stays fixed after wait clears selection, frame=${frame}, removed=${removed}`, async () => {
        const calls: unknown[][] = []
        const { router, state } = createMinimalRouter({
          waitSelector: async (tabId, executionFrame) => {
            calls.push(['wait', tabId, executionFrame])
            state.targeting.selectedFrames.delete(1)
            if (frame === 'top') state.targeting.selectedFrames.set(1, '#different')
          },
          mediaList: async (tabId, executionFrame) => {
            calls.push(['list', tabId, executionFrame])
            if (removed) throw new Error(`frame not found: ${executionFrame}`)
            return { media: [] }
          },
        })
        state.targeting.targetTabId = 1
        if (frame !== 'top') state.targeting.selectedFrames.set(1, frame)
        const request = router.handleCommand({
          command: 'media',
          args: { action: 'list', waitFor: 'article', selector: 'article' },
        })
        if (removed) await expect(request).rejects.toThrow(`frame not found: ${frame}`)
        else expect(await request).toMatchObject({ wait: { completed: true, selector: 'article' } })
        expect(calls).toEqual([
          ['wait', 1, frame],
          ['list', 1, frame],
        ])
      })
    }
  }
  for (const fail of [false, true]) {
    test(`wait and list stay on the resolved tab/frame despite ambient drift, failure=${fail}`, async () => {
      const calls: unknown[][] = []
      const { router, state } = createMinimalRouter({
        waitSelector: async (tabId, frame) => {
          calls.push(['wait', tabId, frame])
          state.targeting.targetTabId = 2
          state.targeting.selectedFrames.set(1, '#different')
          if (fail) throw new Error('wait timeout')
        },
        mediaList: async (tabId, frame, options) => {
          calls.push(['list', tabId, frame, options])
          return { media: [] }
        },
      })
      state.targeting.targetTabId = 1
      state.targeting.selectedFrames.set(1, '#original')
      const request = router.handleCommand({
        command: 'media',
        args: {
          action: 'list',
          waitFor: 'article',
          timeoutMs: 45000,
          selector: 'article',
          frame: '#original',
        },
      })
      if (fail) await expect(request).rejects.toThrow('wait timeout')
      else expect(await request).toMatchObject({ wait: { completed: true, selector: 'article' } })
      expect(calls).toEqual(
        fail
          ? [['wait', 1, '#original']]
          : [
              ['wait', 1, '#original'],
              [
                'list',
                1,
                '#original',
                { resolve: false, selector: 'article', includeBackground: false },
              ],
            ],
      )
    })
  }
})

describe('command router network/session extensions', () => {
  test('forwards guarded HAR stop options and validates direct callers', async () => {
    const calls: unknown[] = []
    const { router } = createMinimalRouter({
      stopHar: async (options) => {
        calls.push(options)
        return { captureId: 'capture-1' }
      },
    })
    expect(
      await router.handleCommand({
        command: 'network',
        args: { action: 'har', subaction: 'stop', captureId: 'capture-1', includeUrls: true },
      }),
    ).toMatchObject({ captureId: 'capture-1' })
    expect(calls).toEqual([{ captureId: 'capture-1', includeUrls: true }])
    for (const invalid of [{ captureId: '' }, { captureId: null }, { includeUrls: 'true' }]) {
      await expect(
        router.handleCommand({
          command: 'network',
          args: { action: 'har', subaction: 'stop', ...invalid },
        }),
      ).rejects.toThrow()
    }
    expect(calls).toHaveLength(1)
  })

  test('routes network route list to the network domain', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'network',
      args: { action: 'route', subaction: 'list' },
    })

    expect(result).toEqual({
      routes: [{ id: 'route_1', pattern: '**/api/*', abort: true }],
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })
  })

  test('passes route mock options through to the network domain', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'network',
      args: {
        action: 'route',
        url: '**/api/user',
        status: 404,
        contentType: 'text/plain',
        headers: { 'x-mock': 'yes' },
        removeHeaders: ['authorization'],
      },
    })) as { route: Record<string, unknown> }

    expect(result.route).toMatchObject({
      pattern: '**/api/user',
      abort: false,
      status: 404,
      contentType: 'text/plain',
      headers: { 'x-mock': 'yes' },
      removeHeaders: ['authorization'],
    })
  })

  test('rejects route mock options outside the 100-599 status range', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({
        command: 'network',
        args: { action: 'route', url: '**/api/*', status: 99 },
      }),
    ).rejects.toThrow('status must be an integer 100-599')
  })

  test('routes cookies delete with a required name', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'cookies',
      args: { action: 'delete', name: 'session' },
    })
    expect(result).toEqual({
      deleted: 1,
      name: 'session',
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })

    await expect(
      router.handleCommand({ command: 'cookies', args: { action: 'delete' } }),
    ).rejects.toThrow('cookies delete requires a cookie name')
  })

  test('routes cookies list as a get alias', async () => {
    const { router, cookieGetCalls } = createMinimalRouter()

    await router.handleCommand({
      command: 'cookies',
      args: { action: 'list', domain: 'example.com' },
    })

    // 未显式指定 tab 时命令已固定到回落的 tab 1（getTargetTab 的兜底选择结果）
    expect(cookieGetCalls).toEqual([
      { tabId: 1, filters: { domain: 'example.com', path: undefined } },
    ])
  })

  test('routes storage delete with the session flag', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'storage',
      args: { action: 'delete', key: 'draft', session: true },
    })

    expect(result).toEqual({
      key: 'draft',
      deleted: true,
      session: true,
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })
  })

  test('routes set permission/ua/timezone/locale to the session domain', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({
        command: 'set',
        args: { type: 'permission', name: 'geolocation' },
      }),
    ).resolves.toEqual({
      permission: 'geolocation',
      setting: 'granted',
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })

    await expect(
      router.handleCommand({
        command: 'set',
        args: { type: 'permission', name: 'geolocation', reset: true },
      }),
    ).resolves.toEqual({
      permission: 'geolocation',
      setting: 'default',
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })

    await expect(
      router.handleCommand({ command: 'set', args: { type: 'ua', value: 'My Agent 1.0' } }),
    ).resolves.toEqual({
      userAgent: 'My Agent 1.0',
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })

    await expect(
      router.handleCommand({ command: 'set', args: { type: 'timezone', value: 'Asia/Shanghai' } }),
    ).resolves.toEqual({
      timezone: 'Asia/Shanghai',
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })

    await expect(
      router.handleCommand({ command: 'set', args: { type: 'locale', value: '' } }),
    ).resolves.toEqual({
      locale: null,
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })
  })
})

describe('command router script management', () => {
  test('routes script add to the init script domain', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'script',
      args: { action: 'add', source: 'window.__injected = true' },
    })

    expect(result).toEqual({
      script: { id: 'script_1', preview: 'window.__injected = true' },
      scripts: [{ id: 'script_1', preview: 'window.__injected = true' }],
      meta: EMPTY_META,
    })
  })

  test('routes script list to the init script domain', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'script',
      args: { action: 'list' },
    })

    expect(result).toEqual({
      scripts: [{ id: 'script_1', preview: 'window.x = 1' }],
      meta: EMPTY_META,
    })
  })

  test('routes script remove by id and --all to the init script domain', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({ command: 'script', args: { action: 'remove', id: 'script_1' } }),
    ).resolves.toEqual({ removed: 'script_1', scripts: [], meta: EMPTY_META })

    await expect(
      router.handleCommand({ command: 'script', args: { action: 'remove', all: true } }),
    ).resolves.toEqual({ removed: ['script_1'], scripts: [], meta: EMPTY_META })

    await expect(
      router.handleCommand({ command: 'script', args: { action: 'remove' } }),
    ).rejects.toThrow('script remove requires an id or --all')
  })

  test('rejects script add without source', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({ command: 'script', args: { action: 'add' } }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
  })
})

describe('command router playwright parity commands', () => {
  test('routes snapshot subtree targets to the page observer', async () => {
    const { router, snapshotCalls } = createMinimalRouter()

    await router.handleCommand({
      command: 'snapshot',
      args: { selector: '#panel' },
    })

    expect(snapshotCalls).toHaveLength(1)
    expect(snapshotCalls[0]).toMatchObject({ frameSelector: null, options: { selector: '#panel' } })
  })

  test('routes element screenshot options to the page observer', async () => {
    const { router, screenshotCalls } = createMinimalRouter()

    await router.handleCommand({
      command: 'screenshot',
      args: { element: '#card' },
    })

    expect(screenshotCalls).toHaveLength(1)
    expect(screenshotCalls[0].options).toMatchObject({
      full: false,
      annotate: false,
      element: '#card',
    })
  })

  test('routes search queries with default context and limit', async () => {
    const { router, searchCalls } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'search',
      args: { tabId: 1, query: 'Sign in' },
    })

    expect(searchCalls).toEqual([
      {
        tabId: 1,
        options: { query: 'Sign in', context: 3, limit: 10, responseFormat: 'concise' },
        frameSelector: null,
      },
    ])
    expect(result).toEqual(
      expect.objectContaining({
        readyState: 'complete',
        meta: explicitTabMeta(),
      }),
    )
  })

  test('rejects search queries with invalid arguments', async () => {
    const { router, searchCalls } = createMinimalRouter()

    await expect(
      router.handleCommand({ command: 'search', args: { tabId: 1 } }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
    await expect(
      router.handleCommand({ command: 'search', args: { tabId: 1, query: '/foo[/' } }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
    expect(searchCalls).toHaveLength(0)
  })

  test('rejects element screenshots combined with full page capture', async () => {
    const { router, screenshotCalls } = createMinimalRouter()

    await expect(
      router.handleCommand({
        command: 'screenshot',
        args: { element: '#card', full: true },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
    expect(screenshotCalls).toHaveLength(0)
  })

  test('routes text-gone waits to the page observer', async () => {
    const { router, waitTextCalls } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'wait',
      args: { type: 'text', text: 'Loading', gone: true },
    })

    expect(waitTextCalls).toEqual([{ text: 'Loading', gone: true }])
    expect(result).toEqual({
      waited: true,
      condition: 'text-gone',
      text: 'Loading',
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })
  })

  test('rejects --gone for non-text waits', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({
        command: 'wait',
        args: { selector: '#spinner', gone: true },
      }),
    ).rejects.toThrow('wait --gone requires --text')
  })

  test('routes type submit to the page input domain', async () => {
    const { router, typeCalls } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'type',
      args: { selector: '#q', value: 'hello', submit: true },
    })

    expect(typeCalls).toEqual([{ tabId: 1, selector: '#q', value: 'hello', submit: true }])
    expect(result).toMatchObject({ typed: true, submitted: true })
  })

  test('routes fillform fields to the page input batch fill with statistics', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'fillform',
      args: {
        fields: [
          { selector: '#name', value: 'Ada' },
          { selector: '#age', value: '36' },
        ],
      },
    })

    expect(result).toEqual({
      results: [
        { selector: '#name', ok: true },
        { selector: '#age', ok: true },
      ],
      succeeded: 2,
      failed: 0,
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })
  })

  test('rejects fillform with invalid fields', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({ command: 'fillform', args: { fields: [] } }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
    await expect(
      router.handleCommand({ command: 'fillform', args: { fields: [{ selector: '#a' }] } }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
    await expect(
      router.handleCommand({
        command: 'fillform',
        args: { fields: [{ selector: ' ', value: 'x' }] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
  })
})

export function openConfirmDialog(_tabId: number): {
  open: boolean
  type: string
  message: string
  defaultPrompt: string
  url: string | null
  openedAt: string
} {
  return {
    open: true,
    type: 'confirm',
    message: 'Continue?',
    defaultPrompt: '',
    url: 'https://example.com',
    openedAt: new Date().toISOString(),
  }
}

describe('command router modal blocking', () => {
  test('blocks interactive commands with a MODAL_OPEN error when the target tab has an open dialog', async () => {
    const { router, state } = createMinimalRouter()
    state.session.dialogs.set(1, openConfirmDialog(1))

    await expect(
      router.handleCommand({ command: 'click', args: { tabId: 1, selector: '#ok' } }),
    ).rejects.toMatchObject({
      code: 'MODAL_OPEN',
      message: 'page has an open confirm dialog: Continue?',
      suggestedAction: expect.stringContaining("run 'dialog accept'"),
      details: { type: 'confirm', message: 'Continue?' },
    })
  })

  test('blocks goto/wait/type while a dialog is open', async () => {
    const { router, state, navigateCalls } = createMinimalRouter()
    state.session.dialogs.set(1, openConfirmDialog(1))

    await expect(
      router.handleCommand({ command: 'goto', args: { tabId: 1, url: 'https://example.com/x' } }),
    ).rejects.toMatchObject({ code: 'MODAL_OPEN' })
    await expect(
      router.handleCommand({ command: 'wait', args: { tabId: 1, selector: '#done' } }),
    ).rejects.toMatchObject({ code: 'MODAL_OPEN' })
    await expect(
      router.handleCommand({ command: 'type', args: { tabId: 1, selector: '#q', value: 'x' } }),
    ).rejects.toMatchObject({ code: 'MODAL_OPEN' })
    expect(navigateCalls).toHaveLength(0)
  })

  test('does not block dialog, query and snapshot commands while a dialog is open', async () => {
    const { router, state, snapshotCalls } = createMinimalRouter()
    const dialog = openConfirmDialog(1)
    state.session.dialogs.set(1, dialog)

    const status = await router.handleCommand({ command: 'dialog', args: { action: 'status' } })
    expect(status).toEqual({
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta({
        dialog: { type: dialog.type, message: dialog.message, openedAt: dialog.openedAt },
      }),
    })

    const handled = await router.handleCommand({
      command: 'dialog',
      args: { tabId: 1, accept: true, promptText: 'Continue?' },
    })
    expect(handled).toBeUndefined()

    const consoleResult = await router.handleCommand({ command: 'console' })
    expect(consoleResult).toEqual({
      messages: [],
      pagination: singlePageInfo(0),
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta({
        dialog: { type: dialog.type, message: dialog.message, openedAt: dialog.openedAt },
      }),
    })

    const snapshot = await router.handleCommand({ command: 'snapshot', args: { tabId: 1 } })
    expect(snapshot).toEqual(expect.objectContaining({ snapshotId: 'snapshot-1' }))
    expect(snapshotCalls).toHaveLength(1)
  })

  test('routes search to the page observe domain while a dialog is open', async () => {
    const { router, state, searchCalls } = createMinimalRouter()
    const dialog = openConfirmDialog(1)
    state.session.dialogs.set(1, dialog)

    const result = await router.handleCommand({
      command: 'search',
      args: { tabId: 1, query: 'Sign in', context: 2, limit: 5 },
    })

    expect(searchCalls).toHaveLength(1)
    expect(searchCalls[0]).toEqual({
      tabId: 1,
      options: { query: 'Sign in', context: 2, limit: 5, responseFormat: 'concise' },
      frameSelector: null,
    })
    expect(result).toEqual(
      expect.objectContaining({
        readyState: 'complete',
        meta: explicitTabMeta({
          dialog: { type: dialog.type, message: dialog.message, openedAt: dialog.openedAt },
        }),
      }),
    )
  })

  test('blocks via getTargetTab fallback when no explicit target is given', async () => {
    const { router, state } = createMinimalRouter()
    state.session.dialogs.set(1, openConfirmDialog(1))

    await expect(
      router.handleCommand({ command: 'click', args: { selector: '#ok' } }),
    ).rejects.toMatchObject({ code: 'MODAL_OPEN' })
  })

  test('blocks via getTargetTab fallback when only a handle is given', async () => {
    const { router, state } = createMinimalRouter()
    state.session.dialogs.set(1, openConfirmDialog(1))

    // handle 未登记在 tabIdsByHandle 时，兜底走 getTargetTab 解析实际目标 tab
    await expect(
      router.handleCommand({ command: 'click', args: { handle: 't1', selector: '#ok' } }),
    ).rejects.toMatchObject({ code: 'MODAL_OPEN' })
  })

  test('does not block when the dialog is on a different tab', async () => {
    const { router, state } = createMinimalRouter()
    state.session.dialogs.set(2, openConfirmDialog(2))

    const result = await router.handleCommand({
      command: 'click',
      args: { tabId: 1, selector: '#ok' },
    })
    expect(result).toEqual({ found: true, selector: '#ok', meta: explicitTabMeta() })
  })
})

describe('command router recovery control plane', () => {
  test('extension actions do not resolve a tab or wait for the page queue', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let targetCalls = 0
    const { router, state } = createMinimalRouter({
      getTargetTab: async () => {
        targetCalls += 1
        return { id: 1 }
      },
      navigateTo: async () => {
        entered()
        return await new Promise(() => {})
      },
    })
    const stuck = router.handleCommand({
      command: 'goto',
      id: 'extension-stuck',
      args: { url: 'https://stuck' },
    })
    await started
    const callsBefore = targetCalls
    state.session.dialogs.set(1, { open: true, type: 'confirm', message: 'blocked' } as DialogState)
    try {
      for (const action of ['reload', 'reconnect']) {
        expect(await router.handleCommand({ command: 'extension', args: { action } })).toEqual({
          [action === 'reload' ? 'reloading' : 'reconnecting']: true,
          reconnectExpected: true,
          meta: EMPTY_META,
        })
      }
      expect(
        await router.handleCommand({ command: 'extension', args: { action: 'info' } }),
      ).toEqual({
        extensionId: 'test-extension',
        version: '0.1.3',
        buildTime: null,
        commit: null,
        userAgent: 'test-browser',
        meta: EMPTY_META,
      })
      expect(targetCalls).toBe(callsBefore)
      await expect(
        router.handleCommand({ command: 'extension', args: { action: 'restart' } }),
      ).rejects.toThrow('action must be info, reload or reconnect')
    } finally {
      router.cancelCommand('extension-stuck')
      await stuck.catch(() => {})
    }
  })

  test('tab control remains available while a page command is stuck', async () => {
    const { router, state } = createMinimalRouter({
      navigateTo: async () => new Promise(() => {}),
      listTabs: async () => [
        {
          id: 2,
          handle: 't2',
          title: 'healthy',
          url: 'https://example.com',
          active: true,
          pinned: false,
          status: 'complete',
          windowId: 1,
        },
      ],
    })
    state.targeting.targetTabId = 1
    void router
      .handleCommand({ command: 'goto', id: 'stuck', args: { url: 'https://stuck' } })
      .catch(() => {})

    const result = await router.handleCommand({ command: 'tab.list' })
    expect(result).toMatchObject({ total: 1, tabs: [{ handle: 't2' }] })
    const cancelled = await router.handleCommand({
      command: 'command',
      args: { action: 'cancel', commandId: 'stuck' },
    })
    expect(cancelled).toMatchObject({ commandId: 'stuck', cancelled: true })
  })
})

describe('command router eval cancellation', () => {
  test('applies the concise result budget and leaves detailed eval uncapped by default', async () => {
    const { router, evalCalls } = createMinimalRouter()

    await router.handleCommand({ command: 'eval', args: { script: '1 + 1' } })
    await router.handleCommand({
      command: 'eval',
      args: { script: '1 + 1', responseFormat: 'detailed' },
    })

    expect(evalCalls.map((call) => call.maxResultBytes)).toEqual([32_768, undefined])
  })

  test('terminates a running eval and lets subsequent tab commands run', async () => {
    let releaseEval!: (value: unknown) => void
    let evalEntered!: () => void
    const evalStarted = new Promise<void>((resolve) => {
      evalEntered = resolve
    })
    const evalGate = new Promise((resolve) => {
      releaseEval = resolve
    })

    const { router, cdpCalls, evalCalls, snapshotCalls } = createMinimalRouter({
      evaluateScript: async () => {
        evalEntered()
        return await evalGate
      },
    })

    const evalPromise = router.handleCommand({
      command: 'eval',
      id: 'eval-running',
      args: { tabId: 1, script: 'while (true) {}' },
    })
    await evalStarted
    expect(evalCalls).toHaveLength(1)

    expect(router.cancelCommand('eval-running')).toBe(true)
    // 运行中的 eval 使用 pin 后的真实 tabId 定向中断
    expect(cdpCalls).toEqual([{ tabId: 1, method: 'Runtime.terminateExecution', params: {} }])

    // 队列已脱钩：同 tab 的后继命令无需等待被中断的 eval
    const snapshot = await router.handleCommand({ command: 'snapshot', args: { tabId: 1 } })
    expect(snapshot).toMatchObject({ snapshotId: 'snapshot-1' })
    expect(snapshotCalls).toHaveLength(1)

    releaseEval({ province: '江西', timepoints: 24 })
    await evalPromise.catch(() => {})
    await Bun.sleep(0)

    const status = await router.handleCommand({
      command: 'command',
      args: { action: 'status', commandId: 'eval-running' },
    })
    expect(status).toMatchObject({
      commands: [
        {
          id: 'eval-running',
          state: 'completed_late',
          result: { province: '江西', timepoints: 24 },
        },
      ],
    })
  })

  test('does not terminate an eval that is still queued', async () => {
    let releaseBlocker!: () => void
    let blockerEntered!: () => void
    const blockerStarted = new Promise<void>((resolve) => {
      blockerEntered = resolve
    })
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })

    const { router, cdpCalls, evalCalls } = createMinimalRouter({
      navigateTo: async () => {
        blockerEntered()
        await blockerGate
        return { navigated: true }
      },
    })

    const blocker = router.handleCommand({
      command: 'goto',
      id: 'blocker',
      args: { tabId: 1, url: 'https://example.com' },
    })
    await blockerStarted

    const queuedEval = router.handleCommand({
      command: 'eval',
      id: 'eval-queued',
      args: { tabId: 1, script: '1 + 1' },
    })
    // 给调度完整的执行机会：eval 仍应停在队列里，未真正开始
    await Bun.sleep(5)
    expect(evalCalls).toHaveLength(0)

    const cancelled = await router.handleCommand({
      command: 'command',
      args: { action: 'cancel', commandId: 'eval-queued' },
    })
    expect(cancelled).toMatchObject({ commandId: 'eval-queued', cancelled: true })
    expect(cdpCalls).toEqual([])

    releaseBlocker()
    await blocker
    await queuedEval.catch(() => {})
  })

  test('does not terminate a cancelled non-eval command', async () => {
    let releaseBlocker!: () => void
    let blockerEntered!: () => void
    const blockerStarted = new Promise<void>((resolve) => {
      blockerEntered = resolve
    })
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })

    const { router, cdpCalls } = createMinimalRouter({
      navigateTo: async () => {
        blockerEntered()
        await blockerGate
        return { navigated: true }
      },
    })

    const blocker = router.handleCommand({
      command: 'goto',
      id: 'goto-running',
      args: { tabId: 1, url: 'https://example.com' },
    })
    await blockerStarted

    expect(router.cancelCommand('goto-running')).toBe(true)
    expect(cdpCalls).toEqual([])

    releaseBlocker()
    await blocker.catch(() => {})
  })
})

describe('command router console/errors tab isolation', () => {
  test('console returns all messages when no tab target is resolved', async () => {
    const { router, state } = createMinimalRouter()
    state.session.consoleMessages.push(
      { type: 'log', text: 'from tab 1', timestamp: 1, tabId: 1 },
      { type: 'error', text: 'from tab 2', timestamp: 2, tabId: 2 },
      { type: 'warn', text: 'no tab', timestamp: 3, tabId: null },
    )

    const result = await router.handleCommand({ command: 'console' })

    // 数据查询的过滤口径独立于页面操作目标：未解析出目标时仍是全局查询
    expect(result).toEqual({
      messages: [
        { type: 'log', text: 'from tab 1', timestamp: 1, tabId: 1 },
        { type: 'error', text: 'from tab 2', timestamp: 2, tabId: 2 },
        { type: 'warn', text: 'no tab', timestamp: 3, tabId: null },
      ],
      pagination: singlePageInfo(3),
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })
  })

  test('console clear empties every tab buffer when no tab target is resolved', async () => {
    const { router, state } = createMinimalRouter()
    state.session.consoleMessages.push(
      { type: 'log', text: 'tab1 msg', timestamp: 1, tabId: 1 },
      { type: 'log', text: 'tab2 msg', timestamp: 2, tabId: 2 },
      { type: 'log', text: 'no tab msg', timestamp: 3, tabId: null },
    )

    const result = await router.handleCommand({ command: 'console', args: { action: 'clear' } })

    expect(result).toMatchObject({ cleared: 3 })
    expect(state.session.consoleMessages).toEqual([])
  })

  test('console clear only drops the target tab buffer when a tab resolves', async () => {
    const { router, state } = createMinimalRouter()
    state.session.consoleMessages.push(
      { type: 'log', text: 'tab1 msg', timestamp: 1, tabId: 1 },
      { type: 'log', text: 'tab2 msg', timestamp: 2, tabId: 2 },
    )

    const result = await router.handleCommand({
      command: 'console',
      args: { action: 'clear', tabId: 2 },
    })

    expect(result).toMatchObject({ cleared: 1 })
    expect(
      state.session.consoleMessages.map((message) => (message as { text: string }).text),
    ).toEqual(['tab1 msg'])
  })

  test('network requests keeps the global scope without a tab target and filters across tabs with one', async () => {
    const { router, state, listRequestsCalls } = createMinimalRouter()
    state.targeting.targetTabId = null

    await router.handleCommand({ command: 'network', args: { action: 'requests' } })
    await router.handleCommand({ command: 'network', args: { action: 'requests', tabId: 2 } })

    // 未解析出目标时不注入 tabId 过滤（全局），显式指定时按该 tab 过滤
    expect(listRequestsCalls[0]).not.toHaveProperty('tabId')
    expect(listRequestsCalls[1]).toMatchObject({ tabId: 2 })
  })

  test('console filters messages by explicit tabId', async () => {
    const { router, state } = createMinimalRouter()
    state.session.consoleMessages.push(
      { type: 'log', text: 'tab1 msg', timestamp: 1, tabId: 1 },
      { type: 'log', text: 'tab2 msg', timestamp: 2, tabId: 2 },
    )

    const result = await router.handleCommand({ command: 'console', args: { tabId: 2 } })

    expect(result).toEqual({
      messages: [{ type: 'log', text: 'tab2 msg', timestamp: 2, tabId: 2 }],
      pagination: singlePageInfo(1),
      meta: explicitTabMeta(),
    })
  })

  test('console resolves handle to its tab id for filtering', async () => {
    const { router, state } = createMinimalRouter()
    state.targeting.tabIdsByHandle.set('t7', 7)
    state.session.consoleMessages.push(
      { type: 'log', text: 'tab7 msg', timestamp: 1, tabId: 7 },
      { type: 'log', text: 'tab1 msg', timestamp: 2, tabId: 1 },
    )

    const result = await router.handleCommand({ command: 'console', args: { handle: 't7' } })

    expect(result).toEqual({
      messages: [{ type: 'log', text: 'tab7 msg', timestamp: 1, tabId: 7 }],
      pagination: singlePageInfo(1),
      meta: explicitTabMeta(),
    })
  })

  test('console folds consecutive identical messages with repeatCount', async () => {
    const { router, state } = createMinimalRouter()
    state.session.consoleMessages.push(
      { type: 'log', text: 'same', timestamp: 1, tabId: 1 },
      { type: 'log', text: 'same', timestamp: 2, tabId: 1 },
      { type: 'log', text: 'same', timestamp: 3, tabId: 1 },
      { type: 'log', text: 'other', timestamp: 4, tabId: 1 },
      { type: 'log', text: 'same', timestamp: 5, tabId: 1 },
    )

    const result = await router.handleCommand({ command: 'console', args: { tabId: 1 } })

    expect(result).toEqual({
      messages: [
        { type: 'log', text: 'same', timestamp: 3, tabId: 1, repeatCount: 3 },
        { type: 'log', text: 'other', timestamp: 4, tabId: 1 },
        { type: 'log', text: 'same', timestamp: 5, tabId: 1 },
      ],
      pagination: singlePageInfo(3),
      meta: explicitTabMeta(),
    })
    // 折叠不改动原始数组，只影响返回快照
    expect(state.session.consoleMessages).toHaveLength(5)
  })

  test('errors are filtered by tab and not folded', async () => {
    const { router, state } = createMinimalRouter()
    state.session.pageErrors.push(
      { error: 'boom', url: 'https://a', timestamp: 1, tabId: 1 },
      { error: 'boom', url: 'https://a', timestamp: 2, tabId: 1 },
      { error: 'boom', url: 'https://b', timestamp: 3, tabId: 2 },
    )

    const result = await router.handleCommand({ command: 'errors', args: { tabId: 1 } })

    expect(result).toEqual({
      errors: [
        { error: 'boom', url: 'https://a', timestamp: 1, tabId: 1 },
        { error: 'boom', url: 'https://a', timestamp: 2, tabId: 1 },
      ],
      pagination: singlePageInfo(2),
      meta: explicitTabMeta(),
    })
  })
})

describe('command router list pagination', () => {
  test('console paginates after tab filtering with hasNextPage flags', async () => {
    const { router, state } = createMinimalRouter()
    for (let index = 1; index <= 5; index += 1) {
      state.session.consoleMessages.push({
        type: 'log',
        text: `msg ${index}`,
        timestamp: index,
        tabId: 1,
      })
    }

    const first = (await router.handleCommand({
      command: 'console',
      args: { tabId: 1, pageSize: 2, pageIdx: 0 },
    })) as { messages: unknown[]; pagination: Record<string, unknown> }

    expect(first.messages.map((message) => (message as { text: string }).text)).toEqual([
      'msg 1',
      'msg 2',
    ])
    expect(first.pagination).toMatchObject({
      currentPage: 0,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: 2,
      invalidPage: false,
    })
    expect(first.pagination.nextCursor).toBeString()

    const middle = (await router.handleCommand({
      command: 'console',
      args: { tabId: 1, pageSize: 2, pageIdx: 1 },
    })) as { messages: unknown[]; pagination: Record<string, unknown> }
    expect(middle.messages.map((message) => (message as { text: string }).text)).toEqual([
      'msg 3',
      'msg 4',
    ])
    expect(middle.pagination).toMatchObject({
      currentPage: 1,
      hasNextPage: true,
      hasPreviousPage: true,
      startIndex: 2,
      endIndex: 4,
      invalidPage: false,
    })
  })

  test('console filters level before folding and paginating results', async () => {
    const { router, state } = createMinimalRouter()
    for (const [index, type] of ['log', 'error', 'debug', 'warning', 'log'].entries()) {
      state.session.consoleMessages.push({
        type,
        text: `msg ${index + 1}`,
        timestamp: index + 1,
        tabId: 1,
      })
    }

    const first = (await router.handleCommand({
      command: 'console',
      args: { tabId: 1, level: 'warning', pageSize: 1, pageIdx: 0 },
    })) as { messages: Array<{ type: string }>; pagination: Record<string, unknown> }
    expect(first.messages.map((message) => message.type)).toEqual(['error'])
    expect(first.pagination).toMatchObject({ totalPages: 2, hasNextPage: true, endIndex: 1 })

    const second = (await router.handleCommand({
      command: 'console',
      args: { tabId: 1, level: 'warning', pageSize: 1, pageIdx: 1 },
    })) as { messages: Array<{ type: string }>; pagination: Record<string, unknown> }
    expect(second.messages.map((message) => message.type)).toEqual(['warning'])
    expect(second.pagination).toMatchObject({
      currentPage: 1,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
      endIndex: 2,
    })
  })

  test('console falls back to the first page with invalidPage for an out-of-range pageIdx', async () => {
    const { router, state } = createMinimalRouter()
    state.session.consoleMessages.push(
      { type: 'log', text: 'only msg', timestamp: 1, tabId: 1 },
      { type: 'log', text: 'other tab', timestamp: 2, tabId: 2 },
    )

    const result = (await router.handleCommand({
      command: 'console',
      args: { tabId: 1, pageSize: 1, pageIdx: 9 },
    })) as { messages: unknown[]; pagination: Record<string, unknown> }

    // 越界不报错：回退第一页，只含 tabId=1 过滤后的消息
    expect(result.messages.map((message) => (message as { text: string }).text)).toEqual([
      'only msg',
    ])
    expect(result.pagination).toEqual({
      currentPage: 0,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: 1,
      invalidPage: true,
    })
  })

  test('errors paginate after the tabId filter', async () => {
    const { router, state } = createMinimalRouter()
    state.session.pageErrors.push(
      { error: 'tab1 a', url: null, timestamp: 1, tabId: 1 },
      { error: 'tab2 x', url: null, timestamp: 2, tabId: 2 },
      { error: 'tab1 b', url: null, timestamp: 3, tabId: 1 },
    )

    const result = (await router.handleCommand({
      command: 'errors',
      args: { tabId: 1, pageSize: 1, pageIdx: 1 },
    })) as { errors: unknown[]; pagination: Record<string, unknown> }

    expect(result.errors.map((error) => (error as { error: string }).error)).toEqual(['tab1 b'])
    expect(result.pagination).toEqual({
      currentPage: 1,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
      startIndex: 1,
      endIndex: 2,
      invalidPage: false,
    })
  })
})

describe('command router window/downloads/dialog-auto routing', () => {
  function defineGlobalValue(name: string, value: unknown): void {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    })
  }

  test('window new remembers the new tab as the command target', async () => {
    const originalChrome = globalThis.chrome
    defineGlobalValue('chrome', {
      runtime: { lastError: undefined },
      windows: {
        // chrome.js 的 runChromeCallback 通过回调收结果，mock 必须显式调用 callback
        create: (_createData: unknown, callback: (window: unknown) => void) => {
          callback({ id: 10, tabs: [{ id: 5 }] })
        },
      },
    })

    try {
      const { router, state } = createMinimalRouter()
      const result = (await router.handleCommand({
        command: 'window',
        args: { action: 'new' },
      })) as { windowId: number; tabId: number }

      expect(result).toMatchObject({ windowId: 10, tabId: 5 })
      // 新窗口的第一个 tab 成为后续命令的默认目标
      expect(state.targeting.targetTabId).toBe(5)
    } finally {
      defineGlobalValue('chrome', originalChrome)
    }
  })

  test('validates and forwards download retry options with the original deadline', async () => {
    const calls: Record<string, unknown>[] = []
    const { router } = createMinimalRouter({
      download: async (args) => {
        calls.push(args)
        return {}
      },
    })
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    for (const retries of [0, 5]) {
      await router.handleCommand({
        command: 'download',
        id: `retry_${retries}`,
        deadlineAt,
        args: {
          url: 'https://example.com/file',
          outputPath: '/tmp/file',
          retries,
          retryDelayMs: 17,
        },
      })
      expect(calls.at(-1)).toMatchObject({
        url: 'https://example.com/file',
        retries,
        retryDelayMs: 17,
        requestId: `retry_${retries}`,
        deadlineAt,
      })
      expect(calls.at(-1)!.context).toBeDefined()
    }
    for (const args of [{ retries: 6 }, { retryDelayMs: 60_001 }, { retries: 1.5 }]) {
      await expect(
        router.handleCommand({
          command: 'download',
          args: { url: 'https://example.com/file', outputPath: '/tmp/file', ...args },
        }),
      ).rejects.toThrow()
    }
    expect(calls).toHaveLength(2)
  })

  test('downloads list defaults to the first page and passes pagination through', async () => {
    const { router, downloadsCalls } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'downloads',
      args: { action: 'list', pageIdx: 2, pageSize: 10 },
    })) as { downloads: unknown[]; total: number }

    expect(result).toMatchObject({ downloads: [], total: 0 })
    expect(downloadsCalls).toContainEqual({ method: 'list', args: [2, 10] })
  })

  test('downloads without an action falls back to list', async () => {
    const { router, downloadsCalls } = createMinimalRouter()

    await router.handleCommand({ command: 'downloads', args: {} })

    expect(downloadsCalls.some((call) => call.method === 'list')).toBe(true)
  })

  test('downloads clear empties the buffer through the domain', async () => {
    const { router, downloadsCalls } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'downloads',
      args: { action: 'clear' },
    })) as { cleared: number }

    expect(result).toMatchObject({ cleared: 0 })
    expect(downloadsCalls).toContainEqual({ method: 'clear', args: [] })
  })

  test('dialog auto without enabled queries the current flag', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'dialog',
      args: { action: 'auto' },
    })) as { autoAccept: boolean }

    expect(result).toMatchObject({ autoAccept: true })
  })

  test('dialog auto with enabled updates the runtime flag', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'dialog',
      args: { action: 'auto', enabled: false },
    })) as { autoAccept: boolean }

    expect(result).toMatchObject({ autoAccept: false })
  })
})

describe('observer and asynchronous network routing', () => {
  test('passes search continuation to the domain', async () => {
    const { router, searchCalls } = createMinimalRouter()
    await router.handleCommand({ command: 'search', args: { query: 'x', startLine: 201 } })
    expect(searchCalls[0]?.options).toMatchObject({ startLine: 201 })
  })

  test('requires uniqueness only for actions without an explicit position', async () => {
    const options: unknown[] = []
    const { router } = createMinimalRouter({
      findSemanticTarget: async (_tab, opts) => {
        options.push(opts)
        return { match: { ref: '@e1' } }
      },
    })
    for (const args of [
      { action: 'locate' },
      { action: 'text' },
      { action: 'click' },
      { action: 'click', position: 'first' },
    ]) {
      await router.handleCommand({
        command: 'find',
        args: { strategy: 'text', query: 'x', ...args },
      })
    }
    expect(options.map((option) => (option as { requireUnique: boolean }).requireUnique)).toEqual([
      false,
      false,
      true,
      false,
    ])
  })

  test('awaits asynchronous request details and preserves errors and result metadata', async () => {
    const { router } = createMinimalRouter({
      getRequestDetail: async () => {
        await Bun.sleep(1)
        return { requestId: 'r1', body: 'loaded' }
      },
    })
    await expect(
      router.handleCommand({ command: 'network', args: { action: 'request', requestId: 'r1' } }),
    ).resolves.toMatchObject({ body: 'loaded', meta: expect.any(Object) })
    const failing = createMinimalRouter({
      getRequestDetail: async () => {
        throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
      },
    })
    await expect(
      failing.router.handleCommand({
        command: 'network',
        args: { action: 'request', requestId: 'r1' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('batch cancellation lifecycle', () => {
  for (const mode of ['cancel', 'reset', 'deadline'] as const) {
    test(`${mode} stops nested steps and retries after an in-flight operation`, async () => {
      let release!: () => void
      let started!: () => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      let calls = 0
      const { router, navigateCalls } = createMinimalRouter({
        snapshotTab: async () => {
          calls++
          started()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          throw new Error('late failure')
        },
      })
      const pending = router.handleCommand({
        id: 'cancel-batch',
        command: 'batch',
        ...(mode === 'deadline' ? { deadlineAt: new Date(Date.now() + 40).toISOString() } : {}),
        args: {
          continueOnError: true,
          retries: 2,
          steps: [
            {
              command: 'batch',
              args: {
                continueOnError: true,
                retries: 2,
                steps: ['snapshot', { command: 'goto', args: { url: 'https://nested.example' } }],
              },
            },
            { command: 'goto', args: { url: 'https://outer.example' } },
          ],
        },
      })
      const outcome = pending.catch((error) => error)
      await entered
      if (mode === 'cancel') expect(router.cancelCommand('cancel-batch')).toBe(true)
      if (mode === 'reset') {
        await router.handleCommand({
          command: 'command',
          args: { action: 'reset', queueKey: 'default' },
        })
      }
      if (mode === 'deadline') await Bun.sleep(60)
      release()
      expect(await outcome).toMatchObject({ code: 'COMMAND_CANCELLED' })
      await Bun.sleep(10)
      expect(calls).toBe(1)
      expect(navigateCalls).toHaveLength(0)
      await expect(router.handleCommand({ command: 'status' })).resolves.toMatchObject({
        connected: true,
      })
    })
  }

  test('cancel during retry delay never starts another attempt or next step', async () => {
    let calls = 0
    const { router, navigateCalls } = createMinimalRouter({
      snapshotTab: async () => {
        calls++
        throw new Error('retry me')
      },
    })
    const pending = router.handleCommand({
      id: 'retry-delay',
      command: 'batch',
      args: {
        retries: 2,
        retryDelayMs: 40,
        continueOnError: true,
        steps: ['snapshot', { command: 'goto', args: { url: 'https://next.example' } }],
      },
    })
    const outcome = pending.catch((error) => error)
    await Bun.sleep(10)
    expect(calls).toBe(1)
    expect(router.cancelCommand('retry-delay')).toBe(true)
    expect(await outcome).toMatchObject({ code: 'COMMAND_CANCELLED' })
    await Bun.sleep(60)
    expect(calls).toBe(1)
    expect(navigateCalls).toHaveLength(0)
  })

  test('cancelled successful step cannot start the following step', async () => {
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const { router, navigateCalls } = createMinimalRouter({
      snapshotTab: async () => {
        started()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { done: true }
      },
    })
    const outcome = router
      .handleCommand({
        id: 'success-cancel',
        command: 'batch',
        args: {
          steps: ['snapshot', { command: 'goto', args: { url: 'https://next.example' } }],
        },
      })
      .catch((error) => error)
    await entered
    router.cancelCommand('success-cancel')
    release()
    expect(await outcome).toMatchObject({ code: 'COMMAND_CANCELLED' })
    await Bun.sleep(10)
    expect(navigateCalls).toHaveLength(0)
  })
})

describe('stale tab handle errors', () => {
  test('createStaleTabHandleError carries a machine-readable code and guidance', () => {
    const error = createStaleTabHandleError('t99')

    expect(error).toMatchObject({
      message: 'tab not found: t99',
      code: 'STALE_TAB_HANDLE',
      suggestedAction: 'Run tab list to see open tabs and refresh handles.',
    })
  })

  test('stale tab handle errors propagate through the command path unchanged', async () => {
    const { router } = createMinimalRouter({
      getTargetTab: async () => {
        throw createStaleTabHandleError('t99')
      },
    })

    await expect(
      router.handleCommand({ command: 'tab.select', args: { handle: 't99' } }),
    ).rejects.toMatchObject({
      code: 'STALE_TAB_HANDLE',
      suggestedAction: 'Run tab list to see open tabs and refresh handles.',
    })
  })
})

describe('command target pinning', () => {
  test('applies a handle target to the page action and to meta', async () => {
    // 生产环境 getTargetTab 对无法解析的目标回落到当前 targetTabId，
    // 这里用同样的回落规则暴露"handle 只进 meta、页面动作仍打当前 tab"的缺陷
    const { router, state, clickCalls } = createMinimalRouter({
      getTargetTab: async (tabId?: unknown) => ({
        id: typeof tabId === 'number' ? tabId : 1,
      }),
    })
    state.targeting.targetTabId = 1
    // 生产环境 getOrCreateTabHandle 同时维护两个方向的映射
    state.targeting.tabHandles.set(2, 't2')
    state.targeting.tabIdsByHandle.set('t2', 2)

    const result = await router.handleCommand({
      command: 'click',
      args: { handle: 't2', selector: '#ok' },
    })

    expect(clickCalls).toEqual([{ tabId: 2, selector: '#ok' }])
    expect(result).toMatchObject({
      found: true,
      selector: '#ok',
      meta: {
        tabId: 2,
        tabHandle: 't2',
        target: { tabId: 2, handle: 't2', explicit: true },
      },
    })
  })

  test('keeps the pinned tab when the target tab changes while the command is queued', async () => {
    let releaseStuck!: () => void
    const { router, state, snapshotCalls } = createMinimalRouter({
      getTargetTab: async (tabId?: unknown) => ({ id: typeof tabId === 'number' ? tabId : 1 }),
      navigateTo: async (tabId: unknown, url: string) => {
        if (url === 'https://stuck') {
          await new Promise<void>((resolve) => {
            releaseStuck = resolve
          })
        }
        return { navigated: true, tabId, url }
      },
    })
    state.targeting.targetTabId = 1

    const stuck = router
      .handleCommand({ command: 'goto', args: { url: 'https://stuck' } })
      .catch(() => undefined)
    await Bun.sleep(5)
    // 无显式目标的命令按入队时的 targetTabId=1 排队
    const queued = router.handleCommand({ command: 'snapshot' })
    await Bun.sleep(5)

    // 生产环境执行过 tab 2 的命令后 targetTabId 会变成 2（getTargetTab 会 rememberTargetTab）
    await router.handleCommand({
      command: 'snapshot',
      args: { tabId: 2 },
    })
    state.targeting.targetTabId = 2
    releaseStuck()

    const queuedResult = (await queued) as { meta: Record<string, unknown> }
    await stuck
    // 最后一条是无显式目标、排队等待的那次 snapshot
    expect(snapshotCalls.at(-1)?.tabId).toBe(1)
    expect(queuedResult.meta.tabId).toBe(1)
  })

  test('reports a stale handle instead of silently acting on the current tab', async () => {
    // t99 会先派生回 tabId 99（SW 重启后句柄映射为空时也能解析），
    // 真正判定"已失效"的是浏览器侧的 tab 存在性校验，这里用同一个契约模拟。
    const { router, state, clickCalls } = createMinimalRouter({
      clickSelector: async (tabId?: unknown) => {
        if (tabId === 99) throw createStaleTabHandleError(tabId as never)
        return { clicked: true }
      },
    })
    state.targeting.targetTabId = 1

    await expect(
      router.handleCommand({ command: 'click', args: { handle: 't99', selector: '#ok' } }),
    ).rejects.toMatchObject({ code: 'STALE_TAB_HANDLE' })
    // 目标钉在 t99 上，没有静默回落到当前 tab 1
    expect(clickCalls).toEqual([{ tabId: 99, selector: '#ok' }])
  })

  test('pins each batch step when the step starts instead of pinning the whole batch', async () => {
    // page-input 内部在 focus 与 insert/Enter 之间会重新解析目标；
    // 可变变量模拟 step 执行期间另一条命令把 target 改成了 tab 2
    let currentTargetTabId: number | null = 1
    const resolvedTargets: Array<{ atFocus: unknown; atInsert: unknown }> = []
    const { router } = createMinimalRouter({
      typeIntoSelector: async (tabId: unknown) => {
        const atFocus = tabId ?? currentTargetTabId
        currentTargetTabId = 2
        resolvedTargets.push({ atFocus, atInsert: tabId ?? currentTargetTabId })
        return { found: true, selector: '#q', typed: true }
      },
    })

    await router.handleCommand({
      command: 'batch',
      args: { steps: [{ command: 'type', args: { selector: '#q', value: 'hi', submit: true } }] },
    })

    // step 开始时固定为 tab 1：focus 与后续输入/Enter 都留在 tab 1
    expect(resolvedTargets).toEqual([{ atFocus: 1, atInsert: 1 }])
  })

  test('lets a batch step that follows tab.select act on the newly selected tab', async () => {
    const originalChrome = globalThis.chrome
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        runtime: { lastError: undefined },
        tabs: {
          update: (_tabId: number, _props: unknown, callback: (tab: unknown) => void) => {
            callback({ id: 2, windowId: 1 })
          },
        },
        windows: {
          update: (_windowId: number, _info: unknown, callback: (window: unknown) => void) => {
            callback({ id: 1 })
          },
        },
      },
    })

    try {
      // 未指定目标时按当前 targetTabId 回落，模拟生产环境 loadTargetTab 的解析顺序
      const harness = createMinimalRouter({
        getTargetTab: async (tabId?: unknown) => ({
          id:
            typeof tabId === 'number'
              ? tabId
              : tabId === 't2'
                ? 2
                : (harness.state.targeting.targetTabId ?? 1),
        }),
      })
      const { router, typeCalls } = harness
      harness.state.targeting.targetTabId = 1
      harness.state.targeting.tabHandles.set(2, 't2')
      harness.state.targeting.tabIdsByHandle.set('t2', 2)

      await router.handleCommand({
        command: 'batch',
        args: {
          steps: [
            { command: 'tab.select', args: { handle: 't2' } },
            { command: 'type', args: { selector: '#q', value: 'hi' } },
          ],
        },
      })

      // 固定发生在每个 step 自己的执行前，因此后续 step 用的是 tab.select 之后的 target
      expect(typeCalls).toEqual([{ tabId: 2, selector: '#q', value: 'hi', submit: false }])
    } finally {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: originalChrome,
      })
    }
  })

  test('re-checks the dialog on the fixed tab right before a queued command runs', async () => {
    let releaseStuck!: () => void
    const { router, state, clickCalls } = createMinimalRouter({
      getTargetTab: async (tabId?: unknown) => ({ id: typeof tabId === 'number' ? tabId : 1 }),
      navigateTo: async (tabId: unknown, url: string) => {
        if (url === 'https://stuck') {
          await new Promise<void>((resolve) => {
            releaseStuck = resolve
          })
        }
        return { navigated: true, tabId, url }
      },
    })
    state.targeting.targetTabId = 1

    const stuck = router
      .handleCommand({ command: 'goto', args: { url: 'https://stuck' } })
      .catch(() => undefined)
    await Bun.sleep(5)
    const queued = router.handleCommand({ command: 'click', args: { selector: '#ok' } })
    await Bun.sleep(5)

    // 入队时没有对话框，排队期间页面弹出 confirm
    state.session.dialogs.set(1, openConfirmDialog(1))
    releaseStuck()

    await expect(queued).rejects.toMatchObject({ code: 'MODAL_OPEN' })
    await stuck
    expect(clickCalls).toEqual([])
  })
})

describe('raw CDP command', () => {
  test('forwards tab-scoped methods, params and results', async () => {
    const { router, cdpCalls } = createMinimalRouter({
      getTargetTab: async () => ({ id: 7 }),
      sendDebuggerCommand: async () => ({ value: 42 }),
    })
    const result = await router.handleCommand({
      command: 'cdp',
      args: {
        tabId: 7,
        method: 'Runtime.evaluate',
        params: { expression: '6 * 7', returnByValue: true },
      },
    })
    expect(cdpCalls).toEqual([
      {
        tabId: 7,
        method: 'Runtime.evaluate',
        params: { expression: '6 * 7', returnByValue: true },
      },
    ])
    expect(result).toMatchObject({ method: 'Runtime.evaluate', result: { value: 42 } })
  })

  test('propagates debugger failures', async () => {
    const failure = Object.assign(new Error('CDP failed'), { code: 'CDP_ERROR' })
    const { router } = createMinimalRouter({
      sendDebuggerCommand: async () => {
        throw failure
      },
    })
    await expect(
      router.handleCommand({ command: 'cdp', args: { method: 'Runtime.enable' } }),
    ).rejects.toBe(failure)
  })
})

describe('coordinate mouse and drop routing', () => {
  test('forwards drop data and frame targets', async () => {
    const { router, dropCalls } = createMinimalRouter()
    await router.handleCommand({
      command: 'drop',
      args: {
        selector: '#drop',
        frame: '@f1',
        data: { 'text/plain': 'hello' },
        files: [{ name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YQ==' }],
      },
    })
    expect(dropCalls[0]!.args.slice(0, 5)).toEqual([
      1,
      '#drop',
      { 'text/plain': 'hello' },
      [{ name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YQ==' }],
      '@f1',
    ])
  })

  test('forwards coordinates, button and wheel deltas', async () => {
    const { router, mouseCalls } = createMinimalRouter()
    await router.handleCommand({ command: 'mousemove', args: { x: 10, y: 20 } })
    await router.handleCommand({ command: 'mousedown', args: { button: 'right' } })
    await router.handleCommand({ command: 'mousewheel', args: { deltaX: 0, deltaY: 100 } })
    await router.handleCommand({ command: 'mouseup', args: {} })
    expect(mouseCalls.map((call) => call.method)).toEqual(['move', 'button', 'wheel', 'button'])
    expect(mouseCalls[0]!.args.slice(1, 3)).toEqual([10, 20])
    expect(mouseCalls[1]!.args.slice(1, 3)).toEqual([true, 'right'])
    expect(mouseCalls[2]!.args.slice(1, 3)).toEqual([0, 100])
    expect(mouseCalls[3]!.args.slice(1, 3)).toEqual([false, 'left'])
  })
})

describe('element tooling routing', () => {
  test('forwards locator and highlight targets', async () => {
    const { router, elementToolCalls } = createMinimalRouter()
    await router.handleCommand({ command: 'locator', args: { selector: '@e1', frame: '@f1' } })
    await router.handleCommand({
      command: 'highlight',
      args: { selector: '@e1', style: '2px solid red', frame: '@f1' },
    })
    expect(elementToolCalls[0]).toMatchObject({ method: 'locator' })
    expect(elementToolCalls[0]!.args.slice(1, 3)).toEqual(['@e1', '@f1'])
    expect(elementToolCalls[1]).toMatchObject({ method: 'highlight' })
    expect(elementToolCalls[1]!.args.slice(1, 5)).toEqual(['@e1', '2px solid red', false, '@f1'])
  })
})
