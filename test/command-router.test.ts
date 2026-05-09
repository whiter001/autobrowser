import { describe, expect, test } from 'bun:test'
import { createCommandRouter } from '../extension/background/command-router.js'

function createMinimalRouter() {
  const snapshotCalls: Array<{ tabId: unknown; frameSelector: unknown }> = []
  const navigateCalls: Array<{ tabId: unknown; url: string }> = []

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
      clickSelector: async () => undefined,
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
      captureScreenshot: async () => undefined,
      findSemanticTarget: async () => ({ match: null, reason: 'not used in test' }),
      waitWithTimeout: async () => undefined,
      waitForSelectorState: async () => undefined,
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

  return { router, snapshotCalls, navigateCalls }
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
      },
    })

    expect(snapshotCalls).toHaveLength(1)
    expect(navigateCalls).toHaveLength(1)
  })
})
