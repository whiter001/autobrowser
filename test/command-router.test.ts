import { describe, expect, test } from 'bun:test'
import { createCommandRouter } from '../extension/background/command-router.js'

function createMinimalRouter() {
  const snapshotCalls: Array<{ tabId: unknown; frameSelector: unknown }> = []
  const feedCalls: Array<{
    tabId: unknown
    options: unknown
    frameSelector: unknown
  }> = []
  const navigateCalls: Array<{ tabId: unknown; url: string }> = []
  const waitTimeoutCalls: number[] = []

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
      typeIntoSelector: async () => undefined,
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
      snapshotTab: async (tabId: unknown, frameSelector: unknown) => {
        snapshotCalls.push({ tabId, frameSelector })
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
      captureScreenshot: async () => undefined,
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
      waitForText: async () => undefined,
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
      storageGet: async () => undefined,
      storageSet: async () => undefined,
      storageClear: async () => undefined,
      setViewport: async () => undefined,
      setOffline: async () => undefined,
      setHeaders: async () => undefined,
      setGeo: async () => undefined,
      setMedia: async () => undefined,
      generatePdf: async () => undefined,
      clipboardRead: async () => undefined,
      clipboardWrite: async () => undefined,
      saveState: async () => undefined,
      loadState: async () => undefined,
      loadStateByName: async () => undefined,
    } as never,
    network: {
      routeRequest: async () => undefined,
      unrouteRequest: async () => undefined,
      listRequests: () => ({}),
      getRequestDetail: () => ({}),
      startHar: async () => undefined,
      stopHar: () => undefined,
    } as never,
    listTabs: async () => [],
    getTargetTab: async () => ({ id: 1 }) as never,
  } as never)

  return { router, snapshotCalls, feedCalls, navigateCalls, waitTimeoutCalls }
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
