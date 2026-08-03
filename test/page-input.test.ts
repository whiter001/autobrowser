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
    // 分块发送：短文本一次 Insert.insertText 调用（50 字符一块）
    expect(insertTexts).toEqual(['hi'])
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

describe('page input insertText chunking', () => {
  function createDebuggerInput() {
    const debuggerCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const pageInput = createPageInputDomain({
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
    return { pageInput, debuggerCalls }
  }

  test('sends long text in 50-character insertText chunks', async () => {
    const { pageInput, debuggerCalls } = createDebuggerInput()
    const longText = 'a'.repeat(120)

    await pageInput.insertTextSequentially(1, longText)

    const insertTexts = debuggerCalls
      .filter((call) => call.method === 'Input.insertText')
      .map((call) => call.params?.text)
    expect(insertTexts).toEqual(['a'.repeat(50), 'a'.repeat(50), 'a'.repeat(20)])
    expect(insertTexts.join('')).toBe(longText)
  })

  test('sends a single chunk for short text', async () => {
    const { pageInput, debuggerCalls } = createDebuggerInput()

    await pageInput.insertTextSequentially(1, 'hi')

    const insertTexts = debuggerCalls
      .filter((call) => call.method === 'Input.insertText')
      .map((call) => call.params?.text)
    expect(insertTexts).toEqual(['hi'])
  })
})

describe('page input fill by element type', () => {
  interface FakeFillElement {
    tagName: string
    type?: string
    value?: string
    checked?: boolean
    options?: Array<{ text: string; value: string }>
    focus: () => void
    dispatchEvent: (event: { type: string }) => boolean
  }

  function createFakeFillElement(overrides: Partial<FakeFillElement> = {}) {
    const events: string[] = []
    return {
      node: {
        tagName: 'INPUT',
        type: 'text',
        value: 'old',
        checked: false,
        options: [],
        focus: () => undefined,
        dispatchEvent: (event: { type: string }) => {
          events.push(event.type)
          return true
        },
        ...overrides,
      },
      events,
    }
  }

  // 捕获 fill 的页面表达式，用测试桩 deepQuerySelector 在 Node 里真实执行，
  // 验证序列化后的 applyFillValue 分派逻辑（select 匹配 / checkbox 校验 / 普通赋值）
  async function evaluateFillForElement(
    element: FakeFillElement,
    fillValue: string,
  ): Promise<{ found?: boolean; reason?: string; checked?: boolean }> {
    let capturedExpression = ''
    const pageInput = createPageInputDomain({
      state: { connection: { token: 'token', relayPort: 1 } } as never,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async (_tabId: unknown, selector: unknown) =>
        ({ tab: { id: 1 }, resolvedSelector: selector }) as never,
      resolveFrameTarget: async () => ({}) as never,
      getFrameExecutionContext: async () => ({}) as never,
      evaluateInTabContext: async (_tabId: unknown, expression: string) => {
        capturedExpression = expression
        return { tab: { id: 1 }, response: { result: undefined }, value: null } as never
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)

    await pageInput.fillSelector(1, '#f', fillValue, null).catch(() => undefined)
    expect(capturedExpression).toContain('applyFillValue')

    // evaluateInTabContext 会注入 deep-dom helpers 前缀，真正的 fill 表达式是
    // 唯一的 IIFE（helpers 源码里没有 `(() => {`），从最后一个 IIFE 起始截取
    const fillExpression = capturedExpression.slice(capturedExpression.lastIndexOf('(() => {'))

    // 表达式里的 deepQuerySelector 和 document 是自由变量，由外层函数提供
    const evaluator = (0, eval)(
      `(function (deepQuerySelector) { const document = null; return ${fillExpression}; })`,
    ) as (stub: () => FakeFillElement) => unknown
    const raw = evaluator(() => element) as {
      found?: boolean
      reason?: string
      checked?: boolean
      selector?: string
    }
    // selector 是固定回显字段，剥离后断言专注三分支的业务结果
    delete raw.selector
    return raw
  }

  test('fill select matches an option by its trimmed text', async () => {
    const { node, events } = createFakeFillElement({
      tagName: 'SELECT',
      options: [
        { text: 'Option A', value: 'a' },
        { text: 'Option B', value: 'b' },
      ],
    })

    const result = await evaluateFillForElement(node, 'Option A')

    expect(result).toEqual({ found: true })
    expect(node.value).toBe('a')
    expect(events).toEqual(['input', 'change'])
  })

  test('fill select falls back to matching an option by its value', async () => {
    const { node } = createFakeFillElement({
      tagName: 'SELECT',
      options: [
        { text: 'Option A', value: 'a' },
        { text: 'Option B', value: 'b' },
      ],
    })

    const result = await evaluateFillForElement(node, 'b')

    expect(result).toEqual({ found: true })
    expect(node.value).toBe('b')
  })

  test('fill select lists the available options when nothing matches', async () => {
    const { node } = createFakeFillElement({
      tagName: 'SELECT',
      options: [
        { text: 'Option A', value: 'a' },
        { text: 'Option B', value: 'b' },
      ],
    })

    const result = await evaluateFillForElement(node, 'nope')

    expect(result).toEqual({
      found: false,
      reason: 'no option matches "nope". available options: Option A, Option B',
    })
  })

  test('fill select caps the listed options at 10', async () => {
    const { node } = createFakeFillElement({
      tagName: 'SELECT',
      options: Array.from({ length: 12 }, (_, index) => ({
        text: `Option ${index}`,
        value: String(index),
      })),
    })

    const result = await evaluateFillForElement(node, 'missing')

    expect(result.found).toBe(false)
    expect(result.reason).toContain(
      'available options: Option 0, Option 1, Option 2, Option 3, Option 4, Option 5, Option 6, Option 7, Option 8, Option 9',
    )
    expect(result.reason).not.toContain('Option 10')
  })

  test('fill checkbox accepts true/false case-insensitively', async () => {
    const { node, events } = createFakeFillElement({
      tagName: 'INPUT',
      type: 'checkbox',
      checked: false,
    })

    const checked = await evaluateFillForElement(node, 'TRUE')
    expect(checked).toEqual({ found: true, checked: true })
    expect(node.checked).toBe(true)
    expect(events).toEqual(['input', 'change'])

    const unchecked = await evaluateFillForElement(node, 'false')
    expect(unchecked).toEqual({ found: true, checked: false })
  })

  test('fill checkbox rejects non-boolean values with a guidance reason', async () => {
    const { node } = createFakeFillElement({ tagName: 'INPUT', type: 'checkbox' })

    const result = await evaluateFillForElement(node, 'yes')

    expect(result).toEqual({
      found: false,
      reason: 'checkbox/radio value must be "true" or "false" (got "yes")',
    })
  })

  test('fill radio accepts true/false', async () => {
    const { node } = createFakeFillElement({ tagName: 'INPUT', type: 'radio', checked: false })

    const result = await evaluateFillForElement(node, 'true')

    expect(result).toEqual({ found: true, checked: true })
  })

  test('fill keeps the plain value assignment for regular inputs', async () => {
    const { node, events } = createFakeFillElement({
      tagName: 'INPUT',
      type: 'text',
      value: 'old',
    })

    const result = await evaluateFillForElement(node, 'new value')

    expect(result).toEqual({ found: true })
    expect(node.value).toBe('new value')
    expect(events).toEqual(['input', 'change'])
  })

  test('fill still rejects elements without a value property', async () => {
    const { node } = createFakeFillElement({ tagName: 'DIV' })
    delete (node as { value?: string }).value

    const result = await evaluateFillForElement(node, 'x')

    expect(result).toEqual({ found: false, reason: 'element does not accept value' })
  })
})

describe('page input fillFields batch', () => {
  function createSequencePageInput(values: unknown[]) {
    const pageInput = createPageInputDomain({
      state: { connection: { token: 'token', relayPort: 1 } } as never,
      getTargetTab: async () => ({ id: 1 }) as never,
      resolveElementSelectorForTab: async (_tabId: unknown, selector: unknown) =>
        ({ tab: { id: 1 }, resolvedSelector: selector }) as never,
      resolveFrameTarget: async () => ({}) as never,
      getFrameExecutionContext: async () => ({}) as never,
      evaluateInTabContext: async () => {
        return { tab: { id: 1 }, response: { result: undefined }, value: values.shift() } as never
      },
      sendDebuggerCommand: async () => undefined as never,
    } as never)
    return { pageInput }
  }

  test('continues on individual field failures and reports statistics', async () => {
    const { pageInput } = createSequencePageInput([
      { found: true },
      { found: false, reason: 'element does not accept value' },
    ])

    const result = await pageInput.fillFields(
      1,
      [
        { selector: '#a', value: '1' },
        { selector: '#div', value: '2' },
      ],
      null,
    )

    expect(result).toEqual({
      results: [
        { selector: '#a', ok: true },
        { selector: '#div', ok: false, error: 'cannot fill #div: element does not accept value' },
      ],
      succeeded: 1,
      failed: 1,
    })
  })

  test('reports not-found fields as failures without throwing', async () => {
    const { pageInput } = createSequencePageInput([{ found: false }])

    const result = await pageInput.fillFields(1, [{ selector: '#missing', value: 'x' }], null)

    expect(result).toEqual({
      results: [{ selector: '#missing', ok: false, error: 'element not found: #missing' }],
      succeeded: 0,
      failed: 1,
    })
  })

  test('succeeds all fields when every fill works', async () => {
    const { pageInput } = createSequencePageInput([{ found: true }, { found: true }])

    const result = await pageInput.fillFields(
      1,
      [
        { selector: '#a', value: '1' },
        { selector: '#b', value: '2' },
      ],
      null,
    )

    expect(result).toEqual({
      results: [
        { selector: '#a', ok: true },
        { selector: '#b', ok: true },
      ],
      succeeded: 2,
      failed: 0,
    })
  })
})
