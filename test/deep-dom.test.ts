import { describe, expect, test } from 'bun:test'
import {
  deepCollectElements,
  deepGetElementById,
  deepQuerySelector,
  deepQuerySelectorAll,
  isDeepActiveElement,
} from '../extension/background/deep-dom.js'

type MockNode = {
  tagName: string
  id?: string
  children?: MockNode[]
  shadowRoot?: MockRoot | null
  matches?: (selector: string) => boolean
}

class MockRoot {
  activeElement: MockNode | null

  constructor(
    private readonly nodes: MockNode[],
    activeElement: MockNode | null = null,
  ) {
    this.activeElement = activeElement
    // mock 节点没有原生 matches，遍历整棵 light DOM 树补上，对齐 DeepDomNodeLike 接口
    const attachMatches = (list: MockNode[]) => {
      for (const node of list) {
        node.matches = (selector: string) => matchesSelector(node, selector)
        if (node.children?.length) {
          attachMatches(node.children)
        }
      }
    }
    attachMatches(nodes)
  }

  querySelectorAll(selector: string): MockNode[] {
    const nodes = this.collectLightDomNodes()
    if (selector === '*') {
      return nodes
    }

    return nodes.filter((node) => matchesSelector(node, selector))
  }

  private collectLightDomNodes(): MockNode[] {
    const result: MockNode[] = []

    const visit = (nodes: MockNode[]) => {
      for (const node of nodes) {
        result.push(node)
        if (node.children?.length) {
          visit(node.children)
        }
      }
    }

    visit(this.nodes)
    return result
  }
}

function matchesSelector(node: MockNode, selector: string): boolean {
  if (selector === 'button') {
    return node.tagName === 'BUTTON'
  }

  if (selector === 'label[for]') {
    return node.tagName === 'LABEL' && Boolean(node.id)
  }

  if (selector === '[id]') {
    return Boolean(node.id)
  }

  if (selector === 'iframe') {
    return node.tagName === 'IFRAME'
  }

  return false
}

describe('deep dom traversal helpers', () => {
  test('collects nodes across open shadow roots', () => {
    const nestedShadowButton: MockNode = { tagName: 'BUTTON', id: 'nested-shadow-button' }
    const nestedHost: MockNode = {
      tagName: 'DIV',
      id: 'nested-host',
      shadowRoot: new MockRoot([nestedShadowButton]),
    }
    const shadowButton: MockNode = { tagName: 'BUTTON', id: 'shadow-button' }
    const shadowLabel: MockNode = { tagName: 'LABEL', id: 'shadow-label' }
    const host: MockNode = {
      tagName: 'DIV',
      id: 'shadow-host',
      shadowRoot: new MockRoot([shadowButton, shadowLabel, nestedHost]),
    }
    const lightButton: MockNode = { tagName: 'BUTTON', id: 'light-button' }
    const root = new MockRoot([lightButton, host], host)

    expect(deepQuerySelectorAll(root, 'button')).toEqual([
      lightButton,
      shadowButton,
      nestedShadowButton,
    ])
    expect(deepQuerySelector(root, 'button')).toBe(lightButton)
    expect(deepCollectElements(root)).toEqual([
      lightButton,
      host,
      shadowButton,
      shadowLabel,
      nestedHost,
      nestedShadowButton,
    ])
  })

  test('repeated ids across shadow roots are all traversed and stay per-root distinguishable', () => {
    // 影子树允许重复 id，遍历必须把各 root 的同名节点都带出来，名称索引才能按 tree scope 分桶。
    const saveLabel: MockNode = { tagName: 'LABEL', id: 'action' }
    const saveHost: MockNode = {
      tagName: 'DIV',
      id: 'save-host',
      shadowRoot: new MockRoot([saveLabel]),
    }
    const deleteLabel: MockNode = { tagName: 'LABEL', id: 'action' }
    const deleteHost: MockNode = {
      tagName: 'DIV',
      id: 'delete-host',
      shadowRoot: new MockRoot([deleteLabel]),
    }
    const root = new MockRoot([saveHost, deleteHost])

    expect(deepCollectElements(root)).toEqual([saveHost, saveLabel, deleteHost, deleteLabel])
    expect(deepCollectElements(saveHost.shadowRoot!)).toEqual([saveLabel])
    expect(deepCollectElements(deleteHost.shadowRoot!)).toEqual([deleteLabel])
    expect(deepQuerySelectorAll(root, 'label[for]')).toEqual([saveLabel, deleteLabel])
  })

  test('respects the maximum shadow traversal depth', () => {
    const nestedShadowButton: MockNode = { tagName: 'BUTTON', id: 'nested-shadow-button' }
    const nestedHost: MockNode = {
      tagName: 'DIV',
      id: 'nested-host',
      shadowRoot: new MockRoot([nestedShadowButton]),
    }
    const shadowButton: MockNode = { tagName: 'BUTTON', id: 'shadow-button' }
    const host: MockNode = {
      tagName: 'DIV',
      id: 'shadow-host',
      shadowRoot: new MockRoot([shadowButton, nestedHost]),
    }
    const lightButton: MockNode = { tagName: 'BUTTON', id: 'light-button' }
    const root = new MockRoot([lightButton, host], host)

    expect(deepQuerySelectorAll(root, 'button', 1)).toEqual([lightButton, shadowButton])
    expect(deepGetElementById(root, 'nested-shadow-button', 1)).toBeNull()
    expect(isDeepActiveElement(root, nestedShadowButton, 1)).toBe(false)
  })

  test('finds ids and active elements inside nested shadow roots', () => {
    const innerButton: MockNode = { tagName: 'BUTTON', id: 'inner-button' }
    const nestedHost: MockNode = {
      tagName: 'DIV',
      id: 'nested-host',
      shadowRoot: new MockRoot([innerButton], innerButton),
    }
    const host: MockNode = {
      tagName: 'DIV',
      id: 'host',
      shadowRoot: new MockRoot([nestedHost], nestedHost),
    }
    const root = new MockRoot([host], host)

    expect(deepGetElementById(root, 'inner-button')).toBe(innerButton)
    expect(deepGetElementById(root, 'missing')).toBeNull()
    expect(isDeepActiveElement(root, innerButton)).toBe(true)
    expect(isDeepActiveElement(root, host)).toBe(true)
  })

  test('maxNodes limits matches, not visits; iterable is consumed only until enough matches', () => {
    let visits = 0
    let queries = 0
    const target = { matches: () => true }
    const root = {
      querySelectorAll: () => {
        queries++
        return (function* () {
          for (let i = 0; i < 60000; i++) {
            visits++
            yield { matches: () => false }
          }
          visits++
          yield target
          throw new Error('must not materialize the rest')
        })()
      },
    }
    expect(deepQuerySelectorAll(root, 'button', 25, 1)).toEqual([target])
    expect(queries).toBe(1)
    expect(visits).toBe(60001)
  })

  test('id lookup reaches late nodes without materializing all results', () => {
    const target = { id: 'late' }
    const root = {
      querySelectorAll: () =>
        (function* () {
          for (let i = 0; i < 60000; i++) yield { id: '' }
          yield target
          throw new Error('lookup should stop at the match')
        })(),
    }
    expect(deepGetElementById(root, 'late')).toBe(target)
  })

  test('scope selectors use the query root instead of the candidate as scope', () => {
    const child = { matches: () => false }
    const root = { querySelectorAll: (_selector: string) => [child] }
    expect(deepQuerySelectorAll(root, ':scope > button')).toEqual([child])
  })
})
