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
const EMPTY_META = {
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

function explicitTabMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return metaWithTarget({ tabId: 1, handle: 't1', explicit: true }, extra)
}

function fallbackTabMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return metaWithTarget(
    { tabId: 1, handle: 't1', explicit: false, note: 'fell back to last non-active tab' },
    extra,
  )
}

function ambientTabMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return metaWithTarget({ tabId: 1, handle: 't1', explicit: false }, extra)
}

// 单页内完整返回时的分页信息（console/errors/network requests 响应的固定字段）
function singlePageInfo(count: number): Record<string, unknown> {
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

function createMinimalRouter(overrides?: {
  getTargetTab?: (tabId?: unknown) => Promise<{ id: number }>
  snapshotTab?: (tabId: unknown, frameSelector: unknown, options?: unknown) => Promise<unknown>
  navigateTo?: (tabId: unknown, url: string) => Promise<unknown>
  listTabs?: () => Promise<unknown[]>
  findSemanticTarget?: (tabId: unknown, options: unknown, frame: unknown) => Promise<unknown>
  getRequestDetail?: () => Promise<unknown>
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
  const evalCalls: Array<{ tabId: unknown; script: unknown }> = []
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
      evaluateScript: async (tabId: unknown, script: unknown) => {
        evalCalls.push({ tabId, script })
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
          error.code = 'STALE_REFERENCE'
          error.suggestedAction = "run 'snapshot' to get fresh element references"
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
      ) => {
        waitSelectorCalls.push({ selector, state, timeout })
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
      stopHar: () => undefined,
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

describe('command router batch handling', () => {
  test('executes batch steps in sequence with a single command entry point', async () => {
    const { router, snapshotCalls, navigateCalls } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'batch',
      args: {
        steps: [{ command: 'snapshot' }, { command: 'goto', args: { url: 'https://example.com' } }],
      },
    })

    expect(snapshotCalls).toHaveLength(1)
    expect(navigateCalls).toHaveLength(1)
    expect(result).toEqual({
      steps: [
        {
          index: 1,
          command: 'snapshot',
          args: {},
          label: null,
          response: {
            ok: true,
            result: {
              snapshotId: 'snapshot-1',
              targetFallback: 'fell back to last non-active tab',
              meta: fallbackTabMeta(),
            },
          },
        },
        {
          index: 2,
          command: 'goto',
          args: { url: 'https://example.com' },
          label: null,
          response: {
            ok: true,
            result: {
              navigated: true,
              url: 'https://example.com',
              targetFallback: 'fell back to last non-active tab',
              meta: fallbackTabMeta({ url: 'https://example.com' }),
            },
          },
        },
      ],
      summary: {
        total: 2,
        completed: 2,
        succeeded: 2,
        failed: 0,
        skippedCount: 0,
        retried: 0,
        continueOnError: false,
        retries: 0,
        retryDelayMs: 0,
      },
      meta: EMPTY_META,
    })
  })

  test('routes feed collection through the page observer', async () => {
    const { router, feedCalls } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'feed',
      args: { tabId: 1 },
    })

    expect(feedCalls).toHaveLength(1)
    expect(feedCalls[0]).toMatchObject({
      tabId: 1,
      options: {
        selector: 'article',
        limit: 30,
        dedupe: 'url',
        maxScrolls: 20,
        pauseMs: 900,
        stallRounds: 3,
      },
      frameSelector: null,
    })
    expect(result).toEqual({
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
      meta: explicitTabMeta(),
    })
  })

  test('routes stable selector waits through the page observer', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'wait',
      args: {
        selector: 'article',
        state: 'stable',
        timeout: 1000,
      },
    })

    expect(result).toEqual({
      waited: true,
      condition: 'selector-stable',
      selector: 'article',
      state: 'stable',
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })
  })

  test('stops batch execution on the first failure and preserves partial steps', async () => {
    const { router, snapshotCalls, navigateCalls } = createMinimalRouter()

    await expect(
      router.handleCommand({
        command: 'batch',
        args: {
          steps: [{ command: 'snapshot' }, { command: 'goto', args: { url: 'chrome://settings' } }],
        },
      }),
    ).rejects.toMatchObject({
      code: 'BATCH_STEP_FAILED',
      details: {
        steps: [
          {
            index: 1,
            command: 'snapshot',
            response: {
              ok: true,
              result: { snapshotId: 'snapshot-1' },
            },
          },
          {
            index: 2,
            command: 'goto',
            response: {
              ok: false,
              error: {
                message: 'cannot access chrome:// and edge:// urls',
                code: 'EXTENSION_COMMAND_ERROR',
              },
            },
          },
        ],
        failedStep: {
          index: 2,
          command: 'goto',
          response: {
            ok: false,
            error: {
              message: 'cannot access chrome:// and edge:// urls',
              code: 'EXTENSION_COMMAND_ERROR',
            },
          },
        },
        summary: {
          total: 2,
          completed: 2,
          succeeded: 1,
          failed: 1,
          retried: 0,
          continueOnError: false,
          retries: 0,
          retryDelayMs: 0,
        },
      },
    })

    expect(snapshotCalls).toHaveLength(1)
    expect(navigateCalls).toHaveLength(1)
  })

  test('continues batch execution when requested and retries failed steps', async () => {
    const { router, snapshotCalls, navigateCalls } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        retries: 1,
        steps: [{ command: 'goto', args: { url: 'chrome://settings' } }, { command: 'snapshot' }],
      },
    })

    expect(result).toEqual({
      steps: [
        {
          index: 1,
          command: 'goto',
          args: { url: 'chrome://settings' },
          label: null,
          response: {
            ok: false,
            error: {
              message: 'cannot access chrome:// and edge:// urls',
              code: 'EXTENSION_COMMAND_ERROR',
            },
          },
        },
        {
          index: 2,
          command: 'snapshot',
          args: {},
          label: null,
          response: {
            ok: true,
            result: {
              snapshotId: 'snapshot-1',
              targetFallback: 'fell back to last non-active tab',
              meta: fallbackTabMeta(),
            },
          },
        },
      ],
      summary: {
        total: 2,
        completed: 2,
        succeeded: 1,
        failed: 1,
        skippedCount: 0,
        retried: 1,
        continueOnError: true,
        retries: 1,
        retryDelayMs: 0,
      },
      meta: EMPTY_META,
    })

    expect(snapshotCalls).toHaveLength(1)
    expect(navigateCalls).toHaveLength(2)
  })

  test('keeps AI guidance fields on batch step errors', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [{ command: 'click', args: { selector: '#missing' } }, { command: 'snapshot' }],
      },
    })

    const [failedStep] = (
      result as { steps: Array<{ response: { ok: boolean; error?: unknown } }> }
    ).steps
    expect(failedStep.response).toEqual({
      ok: false,
      error: {
        message: 'element not found: #missing',
        code: 'STALE_REFERENCE',
        suggestedAction: "run 'snapshot' to get fresh element references",
        ref: '#missing',
      },
    })
  })

  test('gates batch steps on a when condition with truthy', async () => {
    const { router } = createMinimalRouter()

    const hit = await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [
          { command: 'snapshot' },
          {
            command: 'click',
            args: { selector: '#btn' },
            when: { step: 1, path: 'snapshotId', truthy: true },
          },
        ],
      },
    })

    expect(hit).toEqual({
      steps: [
        {
          index: 1,
          command: 'snapshot',
          args: {},
          label: null,
          response: {
            ok: true,
            result: {
              snapshotId: 'snapshot-1',
              targetFallback: 'fell back to last non-active tab',
              meta: fallbackTabMeta(),
            },
          },
        },
        {
          index: 2,
          command: 'click',
          args: { selector: '#btn' },
          label: null,
          response: {
            ok: true,
            result: {
              found: true,
              selector: '#btn',
              targetFallback: 'fell back to last non-active tab',
              meta: fallbackTabMeta(),
            },
          },
        },
      ],
      summary: {
        total: 2,
        completed: 2,
        succeeded: 2,
        failed: 0,
        skippedCount: 0,
        retried: 0,
        continueOnError: true,
        retries: 0,
        retryDelayMs: 0,
      },
      meta: EMPTY_META,
    })

    // truthy 不命中：引用路径不存在 → 跳过
    const missRouter = createMinimalRouter()
    const miss = await missRouter.router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [
          { command: 'snapshot' },
          {
            command: 'click',
            args: { selector: '#btn' },
            when: { step: 1, path: 'missing', truthy: true },
          },
        ],
      },
    })

    expect(miss).toEqual({
      steps: [
        {
          index: 1,
          command: 'snapshot',
          args: {},
          label: null,
          response: {
            ok: true,
            result: {
              snapshotId: 'snapshot-1',
              targetFallback: 'fell back to last non-active tab',
              meta: fallbackTabMeta(),
            },
          },
        },
        {
          index: 2,
          command: 'click',
          args: { selector: '#btn' },
          label: null,
          skipped: true,
          reason: 'skipped: when condition not met (references step 1)',
        },
      ],
      summary: {
        total: 2,
        completed: 1,
        succeeded: 1,
        failed: 0,
        skippedCount: 1,
        retried: 0,
        continueOnError: true,
        retries: 0,
        retryDelayMs: 0,
      },
      meta: EMPTY_META,
    })
  })

  test('supports equals and exists predicates on snapshot result paths', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [
          { command: 'snapshot' },
          { command: 'snapshot', when: { step: 1, path: 'meta.tabId', equals: 1 } },
          { command: 'snapshot', when: { step: 1, path: 'meta', exists: true } },
          { command: 'snapshot', when: { step: 1, path: 'elements', exists: true } },
        ],
      },
    })) as {
      steps: Array<{
        index: number
        command: string
        args: Record<string, unknown>
        label: string | null
        skipped?: true
        reason?: string
      }>
      summary: { completed: number; skippedCount: number }
    }

    expect(result.steps.map((step) => step.skipped ?? false)).toEqual([false, false, false, true])
    expect(result.steps[3]).toEqual({
      index: 4,
      command: 'snapshot',
      args: {},
      label: null,
      skipped: true,
      reason: 'skipped: when condition not met (references step 1)',
    })
    expect(result.summary).toMatchObject({ completed: 3, skippedCount: 1 })

    // equals 不命中 → 跳过
    const miss = (await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [
          { command: 'snapshot' },
          { command: 'snapshot', when: { step: 1, path: 'meta.tabId', equals: 2 } },
        ],
      },
    })) as { steps: Array<{ command?: string; skipped?: true }>; summary: Record<string, unknown> }

    expect(miss.steps[1]).toMatchObject({
      index: 2,
      command: 'snapshot',
      skipped: true,
      reason: 'skipped: when condition not met (references step 1)',
    })
    expect(miss.summary).toMatchObject({
      completed: 1,
      succeeded: 1,
      failed: 0,
      skippedCount: 1,
    })
  })

  test('resolves when paths into array elements with dot notation', async () => {
    const { router } = createMinimalRouter({
      snapshotTab: async () => ({ snapshotId: 's', elements: [{ ref: '@e1' }] }),
    })

    const hit = (await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [
          { command: 'snapshot' },
          { command: 'snapshot', when: { step: 1, path: 'elements.0.ref', equals: '@e1' } },
        ],
      },
    })) as { steps: Array<{ skipped?: true }> }

    expect(hit.steps[1]).toMatchObject({ index: 2, command: 'snapshot' })
    expect(hit.steps[1]).not.toHaveProperty('skipped')

    const miss = (await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [
          { command: 'snapshot' },
          { command: 'snapshot', when: { step: 1, path: 'elements.0.ref', equals: '@e2' } },
        ],
      },
    })) as { steps: Array<{ skipped?: true }> }

    expect(miss.steps[1]).toMatchObject({ index: 2, skipped: true })
  })

  test('references earlier steps by id in a when condition', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [
          { command: 'snapshot', id: 'snap' },
          {
            command: 'click',
            args: { selector: '#btn' },
            when: { step: 'snap', path: 'snapshotId', truthy: true },
          },
        ],
      },
    })) as {
      steps: Array<{ id?: string; skipped?: true; response?: { ok: boolean } }>
    }

    expect(result.steps[0]).toMatchObject({ index: 1, id: 'snap' })
    expect(result.steps[1]).toMatchObject({ index: 2, response: { ok: true } })
    expect(result.steps[1]).not.toHaveProperty('skipped')
  })

  test('skips a when step whose referenced step failed', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        retries: 1,
        steps: [
          { command: 'goto', args: { url: 'chrome://settings' } },
          { command: 'snapshot', when: { step: 1, path: 'snapshotId', truthy: true } },
          { command: 'snapshot' },
        ],
      },
    })) as {
      steps: Array<{ skipped?: true; reason?: string }>
      summary: Record<string, unknown>
    }

    expect(result.steps[1]).toMatchObject({
      index: 2,
      skipped: true,
      reason: 'skipped: when condition not met (references step 1)',
    })
    expect(result.steps[2]).not.toHaveProperty('skipped')
    expect(result.summary).toMatchObject({
      total: 3,
      completed: 2,
      succeeded: 1,
      failed: 1,
      skippedCount: 1,
      retried: 1,
      continueOnError: true,
    })
  })

  test('terminates remaining steps when skipRemainingOnFailure is set', async () => {
    const { router, snapshotCalls, navigateCalls } = createMinimalRouter()

    const result = (await router.handleCommand({
      command: 'batch',
      args: {
        continueOnError: true,
        steps: [
          { command: 'snapshot' },
          {
            command: 'goto',
            args: { url: 'chrome://settings' },
            skipRemainingOnFailure: true,
          },
          { command: 'snapshot' },
          { command: 'snapshot' },
        ],
      },
    })) as {
      steps: Array<{ command?: string; skipped?: true; reason?: string }>
      summary: Record<string, unknown>
    }

    expect(snapshotCalls).toHaveLength(1)
    expect(navigateCalls).toHaveLength(1)
    expect(result.steps[2]).toMatchObject({
      index: 3,
      command: 'snapshot',
      skipped: true,
      reason: 'terminated: step 2 failed with skipRemainingOnFailure',
    })
    expect(result.steps[3]).toMatchObject({ index: 4, skipped: true })
    expect(result.summary).toEqual({
      total: 4,
      completed: 2,
      succeeded: 1,
      failed: 1,
      skippedCount: 2,
      retried: 0,
      continueOnError: true,
      retries: 0,
      retryDelayMs: 0,
      terminated: true,
    })
  })

  test('ignores skipRemainingOnFailure unless continueOnError is set', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({
        command: 'batch',
        args: {
          steps: [
            { command: 'snapshot' },
            {
              command: 'goto',
              args: { url: 'chrome://settings' },
              skipRemainingOnFailure: true,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'BATCH_STEP_FAILED' })
  })

  test('rejects invalid batch when conditions', async () => {
    const { router } = createMinimalRouter()

    const cases: Array<{ steps: Array<Record<string, unknown>>; message: string }> = [
      {
        steps: [{ command: 'snapshot' }, { command: 'snapshot', when: { step: 1 } }],
        message:
          'invalid command arguments for batch: step 2: when must declare exactly one of equals, truthy, or exists',
      },
      {
        steps: [
          { command: 'snapshot' },
          { command: 'snapshot', when: { step: 0, path: 'x', truthy: true } },
        ],
        message:
          'invalid command arguments for batch: step 2: when.step must be a step id string or a positive integer',
      },
      {
        steps: [{ command: 'snapshot' }, { command: 'snapshot', when: { step: 1, truthy: 'yes' } }],
        message: 'invalid command arguments for batch: step 2: when.truthy must be a boolean',
      },
      {
        steps: [
          { command: 'snapshot' },
          { command: 'snapshot', when: { step: 'nope', path: 'x', truthy: true } },
        ],
        message:
          'invalid command arguments for batch: step 2: when.step must reference an earlier step: nope',
      },
      {
        steps: [
          { command: 'snapshot' },
          { command: 'snapshot', when: { step: 5, path: 'x', truthy: true } },
        ],
        message:
          'invalid command arguments for batch: step 2: when.step must reference an earlier step: 5',
      },
    ]

    for (const { steps, message } of cases) {
      await expect(
        router.handleCommand({ command: 'batch', args: { steps } }),
      ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
      await expect(router.handleCommand({ command: 'batch', args: { steps } })).rejects.toThrow(
        message,
      )
    }
  })

  test('rejects time waits without an explicit duration', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({
        command: 'wait',
        args: { type: 'time' },
      }),
    ).rejects.toThrow('wait type "time" requires a positive ms duration')
  })

  test('waits the explicit duration for time waits', async () => {
    const { router, waitTimeoutCalls } = createMinimalRouter()

    await router.handleCommand({
      command: 'wait',
      args: { type: 'time', ms: 50 },
    })

    expect(waitTimeoutCalls).toEqual([50])
  })

  test('reload can wait for a resulting url pattern', async () => {
    const { router, waitUrlCalls } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'reload',
      args: { waitUntil: 'none', waitFor: 'url', url: '#/outNet', timeoutMs: 5000 },
    })

    expect(result).toEqual({
      wait: { waited: true, condition: 'url', url: '#/outNet' },
      targetFallback: 'fell back to last non-active tab',
      meta: fallbackTabMeta(),
    })
    expect(waitUrlCalls).toEqual([{ url: '#/outNet', timeout: 5000 }])
  })
})

describe('command router network/session extensions', () => {
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
      { tabId: 1, options: { query: 'Sign in', context: 3, limit: 20 }, frameSelector: null },
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

function openConfirmDialog(_tabId: number): {
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
      options: { query: 'Sign in', context: 2, limit: 5 },
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

describe('command router meta context', () => {
  test('attaches target tab context to tab-target command results', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'goto',
      args: { tabId: 1, url: 'https://example.com' },
    })

    expect(result).toEqual({
      navigated: true,
      url: 'https://example.com',
      meta: explicitTabMeta({ url: 'https://example.com' }),
    })
  })

  test('attaches all-null meta to commands without page context', async () => {
    const { router } = createMinimalRouter()

    const status = await router.handleCommand({ command: 'status' })
    expect(status).toEqual({ connected: true, tabs: [], meta: EMPTY_META })

    const list = await router.handleCommand({ command: 'tab.list' })
    expect(list).toEqual({
      tabs: [],
      total: 0,
      pagination: singlePageInfo(0),
      meta: EMPTY_META,
    })
  })

  // 基线旧竞态：snapshot 已执行，但 meta 的 tab lookup 尚未返回时后继 frame 切换。
  for (const explicitFrame of [undefined, '#explicit', 'top']) {
    test(`snapshot metadata stays with its executed frame during a gated tab lookup (${explicitFrame})`, async () => {
      let releaseMeta!: () => void
      let enteredMeta!: () => void
      let enteredFollower!: () => void
      const metaGate = new Promise<void>((resolve) => {
        releaseMeta = resolve
      })
      const metaEntered = new Promise<void>((resolve) => {
        enteredMeta = resolve
      })
      const followerEntered = new Promise<void>((resolve) => {
        enteredFollower = resolve
      })
      let gateNextLookup = false
      let metadataWaiting = false
      const { router, state } = createMinimalRouter({
        getTargetTab: async () => {
          if (gateNextLookup) {
            gateNextLookup = false
            metadataWaiting = true
            enteredMeta()
            await metaGate
          } else if (metadataWaiting) enteredFollower()
          return { id: 1 }
        },
        snapshotTab: async (_tab, frame) => {
          const executedFrame =
            frame === 'top' ? null : frame || state.targeting.selectedFrames.get(1) || null
          gateNextLookup = true
          return { executedFrame }
        },
      })
      state.targeting.selectedFrames.set(1, '#frameA')
      const snapshot = router.handleCommand({
        command: 'snapshot',
        args: { tabId: 1, ...(explicitFrame ? { frame: explicitFrame } : {}) },
      })
      await metaEntered
      const follower = router.handleCommand({ command: 'frame', args: { selector: '#frameB' } })
      await followerEntered
      // 给后继命令完整的调度机会；它应停留在同 tab 队列，不能越过 metadata。
      await Bun.sleep(5)
      expect(state.targeting.selectedFrames.get(1)).toBe('#frameA')
      releaseMeta()
      const result = await snapshot
      const expected = explicitFrame === 'top' ? null : explicitFrame || '#frameA'
      expect(result).toMatchObject({ executedFrame: expected, meta: { frame: expected } })
      expect(await follower).toMatchObject({ meta: { frame: '#frameB' } })
      expect(
        await router.handleCommand({ command: 'frame', args: { tabId: 1, selector: 'top' } }),
      ).toMatchObject({ meta: { frame: null } })
    })
  }

  test('resolves effective frame selector into meta', async () => {
    const { router } = createMinimalRouter()

    // 'top' 归一化为 null
    const top = await router.handleCommand({
      command: 'snapshot',
      args: { tabId: 1, frame: 'top' },
    })
    expect(top).toMatchObject({ meta: { frame: null } })
  })

  test('resolves selected frame into meta when no explicit frame is given', async () => {
    const { router, state } = createMinimalRouter()
    state.targeting.selectedFrames.set(1, '@f1')

    const result = await router.handleCommand({
      command: 'snapshot',
      args: { tabId: 1 },
    })
    expect(result).toMatchObject({
      meta: { tabHandle: 't1', tabId: 1, frame: '@f1', pageEpoch: 1 },
    })
  })

  test('keeps a successful result even when target tab lookup fails', async () => {
    const { router } = createMinimalRouter({
      getTargetTab: async () => {
        throw new Error('tab gone')
      },
    })

    const result = await router.handleCommand({
      command: 'goto',
      args: { tabId: 1, url: 'https://example.com' },
    })

    expect(result).toEqual({
      navigated: true,
      url: 'https://example.com',
      meta: { ...EMPTY_META, url: 'https://example.com' },
    })
  })

  test('uses the fresh result url for meta when the tab snapshot is stale', async () => {
    // 导航命令返回时 tabsGet 可能还没反映新 URL，buildCommandMeta 会拿到旧值；
    // meta.url 必须以命令结果体里的 url 为准
    const { router } = createMinimalRouter({
      getTargetTab: async () => ({ id: 1, url: 'https://stale.example.com' }) as never,
    })

    const result = await router.handleCommand({
      command: 'goto',
      args: { tabId: 1, url: 'https://new.example.com' },
    })

    expect(result).toEqual({
      navigated: true,
      url: 'https://new.example.com',
      meta: explicitTabMeta({ url: 'https://new.example.com' }),
    })
  })
})

describe('command router recovery control plane', () => {
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

    releaseEval(undefined)
    await evalPromise.catch(() => {})
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
    expect(first.pagination).toEqual({
      currentPage: 0,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: 2,
      invalidPage: false,
    })

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

describe('command router meta dialog/emulation/target', () => {
  test('echoes an open dialog in meta', async () => {
    const { router, state } = createMinimalRouter()
    const dialog = openConfirmDialog(1)
    state.session.dialogs.set(1, dialog)

    const result = (await router.handleCommand({ command: 'console' })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta.dialog).toEqual({
      type: dialog.type,
      message: dialog.message,
      openedAt: dialog.openedAt,
    })
  })

  test('does not attach a dialog field when no dialog is open', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({ command: 'console' })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta).not.toHaveProperty('dialog')
  })

  test('echoes active emulation overrides in meta', async () => {
    const { router, state } = createMinimalRouter()
    state.session.emulation.set(1, { viewport: true, offline: true, headers: ['x-api-key'] })

    const result = (await router.handleCommand({ command: 'snapshot', args: { tabId: 1 } })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta.emulation).toEqual({
      viewport: true,
      offline: true,
      headers: ['x-api-key'],
    })
  })

  test('does not attach an emulation field without active overrides', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({ command: 'snapshot', args: { tabId: 1 } })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta).not.toHaveProperty('emulation')
  })

  test('target is explicit when tabId is given and omits the note', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({ command: 'snapshot', args: { tabId: 1 } })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta.target).toEqual({ tabId: 1, handle: 't1', explicit: true })
  })

  test('target omits the note when the ambient target already matches', async () => {
    const { router, state } = createMinimalRouter()
    // 无显式指定，但当前 targetTabId 与解析结果一致：不是兜底选择
    state.targeting.targetTabId = 1

    const result = (await router.handleCommand({ command: 'snapshot' })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta).toEqual(ambientTabMeta())
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
    const { router, state, clickCalls } = createMinimalRouter({
      getTargetTab: async (tabId?: unknown) => {
        if (typeof tabId === 'number') return { id: tabId }
        throw createStaleTabHandleError(tabId as never)
      },
    })
    state.targeting.targetTabId = 1

    await expect(
      router.handleCommand({ command: 'click', args: { handle: 't99', selector: '#ok' } }),
    ).rejects.toMatchObject({ code: 'STALE_TAB_HANDLE' })
    expect(clickCalls).toEqual([])
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

describe('diagnostics and automatic snapshots', () => {
  test('records successful and failed actions without argument values', async () => {
    const { router, state } = createMinimalRouter()
    await router.handleCommand({ command: 'click', args: { selector: '#safe' }, id: 'command-1' })
    await expect(
      router.handleCommand({ command: 'click', args: { selector: '#missing' }, id: 'command-2' }),
    ).rejects.toMatchObject({ code: 'STALE_REFERENCE' })
    const timeline = await router.handleCommand({ command: 'actions', args: { action: 'list' } })
    expect(timeline).toMatchObject({
      actions: [
        { id: 'command-1', command: 'click', ok: true },
        { id: 'command-2', command: 'click', ok: false },
      ],
    })
    expect(JSON.stringify(timeline)).not.toContain('#safe')
    expect(JSON.stringify(timeline)).not.toContain('#missing')
    expect(state.session.actionLog).toHaveLength(3)
    await expect(
      router.handleCommand({ command: 'actions', args: { action: 'clear' } }),
    ).resolves.toMatchObject({
      cleared: true,
      count: 3,
    })
  })

  test('attaches snapshots only after enabled actions and preserves results on snapshot failure', async () => {
    const { router, state } = createMinimalRouter()
    await router.handleCommand({ command: 'set', args: { type: 'auto-snapshot', enabled: true } })
    expect(state.session.autoSnapshot).toBe(true)
    const clicked = await router.handleCommand({ command: 'click', args: { selector: '#ok' } })
    expect(clicked).toMatchObject({ found: true, snapshot: { snapshotId: 'snapshot-1' } })
    await expect(
      router.handleCommand({ command: 'snapshot', args: {} }),
    ).resolves.not.toHaveProperty('snapshot.snapshotId')
  })

  test('returns snapshotError without replacing the successful action', async () => {
    const { router } = createMinimalRouter({
      snapshotTab: async () => {
        throw new Error('snapshot failed')
      },
    })
    await router.handleCommand({ command: 'set', args: { type: 'auto-snapshot', enabled: true } })
    await expect(
      router.handleCommand({ command: 'click', args: { selector: '#ok' } }),
    ).resolves.toMatchObject({
      found: true,
      snapshotError: 'snapshot failed',
    })
  })

  test('forwards tracing lifecycle actions', async () => {
    const { router, tracingCalls } = createMinimalRouter()
    await router.handleCommand({ command: 'tracing', args: { action: 'start' } })
    await router.handleCommand({ command: 'tracing', args: { action: 'status' } })
    await router.handleCommand({ command: 'tracing', args: { action: 'stop' } })
    expect(tracingCalls.map((call) => call.action)).toEqual(['start', 'status', 'stop'])
  })

  test('forwards video lifecycle and non-blocking action callouts', async () => {
    const { router, state, videoCalls } = createMinimalRouter()
    state.targeting.targetTabId = 1
    await router.handleCommand({ command: 'video', args: { action: 'start', maxDurationMs: 1000 } })
    await router.handleCommand({
      command: 'video',
      args: { action: 'chapter', title: 'Chapter', description: 'Details', durationMs: 500 },
    })
    await router.handleCommand({
      command: 'video',
      args: { action: 'show-actions', durationMs: 600, highlightStyle: '2px solid red' },
    })
    await router.handleCommand({ command: 'click', args: { selector: '#ok' } })
    await router.handleCommand({ command: 'video', args: { action: 'hide-actions' } })
    await router.handleCommand({ command: 'video', args: { action: 'stop' } })
    expect(
      videoCalls.filter((call) => call.action !== 'handle-action').map((call) => call.action),
    ).toEqual(['start', 'chapter', 'show-actions', 'hide-actions', 'stop'])
    expect(
      videoCalls.some((call) => call.action === 'handle-action' && call.args[0] === 'click'),
    ).toBe(true)
  })

  test('forwards WebMCP list and call targets and object args', async () => {
    const { router, webmcpCalls } = createMinimalRouter()
    await router.handleCommand({ command: 'webmcp', args: { action: 'list', frame: '@f1' } })
    await router.handleCommand({
      command: 'webmcp',
      args: { action: 'call', name: 'lookup', args: { id: 42 }, frame: 'frame-id' },
    })
    expect(webmcpCalls[0]?.args.slice(0, 2)).toEqual([1, '@f1'])
    expect(webmcpCalls[1]?.args.slice(0, 4)).toEqual([1, 'frame-id', 'lookup', { id: 42 }])
  })
})
