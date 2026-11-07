import { describe, expect, test } from 'bun:test'
import { createPageObserveDomain } from '../extension/background/page-observe.js'
import { computeSearchPageTextMatches } from '../extension/background/page-observe-search.js'
import { createObserveState } from './page-observe.test.js'

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
    expect(expressions[0]).toContain('const limit = 10;')
    expect(expressions[0]).toContain('32768,')
    expect(expressions[0]).toContain('100);')
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
