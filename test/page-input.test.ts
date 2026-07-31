import { describe, expect, test } from 'bun:test'
import { createPageInputDomain } from '../extension/background/page-input.js'

function createPageInput(evaluateValue: unknown) {
  return createPageInputDomain({
    state: { connection: { token: 'token', relayPort: 1 } } as never,
    getTargetTab: async () => ({ id: 1 }) as never,
    resolveElementSelectorForTab: async (tabId: unknown, selector: unknown) =>
      ({ tab: { id: 1 }, resolvedSelector: selector }) as never,
    resolveFrameTarget: async () => ({}) as never,
    getFrameExecutionContext: async () => ({}) as never,
    evaluateInTabContext: async () =>
      ({
        tab: { id: 1 },
        response: { result: undefined },
        value: evaluateValue,
      }) as never,
    sendDebuggerCommand: async () => undefined as never,
  } as never)
}

function expectElementNotFound(promise: Promise<unknown>, selector: string) {
  return expect(promise).rejects.toMatchObject({
    message: `element not found: ${selector}`,
    code: 'STALE_REFERENCE',
    suggestedAction: expect.stringContaining('snapshot'),
  })
}

describe('page input element not found handling', () => {
  test('fill throws a guided error when the element is missing', async () => {
    const pageInput = createPageInput({ found: false })

    await expectElementNotFound(pageInput.fillSelector(1, '#missing', 'v', null), '#missing')
  })

  test('fill reports elements that do not accept value', async () => {
    const pageInput = createPageInput({ found: false, reason: 'element does not accept value' })

    await expect(pageInput.fillSelector(1, '#div', 'v', null)).rejects.toThrow(
      'cannot fill #div: element does not accept value',
    )
  })

  test('scroll throws a guided error when the target element is missing', async () => {
    const pageInput = createPageInput({ found: false })

    await expectElementNotFound(pageInput.scrollElement(1, '#missing', 0, 100, null), '#missing')
  })

  test('scroll without a selector keeps scrolling the page', async () => {
    const pageInput = createPageInput({ found: true, scrolled: true })

    await expect(pageInput.scrollElement(1, null, 0, 100, null)).resolves.toMatchObject({
      found: true,
      scrolled: true,
    })
  })

  test('scrollIntoView throws a guided error when the element is missing', async () => {
    const pageInput = createPageInput({ found: false, reason: 'element not found' })

    await expectElementNotFound(pageInput.scrollIntoViewSelector(1, '#missing', null), '#missing')
  })

  test('getAttribute throws a guided error when the element is missing', async () => {
    const pageInput = createPageInput({ found: false })

    await expectElementNotFound(pageInput.getAttribute(1, '#missing', 'text', null), '#missing')
  })

  test('getAttribute returns the value when the element exists', async () => {
    const pageInput = createPageInput({ found: true, value: 'hello' })

    await expect(pageInput.getAttribute(1, '#input', 'text', null)).resolves.toEqual({
      found: true,
      value: 'hello',
    })
  })
})

describe('page input type with submit', () => {
  function createTypePageInput(
    debuggerCalls: Array<{
      method: string
      params?: Record<string, unknown>
    }>,
  ) {
    return createPageInputDomain({
      state: { connection: { token: 'token', relayPort: 1 } } as never,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async (_tabId: unknown, selector: unknown) =>
        ({ tab: { id: 1 }, resolvedSelector: selector }) as never,
      resolveFrameTarget: async () => ({}) as never,
      getFrameExecutionContext: async () => ({}) as never,
      evaluateInTabContext: async () =>
        ({
          tab: { id: 1 },
          response: { result: undefined },
          value: { found: true, focused: true },
        }) as never,
      sendDebuggerCommand: async (
        _tabId: unknown,
        method: string,
        params?: Record<string, unknown>,
      ) => {
        debuggerCalls.push({ method, params })
        return undefined as never
      },
    } as never)
  }

  test('presses Enter after typing when submit is set', async () => {
    const debuggerCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const pageInput = createTypePageInput(debuggerCalls)

    const result = await pageInput.typeIntoSelector(1, '#q', 'hi', null, true)

    expect(result).toMatchObject({ found: true, typed: true, submitted: true })
    const insertTexts = debuggerCalls
      .filter((call) => call.method === 'Input.insertText')
      .map((call) => call.params?.text)
    expect(insertTexts).toEqual(['h', 'i'])
    const keyEvents = debuggerCalls
      .filter((call) => call.method === 'Input.dispatchKeyEvent')
      .map((call) => [call.params?.type, call.params?.key])
    expect(keyEvents).toEqual([
      ['keyDown', 'Enter'],
      ['keyUp', 'Enter'],
    ])
  })

  test('does not press Enter without submit', async () => {
    const debuggerCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const pageInput = createTypePageInput(debuggerCalls)

    const result = await pageInput.typeIntoSelector(1, '#q', 'hi', null)

    expect(result).toMatchObject({ found: true, typed: true })
    expect(result).not.toHaveProperty('submitted')
    expect(debuggerCalls.some((call) => call.method === 'Input.dispatchKeyEvent')).toBe(false)
  })
})
