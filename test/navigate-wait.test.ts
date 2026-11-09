import { describe, expect, test } from 'bun:test'
import { createPageInputDomain } from '../extension/background/page-input.js'
import { createExtensionState } from '../extension/background/state.js'

function createNavigateHarness(
  options: {
    commit?: boolean
    commitDelayMs?: number
    hangDispatch?: boolean
    hangEvaluate?: boolean
    history?: { entries: Array<{ id: number }>; currentIndex: number }
  } = {},
) {
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
      // 模拟导航销毁上下文时 CDP 回调丢失：evaluate 永远不 resolve
      if (options.hangEvaluate) return await new Promise<never>(() => {})
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
      if (method === 'Page.getNavigationHistory') {
        return (options.history || { entries: [{ id: 1 }], currentIndex: 0 }) as never
      }
      // 指令已发出但没有回执：导航销毁 renderer 后 CDP 回调可能永远不来
      if (options.hangDispatch && (method === 'Page.navigate' || method === 'Page.reload')) {
        return await new Promise<never>(() => {})
      }
      if (
        ['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry'].includes(method) &&
        options.commit !== false
      ) {
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

    expect(result).toMatchObject({
      tabId: 1,
      url: 'https://new.example.com',
      requestedUrl: 'https://new.example.com',
      outcome: 'completed',
      phase: 'settle',
      settled: true,
    })
    expect(evaluateCalls.length).toBeGreaterThan(0)
    // 所有稳定判定（readyState / MutationObserver）都发生在导航 commit 之后
    expect(evaluateCalls.every((call) => call.afterCommit)).toBe(true)
  })

  test('navigateTo reports navigation never committed when the epoch never changes', async () => {
    const { pageInput, evaluateCalls } = createNavigateHarness({ commit: false })

    const result = await pageInput.navigateTo(1, 'https://new.example.com', { timeoutMs: 200 })

    expect(result).toMatchObject({
      tabId: 1,
      url: 'https://new.example.com',
      requestedUrl: 'https://new.example.com',
      observedUrl: 'https://example.com',
      outcome: 'partial',
      phase: 'commit',
      settled: false,
      settleReason: 'navigation never committed',
    })
    // commit 未发生就不做任何稳定判定
    expect(evaluateCalls).toHaveLength(0)
  })

  test('navigateTo with wait false returns immediately without commit or settle checks', async () => {
    const { pageInput, evaluateCalls, debuggerCalls } = createNavigateHarness()

    const result = await pageInput.navigateTo(1, 'https://new.example.com', { wait: false })

    expect(result).toEqual({
      tabId: 1,
      url: 'https://new.example.com',
      requestedUrl: 'https://new.example.com',
      outcome: 'dispatched',
      phase: 'dispatch',
    })
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
  test('reloadPage enables the Page domain so navigation commits are observable', async () => {
    // commit 只能靠 Page.frameNavigated / navigatedWithinDocument 观测，Page 域必须显式 enable，
    // 否则没跑过 goto 的 tab 上 reload 永远等不到 commit。
    const { pageInput, debuggerCalls } = createNavigateHarness()

    await pageInput.reloadPage(1)

    expect(debuggerCalls).toEqual(['Page.enable', 'Page.reload'])
  })

  test('reloadPage finishes even when the reload command gets no CDP ack', async () => {
    // 现象：导航销毁 renderer 后 Page.reload 的回调可能永远不来。
    // 不能把命令挂死到 relay 超时，也不能假装它没发出去。
    const { pageInput } = createNavigateHarness({ commit: false, hangDispatch: true })
    const startedAt = Date.now()

    const result = await pageInput.reloadPage(1, { timeoutMs: 300 })

    expect(result).toMatchObject({
      reloaded: true,
      outcome: 'partial',
      phase: 'commit',
      committed: false,
      dispatchTimedOut: true,
      settleReason: 'navigation never committed',
    })
    expect(Date.now() - startedAt).toBeLessThan(5000)
  })

  test('reloadPage bounds a hung readyState probe instead of waiting for the relay timeout', async () => {
    const { pageInput } = createNavigateHarness({ hangEvaluate: true })
    const startedAt = Date.now()

    const result = await pageInput.reloadPage(1, { timeoutMs: 300, waitUntil: 'domcontentloaded' })

    expect(result).toMatchObject({
      reloaded: true,
      outcome: 'partial',
      phase: 'settle',
      committed: true,
      settled: false,
    })
    expect(Date.now() - startedAt).toBeLessThan(5000)
  })
})

describe('history navigation invalidation', () => {
  test('back without history preserves page epoch and selected frame', async () => {
    const { pageInput, state, debuggerCalls } = createNavigateHarness()
    state.targeting.pageEpochs.set(1, 4)
    state.targeting.selectedFrames.set(1, '#child')

    await expect(pageInput.navigateBack(1)).resolves.toEqual({
      navigated: false,
      reason: 'no back history',
    })
    expect(state.targeting.pageEpochs.get(1)).toBe(4)
    expect(state.targeting.selectedFrames.get(1)).toBe('#child')
    expect(debuggerCalls).toEqual(['Page.enable', 'Page.getNavigationHistory'])
  })

  test('forward without history preserves page epoch and selected frame', async () => {
    const { pageInput, state } = createNavigateHarness()
    state.targeting.pageEpochs.set(1, 4)
    state.targeting.selectedFrames.set(1, '#child')

    await expect(pageInput.navigateForward(1)).resolves.toEqual({
      navigated: false,
      reason: 'no forward history',
    })
    expect(state.targeting.pageEpochs.get(1)).toBe(4)
    expect(state.targeting.selectedFrames.get(1)).toBe('#child')
  })

  test('back with a target entry invalidates refs and waits for commit', async () => {
    const { pageInput, state } = createNavigateHarness({
      history: { entries: [{ id: 1 }, { id: 2 }], currentIndex: 1 },
    })
    state.targeting.pageEpochs.set(1, 4)
    state.targeting.selectedFrames.set(1, '#child')

    await expect(pageInput.navigateBack(1)).resolves.toMatchObject({
      navigated: true,
      back: true,
      settled: true,
    })
    expect(state.targeting.pageEpochs.get(1)).toBe(6)
    expect(state.targeting.selectedFrames.has(1)).toBe(false)
  })
})
