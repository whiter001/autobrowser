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
