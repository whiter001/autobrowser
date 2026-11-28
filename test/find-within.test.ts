import { describe, expect, test } from 'bun:test'
import { parseFindArgs } from '../src/cli/parse.js'
import {
  getAgentElementRefPageEpoch,
  isStaleAgentElementRef,
  resolveAgentSelector,
} from '../src/core/agent-selectors.js'
import { validateCommandArgs } from '../src/core/command-spec.js'
import { createCommandHandlers } from '../extension/background/command-handlers.js'
import { createPageObserveDomain } from '../extension/background/page-observe.js'
import { createExtensionState } from '../extension/background/state.js'

// ---------- 轻量假 DOM：只模拟 find 脚本用到的 DOM API ----------
// 与 page-observe.test.ts 的桩不同，这里执行真实注入脚本，断言的是匹配/收窄逻辑本身。

function collectDescendants(nodes: MockNode[]): MockNode[] {
  const collected: MockNode[] = []
  const visit = (list: MockNode[]) => {
    for (const node of list) {
      collected.push(node)
      visit(node.children)
    }
  }
  visit(nodes)
  return collected
}

class MockShadowRoot {
  readonly nodeType = 11
  host!: MockNode
  children: MockNode[] = []

  querySelectorAll(selector: string): MockNode[] {
    return collectDescendants(this.children).filter((node) => node.matches(selector))
  }

  getElementById(id: string): MockNode | null {
    return collectDescendants(this.children).find((node) => node.id === id) ?? null
  }
}

class MockNode {
  readonly nodeType = 1
  attributes = new Map<string, string>()
  children: MockNode[] = []
  parentElement: MockNode | null = null
  parentNode: MockNode | MockShadowRoot | MockDocument | null = null
  shadowRoot: MockShadowRoot | null = null
  ownerDocument!: MockDocument
  treeScope: MockDocument | MockShadowRoot | null = null
  innerText = ''
  textContent = ''
  id = ''
  type = 'text'
  value = ''
  rect = { left: 0, top: 0, width: 40, height: 20 }

  constructor(public tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getBoundingClientRect() {
    return this.rect
  }

  getRootNode(): MockDocument | MockShadowRoot | null {
    return this.treeScope ?? this.ownerDocument
  }

  attachShadow(): MockShadowRoot {
    const root = new MockShadowRoot()
    root.host = this
    this.shadowRoot = root
    return root
  }

  matches(selector: string): boolean {
    return selector.split(',').some((part) => this.matchesPart(part.trim()))
  }

  closest(selector: string): MockNode | null {
    if (this.matches(selector)) return this
    return this.parentElement?.closest(selector) ?? null
  }

  querySelectorAll(selector: string): MockNode[] {
    return collectDescendants(this.children).filter((node) => node.matches(selector))
  }

  private matchesPart(part: string): boolean {
    if (!part) return false
    if (part === '*') return true

    const notIndex = part.indexOf(':not(')
    if (notIndex >= 0) {
      const inner = part.slice(notIndex + 5, part.lastIndexOf(')'))
      return this.matchesPart(part.slice(0, notIndex)) && !this.matchesPart(inner)
    }

    let rest = part
    const tagMatch = /^([a-z0-9-]+|\*)/i.exec(rest)
    if (tagMatch) {
      if (tagMatch[1] !== '*' && this.tagName.toLowerCase() !== tagMatch[1]!.toLowerCase()) {
        return false
      }
      rest = rest.slice(tagMatch[0].length)
    }

    const idMatch = /#([\w-]+)/.exec(rest)
    if (idMatch && this.id !== idMatch[1]) return false

    const classes = String(this.attributes.get('class') ?? '')
      .split(/\s+/)
      .filter(Boolean)
    for (const match of rest.matchAll(/\.([\w-]+)/g)) {
      if (!classes.includes(match[1]!)) return false
    }

    for (const match of rest.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g)) {
      const name = match[1]!
      const expected = match[2] ?? match[3] ?? match[4]
      if (!this.attributes.has(name)) return false
      if (expected !== undefined && this.attributes.get(name) !== expected) return false
    }

    return true
  }
}

class MockInput extends MockNode {
  constructor() {
    super('INPUT')
    this.setAttribute('type', 'text')
  }
}

class MockAnchor extends MockNode {
  constructor() {
    super('A')
    this.setAttribute('href', '/target')
  }
}

class MockDocument {
  title = ''
  readyState = 'complete'
  body = { innerText: '' }
  defaultView = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  }
  __autobrowserObservation?: unknown

  constructor(public roots: MockNode[] = []) {
    this.attach()
  }

  attach(): void {
    const visit = (
      nodes: MockNode[],
      parentElement: MockNode | null,
      parentNode: MockNode | MockShadowRoot | MockDocument,
      scope: MockDocument | MockShadowRoot,
    ) => {
      for (const node of nodes) {
        node.ownerDocument = this
        node.parentElement = parentElement
        node.parentNode = parentNode
        node.treeScope = scope
        visit(node.children, node, node, scope)
        if (node.shadowRoot) {
          node.shadowRoot.host = node
          visit(node.shadowRoot.children, null, node.shadowRoot, node.shadowRoot)
        }
      }
    }
    visit(this.roots, null, this, this)
  }

  querySelectorAll(selector: string): MockNode[] {
    this.attach()
    return collectDescendants(this.roots).filter((node) => node.matches(selector))
  }

  getElementById(id: string): MockNode | null {
    this.attach()
    return collectDescendants(this.roots).find((node) => node.id === id) ?? null
  }
}

function createFindHarness(roots: MockNode[]) {
  const document = new MockDocument(roots)
  const state = createExtensionState(57978)
  const domain = createPageObserveDomain({
    state,
    getTargetTab: async () => ({ id: 1 }),
    resolveElementSelectorForTab: async (_: unknown, selector: string) => {
      if (isStaleAgentElementRef(selector, 1)) {
        throw Object.assign(new Error(`element ref ${selector} is stale`), {
          code: 'STALE_ELEMENT_REF',
          expectedPageEpoch: getAgentElementRefPageEpoch(selector),
          currentPageEpoch: 1,
        })
      }
      return { tab: { id: 1 }, pageEpoch: 1, resolvedSelector: resolveAgentSelector(selector) }
    },
    resolveFrameTarget: async () => {
      throw new Error('unused')
    },
    evaluateInTabContext: async (_: unknown, expression: string) => {
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
        MockNode,
        MockInput,
        MockAnchor,
        MockNode,
        document.defaultView.getComputedStyle,
      )
      return { tab: { id: 1 }, response: { result: {} }, value }
    },
    sendDebuggerCommand: async () => undefined,
  } as never)
  return {
    document,
    state,
    domain,
    find: (options: Record<string, unknown>) =>
      domain.findSemanticTarget(1, options as never, null),
  }
}

/** 通过 handleFindCommand 驱动完整 find 流程（真实页面脚本 + 动作分发）。 */
function createHandlerHarness(findHarness: ReturnType<typeof createFindHarness>) {
  const clickCalls: string[] = []
  const handlers = createCommandHandlers({
    state: findHarness.state,
    getTargetTab: async () => ({ id: 1 }),
    pageInput: {
      clickSelector: async (_tabId: unknown, selector: string) => {
        clickCalls.push(selector)
        return { clicked: selector }
      },
    },
    pageObserve: findHarness.domain,
    webmcp: {},
    downloads: {},
    fileTransfer: {},
    mediaDomain: {},
    initScripts: {},
    sendDebuggerCommand: async () => undefined,
    handleTabsCommand: async () => ({}),
    handleDiagnosticsCommand: async () => ({}),
    handleNetworkCommand: async () => ({}),
    handleSessionCommand: async () => ({}),
    handleBatchCommand: async () => ({}),
  } as never)

  const run = async (args: Record<string, unknown>) =>
    handlers.handle({
      scope: { command: 'find', action: '', args, tabId: 1, frameSelector: null } as never,
      executionFrame: null,
    })

  return { run, clickCalls }
}

function button(text: string, rect = { left: 0, top: 0, width: 40, height: 20 }) {
  const node = new MockNode('BUTTON')
  node.innerText = text
  node.rect = rect
  return node
}

function container(tagName: string, className: string, extra: { id?: string } = {}) {
  const node = new MockNode(tagName)
  node.setAttribute('class', className)
  if (extra.id) node.id = extra.id
  return node
}

/** records 容器里两个同名按钮，record-42 内一个、record-41 内一个；容器外还有一个同名按钮。 */
function recordsFixture() {
  const outside = button('删除', { left: 500, top: 0, width: 40, height: 20 })
  const record41 = container('DIV', 'record', { id: 'record-41' })
  const record42 = container('DIV', 'record', { id: 'record-42' })
  record42.setAttribute('data-autobrowser-ref', 'e7')
  const inside41 = button('删除', { left: 0, top: 0, width: 40, height: 20 })
  const inside42 = button('删除', { left: 0, top: 40, width: 40, height: 20 })
  record41.children = [inside41]
  record42.children = [inside42]
  const records = container('DIV', 'records', { id: 'records' })
  records.children = [record41, record42]
  return { records, record41, record42, inside41, inside42, outside }
}

describe('find within containers (executed page script)', () => {
  test('same-name buttons stay ambiguous without within and resolve inside a unique container', async () => {
    const fixture = recordsFixture()
    const h = createFindHarness([fixture.records])

    await expect(
      h.find({ strategy: 'role', role: 'button', name: '删除', requireUnique: true }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' })

    const scoped = await h.find({
      strategy: 'role',
      role: 'button',
      name: '删除',
      requireUnique: true,
      within: ['#record-42'],
    })

    expect(scoped).toMatchObject({
      found: true,
      within: ['#record-42'],
      match: { tag: 'button', name: '删除', y: 50 },
    })
    expect(fixture.inside42.getAttribute('data-autobrowser-ref')).toBeTruthy()
  })

  test('two nested layers narrow step by step', async () => {
    const h = createFindHarness([recordsFixture().records])

    const scoped = await h.find({
      strategy: 'role',
      role: 'button',
      name: '删除',
      within: ['.records', '#record-41'],
    })

    expect(scoped).toMatchObject({
      found: true,
      within: ['.records', '#record-41'],
      match: { tag: 'button', y: 10 },
    })
  })

  test('@eN container resolves to its selector and is reported back', async () => {
    const h = createFindHarness([recordsFixture().records])

    const scoped = await h.find({
      strategy: 'role',
      role: 'button',
      name: '删除',
      within: '@e7',
    })

    expect(scoped).toMatchObject({
      found: true,
      within: ['[data-autobrowser-ref="e7"]'],
      match: { tag: 'button', y: 50 },
    })
  })

  test('a stale @eN container fails before the page script runs', async () => {
    const h = createFindHarness([recordsFixture().records])

    await expect(
      h.find({ strategy: 'role', role: 'button', within: '@e7#p9' }),
    ).rejects.toMatchObject({ code: 'STALE_ELEMENT_REF' })
  })

  test('missing container reports WITHIN_SCOPE_NOT_FOUND with the layer and selector', async () => {
    const h = createFindHarness([recordsFixture().records])

    const error = await h
      .find({ strategy: 'role', role: 'button', within: ['#missing'] })
      .then(() => {
        throw new Error('expected within failure')
      })
      .catch(
        (value: unknown) => value as { code?: string; details?: unknown; suggestedAction?: string },
      )

    expect(error.code).toBe('WITHIN_SCOPE_NOT_FOUND')
    expect(error.details).toMatchObject({ layer: 1, selector: '#missing', candidates: [] })
    expect(error.suggestedAction).toContain('details.layer')
  })

  test('ambiguous container returns bounded candidates instead of picking the first', async () => {
    const h = createFindHarness([recordsFixture().records])

    const error = await h
      .find({ strategy: 'role', role: 'button', within: ['.records', '.record'] })
      .then(() => {
        throw new Error('expected within failure')
      })
      .catch((value: unknown) => value as { code?: string; details?: { candidates?: unknown[] } })

    expect(error.code).toBe('WITHIN_SCOPE_AMBIGUOUS')
    expect(error.details?.candidates).toHaveLength(2)
    expect(error.details).toMatchObject({ layer: 2, selector: '.record' })
  })

  test('a layer that only matches outside the previous container reports WITHIN_SCOPE_ESCAPE', async () => {
    const h = createFindHarness([recordsFixture().records])

    const error = await h
      .find({ strategy: 'role', role: 'button', within: ['#record-42', '.records'] })
      .then(() => {
        throw new Error('expected within failure')
      })
      .catch((value: unknown) => value as { code?: string; details?: unknown })

    expect(error.code).toBe('WITHIN_SCOPE_ESCAPE')
    expect(error.details).toMatchObject({ layer: 2, selector: '.records' })
  })

  test('container errors are not downgraded to ELEMENT_NOT_FOUND for locate', async () => {
    const h = createFindHarness([recordsFixture().records])

    await expect(
      h.find({
        strategy: 'role',
        role: 'button',
        action: 'locate',
        allowNoMatch: true,
        within: ['#missing'],
      }),
    ).rejects.toMatchObject({ code: 'WITHIN_SCOPE_NOT_FOUND' })
  })

  test('text fallback does not climb to an actionable ancestor outside the container', async () => {
    const outerButton = new MockNode('BUTTON')
    const panel = container('DIV', 'panel')
    const span = new MockNode('SPAN')
    span.innerText = 'Open'
    panel.children = [span]
    outerButton.children = [panel]

    const h = createFindHarness([outerButton])
    const result = await h.find({ strategy: 'text', query: 'Open', within: ['.panel'] })

    // 容器内没有可交互祖先，保留原节点而不是把动作带到容器外的 button
    expect(result).toMatchObject({ found: true, match: { tag: 'span', name: 'Open' } })
    expect(span.getAttribute('data-autobrowser-ref')).toBeTruthy()
    expect(outerButton.getAttribute('data-autobrowser-ref')).toBeNull()
  })

  test('shadow content stays inside the container and never escapes to an outer actionable host', async () => {
    const outerButton = new MockNode('BUTTON')
    const host = container('DIV', 'host', { id: 'host' })
    const shadow = host.attachShadow()
    const shadowButton = button('Delete', { left: 10, top: 10, width: 30, height: 10 })
    shadow.children = [shadowButton]
    outerButton.children = [host]

    const h = createFindHarness([outerButton])

    const scoped = await h.find({
      strategy: 'role',
      role: 'button',
      name: 'Delete',
      within: ['#host'],
    })
    expect(scoped).toMatchObject({ found: true, match: { tag: 'button', x: 25, y: 15 } })

    // 容器内只有非交互文本：不能上溯到容器外的 button
    const textHost = container('DIV', 'text-host', { id: 'text-host' })
    const textShadow = textHost.attachShadow()
    const shadowSpan = new MockNode('SPAN')
    shadowSpan.innerText = 'Rename'
    textShadow.children = [shadowSpan]
    const wrappingButton = new MockNode('BUTTON')
    wrappingButton.children = [textHost]
    const textHarness = createFindHarness([wrappingButton])
    const textResult = await textHarness.find({
      strategy: 'text',
      query: 'Rename',
      within: ['#text-host'],
    })

    expect(textResult).toMatchObject({ found: true, match: { tag: 'span' } })
    expect(wrappingButton.getAttribute('data-autobrowser-ref')).toBeNull()
  })

  test('the final container itself can be the semantic target', async () => {
    const submit = button('提交')
    const h = createFindHarness([submit])

    const result = await h.find({ strategy: 'text', query: '提交', within: ['button'] })

    expect(result).toMatchObject({ found: true, within: ['button'], match: { tag: 'button' } })
  })

  test('without within the result shape and candidate ordering stay unchanged', async () => {
    const first = button('Save', { left: 0, top: 0, width: 40, height: 20 })
    const second = button('Save', { left: 100, top: 0, width: 40, height: 20 })
    const h = createFindHarness([first, second])

    const candidates = await h.find({ strategy: 'text', query: 'Save', candidates: 5 })
    expect(candidates).not.toHaveProperty('within')
    expect((candidates.candidates as Array<{ x: number }>).map((item) => item.x)).toEqual([20, 120])

    const last = await h.find({ strategy: 'text', query: 'Save', position: 'last' })
    expect(last).toMatchObject({ found: true, match: { x: 120 } })
    expect(last).not.toHaveProperty('within')

    await expect(
      h.find({ strategy: 'text', query: 'Save', requireUnique: true }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' })
  })

  test('invalid within values fail with INVALID_COMMAND_ARGS', async () => {
    const h = createFindHarness([recordsFixture().records])

    await expect(
      h.find({ strategy: 'role', role: 'button', within: Array(7).fill('.record') }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
    await expect(
      h.find({ strategy: 'role', role: 'button', within: ['  '] }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
  })
})

describe('find within end-to-end through command handlers', () => {
  test('a scoped click performs the action on the in-container ref', async () => {
    const h = createFindHarness([recordsFixture().records])
    const handler = createHandlerHarness(h)

    const result = (await handler.run({
      strategy: 'role',
      role: 'button',
      name: '删除',
      action: 'click',
      within: '.records',
      position: 'nth=2',
    })) as { match?: { ref?: string; y?: number }; within?: string[]; action?: string }

    expect(result.within).toEqual(['.records'])
    expect(result.match).toMatchObject({ y: 50 })
    expect(result.action).toBe('click')
    expect(result.match?.ref).toBeTruthy()
    expect(handler.clickCalls).toEqual([result.match?.ref ?? ''])
  })

  test('handler forwards within as a string or array and keeps write ambiguity protection', async () => {
    const h = createFindHarness([recordsFixture().records])
    const handler = createHandlerHarness(h)

    await expect(
      handler.run({
        strategy: 'role',
        role: 'button',
        name: '删除',
        action: 'click',
        within: '.records',
      }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' })
    expect(handler.clickCalls).toEqual([])

    const single = (await handler.run({
      strategy: 'role',
      role: 'button',
      name: '删除',
      action: 'locate',
      within: '#record-42',
    })) as { within?: string[] }
    expect(single.within).toEqual(['#record-42'])
  })
})

describe('find within CLI and protocol', () => {
  test('repeated --within keeps outer-to-inner order', () => {
    expect(
      parseFindArgs([
        'role',
        'button',
        'click',
        '--name',
        '删除',
        '--within',
        '.records',
        '--within',
        '#record-42',
      ]),
    ).toMatchObject({
      strategy: 'role',
      role: 'button',
      action: 'click',
      name: '删除',
      within: ['.records', '#record-42'],
    })

    expect(parseFindArgs(['text', '删除', 'click', '--within', '@e7'])).toMatchObject({
      within: ['@e7'],
    })
  })

  test('rejects a seventh layer and empty container values', () => {
    const args = ['role', 'button']
    for (let index = 0; index < 6; index += 1) args.push('--within', `.layer-${index}`)
    expect(parseFindArgs(args)).toMatchObject({ within: expect.any(Array) })
    args.push('--within', '.layer-6')
    expect(() => parseFindArgs(args)).toThrow('at most 6 nested layers')

    expect(() => parseFindArgs(['role', 'button', '--within', ' '])).toThrow(
      '--within requires a non-empty container',
    )
    expect(() => parseFindArgs(['role', 'button', '--within'])).toThrow(
      '--within requires a non-empty container',
    )
  })

  test('protocol validation accepts string|string[] and reports bad shapes', () => {
    expect(() =>
      validateCommandArgs('find', { strategy: 'role', role: 'button', within: '.records' }),
    ).not.toThrow()
    expect(() =>
      validateCommandArgs('find', {
        strategy: 'role',
        role: 'button',
        within: ['.records', '#record-42'],
      }),
    ).not.toThrow()
    // 空数组等同未提供
    expect(() =>
      validateCommandArgs('find', { strategy: 'role', role: 'button', within: [] }),
    ).not.toThrow()

    expect(() =>
      validateCommandArgs('find', {
        strategy: 'role',
        role: 'button',
        within: Array(7).fill('.record'),
      }),
    ).toThrow('at most 6 nested layers')
    expect(() =>
      validateCommandArgs('find', { strategy: 'role', role: 'button', within: [''] }),
    ).toThrow('must be non-empty')
    expect(() =>
      validateCommandArgs('find', { strategy: 'role', role: 'button', within: 5 }),
    ).toThrow('within must be a string or an array of strings')
  })
})
