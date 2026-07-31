import { describe, expect, test } from 'bun:test'
import { createPageObserveDomain } from '../extension/background/page-observe.js'

describe('page observe waitForExpression', () => {
  test('wraps expressions so promise-returning functions are awaited', async () => {
    const expressions: string[] = []

    const pageObserve = createPageObserveDomain({
      state: {} as never,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async (_tabId: unknown, expression: string) => {
        expressions.push(expression)
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: true,
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = await pageObserve.waitForExpression(1, 'Promise.resolve(true)', 1000, null)

    expect(result).toEqual({
      waited: true,
      condition: 'fn',
      expression: 'Promise.resolve(true)',
    })
    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('async () =>')
    expect(expressions[0]).toContain("await Promise.resolve(Function('return (' + ")
  })
})

describe('page observe selector waits', () => {
  test('waits for a new visible selector signature', async () => {
    const signatures = ['article-one', 'article-two']
    let callCount = 0

    const pageObserve = createPageObserveDomain({
      state: {} as never,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async (_tabId: unknown, selector: string) => ({
        tab: { id: 1 } as never,
        pageEpoch: 1,
        resolvedSelector: selector,
      }),
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async (_tabId: unknown) => {
        const signature = signatures[Math.min(callCount, signatures.length - 1)]
        callCount += 1
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: { signature },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = await pageObserve.waitForSelectorState(1, 'article', 'new', 1000, null)

    expect(result).toEqual({
      waited: true,
      condition: 'selector-new',
      selector: 'article',
      state: 'new',
    })
    expect(callCount).toBeGreaterThanOrEqual(2)
  })
})

function createObserveState() {
  return {
    targeting: {
      selectedFrames: new Map(),
      pageEpochs: new Map(),
    },
  } as never
}

function createObserveForScreenshot(
  evaluateValue: unknown,
  debuggerCalls: Array<{
    method: string
    params?: Record<string, unknown>
  }>,
) {
  return createPageObserveDomain({
    state: createObserveState(),
    getTargetTab: async () => ({ id: 1 }) as never,
    resolveElementSelectorForTab: async (_tabId: unknown, selector: string) =>
      ({ tab: { id: 1 }, pageEpoch: 1, resolvedSelector: selector }) as never,
    resolveFrameTarget: async () => {
      throw new Error('not used')
    },
    evaluateInTabContext: async () =>
      ({
        tab: { id: 1 },
        response: { result: {} },
        value: evaluateValue,
      }) as never,
    sendDebuggerCommand: async (
      _tabId: unknown,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      debuggerCalls.push({ method, params })
      return { data: 'aGk=' } as never
    },
  } as never)
}

describe('page observe element screenshot', () => {
  test('captures an element clip derived from the element rect', async () => {
    const debuggerCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const pageObserve = createObserveForScreenshot(
      { x: 10.4, y: 20.2, width: 100, height: 50 },
      debuggerCalls,
    )

    const result = (await pageObserve.captureScreenshot(1, { element: '#card' }, null)) as {
      element?: string
    }

    const captureCall = debuggerCalls.find((call) => call.method === 'Page.captureScreenshot')
    expect(captureCall?.params).toMatchObject({
      clip: { x: 10.4, y: 20.2, width: 100, height: 50, scale: 1 },
    })
    expect(result.element).toBe('#card')
  })

  test('rejects element capture combined with --full', async () => {
    const pageObserve = createObserveForScreenshot(null, [])

    await expect(
      pageObserve.captureScreenshot(1, { element: '#card', full: true }, null),
    ).rejects.toThrow('cannot be combined')
  })

  test('throws a guided error when the element is missing', async () => {
    const pageObserve = createObserveForScreenshot(null, [])

    await expect(
      pageObserve.captureScreenshot(1, { element: '#missing' }, null),
    ).rejects.toMatchObject({
      message: 'element not found: #missing',
      code: 'STALE_REFERENCE',
      suggestedAction: expect.stringContaining('snapshot'),
    })
  })
})

describe('page observe snapshot subtree', () => {
  test('scopes the traversal to the resolved target selector', async () => {
    const expressions: string[] = []
    const resolvedSelectors: string[] = []

    const pageObserve = createPageObserveDomain({
      state: createObserveState(),
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async (_tabId: unknown, selector: string) => {
        resolvedSelectors.push(selector)
        return { tab: { id: 1 }, pageEpoch: 1, resolvedSelector: '#panel' } as never
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async (_tabId: unknown, expression: string) => {
        expressions.push(expression)
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: { pageEpoch: 1, elements: [] },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    await pageObserve.snapshotTab(1, null, '@e3#p1')

    expect(resolvedSelectors).toEqual(['@e3#p1'])
    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('const targetRootSelector = "#panel";')
    expect(expressions[0]).toContain('deepQuerySelector(document, targetRootSelector)')
    expect(expressions[0]).toContain('deepCollectElements(scope)')
    expect(expressions[0]).not.toContain('deepCollectElements(document)')
  })

  test('throws a guided error when the snapshot target is missing', async () => {
    const pageObserve = createPageObserveDomain({
      state: createObserveState(),
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async (_tabId: unknown, selector: string) =>
        ({ tab: { id: 1 }, pageEpoch: 1, resolvedSelector: selector }) as never,
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async () =>
        ({
          tab: { id: 1 },
          response: { result: {} },
          value: { found: false, pageEpoch: 1 },
        }) as never,
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    await expect(pageObserve.snapshotTab(1, null, '#missing')).rejects.toMatchObject({
      message: 'element not found: #missing',
      code: 'STALE_REFERENCE',
    })
  })
})

describe('page observe waitForText gone', () => {
  test('waits for text to disappear when gone is set', async () => {
    const expressions: string[] = []

    const pageObserve = createPageObserveDomain({
      state: createObserveState(),
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async (_tabId: unknown, expression: string) => {
        expressions.push(expression)
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: true,
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = await pageObserve.waitForText(1, 'Loading', 1000, null, true)

    expect(result).toEqual({ waited: true, condition: 'text-gone', text: 'Loading' })
    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('!document.body.innerText.toLowerCase().includes("loading")')
  })
})
