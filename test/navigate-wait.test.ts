import { describe, expect, test } from 'bun:test'
import { createPageInputDomain } from '../extension/background/page-input.js'
import { createExtensionState } from '../extension/background/state.js'

function createNavigateHarness(options: { commit?: boolean; commitDelayMs?: number } = {}) {
  const state = createExtensionState(9222)
  const debuggerCalls: string[] = []
  const evaluateCalls: Array<{ expression: string; afterCommit: boolean }> = []
  let committed = false

  const pageInput = createPageInputDomain({
    state,
    getTargetTab: async () => ({ id: 1, url: 'https://example.com' }) as never,
    resolveElementSelectorForTab: async () => {
      throw new Error('unused in navigate tests')
    },
    resolveFrameTarget: async () => {
      throw new Error('unused in navigate tests')
    },
    getFrameExecutionContext: async () => {
      throw new Error('unused in navigate tests')
    },
    evaluateInTabContext: async <TValue = unknown>(_tabId: unknown, expression: string) => {
      evaluateCalls.push({ expression, afterCommit: committed })
      const value = expression.includes('document.readyState')
        ? ('complete' as TValue)
        : ({ settled: true, reason: null } as TValue)
      return {
        tab: { id: 1, url: 'https://new.example.com' } as never,
        response: { result: {} },
        value,
      }
    },
    sendDebuggerCommand: async (_tabId: number, method: string) => {
      debuggerCalls.push(method)
      if ((method === 'Page.navigate' || method === 'Page.reload') && options.commit !== false) {
        // 模拟导航 commit：connection.ts 的 frameNavigated 会递增 epoch；
        // commitDelayMs 模拟慢服务器/慢 commit 窗口
        const applyCommit = () => {
          state.targeting.pageEpochs.set(1, (state.targeting.pageEpochs.get(1) || 0) + 1)
          committed = true
        }
        if (options.commitDelayMs) {
          setTimeout(applyCommit, options.commitDelayMs)
        } else {
          applyCommit()
        }
      }
      return undefined as never
    },
  })

  return { pageInput, state, debuggerCalls, evaluateCalls }
}

describe('navigation wait for commit', () => {
  test('navigateTo does not settle on the stale old document before the navigation commits', async () => {
    // 慢 commit（120ms）：旧代码会在 commit 前就对旧文档判 settled，新代码必须先等 commit
    const { pageInput, evaluateCalls } = createNavigateHarness({ commitDelayMs: 120 })

    const result = await pageInput.navigateTo(1, 'https://new.example.com', { timeoutMs: 5000 })

    expect(result).toMatchObject({ tabId: 1, url: 'https://new.example.com', settled: true })
    expect(evaluateCalls.length).toBeGreaterThan(0)
    // 所有稳定判定（readyState / MutationObserver）都发生在导航 commit 之后
    expect(evaluateCalls.every((call) => call.afterCommit)).toBe(true)
  })

  test('navigateTo reports navigation never committed when the epoch never changes', async () => {
    const { pageInput, evaluateCalls } = createNavigateHarness({ commit: false })

    const result = await pageInput.navigateTo(1, 'https://new.example.com', { timeoutMs: 200 })

    expect(result).toEqual({
      tabId: 1,
      url: 'https://new.example.com',
      settled: false,
      settleReason: 'navigation never committed',
    })
    // commit 未发生就不做任何稳定判定
    expect(evaluateCalls).toHaveLength(0)
  })

  test('navigateTo with wait false returns immediately without commit or settle checks', async () => {
    const { pageInput, evaluateCalls, debuggerCalls } = createNavigateHarness()

    const result = await pageInput.navigateTo(1, 'https://new.example.com', { wait: false })

    expect(result).toEqual({ tabId: 1, url: 'https://new.example.com' })
    expect(debuggerCalls).toEqual(['Page.enable', 'Page.navigate'])
    expect(evaluateCalls).toHaveLength(0)
  })

  test('reloadPage waits for the navigation commit before settling', async () => {
    const { pageInput, evaluateCalls } = createNavigateHarness()

    const result = await pageInput.reloadPage(1)

    expect(result).toMatchObject({ reloaded: true, settled: true })
    expect(evaluateCalls.length).toBeGreaterThan(0)
    expect(evaluateCalls.every((call) => call.afterCommit)).toBe(true)
  })
})
