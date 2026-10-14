import { describe, expect, test } from 'bun:test'
import { createExtensionState } from '../extension/background/state.js'
import { resolveEffectiveFrameSelector } from '../extension/background/targeting.js'
import {
  collapseWhitespace,
  parsePageContextElementRefIndex,
  splitWhitespaceTokens,
} from '../extension/background/page-context-helpers.js'

function evaluateSerializedHelpers<TResult>(expression: string): TResult {
  return (0, eval)(`(() => {
${collapseWhitespace.toString()}
${splitWhitespaceTokens.toString()}
${parsePageContextElementRefIndex.toString()}
return (${expression});
})()`) as TResult
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
})

describe('background frame execution context', () => {
  async function createContextHarness() {
    const source = await Bun.file(
      new URL('../extension/background-main.ts', import.meta.url),
    ).text()
    // 只执行真实函数，避开 background 模块初始化时注册 Chrome/网络监听器。
    const functionSource = source.slice(
      source.indexOf('async function getFrameExecutionContext('),
      source.indexOf('// 缓存的 world 可能已被页面销毁'),
    )
    const transpiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(functionSource)
    const state = createExtensionState(9222)
    const resolved: string[] = []
    const commands: string[] = []
    const context = new Function(
      'state',
      'getTargetTab',
      'resolveEffectiveFrameSelector',
      'resolveFrameTarget',
      'frameWorldContextCache',
      'sendDebuggerCommand',
      'FRAME_WORLD_NAME',
      `${transpiled}; return getFrameExecutionContext;`,
    )(
      state,
      async () => ({ id: 1 }),
      resolveEffectiveFrameSelector,
      async (_tabId: number, selector: string) => {
        resolved.push(selector)
        return { frameId: 'child', pageEpoch: 1 }
      },
      new Map(),
      async (_tabId: number, method: string) => {
        commands.push(method)
        return { executionContextId: 42 }
      },
      'test-world',
    ) as (
      tabId: number,
      selector?: string | null,
    ) => Promise<{ tab: { id: number }; executionContextId: number | null }>
    return { state, resolved, commands, context }
  }

  test('explicit top aliases bypass selected frames and do not create a child world', async () => {
    const h = await createContextHarness()
    h.state.targeting.selectedFrames.set(1, '#selected')
    for (const selector of ['top', 'main', 'default', ' TOP ']) {
      expect(await h.context(1, selector)).toEqual({ tab: { id: 1 }, executionContextId: null })
    }
    expect(h.resolved).toEqual([])
    expect(h.commands).toEqual([])
    expect(h.state.targeting.selectedFrames.get(1)).toBe('#selected')
  })

  test('omitted frames retain the selected frame and explicit frames take precedence', async () => {
    const h = await createContextHarness()
    expect((await h.context(1)).executionContextId).toBeNull()
    h.state.targeting.selectedFrames.set(1, '#selected')
    expect((await h.context(1)).executionContextId).toBe(42)
    expect((await h.context(1, ' #explicit ')).executionContextId).toBe(42)
    expect(h.resolved).toEqual(['#selected', '#explicit'])
    expect(h.commands).toEqual(['Page.enable', 'Page.createIsolatedWorld'])
  })
})
