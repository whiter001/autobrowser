import { describe, expect, test } from 'bun:test'
import {
  computeSearchPageTextMatches,
  createPageObserveDomain,
} from '../extension/background/page-observe.js'
import type { DialogState } from '../extension/background/types.js'

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
      selectedFrames: new Map<number, string>(),
      pageEpochs: new Map<number, number>(),
    },
    session: {
      dialogs: new Map<number, DialogState>(),
      lastDialog: null as Record<string, unknown> | null,
    },
  }
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

    await pageObserve.snapshotTab(1, null, { selector: '@e3#p1' })

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

    await expect(pageObserve.snapshotTab(1, null, { selector: '#missing' })).rejects.toMatchObject({
      message: 'element not found: #missing',
      code: 'STALE_REFERENCE',
    })
  })
})

describe('page observe snapshot modal blocking', () => {
  test('returns modal description without running DOM traversal when a dialog is open', async () => {
    const state = createObserveState()
    state.session.dialogs.set(1, {
      open: true,
      type: 'confirm',
      message: 'Continue?',
      defaultPrompt: 'Yes',
      url: null,
      openedAt: new Date().toISOString(),
    })

    let evaluateCalls = 0
    const pageObserve = createPageObserveDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async () => {
        evaluateCalls += 1
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: {},
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = (await pageObserve.snapshotTab(1, null)) as Record<string, unknown>

    expect(result).toEqual(
      expect.objectContaining({
        readyState: 'blocked',
        title: null,
        url: null,
        text: '',
        elements: [],
        frames: [],
        headings: [],
        buttons: [],
        modal: {
          open: true,
          type: 'confirm',
          message: 'Continue?',
          defaultPrompt: 'Yes',
        },
      }),
    )
    expect(evaluateCalls).toBe(0)
  })
})

describe('page observe snapshot role filter & incremental', () => {
  test('injects the role filter into the page expression', async () => {
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
          value: { pageEpoch: 1, elements: [], signatures: [] },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    await pageObserve.snapshotTab(1, null, { roles: ['button', 'link'] })

    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('const roles = ["button","link"];')
    expect(expressions[0]).toContain('!roles.includes(role)')
  })

  test('returns a full snapshot on the first --changed run and strips internal signatures', async () => {
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
          value: {
            pageEpoch: 1,
            elements: [{ ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' }],
            signatures: ['@e1#p1~button~Save~Save'],
            full: true,
            unchangedCount: 0,
          },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = (await pageObserve.snapshotTab(1, null, {
      changed: true,
    })) as Record<string, unknown>

    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('const previousSignatures = [];')
    expect(expressions[0]).toContain('const changedMode = true;')
    expect(result).toEqual(
      expect.objectContaining({
        elements: [{ ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' }],
        full: true,
        unchangedCount: 0,
      }),
    )
    expect(result).not.toHaveProperty('signatures')
  })

  test('diffs against the cached signatures on the next --changed run', async () => {
    const expressions: string[] = []
    const mockValues = [
      {
        pageEpoch: 1,
        elements: [
          { ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' },
          { ref: '@e2#p1', role: 'button', text: 'Cancel', name: 'Cancel' },
        ],
        signatures: ['@e1#p1~button~Save~Save', '@e2#p1~button~Cancel~Cancel'],
        full: true,
        unchangedCount: 0,
      },
      {
        pageEpoch: 1,
        elements: [{ ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' }],
        signatures: ['@e1#p1~button~Save~Save', '@e2#p1~button~Cancel~Cancel'],
        full: false,
        unchangedCount: 1,
      },
    ]
    let callCount = 0

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
        const value = mockValues[Math.min(callCount, mockValues.length - 1)]
        callCount += 1
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value,
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    await pageObserve.snapshotTab(1, null, { changed: true })

    const second = (await pageObserve.snapshotTab(1, null, {
      changed: true,
    })) as Record<string, unknown>

    expect(expressions).toHaveLength(2)
    expect(expressions[1]).toContain(
      'const previousSignatures = ["@e1#p1~button~Save~Save","@e2#p1~button~Cancel~Cancel"];',
    )
    expect(second).toEqual(
      expect.objectContaining({
        elements: [{ ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' }],
        full: false,
        unchangedCount: 1,
      }),
    )
    expect(second).not.toHaveProperty('signatures')
  })

  test('invalidates the incremental cache when the page epoch changes', async () => {
    const expressions: string[] = []
    const state = createObserveState()

    const pageObserve = createPageObserveDomain({
      state,
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
          value: {
            pageEpoch: 1,
            elements: [{ ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' }],
            signatures: ['@e1#p1~button~Save~Save'],
            full: true,
            unchangedCount: 0,
          },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    await pageObserve.snapshotTab(1, null, { changed: true })
    expect(expressions[0]).toContain('const previousSignatures = [];')

    state.targeting.pageEpochs.set(1, 2)
    await pageObserve.snapshotTab(1, null, { changed: true })

    expect(expressions).toHaveLength(2)
    expect(expressions[1]).toContain('const previousSignatures = [];')
  })

  test('does not update the incremental cache while a modal blocks the page', async () => {
    const expressions: string[] = []
    const state = createObserveState()
    state.session.dialogs.set(1, {
      open: true,
      type: 'confirm',
      message: 'Continue?',
      defaultPrompt: 'Yes',
      url: null,
      openedAt: new Date().toISOString(),
    })

    let evaluateCalls = 0
    const pageObserve = createPageObserveDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async (_tabId: unknown, expression: string) => {
        evaluateCalls += 1
        expressions.push(expression)
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: {
            pageEpoch: 1,
            elements: [],
            signatures: ['@e1#p1~button~Save~Save'],
            full: true,
            unchangedCount: 0,
          },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const blocked = (await pageObserve.snapshotTab(1, null, {
      changed: true,
      roles: ['button'],
    })) as Record<string, unknown>

    expect(blocked).toEqual(expect.objectContaining({ readyState: 'blocked' }))
    expect(blocked).not.toHaveProperty('full')
    expect(blocked).not.toHaveProperty('unchangedCount')
    expect(blocked).not.toHaveProperty('signatures')
    expect(evaluateCalls).toBe(0)

    // modal 分支不写缓存：对话框关闭后的首次 --changed 仍退化为全量
    state.session.dialogs.delete(1)
    await pageObserve.snapshotTab(1, null, { changed: true })

    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('const previousSignatures = [];')
  })

  test('does not reuse role-filtered signatures for a later full --changed snapshot', async () => {
    const expressions: string[] = []
    const state = createObserveState()

    const pageObserve = createPageObserveDomain({
      state,
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
          value: {
            pageEpoch: 1,
            elements: [{ ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' }],
            signatures: ['@e1#p1~button~Save~Save'],
            full: true,
            unchangedCount: 0,
          },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    // 先跑 role 子集快照，把 button 子集签名写入缓存
    await pageObserve.snapshotTab(1, null, { roles: ['button'], changed: true })
    // 再跑不带 roles 的全量 --changed：若命中 button 子集缓存会把非 button 元素全判为 changed
    await pageObserve.snapshotTab(1, null, { changed: true })

    expect(expressions).toHaveLength(2)
    expect(expressions[0]).toContain('const roles = ["button"];')
    expect(expressions[0]).toContain('const previousSignatures = [];')
    expect(expressions[1]).toContain('const roles = [];')
    expect(expressions[1]).toContain('const previousSignatures = [];')
  })

  test('does not reuse a subtree snapshot signature for the full --changed snapshot', async () => {
    const expressions: string[] = []
    const state = createObserveState()

    const pageObserve = createPageObserveDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async (_tabId: unknown, _selector: string) =>
        ({ tab: { id: 1 }, pageEpoch: 1, resolvedSelector: '#panel' }) as never,
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async (_tabId: unknown, expression: string) => {
        expressions.push(expression)
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: {
            pageEpoch: 1,
            elements: [{ ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' }],
            signatures: ['@e1#p1~button~Save~Save'],
            full: true,
            unchangedCount: 0,
          },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    await pageObserve.snapshotTab(1, null, { selector: '#panel', changed: true })
    await pageObserve.snapshotTab(1, null, { changed: true })

    expect(expressions).toHaveLength(2)
    expect(expressions[0]).toContain('const targetRootSelector = "#panel";')
    expect(expressions[0]).toContain('const previousSignatures = [];')
    expect(expressions[1]).toContain('const targetRootSelector = null;')
    expect(expressions[1]).toContain('const previousSignatures = [];')
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

describe('page observe semantic find', () => {
  function createObserveForFind(evaluateValue: unknown, expressions: string[]) {
    return createPageObserveDomain({
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
          value: evaluateValue,
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)
  }

  test('embeds strategy matchers for each supported strategy', async () => {
    const cases: Array<[string, string]> = [
      ['placeholder', "getAttribute('placeholder')"],
      ['alt', "getAttribute('alt')"],
      ['title', "getAttribute('title')"],
      ['test-id', '[data-testid]'],
      ['exact-name', "strategy === 'exact-name'"],
    ]

    for (const [strategy, expectedFragment] of cases) {
      const expressions: string[] = []
      const pageObserve = createObserveForFind(
        { found: true, match: { ref: '@e1#p1' } },
        expressions,
      )
      await pageObserve.findSemanticTarget(1, { strategy, query: 'x' } as never, null)
      expect(expressions[0]).toContain(expectedFragment)
    }
  })

  test('embeds position and candidates count when provided', async () => {
    const expressions: string[] = []
    const pageObserve = createObserveForFind({ found: true, match: { ref: '@e1#p1' } }, expressions)
    await pageObserve.findSemanticTarget(
      1,
      { strategy: 'text', query: 'x', position: 'nth=2', candidates: 3 } as never,
      null,
    )
    expect(expressions[0]).toContain('const position = "nth=2";')
    expect(expressions[0]).toContain('const candidatesCount = 3;')
  })

  test('returns candidates unchanged in candidates mode', async () => {
    const expressions: string[] = []
    const candidates = [{ ref: '@e1#p1' }, { ref: '@e2#p1' }]
    const pageObserve = createObserveForFind({ found: true, candidates }, expressions)
    const result = (await pageObserve.findSemanticTarget(
      1,
      { strategy: 'text', query: 'x', candidates: 2 } as never,
      null,
    )) as { found: boolean; candidates?: unknown[] }
    expect(result.found).toBe(true)
    expect(result.candidates).toEqual(candidates)
  })

  test('rejects when the page reports an out-of-range nth position', async () => {
    const expressions: string[] = []
    const pageObserve = createObserveForFind(
      {
        found: false,
        reason: 'nth position out of range: nth=5 (only 3 matches found)',
      },
      expressions,
    )
    await expect(
      pageObserve.findSemanticTarget(
        1,
        { strategy: 'role', role: 'button', position: 'nth=5' } as never,
        null,
      ),
    ).rejects.toThrow('nth position out of range')
  })
})

describe('page observe search', () => {
  test('matches literal text case-insensitively and flags matched lines', () => {
    const result = computeSearchPageTextMatches(
      'Alpha\nbeta\nGamma\nalpha!',
      'ALPHA',
      'ALPHA',
      'i',
      0,
      20,
      240,
      'complete',
    )

    expect(result.totalMatches).toBe(2)
    expect(result.regex).toBe(false)
    expect(result.returned).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.windows).toEqual([
      {
        startLine: 1,
        endLine: 1,
        lines: [{ line: 1, text: 'Alpha', matched: true, truncated: false }],
      },
      {
        startLine: 4,
        endLine: 4,
        lines: [{ line: 4, text: 'alpha!', matched: true, truncated: false }],
      },
    ])
  })

  test('matches a regex pattern with explicit flags', () => {
    const result = computeSearchPageTextMatches(
      'Log in\nLogged out\nlogin',
      '/^log/i',
      '^log',
      'i',
      0,
      20,
      240,
      'complete',
    )

    expect(result.totalMatches).toBe(3)
    expect(result.regex).toBe(true)
    // 相邻命中（1-3 行，context 0）合并成一个窗口
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0].lines.map((line) => line.text)).toEqual([
      'Log in',
      'Logged out',
      'login',
    ])
  })

  test('merges overlapping and adjacent context windows', () => {
    // line 2 命中（context 1 -> 窗口 1-3），line 4 命中（窗口 3-5）重叠合并为 1-5
    const overlapping = computeSearchPageTextMatches(
      'a\nmatch1\nb\nmatch2\nc',
      'match',
      'match',
      'i',
      1,
      20,
      240,
      'complete',
    )
    expect(overlapping.windows).toHaveLength(1)
    expect(overlapping.windows[0]).toEqual({ startLine: 1, endLine: 5, lines: expect.any(Array) })
    expect(overlapping.windows[0].lines).toHaveLength(5)

    // line 3 与 line 6 的窗口（2-4 与 5-7）相邻，也合并为 2-7
    const adjacent = computeSearchPageTextMatches(
      'a\nb\nmatch\nc\nd\nmatch\ne',
      'match',
      'match',
      'i',
      1,
      20,
      240,
      'complete',
    )
    expect(adjacent.windows).toHaveLength(1)
    expect(adjacent.windows[0].startLine).toBe(2)
    expect(adjacent.windows[0].endLine).toBe(7)
  })

  test('caps returned windows at the limit', () => {
    const text = Array.from({ length: 20 }, (_, index) =>
      index === 0 || index === 9 || index === 19 ? 'hit' : `line ${index}`,
    ).join('\n')
    const result = computeSearchPageTextMatches(text, 'hit', 'hit', 'i', 0, 2, 240, 'complete')

    expect(result.totalMatches).toBe(3)
    expect(result.returned).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.windows).toHaveLength(2)
  })

  test('truncates long lines to the line length cap', () => {
    const longLine = 'x'.repeat(50)
    const result = computeSearchPageTextMatches(longLine, 'x', 'x', 'i', 0, 20, 10, 'complete')

    expect(result.windows[0].lines[0].text).toHaveLength(10)
    expect(result.windows[0].lines[0].truncated).toBe(true)
  })

  test('handles empty text and zero limit', () => {
    const empty = computeSearchPageTextMatches('', 'x', 'x', 'i', 3, 20, 240, 'complete')
    expect(empty.totalMatches).toBe(0)
    expect(empty.windows).toEqual([])

    const zeroLimit = computeSearchPageTextMatches('x\nx', 'x', 'x', 'i', 0, 0, 240, 'complete')
    expect(zeroLimit.totalMatches).toBe(2)
    expect(zeroLimit.returned).toBe(0)
    expect(zeroLimit.truncated).toBe(true)
    expect(zeroLimit.windows).toEqual([])
  })

  test('embeds the match helper and normalized query into the page expression', async () => {
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
          value: {
            pageEpoch: 1,
            query: 'ALPHA',
            regex: false,
            pattern: 'ALPHA',
            context: 0,
            limit: 20,
            readyState: 'complete',
            totalMatches: 0,
            returned: 0,
            truncated: false,
            windows: [],
          },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = await pageObserve.searchPageText(1, { query: 'ALPHA', context: 0 }, null)

    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('computeSearchPageTextMatches')
    expect(expressions[0]).toContain('"ALPHA"')
    expect(expressions[0]).toContain('const lineMax = 240;')
    expect(result).toEqual(
      expect.objectContaining({
        pageEpoch: 1,
        query: 'ALPHA',
        regex: false,
        pattern: 'ALPHA',
        context: 0,
        readyState: 'complete',
      }),
    )
  })

  test('reads readyState from the live document instead of hardcoding complete', async () => {
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
          value: {
            pageEpoch: 1,
            query: 'ALPHA',
            regex: false,
            pattern: 'ALPHA',
            context: 0,
            limit: 20,
            readyState: 'interactive',
            totalMatches: 0,
            returned: 0,
            truncated: false,
            windows: [],
          },
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = await pageObserve.searchPageText(1, { query: 'ALPHA', context: 0 }, null)

    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('const readyState = document.readyState;')
    expect(expressions[0]).not.toContain('const readyState = "complete";')
    // 返回值回显页面报告的真实 readyState，而不是硬编码的 'complete'
    expect(result).toEqual(
      expect.objectContaining({
        readyState: 'interactive',
      }),
    )
  })

  test('returns a blocked result without evaluating when a modal dialog is open', async () => {
    const state = createObserveState()
    state.session.dialogs.set(1, {
      open: true,
      type: 'confirm',
      message: 'Continue?',
      defaultPrompt: 'Yes',
      url: null,
      openedAt: new Date().toISOString(),
    })

    let evaluateCalls = 0
    const pageObserve = createPageObserveDomain({
      state,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async () => {
        evaluateCalls += 1
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: {},
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = await pageObserve.searchPageText(1, { query: 'x' }, null)

    expect(result).toEqual(
      expect.objectContaining({
        readyState: 'blocked',
        totalMatches: 0,
        windows: [],
        modal: { open: true, type: 'confirm', message: 'Continue?', defaultPrompt: 'Yes' },
      }),
    )
    expect(evaluateCalls).toBe(0)
  })

  test('returns an empty result for a blank query without evaluating', async () => {
    let evaluateCalls = 0
    const pageObserve = createPageObserveDomain({
      state: createObserveState(),
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async () => {
        evaluateCalls += 1
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: {},
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = await pageObserve.searchPageText(1, { query: '   ' }, null)

    expect(result).toEqual(
      expect.objectContaining({
        readyState: 'complete',
        query: '',
        totalMatches: 0,
        windows: [],
      }),
    )
    expect(evaluateCalls).toBe(0)
  })

  test('rejects an invalid search regex before evaluating', async () => {
    let evaluateCalls = 0
    const pageObserve = createPageObserveDomain({
      state: createObserveState(),
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async () => {
        evaluateCalls += 1
        return {
          tab: { id: 1 } as never,
          response: { result: {} },
          value: {},
        }
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    await expect(pageObserve.searchPageText(1, { query: '/foo[/' }, null)).rejects.toThrow(
      'invalid search regex: /foo[/',
    )
    expect(evaluateCalls).toBe(0)
  })
})
