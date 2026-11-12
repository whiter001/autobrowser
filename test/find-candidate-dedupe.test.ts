import { describe, expect, test } from 'bun:test'
import { createPageObserveDomain } from '../extension/background/page-observe.js'

// 直接执行注入到页面的 find 表达式：只桩掉 DOM API，不按预期结果打桩，
// 这样断言的是真实匹配/排序/去重逻辑，而不是扩展侧透传。
class MockNode {
  tagName: string
  attributes = new Map<string, string>()
  children: MockNode[] = []
  parentElement: MockNode | null = null
  ownerDocument!: MockDocument
  shadowRoot: MockDocument | null = null
  innerText = ''
  textContent = ''
  id = ''
  value = ''
  type = 'text'
  labels: MockNode[] | null = null
  rect = { left: 0, top: 0, width: 40, height: 20 }

  constructor(tagName: string) {
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

  getRootNode(): MockDocument {
    return this.ownerDocument
  }

  matches(selector: string): boolean {
    return selector.split(',').some((part) => this.matchesPart(part.trim()))
  }

  closest(selector: string): MockNode | null {
    if (this.matches(selector)) return this
    return this.parentElement?.closest(selector) ?? null
  }

  private matchesPart(part: string): boolean {
    if (!part) return false
    if (part === '*') return true
    const notMatch = /:not\((.*)\)/.exec(part)
    if (notMatch) {
      return this.matchesPart(part.slice(0, notMatch.index)) && !this.matchesPart(notMatch[1]!)
    }
    const tag = /^[a-z0-9-]+/i.exec(part)?.[0]
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false
    const attributes = Array.from(part.matchAll(/\[([^\]=]+)(?:=["']?([^"'\]]+)["']?)?\]/g))
    return attributes.every(([, name, value]) => {
      const actual = this.attributes.get(name!)
      return actual !== undefined && (value === undefined || actual === value)
    })
  }
}

class MockInput extends MockNode {
  constructor() {
    super('INPUT')
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

  constructor(public nodes: MockNode[] = []) {
    this.attach()
  }

  // 平铺列表 + children 组合：querySelectorAll('*') 走平铺列表，祖先关系走 parentElement
  attach(): void {
    // 先记下被 children 引用的节点，扁平列表里的同一节点不能再被当成根节点覆盖父指针
    const childNodes = new Set<MockNode>()
    for (const node of this.nodes) {
      for (const child of node.children) childNodes.add(child)
    }
    const link = (parent: MockNode | null, nodes: MockNode[]) => {
      for (const node of nodes) {
        if (parent === null && childNodes.has(node)) continue
        node.ownerDocument = this
        node.parentElement = parent
        link(node, node.children)
      }
    }
    link(null, this.nodes)
  }

  querySelectorAll(selector: string): MockNode[] {
    this.attach()
    return this.nodes.filter((node) => node.matches(selector))
  }

  querySelector(selector: string): MockNode | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  getElementById(id: string): MockNode | null {
    this.attach()
    return this.nodes.find((node) => node.id === id) ?? null
  }
}

type FindOptions = Record<string, unknown>
type Candidate = {
  ref: string
  tag: string
  role: string | null
  text: string
  name: string
  x: number
  y: number
}

function createHarness(nodes: MockNode[]) {
  const document = new MockDocument(nodes)
  const state = {
    targeting: { selectedFrames: new Map<number, string>(), pageEpochs: new Map<number, number>() },
    session: { dialogs: new Map<number, unknown>(), lastDialog: null },
  }
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
    find: (options: FindOptions) => domain.findSemanticTarget(1, options as never, null),
  }
}

function setRect(node: MockNode, left: number, top: number, width: number, height: number) {
  node.rect = { left, top, width, height }
  return node
}

function candidateTags(candidates: Candidate[] | undefined) {
  return (candidates ?? []).map((candidate) => candidate.tag)
}

// role=menuitem 的包装 <li> 与它内部的 <a href> 会被同时命中：同一个点位、同一段文案
function menuItemWithAnchor(anchorText = 'Save') {
  const anchor = new MockAnchor()
  anchor.innerText = anchorText
  const menuItem = new MockNode('LI')
  menuItem.setAttribute('role', 'menuitem')
  menuItem.setAttribute('tabindex', '0')
  menuItem.innerText = anchorText
  menuItem.children = [anchor]
  return { anchor, menuItem }
}

describe('find candidates nested dedupe', () => {
  test('collapses a role wrapper into the native descendant at the same point', async () => {
    const { anchor, menuItem } = menuItemWithAnchor()
    const h = createHarness([menuItem, anchor])

    const result = await h.find({ strategy: 'text', query: 'Save', candidates: 5 })
    const candidates = result.candidates as Candidate[]

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ tag: 'a', role: 'link', name: 'Save', x: 20, y: 10 })
  })

  test('collapses a nested wrapper chain down to one candidate', async () => {
    const { anchor, menuItem } = menuItemWithAnchor()
    const outerItem = new MockNode('DIV')
    outerItem.setAttribute('role', 'menuitem')
    outerItem.setAttribute('tabindex', '0')
    outerItem.innerText = 'Save'
    outerItem.children = [menuItem]

    const result = await createHarness([outerItem, menuItem, anchor]).find({
      strategy: 'text',
      query: 'Save',
      candidates: 5,
    })

    expect(candidateTags(result.candidates as Candidate[])).toEqual(['a'])
  })

  test('merges by normalized text when the wrapper name comes from aria-label', async () => {
    const anchor = new MockAnchor()
    anchor.innerText = 'Delete'
    const menuItem = new MockNode('DIV')
    menuItem.setAttribute('role', 'menuitem')
    menuItem.setAttribute('tabindex', '0')
    menuItem.setAttribute('aria-label', 'Row actions')
    menuItem.innerText = 'Delete'
    menuItem.children = [anchor]

    const result = await createHarness([menuItem, anchor]).find({
      strategy: 'text',
      query: 'Delete',
      candidates: 5,
    })
    const candidates = result.candidates as Candidate[]

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ tag: 'a', name: 'Delete' })
  })

  test('keeps the native ancestor when the descendant is only a role wrapper', async () => {
    const innerItem = new MockNode('DIV')
    innerItem.setAttribute('role', 'menuitem')
    innerItem.setAttribute('tabindex', '0')
    innerItem.innerText = 'Save'
    const button = new MockNode('BUTTON')
    button.innerText = 'Save'
    button.children = [innerItem]

    const result = await createHarness([button, innerItem]).find({
      strategy: 'text',
      query: 'Save',
      candidates: 5,
    })
    const candidates = result.candidates as Candidate[]

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ tag: 'button', role: 'button' })
  })

  test('keeps parallel same-text buttons that share the same position', async () => {
    const first = new MockNode('BUTTON')
    first.innerText = 'Save'
    const second = new MockNode('BUTTON')
    second.innerText = 'Save'

    const result = await createHarness([first, second]).find({
      strategy: 'text',
      query: 'Save',
      candidates: 5,
    })

    // 无祖先关系，即便文案与中心点完全相同也必须全部保留
    expect(candidateTags(result.candidates as Candidate[])).toEqual(['button', 'button'])
  })

  test('keeps nested targets whose centers differ', async () => {
    const { anchor, menuItem } = menuItemWithAnchor()
    setRect(menuItem, 0, 0, 600, 400)
    setRect(anchor, 20, 20, 100, 20)

    const result = await createHarness([menuItem, anchor]).find({
      strategy: 'text',
      query: 'Save',
      candidates: 5,
    })

    expect(candidateTags(result.candidates as Candidate[])).toEqual(['li', 'a'])
  })

  test('keeps same-name targets at different positions', async () => {
    const left = setRect(new MockNode('BUTTON'), 0, 0, 40, 20)
    left.innerText = 'Save'
    const right = setRect(new MockNode('BUTTON'), 200, 0, 40, 20)
    right.innerText = 'Save'

    const result = await createHarness([left, right]).find({
      strategy: 'text',
      query: 'Save',
      candidates: 5,
    })

    expect(result.candidates as Candidate[]).toEqual([
      expect.objectContaining({ tag: 'button', x: 20 }),
      expect.objectContaining({ tag: 'button', x: 220 }),
    ])
  })
})

describe('find text broad fallback drops matching ancestors', () => {
  // 没有可交互候选时 text 策略才走 broad 兜底，此时 html/nav/div/span 会因同一段文本全部命中
  function nestedTextChain() {
    const span = new MockNode('SPAN')
    span.innerText = 'Deep'
    const container = new MockNode('DIV')
    container.innerText = 'Deep'
    container.children = [span]
    const nav = new MockNode('NAV')
    nav.innerText = 'Deep'
    nav.children = [container]
    const html = new MockNode('HTML')
    html.innerText = 'Deep'
    html.children = [nav]
    return { html, nav, container, span, nodes: [html, nav, container, span] }
  }

  test('default first returns the deepest match instead of html/nav', async () => {
    const { span, nodes } = nestedTextChain()

    const result = await createHarness(nodes).find({ strategy: 'text', query: 'Deep' })

    expect(result.match).toMatchObject({ tag: 'span', ref: '@e1#p1' })
    expect(span.attributes.get('data-autobrowser-ref')).toBe('e1')
  })

  test('explicit position=first returns the same deepest match', async () => {
    const { nodes } = nestedTextChain()

    const result = await createHarness(nodes).find({
      strategy: 'text',
      query: 'Deep',
      position: 'first',
    })

    expect(result.match).toMatchObject({ tag: 'span' })
  })

  test('candidates exclude the matching ancestors', async () => {
    const { nodes } = nestedTextChain()

    const result = await createHarness(nodes).find({
      strategy: 'text',
      query: 'Deep',
      candidates: 5,
    })

    expect(candidateTags(result.candidates as Candidate[])).toEqual(['span'])
  })

  test('parallel same-text leaves all survive and keep DOM order', async () => {
    const first = setRect(new MockNode('SPAN'), 0, 0, 40, 20)
    first.innerText = 'Deep'
    const second = setRect(new MockNode('SPAN'), 100, 0, 40, 20)
    second.innerText = 'Deep'
    const container = new MockNode('DIV')
    container.innerText = 'Deep'
    container.children = [first, second]
    const nav = new MockNode('NAV')
    nav.innerText = 'Deep'
    nav.children = [container]
    const html = new MockNode('HTML')
    html.innerText = 'Deep'
    html.children = [nav]
    const nodes = [html, nav, container, first, second]
    const h = createHarness(nodes)
    const options = { strategy: 'text', query: 'Deep' }

    expect(
      candidateTags((await h.find({ ...options, candidates: 5 })).candidates as Candidate[]),
    ).toEqual(['span', 'span'])
    // 过滤后仍是原 DOM 顺序：first/last/nth 都基于这个序列
    expect((await h.find({ ...options, position: 'first' })).match).toMatchObject({
      tag: 'span',
      x: 20,
    })
    expect((await h.find({ ...options, position: 'nth=2' })).match).toMatchObject({
      tag: 'span',
      x: 120,
    })
    expect((await h.find({ ...options, position: 'last' })).match).toMatchObject({
      tag: 'span',
      x: 120,
    })
  })

  test('requireUnique no longer reports the dropped ancestors as ambiguity', async () => {
    const { nodes } = nestedTextChain()

    const result = await createHarness(nodes).find({
      strategy: 'text',
      query: 'Deep',
      requireUnique: true,
    })

    expect(result.match).toMatchObject({ tag: 'span' })
  })
})

describe('find candidates dedupe leaves matching semantics untouched', () => {
  test('frees a Top-N slot that the duplicate wrapper used to occupy', async () => {
    const { anchor, menuItem } = menuItemWithAnchor()
    const otherButton = setRect(new MockNode('BUTTON'), 300, 0, 40, 20)
    otherButton.innerText = 'Save'

    const result = await createHarness([menuItem, anchor, otherButton]).find({
      strategy: 'text',
      query: 'Save',
      candidates: 2,
    })

    expect(candidateTags(result.candidates as Candidate[])).toEqual(['a', 'button'])
  })

  test('write ambiguity still counts both nested matches', async () => {
    const innerButton = new MockNode('BUTTON')
    innerButton.innerText = 'Save'
    const wrapper = new MockNode('DIV')
    wrapper.setAttribute('role', 'button')
    wrapper.setAttribute('tabindex', '0')
    wrapper.innerText = 'Save'
    wrapper.children = [innerButton]
    const h = createHarness([wrapper, innerButton])

    const error = await h
      .find({ strategy: 'role', role: 'button', requireUnique: true })
      .then(() => {
        throw new Error('expected ambiguity')
      })
      .catch(
        (error: unknown) => error as { code?: string; message?: string; candidates?: Candidate[] },
      )

    // 去重只作用于 candidates 展示，写操作歧义计数必须保持 DOM 匹配数
    expect(error.code).toBe('AMBIGUOUS_TARGET')
    expect(error.message).toBe('Multiple targets matched (2).')
    expect(candidateTags(error.candidates)).toEqual(['div', 'button'])

    const displayed = await h.find({
      strategy: 'role',
      role: 'button',
      requireUnique: false,
      candidates: 5,
    })
    expect(candidateTags(displayed.candidates as Candidate[])).toEqual(['button'])
  })

  test('locate keeps returning the first DOM match instead of the deduped candidate', async () => {
    const innerButton = new MockNode('BUTTON')
    innerButton.innerText = 'Save'
    const wrapper = new MockNode('DIV')
    wrapper.setAttribute('role', 'button')
    wrapper.setAttribute('tabindex', '0')
    wrapper.innerText = 'Save'
    wrapper.children = [innerButton]

    const result = await createHarness([wrapper, innerButton]).find({
      strategy: 'role',
      role: 'button',
    })

    expect(result.candidates).toBeUndefined()
    expect(result.match).toMatchObject({ ref: '@e1#p1', tag: 'div', role: 'button' })
  })

  test('position still selects by the undeduped match sequence', async () => {
    const { anchor, menuItem } = menuItemWithAnchor()
    const h = createHarness([menuItem, anchor])
    const options = { strategy: 'text', query: 'Save' }

    const first = await h.find({ ...options, position: 'nth=1' })
    const second = await h.find({ ...options, position: 'nth=2' })

    expect(first.match).toMatchObject({ ref: '@e1#p1', tag: 'li', role: 'menuitem' })
    expect(second.match).toMatchObject({ ref: '@e2#p1', tag: 'a', role: 'link' })
  })

  test('empty candidate payload still reports NO_MATCH', async () => {
    const result = await createHarness([new MockNode('BUTTON')]).find({
      strategy: 'text',
      query: 'Missing',
      candidates: 5,
    })

    expect(result).toMatchObject({
      found: true,
      empty: true,
      emptyReason: 'NO_MATCH',
      candidates: [],
    })
  })
})
