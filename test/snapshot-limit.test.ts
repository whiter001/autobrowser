import { describe, expect, test } from 'bun:test'
import { createPageObserveDomain } from '../extension/background/page-observe.js'
import { parseSnapshotArgs } from '../src/cli/parse.js'
import { validateCommandArgs } from '../src/core/command-spec.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

type SnapshotResult = {
  elements: Array<Record<string, unknown>>
  frames: Array<Record<string, unknown>>
  truncated?: boolean
  totalElements?: number
  returnedElements?: number
  unchangedCount?: number
  full?: boolean
}

function createState() {
  return {
    targeting: {
      selectedFrames: new Map<number, string>(),
      pageEpochs: new Map<number, number>(),
    },
    session: {
      dialogs: new Map<number, unknown>(),
      lastDialog: null as Record<string, unknown> | null,
    },
  }
}

/** 只记录注入表达式，不执行：用于断言 limit / 字节预算被写进页内脚本。 */
function createRecordingObserve(value: unknown = { pageEpoch: 1, elements: [], signatures: [] }) {
  const expressions: string[] = []
  const domain = createPageObserveDomain({
    state: createState(),
    getTargetTab: async () => ({ id: 1 }) as never,
    resolveElementSelectorForTab: async () => {
      throw new Error('not used')
    },
    resolveFrameTarget: async () => {
      throw new Error('not used')
    },
    evaluateInTabContext: async (_tabId: unknown, expression: string) => {
      expressions.push(expression)
      return { tab: { id: 1 } as never, response: { result: {} }, value }
    },
    sendDebuggerCommand: async () => undefined as never,
  } as never)

  return { domain, expressions }
}

// 执行真正的注入表达式；只模拟 DOM API，不模拟 snapshot 的返回值。
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
  treeScope: ObserveDocument | null = null
  constructor(public tagName = 'BUTTON') {}
  getRootNode() {
    return this.treeScope ?? this.ownerDocument ?? null
  }
  getAttribute(key: string) {
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
    this.attach()
    return this.nodes.filter((node) => node.matches(selector))
  }
  querySelector(selector: string) {
    this.attach()
    return this.nodes.filter((node) => node.matches(selector))[0] ?? null
  }
  getElementById(id: string) {
    this.attach()
    return this.nodes.find((node) => node.id === id) ?? null
  }
}

function expressionHarness(document: ObserveDocument) {
  const payloads: unknown[] = []
  const expressions: string[] = []
  const domain = createPageObserveDomain({
    state: createState(),
    getTargetTab: async () => ({ id: 1 }),
    resolveElementSelectorForTab: async (_: unknown, selector: string) => ({
      tab: { id: 1 },
      resolvedSelector: selector,
    }),
    resolveFrameTarget: async () => {
      throw new Error('unused')
    },
    evaluateInTabContext: async (_: unknown, expression: string) => {
      expressions.push(expression)
      const value = await new Function(
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
        document,
        { href: document.title },
        { scrollX: 0, scrollY: 0 },
        ObserveNode,
        ObserveInput,
        ObserveAnchor,
        ObserveFrame,
        document.defaultView.getComputedStyle,
      )
      payloads.push(value)
      return { tab: { id: 1 }, response: { result: {} }, value }
    },
    sendDebuggerCommand: async () => undefined,
  } as never)
  return { domain, payloads }
}

const buttonNodes = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const node = new ObserveNode()
    node.innerText = `Button ${index + 1}`
    return node
  })

describe('snapshot --limit parsing', () => {
  test('parses a limit and keeps the other snapshot options intact', () => {
    const args = parseSnapshotArgs(['--target', '#panel', '--role', 'button', '--limit', '120'])

    expect(args).toEqual({
      target: '#panel',
      roles: ['button'],
      changed: false,
      includeText: false,
      limit: 120,
    })
  })

  test('accepts the inclusive 1..200 boundaries and omits limit when absent', () => {
    expect(parseSnapshotArgs(['--limit', '1']).limit).toBe(1)
    expect(parseSnapshotArgs(['--limit', '200']).limit).toBe(200)
    expect(parseSnapshotArgs([])).not.toHaveProperty('limit')
  })

  test('parses --include-text as an explicit opt-in', () => {
    expect(parseSnapshotArgs(['--include-text']).includeText).toBe(true)
    expect(parseSnapshotArgs([]).includeText).toBe(false)
  })

  test('rejects non-integer and out-of-range limits', () => {
    expect(() => parseSnapshotArgs(['--limit', '0'])).toThrow('expected >= 1')
    expect(() => parseSnapshotArgs(['--limit', '201'])).toThrow('expected <= 200')
    expect(() => parseSnapshotArgs(['--limit', '1.5'])).toThrow('expected an integer')
    expect(() => parseSnapshotArgs(['--limit', 'abc'])).toThrow('expected a finite number')
    expect(() => parseSnapshotArgs(['--limit'])).toThrow('missing limit value')
  })

  test('applies the same range to direct command and MCP calls', () => {
    expect(() => validateCommandArgs('snapshot', { limit: 120 })).not.toThrow()
    expect(() => validateCommandArgs('snapshot', { limit: 0 })).toThrow('between 1 and 200')
    expect(() => validateCommandArgs('snapshot', { limit: 201 })).toThrow('between 1 and 200')
  })
})

describe('snapshot --limit forwarding', () => {
  test('forwards limit to the extension request', async () => {
    const result = await runCli(['snapshot', '--limit', '120'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'snapshot',
      args: {
        limit: 120,
        responseFormat: 'concise',
      },
    })
  })

  test('does not send a limit key when the flag is missing', async () => {
    const result = await runCli(['snapshot'])

    expect(result.fetchCalls[0].body).toEqual({
      command: 'snapshot',
      args: {
        responseFormat: 'concise',
      },
    })
  })

  test('forwards --include-text only when explicitly requested', async () => {
    const result = await runCli(['snapshot', '--include-text'])

    expect(result.fetchCalls[0].body).toEqual({
      command: 'snapshot',
      args: {
        includeText: true,
        responseFormat: 'concise',
      },
    })
  })

  test('rejects an invalid limit before calling the extension', async () => {
    const result = await runCli(['snapshot', '--limit', '0'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain('invalid limit')
  })
})

describe('snapshot limit element caps', () => {
  test('keeps the concise 50 / detailed 200 defaults when limit is absent', async () => {
    const concise = createRecordingObserve()
    await concise.domain.snapshotTab(1, null)

    const detailed = createRecordingObserve()
    await detailed.domain.snapshotTab(1, null, { responseFormat: 'detailed' })

    expect(concise.expressions[0]).toContain('append(result.elements, item, 50)')
    expect(detailed.expressions[0]).toContain('append(result.elements, item, 200)')
  })

  test('raises the concise cap above 50 when a limit is given', async () => {
    const { domain, expressions } = createRecordingObserve()

    await domain.snapshotTab(1, null, { limit: 120 })

    expect(expressions[0]).toContain('append(result.elements, item, 120)')
  })

  test('never exceeds the 200 element hard cap and ignores malformed limits', async () => {
    const capped = createRecordingObserve()
    await capped.domain.snapshotTab(1, null, { limit: 500 })
    await capped.domain.snapshotTab(1, null, { limit: 200.9 })

    expect(capped.expressions[0]).toContain('append(result.elements, item, 200)')
    expect(capped.expressions[1]).toContain('append(result.elements, item, 200)')

    const malformed = createRecordingObserve()
    await malformed.domain.snapshotTab(1, null, { limit: 0 })
    await malformed.domain.snapshotTab(1, null, { limit: Number.NaN, responseFormat: 'detailed' })

    expect(malformed.expressions[0]).toContain('append(result.elements, item, 50)')
    expect(malformed.expressions[1]).toContain('append(result.elements, item, 200)')
  })

  test('does not relax the byte budget when the limit grows', async () => {
    const concise = createRecordingObserve()
    await concise.domain.snapshotTab(1, null, { limit: 200 })

    const detailed = createRecordingObserve()
    await detailed.domain.snapshotTab(1, null, { limit: 200, responseFormat: 'detailed' })

    expect(concise.expressions[0]).toContain('truncateSnapshotToByteLimit(result, 32768)')
    expect(detailed.expressions[0]).toContain('truncateSnapshotToByteLimit(result, 200000)')
  })
})

describe('snapshot limit truncation metadata', () => {
  test('delivers exactly the limit and reports the dropped elements', async () => {
    const h = expressionHarness(new ObserveDocument(buttonNodes(5)))

    const result = (await h.domain.snapshotTab(1, null, { limit: 2 })) as SnapshotResult

    expect(result.elements).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.totalElements).toBe(5)
    expect(result.returnedElements).toBe(2)
  })

  test('does not mark truncation when the element count matches the limit exactly', async () => {
    const h = expressionHarness(new ObserveDocument(buttonNodes(2)))

    const result = (await h.domain.snapshotTab(1, null, { limit: 2 })) as SnapshotResult

    expect(result.elements).toHaveLength(2)
    expect(result).not.toHaveProperty('truncated')
    expect(result).not.toHaveProperty('totalElements')
    expect(result).not.toHaveProperty('returnedElements')
  })

  test('limit raises the concise delivery above the default 50', async () => {
    const h = expressionHarness(new ObserveDocument(buttonNodes(120)))

    const defaultPage = (await h.domain.snapshotTab(1, null)) as SnapshotResult
    const raised = (await h.domain.snapshotTab(1, null, { limit: 120 })) as SnapshotResult

    expect(defaultPage.elements).toHaveLength(50)
    expect(defaultPage.truncated).toBe(true)
    expect(defaultPage.totalElements).toBe(120)
    expect(raised.elements).toHaveLength(120)
    // buttons 摘要仍有独立上限，因此全局 truncated 可能由摘要而不是 elements 触发。
    expect(raised.totalElements).toBe(120)
  })

  test('a limit above the hard cap still delivers at most 200 elements', async () => {
    const h = expressionHarness(new ObserveDocument(buttonNodes(220)))

    const result = (await h.domain.snapshotTab(1, null, {
      limit: 250,
      responseFormat: 'detailed',
    })) as SnapshotResult

    expect(result.elements).toHaveLength(200)
    expect(result.truncated).toBe(true)
    expect(result.totalElements).toBe(220)
    expect(result.returnedElements).toBe(200)
  })

  test('the byte cap still applies when the limit is maxed out', async () => {
    const nodes = buttonNodes(200).map((node) => {
      node.setAttribute('placeholder', '界'.repeat(4000))
      return node
    })
    const h = expressionHarness(new ObserveDocument(nodes))

    const result = (await h.domain.snapshotTab(1, null, { limit: 200 })) as SnapshotResult

    expect(result.truncated).toBe(true)
    expect(result.elements).toHaveLength(result.returnedElements!)
    expect(result.returnedElements!).toBeLessThan(200)
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(32_768)
  })
})

describe('snapshot limit cache isolation', () => {
  test('isolates --changed baselines per limit and only stores delivered elements', async () => {
    const h = expressionHarness(new ObserveDocument(buttonNodes(5)))

    // 先按 limit=2 建立 baseline：只有交付的前两个元素能进入签名集合
    await h.domain.snapshotTab(1, null, { limit: 2, changed: true })
    const baseline = (h.payloads.at(-1) as { signatures: string[] }).signatures
    expect(baseline).toHaveLength(2)

    const sameLimit = (await h.domain.snapshotTab(1, null, {
      limit: 2,
      changed: true,
    })) as SnapshotResult
    // 未进入 baseline 的第 3、4 项会在下一次同 limit 快照中补交付（concise 不带 text，按 ref 断言）。
    expect(sameLimit.elements.map((element) => element.ref)).toEqual(['@e3#p1', '@e4#p1'])
    expect(sameLimit.unchangedCount).toBe(2)

    // 不同 limit 必须换键：不能拿 limit=2 的 baseline 去 diff limit=3 的交付集
    const widerLimit = (await h.domain.snapshotTab(1, null, {
      limit: 3,
      changed: true,
    })) as SnapshotResult
    expect(widerLimit.full).toBe(true)
    expect(widerLimit.elements).toHaveLength(3)
    expect(widerLimit.truncated).toBe(true)
    expect(widerLimit.totalElements).toBe(5)
  })
})
