import { describe, expect, test } from 'bun:test'
import {
  computeSearchPageTextMatches,
  computeStableRefIndexes,
  createPageObserveDomain,
} from '../extension/background/page-observe.js'
import type { DialogState } from '../extension/background/types.js'
import { serializeCommandError } from '../extension/background/errors.js'

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

class MockRefNode {
  private readonly attributes = new Map<string, string>()

  constructor(private readonly id: string) {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
}

const parseMockElementRef = (value: string | null): number | null => {
  const match = /^e(\d+)$/.exec(String(value || '').trim())
  return match ? Number(match[1]) : null
}

describe('page observe stable ref allocation', () => {
  test('reuses existing refs across snapshot passes and never rewrites them', () => {
    const first = new MockRefNode('first')
    const second = new MockRefNode('second')
    first.setAttribute('data-autobrowser-ref', 'e1')
    second.setAttribute('data-autobrowser-ref', 'e2')

    const firstPass = computeStableRefIndexes(
      [first, second],
      [first, second],
      'data-autobrowser-ref',
      'e',
      parseMockElementRef,
    )
    const secondPass = computeStableRefIndexes(
      [first, second],
      [first, second],
      'data-autobrowser-ref',
      'e',
      parseMockElementRef,
    )

    // 同 epoch 两次 snapshot：同元素同 ref，属性未被重写
    expect(firstPass.get(first)).toBe(1)
    expect(firstPass.get(second)).toBe(2)
    expect(secondPass.get(first)).toBe(1)
    expect(secondPass.get(second)).toBe(2)
    expect(first.getAttribute('data-autobrowser-ref')).toBe('e1')
    expect(second.getAttribute('data-autobrowser-ref')).toBe('e2')
  })

  test('assigns new elements from the page-wide max index + 1', () => {
    const existing = new MockRefNode('existing')
    existing.setAttribute('data-autobrowser-ref', 'e5')
    const fresh = new MockRefNode('fresh')

    const indexes = computeStableRefIndexes(
      [existing],
      [fresh],
      'data-autobrowser-ref',
      'e',
      parseMockElementRef,
    )

    expect(indexes.get(fresh)).toBe(6)
    expect(fresh.getAttribute('data-autobrowser-ref')).toBe('e6')
  })

  test('leaves role-filtered-out elements untouched while their refs still count for numbering', () => {
    const kept = new MockRefNode('kept')
    const filteredOut = new MockRefNode('filteredOut')
    kept.setAttribute('data-autobrowser-ref', 'e1')
    filteredOut.setAttribute('data-autobrowser-ref', 'e2')
    const fresh = new MockRefNode('fresh')

    // filteredOut 只在 refNodes（全页带 ref 的节点）里、不在候选里，模拟角色过滤未入选
    const indexes = computeStableRefIndexes(
      [kept, filteredOut],
      [kept, fresh],
      'data-autobrowser-ref',
      'e',
      parseMockElementRef,
    )

    expect(indexes.get(kept)).toBe(1)
    expect(indexes.get(fresh)).toBe(3)
    expect(indexes.has(filteredOut)).toBe(false)
    // 未入选元素的旧 ref 属性保留不动
    expect(filteredOut.getAttribute('data-autobrowser-ref')).toBe('e2')
  })

  test('does not reuse the number of a removed element while higher refs remain', () => {
    const kept = new MockRefNode('kept')
    const removed = new MockRefNode('removed')
    const higher = new MockRefNode('higher')
    const fresh = new MockRefNode('fresh')
    kept.setAttribute('data-autobrowser-ref', 'e1')
    removed.setAttribute('data-autobrowser-ref', 'e2')
    higher.setAttribute('data-autobrowser-ref', 'e3')

    // removed 从 DOM 消失（不再出现在 refNodes / 候选里），e2 编号不被回收
    const indexes = computeStableRefIndexes(
      [kept, higher],
      [kept, higher, fresh],
      'data-autobrowser-ref',
      'e',
      parseMockElementRef,
    )

    // 新元素从现存最大编号 +1 起编（e3 + 1），被删元素的 e2 不复用
    expect(indexes.get(fresh)).toBe(4)
    expect(fresh.getAttribute('data-autobrowser-ref')).toBe('e4')
  })

  test('assigns frame refs with the f prefix under the same rules', () => {
    const existingFrame = new MockRefNode('existingFrame')
    existingFrame.setAttribute('data-autobrowser-frame', 'f1')
    const newFrame = new MockRefNode('newFrame')
    const parseFrameRef = (value: string | null): number | null => {
      const match = /^f(\d+)$/.exec(String(value || '').trim())
      return match ? Number(match[1]) : null
    }

    const indexes = computeStableRefIndexes(
      [existingFrame],
      [existingFrame, newFrame],
      'data-autobrowser-frame',
      'f',
      parseFrameRef,
    )

    expect(indexes.get(existingFrame)).toBe(1)
    expect(indexes.get(newFrame)).toBe(2)
    expect(newFrame.getAttribute('data-autobrowser-frame')).toBe('f2')
  })

  test('injects the stable ref allocator instead of the page-wide cleanup', async () => {
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

    await pageObserve.snapshotTab(1, null)

    expect(expressions).toHaveLength(1)
    // 新逻辑：全页最大编号扫描 + 复用/续号，不再整页 removeAttribute 清理重编号
    expect(expressions[0]).toContain('computeStableRefIndexes(')
    expect(expressions[0]).toContain("deepQuerySelectorAll(document, '[' + refAttribute + ']')")
    expect(expressions[0]).not.toContain('removeAttribute(refAttribute)')
    expect(expressions[0]).not.toContain('element.removeAttribute')
  })
})

describe('page observe snapshot byte cap', () => {
  test('truncates oversized snapshots from the elements tail with counts', async () => {
    const bigElements = Array.from({ length: 60 }, (_, index) => ({
      ref: `@e${index + 1}#p1`,
      tag: 'button',
      role: 'button',
      text: 'x'.repeat(4000),
      name: 'x'.repeat(4000),
    }))

    const pageObserve = createPageObserveDomain({
      state: createObserveState(),
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async () =>
        ({
          tab: { id: 1 },
          response: { result: {} },
          value: {
            pageEpoch: 1,
            title: '',
            url: '',
            readyState: 'complete',
            text: '',
            elements: bigElements,
            signatures: [],
          },
        }) as never,
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = (await pageObserve.snapshotTab(1, null)) as {
      truncated: boolean
      totalElements: number
      returnedElements: number
      elements: unknown[]
    }

    expect(result.truncated).toBe(true)
    expect(result.totalElements).toBe(60)
    expect(result.returnedElements).toBeLessThan(60)
    expect(result.elements).toHaveLength(result.returnedElements)
    // 截断后整包仍必须不超过字节上限
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(200_000)
  })

  test('does not attach truncation fields when the snapshot fits', async () => {
    const pageObserve = createPageObserveDomain({
      state: createObserveState(),
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async () => {
        throw new Error('not used')
      },
      resolveFrameTarget: async () => {
        throw new Error('not used')
      },
      evaluateInTabContext: async () =>
        ({
          tab: { id: 1 },
          response: { result: {} },
          value: {
            pageEpoch: 1,
            elements: [{ ref: '@e1#p1', role: 'button', text: 'Save', name: 'Save' }],
            signatures: [],
          },
        }) as never,
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    const result = (await pageObserve.snapshotTab(1, null)) as Record<string, unknown>

    expect(result).not.toHaveProperty('truncated')
    expect(result).not.toHaveProperty('totalElements')
    expect(result).not.toHaveProperty('returnedElements')
  })
})

// 执行真正的注入表达式；只模拟 DOM API，不模拟 snapshot/find 的返回值。
class ObserveNode {
  attributes = new Map<string, string>()
  children: ObserveNode[] = []
  shadowRoot: ObserveDocument | null = null
  innerText = ''
  id = ''
  className = ''
  name = ''
  title = ''
  src = ''
  href = ''
  type = 'text'
  value = ''
  checked = false
  disabled = false
  ownerDocument!: ObserveDocument
  /** 显式 tree scope；缺省按 ownerDocument 判定，影子树节点天然落在各自 shadow root */
  treeScope: ObserveDocument | null = null
  reads = new Map<string, number>()
  constructor(public tagName = 'BUTTON') {}
  getRootNode() {
    return this.treeScope ?? this.ownerDocument ?? null
  }
  getAttribute(key: string) {
    this.reads.set(key, (this.reads.get(key) || 0) + 1)
    return this.attributes.get(key) ?? null
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value)
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 20, height: 10 }
  }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      if (part === '*') return true
      if (part.startsWith('#')) return this.id === part.slice(1)
      const attr = /\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]/.exec(part)
      const tag = /^[a-z0-9]+/i.exec(part)?.[0]
      if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false
      if (part.includes(':not'))
        return this.tagName === 'INPUT' ? this.type !== 'hidden' : this.attributes.has('tabindex')
      if (part === 'label[for]') return this.tagName === 'LABEL' && this.attributes.has('for')
      return (
        !attr ||
        (this.attributes.has(attr[1]!) && (!attr[2] || this.attributes.get(attr[1]!) === attr[2]))
      )
    })
  }
  closest(selector: string) {
    return this.matches(selector) ? this : null
  }
  querySelectorAll(selector: string) {
    return this.children.filter((node) => node.matches(selector))
  }
}
class ObserveInput extends ObserveNode {
  constructor() {
    super('INPUT')
  }
}
class ObserveAnchor extends ObserveNode {
  constructor() {
    super('A')
    this.setAttribute('href', '/a')
    this.href = '/a'
  }
}
class ObserveFrame extends ObserveNode {
  constructor() {
    super('IFRAME')
  }
}
class ObserveDocument {
  title = ''
  readyState = 'complete'
  body = { innerText: '' }
  queries = 0
  defaultView = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  }
  constructor(public nodes: ObserveNode[] = []) {
    this.attach()
  }
  attach() {
    const visit = (nodes: ObserveNode[]) => {
      for (const node of nodes) {
        node.ownerDocument = this
        if (node.children.length) visit(node.children)
      }
    }
    visit(this.nodes)
  }
  querySelectorAll(selector: string) {
    this.queries++
    return this.matching(selector)
  }
  // 单独计数：名称索引若退化为逐 id 选择器查询，这里能直接观测到
  querySelector(selector: string) {
    this.queries++
    return this.matching(selector)[0] ?? null
  }
  private matching(selector: string) {
    this.attach()
    return this.nodes.filter((node) => node.matches(selector))
  }
  getElementById(id: string) {
    this.attach()
    return this.nodes.find((node) => node.id === id) ?? null
  }
}
function expressionHarness(document: ObserveDocument) {
  const state = createObserveState()
  const documents = new Map<string, ObserveDocument>([['top', document]])
  const payloads: unknown[] = []
  const domain = createPageObserveDomain({
    state,
    getTargetTab: async () => ({ id: 1 }),
    resolveElementSelectorForTab: async (_: unknown, selector: string) => ({
      tab: { id: 1 },
      resolvedSelector: selector,
    }),
    resolveFrameTarget: async () => {
      throw new Error('unused')
    },
    evaluateInTabContext: async (
      _: unknown,
      expression: string,
      options?: { frameSelector?: string },
    ) => {
      const frame = options?.frameSelector || state.targeting.selectedFrames.get(1) || 'top'
      const doc = documents.get(frame)!
      const value = new Function(
        'document',
        'location',
        'window',
        'HTMLElement',
        'HTMLInputElement',
        'HTMLAnchorElement',
        'HTMLIFrameElement',
        'getComputedStyle',
        `return ${expression}`,
      )(
        doc,
        { href: doc.title },
        { scrollX: 0, scrollY: 0 },
        ObserveNode,
        ObserveInput,
        ObserveAnchor,
        ObserveFrame,
        doc.defaultView.getComputedStyle,
      )
      payloads.push(value)
      return { tab: { id: 1 }, response: { result: {} }, value }
    },
    sendDebuggerCommand: async () => undefined,
  } as never)
  return { domain, state, documents, payloads }
}
type ObservedSnapshot = {
  elements: Array<Record<string, unknown>>
  frames: Array<{ ref: string }>
  full: boolean
  removedRefs: string[]
  truncated?: boolean
}

describe('executed observation expressions', () => {
  test('find deduplicates native and indexed labels by DOM identity for exact names', async () => {
    const input = new ObserveInput()
    input.id = 'control-99'
    const label = new ObserveNode('LABEL')
    label.setAttribute('for', input.id)
    label.innerText = 'Control 99'
    Object.assign(input, { labels: [label] })
    const doc = new ObserveDocument([input, label])
    const h = expressionHarness(doc)
    const result = await h.domain.findSemanticTarget(
      1,
      {
        strategy: 'role',
        role: 'textbox',
        name: 'Control 99',
        exact: true,
      } as never,
      null,
    )
    expect(result.match?.name).toBe('Control 99')
    expect(result.match?.ref).toBe('@e1#p1')
    expect(doc.queries).toBe(2)
  })

  test('find retains distinct same-text wrapping and external labels from both sources', async () => {
    for (const nativeIncludesExternal of [false, true]) {
      const input = new ObserveInput()
      input.id = 'control'
      const wrapping = new ObserveNode('LABEL')
      wrapping.innerText = 'Control'
      wrapping.children = [input]
      const external = new ObserveNode('LABEL')
      external.setAttribute('for', input.id)
      external.innerText = 'Control'
      Object.assign(input, { labels: nativeIncludesExternal ? [wrapping, external] : [wrapping] })
      const doc = new ObserveDocument([wrapping, input, external])
      const h = expressionHarness(doc)
      const result = await h.domain.findSemanticTarget(
        1,
        {
          strategy: 'role',
          role: 'textbox',
          name: 'Control Control',
          exact: true,
        } as never,
        null,
      )
      expect(result.match?.name).toBe('Control Control')
      expect(doc.queries).toBe(2)
    }
  })

  test('ambiguity candidates survive the real command error serializer', async () => {
    const h = expressionHarness(
      new ObserveDocument(Array.from({ length: 25 }, () => new ObserveNode())),
    )
    const error = await h.domain
      .findSemanticTarget(
        1,
        {
          strategy: 'role',
          role: 'button',
          requireUnique: true,
        } as never,
        null,
      )
      .then(
        () => {
          throw new Error('expected ambiguity')
        },
        (error: unknown) => error,
      )
    const serialized = JSON.parse(JSON.stringify(serializeCommandError(error)))
    expect(serialized.code).toBe('AMBIGUOUS_TARGET')
    expect(serialized.details.candidates).toHaveLength(10)
    expect(serialized.details.candidates[0].ref).toBe('@e1#p1')
    expect(serialized.suggestedAction).toContain('exact:true')
    expect(new TextEncoder().encode(JSON.stringify(serialized)).length).toBeLessThan(20000)
  })

  test('password values are never read or included in names, text, signatures or payloads', async () => {
    const unlabeled = new ObserveInput(),
      labeled = new ObserveInput(),
      aria = new ObserveInput()
    const nodes = [unlabeled, labeled, aria]
    const secret = 'private-password-do-not-export'
    let valueReads = 0
    for (const node of nodes) {
      node.type = 'password'
      node.setAttribute('type', 'password')
      node.innerText = secret
      Object.defineProperty(node, 'value', {
        configurable: true,
        get: () => {
          valueReads++
          return secret
        },
      })
    }
    labeled.id = 'password'
    const label = new ObserveNode('LABEL')
    label.setAttribute('for', 'password')
    label.innerText = 'Account password'
    aria.setAttribute('aria-label', 'Secret input')
    const h = expressionHarness(new ObserveDocument([...nodes, label]))
    const first = (await h.domain.snapshotTab(1, null)) as ObservedSnapshot
    expect(first.elements.map((node) => node.value)).toEqual([null, null, null])
    expect(first.elements.map((node) => node.name)).toEqual([
      '',
      'Account password',
      'Secret input',
    ])
    expect(first.elements.map((node) => node.text)).toEqual(['', '', ''])
    const signatures = (h.payloads.at(-1) as { signatures: string[] }).signatures
    for (const node of nodes)
      Object.defineProperty(node, 'value', {
        get: () => {
          valueReads++
          return 'changed-password'
        },
      })
    const delta = (await h.domain.snapshotTab(1, null, { changed: true })) as ObservedSnapshot
    expect(delta.elements).toHaveLength(0)
    expect((h.payloads.at(-1) as { signatures: string[] }).signatures).toEqual(signatures)
    expect(valueReads).toBe(0)
    expect(JSON.stringify(h.payloads)).not.toContain(secret)
    expect(JSON.stringify(h.payloads)).not.toContain('changed-password')
  })

  test('find excludes password fallbacks in locate and ambiguity while retaining ordinary input values', async () => {
    const unlabeled = new ObserveInput(),
      labeled = new ObserveInput(),
      aria = new ObserveInput()
    const secret = 'find-password-must-not-leak'
    let valueReads = 0
    for (const node of [unlabeled, labeled, aria]) {
      node.type = 'password'
      node.setAttribute('type', 'password')
      node.innerText = secret
      Object.defineProperty(node, 'value', {
        get: () => {
          valueReads++
          return secret
        },
      })
    }
    labeled.id = 'find-password'
    const label = new ObserveNode('LABEL')
    label.setAttribute('for', labeled.id)
    label.innerText = 'Account password'
    aria.setAttribute('aria-label', 'Secret input')
    const ordinary = new ObserveInput()
    ordinary.value = '  Ordinary value  '
    const h = expressionHarness(new ObserveDocument([unlabeled, labeled, aria, ordinary, label]))
    const options = { strategy: 'role', role: 'textbox' }
    for (const [index, name] of [
      '',
      'Account password',
      'Secret input',
      'Ordinary value',
    ].entries()) {
      const result = await h.domain.findSemanticTarget(
        1,
        { ...options, position: `nth=${index + 1}` } as never,
        null,
      )
      expect(result.match?.name).toBe(name)
      expect(result.match?.text).toBe('')
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    const candidates = await h.domain.findSemanticTarget(
      1,
      { ...options, candidates: 4 } as never,
      null,
    )
    expect(candidates.candidates?.map((node) => node.name)).toEqual([
      '',
      'Account password',
      'Secret input',
      'Ordinary value',
    ])
    const error = await h.domain
      .findSemanticTarget(1, { ...options, requireUnique: true } as never, null)
      .then(
        () => {
          throw new Error('expected ambiguity')
        },
        (error: unknown) => error,
      )
    const serialized = serializeCommandError(error)
    expect(serialized.code).toBe('AMBIGUOUS_TARGET')
    expect((serialized.details as { candidates: unknown[] }).candidates).toHaveLength(4)
    expect(JSON.stringify(serialized)).not.toContain(secret)
    await expect(
      h.domain.findSemanticTarget(1, { strategy: 'text', query: secret } as never, null),
    ).rejects.toThrow('no text match found')
    expect(valueReads).toBe(0)
    // 无匹配错误可能回显查询；此前所有成功 locate/候选及歧义 payload 均不得包含密码。
    expect(JSON.stringify(h.payloads.slice(0, -1))).not.toContain(secret)
  })

  test('all visibility layout reads precede any ref attribute writes', async () => {
    const events: string[] = []
    const nodes = [
      new ObserveNode(),
      new ObserveInput(),
      new ObserveNode(),
      new ObserveFrame(),
      new ObserveFrame(),
    ]
    for (const [index, node] of nodes.entries()) {
      node.getBoundingClientRect = () => {
        events.push(`rect:${index}`)
        return { left: 0, top: 0, width: 20, height: 10 }
      }
      const setAttribute = node.setAttribute.bind(node)
      node.setAttribute = (key, value) => {
        if (key.startsWith('data-autobrowser-')) events.push(`write:${index}`)
        setAttribute(key, value)
      }
    }
    const doc = new ObserveDocument(nodes)
    doc.defaultView.getComputedStyle = () => {
      events.push('style')
      return { display: 'block', visibility: 'visible', opacity: '1' }
    }
    await expressionHarness(doc).domain.snapshotTab(1, null)
    const firstWrite = events.findIndex((event) => event.startsWith('write:'))
    expect(firstWrite).toBe(10)
    expect(events.slice(0, firstWrite).filter((event) => event.startsWith('rect:'))).toHaveLength(5)
    expect(events.slice(0, firstWrite).filter((event) => event === 'style')).toHaveLength(5)
    expect(events.slice(firstWrite)).toHaveLength(5)
    expect(events.slice(firstWrite).every((event) => event.startsWith('write:'))).toBe(true)
  })

  test('snapshot/find share monotonic element and frame counters after maximum/all deletion', async () => {
    const doc = new ObserveDocument([new ObserveNode(), new ObserveNode(), new ObserveFrame()])
    const h = expressionHarness(doc)
    const first = (await h.domain.snapshotTab(1, null)) as ObservedSnapshot
    expect(first.elements.map((e) => e.ref)).toEqual(['@e1#p1', '@e2#p1'])
    doc.nodes.pop()
    doc.nodes.pop()
    doc.nodes.push(new ObserveNode(), new ObserveFrame())
    const second = (await h.domain.snapshotTab(1, null)) as ObservedSnapshot
    expect(second.elements[1]!.ref).toBe('@e3#p1')
    expect(second.frames[0]!.ref).toBe('@f2#p1')
    doc.nodes = [new ObserveNode()]
    const found = await h.domain.findSemanticTarget(
      1,
      { strategy: 'role', role: 'button' } as never,
      null,
    )
    expect(found.match!.ref).toBe('@e4#p1')
    doc.nodes = [new ObserveNode(), new ObserveFrame()]
    const last = (await h.domain.snapshotTab(1, null)) as ObservedSnapshot
    expect(last.elements[0]!.ref).toBe('@e5#p1')
    expect(last.frames[0]!.ref).toBe('@f3#p1')
  })

  test('semantic changes and removals are delivered, selected frame and new document reset baselines', async () => {
    const input = new ObserveInput(),
      anchor = new ObserveAnchor()
    const doc = new ObserveDocument([input, anchor])
    const h = expressionHarness(doc)
    await h.domain.snapshotTab(1, null)
    expect(
      ((await h.domain.snapshotTab(1, null, { changed: true })) as ObservedSnapshot).elements,
    ).toHaveLength(0)
    for (const mutate of [
      () => {
        input.checked = true
      },
      () => {
        input.disabled = true
      },
      () => {
        input.type = 'checkbox'
      },
      () => input.setAttribute('placeholder', 'new'),
      () => {
        anchor.href = '/b'
      },
    ]) {
      mutate()
      expect(
        ((await h.domain.snapshotTab(1, null, { changed: true })) as ObservedSnapshot).elements,
      ).toHaveLength(1)
    }
    doc.nodes = [anchor]
    expect(
      ((await h.domain.snapshotTab(1, null, { changed: true })) as ObservedSnapshot).removedRefs,
    ).toEqual(['@e1#p1'])
    h.documents.set('#child', new ObserveDocument([new ObserveAnchor()]))
    h.state.targeting.selectedFrames.set(1, '#child')
    expect(
      ((await h.domain.snapshotTab(1, undefined, { changed: true })) as ObservedSnapshot).full,
    ).toBe(true)
    expect(
      ((await h.domain.snapshotTab(1, undefined, { changed: true })) as ObservedSnapshot).elements,
    ).toHaveLength(0)
    h.documents.set('#child', new ObserveDocument([new ObserveAnchor()]))
    expect(
      ((await h.domain.snapshotTab(1, undefined, { changed: true })) as ObservedSnapshot).full,
    ).toBe(true)
    expect(
      ((await h.domain.snapshotTab(1, 'top', { changed: true })) as ObservedSnapshot).elements,
    ).toHaveLength(0)
  })

  test('quantity/UTF8 clipping only acknowledges delivered refs, including summaries and internal payload', async () => {
    const nodes = Array.from({ length: 260 }, () => {
      const node = new ObserveInput()
      node.setAttribute('placeholder', '界'.repeat(4000))
      node.value = '界'.repeat(4000)
      return node
    })
    const doc = new ObserveDocument(nodes)
    doc.title = '界'.repeat(100000)
    doc.body.innerText = doc.title
    for (let i = 0; i < 30; i++) {
      const frame = new ObserveFrame()
      frame.src = doc.title
      frame.title = doc.title
      const heading = new ObserveNode('H1')
      heading.id = doc.title
      heading.className = doc.title
      doc.nodes.push(frame, heading)
    }
    const h = expressionHarness(doc)
    const seen = new Set<unknown>()
    for (let i = 0; i < 20 && seen.size < 260; i++) {
      const result = (await h.domain.snapshotTab(1, null, { changed: true })) as ObservedSnapshot
      expect(result.truncated).toBe(true)
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(200000)
      expect(
        new TextEncoder().encode(JSON.stringify(h.payloads.at(-1))).length,
      ).toBeLessThanOrEqual(200000)
      for (const node of result.elements) {
        expect(seen.has(node.ref)).toBe(false)
        seen.add(node.ref)
      }
    }
    expect(seen.size).toBe(260)
  })

  test('write ambiguity is bounded; locate first and explicit positions remain supported', async () => {
    const doc = new ObserveDocument(Array.from({ length: 15 }, () => new ObserveNode()))
    const h = expressionHarness(doc)
    const options = { strategy: 'role', role: 'button', requireUnique: true } as const
    await expect(h.domain.findSemanticTarget(1, options as never, null)).rejects.toMatchObject({
      code: 'AMBIGUOUS_TARGET',
      candidates: expect.any(Array),
      suggestedAction: expect.stringContaining('exact:true'),
    })
    expect((h.payloads.at(-1) as { candidates: unknown[] }).candidates).toHaveLength(10)
    expect(
      (await h.domain.findSemanticTarget(1, { ...options, requireUnique: false } as never, null))
        .match!.ref,
    ).toBe('@e1#p1')
    expect(
      (await h.domain.findSemanticTarget(1, { ...options, position: 'nth=2' } as never, null))
        .match!.ref,
    ).toBe('@e2#p1')
  })

  test('count cap pages undisclosed nodes and names resolve through shadow-root indexes', async () => {
    const nodes = Array.from({ length: 205 }, () => new ObserveNode())
    const shadowButton = new ObserveNode()
    shadowButton.setAttribute('aria-labelledby', 'shadow-label')
    const label = new ObserveNode('LABEL')
    label.id = 'shadow-label'
    label.innerText = 'Shadow Save'
    const host = new ObserveNode('DIV')
    host.shadowRoot = new ObserveDocument([shadowButton, label])
    const doc = new ObserveDocument([...nodes, host])
    const h = expressionHarness(doc)
    const first = (await h.domain.snapshotTab(1, null, { changed: true })) as ObservedSnapshot
    expect(first.elements).toHaveLength(200)
    expect(first.truncated).toBe(true)
    const second = (await h.domain.snapshotTab(1, null, { changed: true })) as ObservedSnapshot
    expect(second.elements).toHaveLength(6)
    expect(second.elements.at(-1)!.name).toBe('Shadow Save')
    const found = await h.domain.findSemanticTarget(
      1,
      { strategy: 'role', role: 'button', name: 'Shadow Save', exact: true } as never,
      null,
    )
    expect(found.match!.ref).toBe(second.elements.at(-1)!.ref as string)
  })

  // 影子树里重复 id 是合法的，名称必须按 tree scope 解析，否则先出现的 label 会串到另一个 root。
  function shadowHostWithLabelledButton(labelText: string) {
    const button = new ObserveNode()
    button.setAttribute('aria-labelledby', 'action')
    const label = new ObserveNode('LABEL')
    label.id = 'action'
    label.innerText = labelText
    const host = new ObserveNode('DIV')
    host.shadowRoot = new ObserveDocument([button, label])
    return host
  }

  test('shadow roots keep identical ids in separate name scopes', async () => {
    const doc = new ObserveDocument([
      shadowHostWithLabelledButton('Save'),
      shadowHostWithLabelledButton('Delete'),
    ])
    const h = expressionHarness(doc)
    const snapshot = (await h.domain.snapshotTab(1, null)) as ObservedSnapshot
    expect(snapshot.elements.map((element) => element.name)).toEqual(['Save', 'Delete'])
    expect(snapshot.elements.map((element) => element.text)).toEqual(['', ''])
    for (const [index, name] of ['Save', 'Delete'].entries()) {
      const found = await h.domain.findSemanticTarget(
        1,
        { strategy: 'exact-name', query: name, exact: true } as never,
        null,
      )
      expect(found.match!.ref).toBe(snapshot.elements[index]!.ref as string)
    }
  })

  test('label for associations stay inside their own shadow root', async () => {
    function shadowHostWithLabelledInput(labelText: string) {
      const input = new ObserveInput()
      input.id = 'field'
      const label = new ObserveNode('LABEL')
      label.setAttribute('for', 'field')
      label.innerText = labelText
      const host = new ObserveNode('DIV')
      host.shadowRoot = new ObserveDocument([input, label])
      return host
    }
    const doc = new ObserveDocument([
      shadowHostWithLabelledInput('Street'),
      shadowHostWithLabelledInput('City'),
    ])
    const h = expressionHarness(doc)
    const snapshot = (await h.domain.snapshotTab(1, null)) as ObservedSnapshot
    expect(snapshot.elements.map((element) => element.name)).toEqual(['Street', 'City'])
    const found = await h.domain.findSemanticTarget(
      1,
      { strategy: 'label', query: 'City', exact: true } as never,
      null,
    )
    expect(found.match!.ref).toBe(snapshot.elements[1]!.ref as string)
  })

  test('same-document name references keep resolving for light DOM and shadow DOM', async () => {
    const title = new ObserveNode('H1')
    title.id = 'section-title'
    title.innerText = 'Payment details'
    const input = new ObserveInput()
    input.setAttribute('aria-labelledby', 'section-title')
    const inputLabel = new ObserveNode('LABEL')
    inputLabel.setAttribute('for', 'card-number')
    inputLabel.innerText = 'Card number'
    const cardNumber = new ObserveInput()
    cardNumber.id = 'card-number'
    const shadowInput = new ObserveInput()
    shadowInput.setAttribute('aria-label', 'Shadow field')
    const host = new ObserveNode('DIV')
    host.shadowRoot = new ObserveDocument([shadowInput])
    const doc = new ObserveDocument([title, input, inputLabel, cardNumber, host])
    const h = expressionHarness(doc)
    const snapshot = (await h.domain.snapshotTab(1, null)) as ObservedSnapshot
    expect(snapshot.elements.map((element) => element.name)).toEqual([
      'Payment details',
      'Card number',
      'Shadow field',
    ])
    const found = await h.domain.findSemanticTarget(
      1,
      { strategy: 'label', query: 'Card number', exact: true } as never,
      null,
    )
    expect(found.match!.ref).toBe(snapshot.elements[1]!.ref as string)
  })

  test('subtree snapshots resolve same-document references outside the subtree', async () => {
    const label = new ObserveNode('LABEL')
    label.id = 'panel-title'
    label.innerText = 'Shipping panel'
    const input = new ObserveInput()
    input.setAttribute('aria-labelledby', 'panel-title')
    const panel = new ObserveNode('DIV')
    panel.id = 'panel'
    panel.children = [input]
    const doc = new ObserveDocument([label, input, panel])
    const h = expressionHarness(doc)
    const scoped = (await h.domain.snapshotTab(1, null, { selector: '#panel' })) as ObservedSnapshot
    expect(scoped.elements.map((element) => element.name)).toEqual(['Shipping panel'])
  })

  test('subtree snapshots backfill out-of-subtree labels once per tree scope', async () => {
    const label = new ObserveNode('LABEL')
    label.setAttribute('for', 'field')
    label.innerText = 'Shipping panel'
    const panel = new ObserveNode('DIV')
    panel.id = 'panel'
    const inputs = Array.from({ length: 100 }, (_, index) => {
      const input = new ObserveInput()
      input.id = index === 0 ? 'field' : `field-${index}`
      panel.children.push(input)
      return input
    })
    const doc = new ObserveDocument([label, panel])
    const h = expressionHarness(doc)
    const scoped = (await h.domain.snapshotTab(1, null, { selector: '#panel' })) as ObservedSnapshot
    expect(scoped.elements).toHaveLength(100)
    expect(scoped.elements[0]!.name).toBe('Shipping panel')
    expect(scoped.elements.slice(1).every((element) => element.name === '')).toBe(true)
    // 100 个 input 只允许触发一次 label[for] 补全，不得逐 id 扫描 root
    expect(doc.queries).toBeLessThanOrEqual(8)
    expect(inputs).toHaveLength(100)
  })

  test('full-page name resolution keeps root queries constant as labelled candidates grow', async () => {
    const run = async (count: number) => {
      const doc = new ObserveDocument()
      for (let index = 0; index < count; index += 1) {
        const button = new ObserveNode()
        button.id = `button-${index}`
        doc.nodes.push(button)
      }
      const h = expressionHarness(doc)
      const snapshot = (await h.domain.snapshotTab(1, null)) as ObservedSnapshot
      expect(snapshot.elements).toHaveLength(count)
      const found = await h.domain.findSemanticTarget(
        1,
        { strategy: 'role', role: 'button', candidates: 3 } as never,
        null,
      )
      expect(found.candidates).toHaveLength(Math.min(3, count))
      return doc.queries
    }
    // 覆盖整棵树的 scope 未命中即负结果，查询数与候选数量无关
    expect(await run(100)).toBe(await run(1))
  })

  test('final defensive cap bounds oversized metadata and every summary array', async () => {
    const huge = '界'.repeat(100000)
    const result = (await createObserveForScreenshot(
      {
        title: huge,
        url: huge,
        text: huge,
        elements: [],
        frames: [{ src: huge }],
        headings: [{ className: huge }],
        buttons: [{ text: huge }],
        modal: { message: huge },
        signatures: [],
      },
      [],
    ).snapshotTab(1, null)) as Record<string, unknown>
    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(200000)
  })

  test('find uses two root queries independent of labelled candidates, with lazy memoized names', async () => {
    const doc = new ObserveDocument()
    for (let i = 0; i < 100; i++) {
      const node = new ObserveNode()
      node.id = `button${i}`
      node.setAttribute('aria-label', 'Save')
      node.setAttribute('aria-labelledby', 'label')
      doc.nodes.push(node)
    }
    const label = new ObserveNode('LABEL')
    label.id = 'label'
    label.innerText = 'Other'
    doc.nodes.push(label)
    const h = expressionHarness(doc)
    await h.domain.findSemanticTarget(
      1,
      { strategy: 'role', role: 'button', name: 'Save', candidates: 5 } as never,
      null,
    )
    expect(doc.queries).toBe(2)
    expect(doc.nodes[0]!.reads.get('aria-label')).toBe(1)
    expect(doc.nodes[0]!.reads.get('aria-labelledby')).toBeUndefined()
  })

  test('search executes pagination with no missing or duplicated lines', async () => {
    const doc = new ObserveDocument()
    doc.body.innerText = Array(501).fill('hit').join('\n')
    const h = expressionHarness(doc)
    const lines: number[] = []
    let startLine = 1
    for (let i = 0; i < 4; i++) {
      const result = await h.domain.searchPageText(
        1,
        { query: '/hit/g', context: 100, startLine },
        null,
      )
      expect(result.context).toBe(50)
      lines.push(
        ...result.windows.flatMap((w) =>
          w.lines.map((l) => {
            expect(l.matched).toBe(true)
            return l.line
          }),
        ),
      )
      if (!result.nextStartLine) {
        expect(result.truncated).toBe(false)
        break
      }
      expect(result.nextStartLine).toBeGreaterThan(startLine)
      startLine = result.nextStartLine
    }
    expect(lines).toEqual(Array.from({ length: 501 }, (_, i) => i + 1))
  })
})

describe('search byte and window continuation', () => {
  test('UTF8 byte budget cuts inside one window and resumes at the exact next line', () => {
    const raw = Array(350).fill('界'.repeat(240)).join('\n')
    const first = computeSearchPageTextMatches(raw, '界', '界', 'g', 0, 20, 240, 'complete')
    const count = first.windows[0]!.lines.length
    expect(count).toBeLessThan(200)
    expect(first.nextStartLine).toBe(count + 1)
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThanOrEqual(100000)
    expect(first.windows[0]!.lines.every((line) => line.matched)).toBe(true)
    const next = computeSearchPageTextMatches(
      raw,
      '界',
      '界',
      'g',
      0,
      20,
      240,
      'complete',
      first.nextStartLine,
    )
    expect(next.windows[0]!.startLine).toBe(count + 1)
  })
  test('window limit continuation, long-line terminal truncation and zero-limit do not loop', () => {
    const first = computeSearchPageTextMatches(
      'hit\nno\nhit',
      'hit',
      'hit',
      'i',
      0,
      1,
      240,
      'complete',
    )
    expect(first.nextStartLine).toBe(3)
    const last = computeSearchPageTextMatches(
      'hit\nno\nhit',
      'hit',
      'hit',
      'i',
      0,
      1,
      240,
      'complete',
      3,
    )
    expect(last.truncated).toBe(false)
    expect(last.nextStartLine).toBeUndefined()
    const long = computeSearchPageTextMatches(
      'x'.repeat(500),
      'x',
      'x',
      'i',
      0,
      20,
      240,
      'complete',
    )
    expect(long.truncated).toBe(true)
    expect(long.nextStartLine).toBeUndefined()
    expect(
      computeSearchPageTextMatches('x', 'x', 'x', 'i', 0, 0, 240, 'complete').nextStartLine,
    ).toBeUndefined()
  })
})
