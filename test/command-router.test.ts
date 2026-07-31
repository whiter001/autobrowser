import { describe, expect, test } from 'bun:test'
import { createCommandRouter } from '../extension/background/command-router.js'

function createMinimalRouter() {
  const snapshotCalls: Array<{ tabId: unknown; frameSelector: unknown; target?: unknown }> = []
  const feedCalls: Array<{
    tabId: unknown
    options: unknown
    frameSelector: unknown
  }> = []
  const navigateCalls: Array<{ tabId: unknown; url: string }> = []
  const waitTimeoutCalls: number[] = []
  const screenshotCalls: Array<{ tabId: unknown; options: unknown }> = []
  const waitTextCalls: Array<{ text: unknown; gone?: unknown }> = []
  const typeCalls: Array<{ selector: unknown; value: unknown; submit?: unknown }> = []

  const router = createCommandRouter({
    state: {
      consoleMessages: [],
      pageErrors: [],
      targetTabId: null,
    } as never,
    pageInput: {
      navigateTo: async (tabId: unknown, url: string) => {
        navigateCalls.push({ tabId, url })
        if (url.startsWith('chrome://')) {
          const error = new Error('cannot access chrome:// and edge:// urls') as Error & {
            code?: string
          }
          error.code = 'EXTENSION_COMMAND_ERROR'
          throw error
        }
        return { navigated: true, url }
      },
      evaluateScript: async () => undefined,
      clickSelector: async (_tabId: unknown, selector: unknown) => {
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
      typeIntoSelector: async (
        _tabId: unknown,
        selector: unknown,
        value: unknown,
        _frame: unknown,
        submit?: unknown,
      ) => {
        typeCalls.push({ selector, value, submit })
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
      uploadFiles: async () => undefined,
      navigateBack: async () => undefined,
      navigateForward: async () => undefined,
      reloadPage: async () => undefined,
      switchToFrame: async () => undefined,
      checkIsState: async () => undefined,
      getAttribute: async () => ({ value: undefined }),
    } as never,
    pageObserve: {
      snapshotTab: async (tabId: unknown, frameSelector: unknown, target?: unknown) => {
        snapshotCalls.push({ tabId, frameSelector, target })
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
      findSemanticTarget: async () => ({ match: null, reason: 'not used in test' }),
      waitWithTimeout: async (_tabId: unknown, ms: number) => {
        waitTimeoutCalls.push(ms)
      },
      waitForSelectorState: async (_tabId: unknown, selector: unknown, state: unknown) => ({
        waited: true,
        condition: 'selector-stable',
        selector,
        state,
      }),
      waitForUrl: async () => undefined,
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
      handleDialog: async () => undefined,
      cookiesGet: async () => undefined,
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
      listRequests: () => ({}),
      getRequestDetail: () => ({}),
      startHar: async () => undefined,
      stopHar: () => undefined,
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
    listTabs: async () => [],
    getTargetTab: async () => ({ id: 1 }) as never,
  } as never)

  return {
    router,
    snapshotCalls,
    feedCalls,
    navigateCalls,
    waitTimeoutCalls,
    screenshotCalls,
    waitTextCalls,
    typeCalls,
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
            result: { snapshotId: 'snapshot-1' },
          },
        },
        {
          index: 2,
          command: 'goto',
          args: { url: 'https://example.com' },
          label: null,
          response: {
            ok: true,
            result: { navigated: true, url: 'https://example.com' },
          },
        },
      ],
      summary: {
        total: 2,
        completed: 2,
        succeeded: 2,
        failed: 0,
        retried: 0,
        continueOnError: false,
        retries: 0,
        retryDelayMs: 0,
      },
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
            result: { snapshotId: 'snapshot-1' },
          },
        },
      ],
      summary: {
        total: 2,
        completed: 2,
        succeeded: 1,
        failed: 1,
        retried: 1,
        continueOnError: true,
        retries: 1,
        retryDelayMs: 0,
      },
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
})

describe('command router network/session extensions', () => {
  test('routes network route list to the network domain', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'network',
      args: { action: 'route', subaction: 'list' },
    })

    expect(result).toEqual({ routes: [{ id: 'route_1', pattern: '**/api/*', abort: true }] })
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
    expect(result).toEqual({ deleted: 1, name: 'session' })

    await expect(
      router.handleCommand({ command: 'cookies', args: { action: 'delete' } }),
    ).rejects.toThrow('cookies delete requires a cookie name')
  })

  test('routes storage delete with the session flag', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'storage',
      args: { action: 'delete', key: 'draft', session: true },
    })

    expect(result).toEqual({ key: 'draft', deleted: true, session: true })
  })

  test('routes set permission/ua/timezone/locale to the session domain', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({
        command: 'set',
        args: { type: 'permission', name: 'geolocation' },
      }),
    ).resolves.toEqual({ permission: 'geolocation', setting: 'granted' })

    await expect(
      router.handleCommand({
        command: 'set',
        args: { type: 'permission', name: 'geolocation', reset: true },
      }),
    ).resolves.toEqual({ permission: 'geolocation', setting: 'default' })

    await expect(
      router.handleCommand({ command: 'set', args: { type: 'ua', value: 'My Agent 1.0' } }),
    ).resolves.toEqual({ userAgent: 'My Agent 1.0' })

    await expect(
      router.handleCommand({ command: 'set', args: { type: 'timezone', value: 'Asia/Shanghai' } }),
    ).resolves.toEqual({ timezone: 'Asia/Shanghai' })

    await expect(
      router.handleCommand({ command: 'set', args: { type: 'locale', value: '' } }),
    ).resolves.toEqual({ locale: null })
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
    })
  })

  test('routes script list to the init script domain', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'script',
      args: { action: 'list' },
    })

    expect(result).toEqual({ scripts: [{ id: 'script_1', preview: 'window.x = 1' }] })
  })

  test('routes script remove by id and --all to the init script domain', async () => {
    const { router } = createMinimalRouter()

    await expect(
      router.handleCommand({ command: 'script', args: { action: 'remove', id: 'script_1' } }),
    ).resolves.toEqual({ removed: 'script_1', scripts: [] })

    await expect(
      router.handleCommand({ command: 'script', args: { action: 'remove', all: true } }),
    ).resolves.toEqual({ removed: ['script_1'], scripts: [] })

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
    expect(snapshotCalls[0]).toMatchObject({ frameSelector: null, target: '#panel' })
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
    expect(result).toEqual({ waited: true, condition: 'text-gone', text: 'Loading' })
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

    expect(typeCalls).toEqual([{ selector: '#q', value: 'hello', submit: true }])
    expect(result).toMatchObject({ typed: true, submitted: true })
  })
})
