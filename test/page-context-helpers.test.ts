import { describe, expect, test } from 'bun:test'
import { createFrameContext } from '../extension/background/frame-context.js'
import { createExtensionState } from '../extension/background/state.js'
import {
  collapseWhitespace,
  boundPageText,
  getPageObservationState,
  createPageNameIndex,
  parsePageContextElementRefIndex,
  splitWhitespaceTokens,
} from '../extension/background/page-context-helpers.js'

function evaluateSerializedHelpers<TResult>(expression: string): TResult {
  // 这些 helper 是靠 toString() 拼进页面脚本执行的，正常 import 调用验证不到序列化后的行为，
  // 用 new Function 还原注入后的执行环境（与下方 boundPageText 的校验方式保持一致）。
  const evaluate = new Function(`return (() => {
${collapseWhitespace.toString()}
${splitWhitespaceTokens.toString()}
${parsePageContextElementRefIndex.toString()}
return (${expression});
})()`) as () => TResult
  return evaluate()
}

type StubNameNode = {
  id: string
  tagName: string
  getAttribute: (name: string) => string | null
  getRootNode?: () => object | null
}

/** 只实现名称索引用到的成员，按 Element 参与索引 API 调用 */
function stubNameNode(
  options: {
    id?: string
    tagName?: string
    forId?: string
    root?: object | null
    legacy?: boolean
  } = {},
): Element {
  const node: StubNameNode = {
    id: options.id || '',
    tagName: options.tagName || 'DIV',
    getAttribute: (name: string) => (name === 'for' ? (options.forId ?? null) : null),
  }
  // legacy 模拟老 DOM stub 缺少 getRootNode 的情况
  if (!options.legacy) node.getRootNode = () => options.root ?? null
  return node as unknown as Element
}

describe('page context helpers', () => {
  test('collapses mixed whitespace for snapshot and find text normalization', () => {
    expect(collapseWhitespace('  hello\n\tworld   again  ')).toBe('hello world again')
  })

  test('splits aria-labelledby token lists by any whitespace', () => {
    expect(splitWhitespaceTokens('first\n second\t\tthird  fourth')).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ])
  })

  test('parses existing element ref ordinals from trimmed attribute values', () => {
    expect(parsePageContextElementRefIndex(' e42 ')).toBe(42)
    expect(parsePageContextElementRefIndex('x42')).toBeNull()
  })

  test('preserves regex behavior after helper source is serialized into injected scripts', () => {
    expect(
      evaluateSerializedHelpers<string>("collapseWhitespace('  hello\\n\\tworld   again  ')"),
    ).toBe('hello world again')
    expect(
      evaluateSerializedHelpers<string[]>(
        "splitWhitespaceTokens('first\\n second\\t\\tthird  fourth')",
      ),
    ).toEqual(['first', 'second', 'third', 'fourth'])
    expect(
      evaluateSerializedHelpers<number | null>("parsePageContextElementRefIndex(' e42 ')"),
    ).toBe(42)
  })

  test('UTF8 bounding preserves codepoints and serializes without module closures', () => {
    const bound = new Function(`return (${boundPageText.toString()})`)() as typeof boundPageText
    expect(bound('😀界abc', 6)).toBe('😀')
    expect(bound('界'.repeat(10000), 10)).toBe('界界界')
    expect(new TextEncoder().encode(bound('😀'.repeat(10000), 1024)).length).toBe(1024)
  })

  test('document identity persists until epoch/document changes', () => {
    const doc = {}
    const first = getPageObservationState(doc, 1)
    first.highWater.e = 99
    expect(getPageObservationState(doc, 1)).toBe(first)
    expect(getPageObservationState(doc, 2).id).not.toBe(first.id)
    expect(getPageObservationState({}, 2).highWater).toEqual({})
  })

  test('name indexes preserve the first id/label match in one iteration', () => {
    const root = {}
    const first = stubNameNode({ id: 'same', tagName: 'LABEL', forId: 'input', root })
    const duplicate = stubNameNode({ id: 'same', tagName: 'LABEL', forId: 'input', root })
    let visits = 0
    const nodes = (function* () {
      visits++
      yield first
      visits++
      yield duplicate
    })()
    const index = createPageNameIndex(nodes)
    expect(index.lookupId(stubNameNode({ root }), 'same')).toBe(first)
    expect(index.lookupLabel(stubNameNode({ id: 'input', root }), 'input')).toBe(first)
    expect(visits).toBe(2)
  })

  test('repeated ids in different tree scopes never cross over', () => {
    const documentRoot = { name: 'document' }
    const saveRoot = { name: 'save-shadow' }
    const deleteRoot = { name: 'delete-shadow' }
    const saveLabel = stubNameNode({ id: 'action', tagName: 'LABEL', root: saveRoot })
    const deleteLabel = stubNameNode({ id: 'action', tagName: 'LABEL', root: deleteRoot })
    const saveButton = stubNameNode({ root: saveRoot })
    const deleteButton = stubNameNode({ root: deleteRoot })
    const pageButton = stubNameNode({ root: documentRoot })
    const index = createPageNameIndex([
      saveLabel,
      deleteLabel,
      saveButton,
      deleteButton,
      pageButton,
    ])
    expect(index.lookupId(saveButton, 'action')).toBe(saveLabel)
    expect(index.lookupId(deleteButton, 'action')).toBe(deleteLabel)
    expect(index.lookupId(pageButton, 'action')).toBeNull()
  })

  test('label for lookup follows the referencing node tree scope', () => {
    const streetRoot = { name: 'street-shadow' }
    const cityRoot = { name: 'city-shadow' }
    const streetLabel = stubNameNode({ tagName: 'LABEL', forId: 'field', root: streetRoot })
    const cityLabel = stubNameNode({ tagName: 'LABEL', forId: 'field', root: cityRoot })
    const index = createPageNameIndex([streetLabel, cityLabel])
    expect(index.lookupLabel(stubNameNode({ id: 'field', root: streetRoot }), 'field')).toBe(
      streetLabel,
    )
    expect(index.lookupLabel(stubNameNode({ id: 'field', root: cityRoot }), 'field')).toBe(
      cityLabel,
    )
    expect(
      index.lookupLabel(stubNameNode({ id: 'field', root: { name: 'other' } }), 'field'),
    ).toBeNull()
  })

  test('index misses fall back to the referencing tree scope, not the whole document', () => {
    // snapshot 子树只收集子树元素，同 root 子树外的引用目标必须仍可解析。
    const outsideLabel = stubNameNode({ id: 'panel-title', tagName: 'SPAN' })
    const outsideForLabel = stubNameNode({ tagName: 'LABEL', forId: 'field' })
    let labelQueries = 0
    const documentRoot = {
      getElementById: (id: string) => (id === 'panel-title' ? outsideLabel : null),
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('label[for]')
        labelQueries += 1
        return [outsideForLabel]
      },
    }
    const index = createPageNameIndex([])
    const input = stubNameNode({ id: 'field', tagName: 'INPUT', root: documentRoot })
    expect(index.lookupId(input, 'panel-title')).toBe(outsideLabel)
    expect(index.lookupLabel(input, 'field')).toBe(outsideForLabel)
    expect(index.lookupId(input, 'missing')).toBeNull()
    // 负命中也缓存：后续同 scope 查找不得重复扫描
    expect(index.lookupLabel(input, 'other')).toBeNull()
    expect(index.lookupLabel(input, 'field')).toBe(outsideForLabel)
    expect(labelQueries).toBe(1)
  })

  test('label lookup never builds a selector from the referenced id', () => {
    // 控制字符会让拼出的属性选择器非法并抛 SyntaxError，让整次 snapshot/find 失败。
    const weirdIds = ['a\nb', 'a\rb', 'a\fb', 'a"b\\c']
    for (const weirdId of weirdIds) {
      const label = stubNameNode({ tagName: 'LABEL', forId: weirdId })
      const selectors: string[] = []
      const root = {
        // 模拟真实 CSS 解析：选择器含裸控制字符直接 SyntaxError
        querySelector: (selector: string) => {
          selectors.push(selector)
          if (/[\n\r\f]/.test(selector)) throw new SyntaxError(`invalid selector: ${selector}`)
          return selector === `label[for="${weirdId.replace(/["\\]/g, '\\$&')}"]` ? label : null
        },
        querySelectorAll: (selector: string) => {
          selectors.push(selector)
          return [label]
        },
      }
      const index = createPageNameIndex([])
      const input = stubNameNode({ id: weirdId, tagName: 'INPUT', root })
      expect(index.lookupLabel(input, weirdId)).toBe(label)
      expect(selectors).toEqual(['label[for]'])
    }
  })

  test('covered tree scopes answer negative labels without any fallback query', () => {
    let queries = 0
    const root = {
      querySelectorAll: () => {
        queries += 1
        return []
      },
    }
    const button = stubNameNode({ id: 'field', tagName: 'BUTTON', root })
    const covered = createPageNameIndex([button], root)
    for (let i = 0; i < 50; i++) expect(covered.lookupLabel(button, `missing-${i}`)).toBeNull()
    expect(queries).toBe(0)
    // 同一 scope 传成子树根时视为未覆盖，才允许补全
    const uncovered = createPageNameIndex([button], stubNameNode({ tagName: 'DIV', root }))
    expect(uncovered.lookupLabel(button, 'missing')).toBeNull()
    expect(queries).toBe(1)
  })

  test('nodes without getRootNode share one bucket for compatibility', () => {
    const label = stubNameNode({ id: 'action', tagName: 'LABEL', legacy: true })
    const other = stubNameNode({ tagName: 'SPAN', legacy: true })
    const index = createPageNameIndex([label, other])
    expect(index.lookupId(other, 'action')).toBe(label)
    expect(index.lookupId(stubNameNode({ legacy: true }), 'action')).toBe(label)
    // 无 tree scope 时无法做 scope 内回退，但也不能抛异常
    expect(index.lookupLabel(other, 'field')).toBeNull()
  })

  test('serialized name index source is self-contained in injected scripts', () => {
    const createIndex = new Function(
      `return (${createPageNameIndex.toString()})`,
    )() as typeof createPageNameIndex
    const shadowRoot = {
      getElementById: () => null,
      querySelectorAll: () => [stubNameNode({ tagName: 'LABEL', forId: 'weird\nid' })],
    }
    const label = stubNameNode({ id: 'action', tagName: 'LABEL', root: shadowRoot })
    const button = stubNameNode({ root: shadowRoot })
    const index = createIndex([label, button])
    expect(index.lookupId(button, 'action')).toBe(label)
    expect(index.lookupId(stubNameNode({}), 'action')).toBeNull()
    expect(index.lookupLabel(button, 'weird\nid')).not.toBeNull()
  })
})

describe('background frame execution context', () => {
  function createContextHarness() {
    const state = createExtensionState(9222)
    const resolved: string[] = []
    const commands: string[] = []
    const frameContext = createFrameContext({
      state,
      getTargetTab: (async () => ({ id: 1 })) as never,
      sendDebuggerCommand: (async (
        _tabId: number,
        method: string,
        params: Record<string, unknown> = {},
      ) => {
        commands.push(method)
        if (method === 'Runtime.evaluate') {
          const match = /deepQuerySelector\(document, ("(?:[^"\\]|\\.)*")\)/.exec(
            String(params.expression),
          )
          if (match?.[1]) resolved.push(JSON.parse(match[1]))
          return {
            result: {
              value: {
                refValue: null,
                src: null,
                left: 0,
                top: 0,
                width: 10,
                height: 10,
                x: 5,
                y: 5,
              },
            },
          }
        }
        if (method === 'DOM.getNodeForLocation') return { frameId: 'child' }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 }
        return {}
      }) as never,
    })
    return { state, resolved, commands, context: frameContext.getFrameExecutionContext }
  }

  test('explicit top aliases bypass selected frames and do not create a child world', async () => {
    const h = createContextHarness()
    h.state.targeting.selectedFrames.set(1, '#selected')
    for (const selector of ['top', 'main', 'default', ' TOP ']) {
      const result = await h.context(1, selector)
      expect(result.tab.id).toBe(1)
      expect(result.executionContextId).toBeNull()
    }
    expect(h.resolved).toEqual([])
    expect(h.commands).toEqual([])
    expect(h.state.targeting.selectedFrames.get(1)).toBe('#selected')
  })

  test('omitted frames retain the selected frame and explicit frames take precedence', async () => {
    const h = createContextHarness()
    expect((await h.context(1, null)).executionContextId).toBeNull()
    h.state.targeting.selectedFrames.set(1, '#selected')
    expect((await h.context(1, null)).executionContextId).toBe(42)
    expect((await h.context(1, ' #explicit ')).executionContextId).toBe(42)
    expect(h.resolved).toEqual(['#selected', '#explicit'])
    expect(h.commands).toEqual([
      'Runtime.evaluate',
      'DOM.enable',
      'DOM.getNodeForLocation',
      'Page.enable',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
      'DOM.enable',
      'DOM.getNodeForLocation',
    ])
  })
})
