import { describe, expect, test } from 'bun:test'
import { serializeCommandFailure } from '../extension/background/errors.js'
import {
  createMinimalRouter,
  EMPTY_META,
  explicitTabMeta,
  fallbackTabMeta,
} from './command-router.test.js'

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
                retryable: false,
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
              retryable: false,
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
              retryable: false,
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
        code: 'ELEMENT_NOT_FOUND',
        retryable: true,
        suggestedAction: 'check the selector and selected frame',
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

  for (const command of ['goto', 'open']) {
    for (const waitFor of ['url', 'selector']) {
      test(`${command} reuses existing ${waitFor} observation after navigating`, async () => {
        const { router, navigateCalls, waitUrlCalls, waitSelectorCalls } = createMinimalRouter()
        const result = await router.handleCommand({
          command,
          args: {
            url: 'https://example.com',
            waitFor,
            waitUrl: '#ready',
            selector: 'article',
            timeoutMs: 45000,
          },
        })
        expect(navigateCalls).toHaveLength(1)
        expect(navigateCalls[0]?.url).toBe('https://example.com')
        if (waitFor === 'url') {
          expect(waitUrlCalls).toEqual([{ url: '#ready', timeout: 45000 }])
          expect(waitSelectorCalls).toHaveLength(0)
        } else {
          expect(waitSelectorCalls).toEqual([
            { selector: 'article', state: 'visible', timeout: 45000 },
          ])
          expect(waitUrlCalls).toHaveLength(0)
        }
        expect(result).toHaveProperty('wait.waited', true)
      })
    }
  }

  for (const command of ['goto', 'open']) {
    for (const waitFor of ['url', 'selector']) {
      test(`${command} ${waitFor} wait defaults to 30000 and returns matching execution proof`, async () => {
        const { router, waitUrlCalls, waitSelectorCalls } = createMinimalRouter()
        const result = await router.handleCommand({
          command,
          args: { url: 'https://example.com', waitFor, waitUrl: '#ready', selector: 'article' },
        })
        expect((waitFor === 'url' ? waitUrlCalls : waitSelectorCalls)[0]?.timeout).toBe(30000)
        expect(result).toHaveProperty(
          'wait',
          expect.objectContaining({
            type: waitFor,
            value: waitFor === 'url' ? '#ready' : 'article',
            completed: true,
          }),
        )
      })
    }
    test(`${command} wait failure retains completed navigation and final URL in a failed response`, async () => {
      const { router } = createMinimalRouter({
        navigateTo: async () => ({ navigated: true, url: 'https://example.com/final' }),
        waitSelector: async () => {
          throw Object.assign(new Error('selector timeout'), {
            code: 'TIMEOUT',
            details: { selector: 'article' },
          })
        },
      })
      try {
        await router.handleCommand({
          command,
          args: { url: 'https://example.com', waitFor: 'selector', selector: 'article' },
        })
        throw new Error('expected wait failure')
      } catch (error) {
        const response = serializeCommandFailure(error)
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'TIMEOUT', details: { selector: 'article' } },
          result: {
            navigated: true,
            url: 'https://example.com/final',
            navigationResult: { navigated: true, url: 'https://example.com/final' },
            wait: { completed: false },
          },
        })
      }
      const batch = await router.handleCommand({
        command: 'batch',
        args: {
          continueOnError: true,
          steps: [
            {
              command,
              args: { url: 'https://example.com', waitFor: 'selector', selector: 'article' },
            },
          ],
        },
      })
      expect(batch).toHaveProperty(
        'steps.0.response',
        expect.objectContaining({
          ok: false,
          result: expect.objectContaining({ url: 'https://example.com/final' }),
        }),
      )
    })
  }

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
