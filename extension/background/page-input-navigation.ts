import { clearSelectedFrame, getPageEpoch, invalidatePageRefs } from './targeting.js'
import type { CommandExecutionContext } from './command-queue.js'
import type { TabInput } from './types.js'
import type { PageInputContext } from './page-input-context.js'

// 导航类命令（goto/open/back/forward/reload）等待"导航发生 + 页面稳定"的默认总预算
const DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS = 10000

interface WaitForPageSettledOptions {
  timeoutMs?: number
  waitUntil?: string
  domQuietMs?: number
}

// 页面内 MutationObserver 表达式：documentElement 连续 100ms 无变更即 settled。
// 页面持续变更时由 hardCapMs 硬上限兜底 resolve（settled:false），
// 实测 CDP Runtime.evaluate 的 timeout 无法中断 awaitPromise 的挂起等待，
// 必须靠页面内定时器自兜底，扩展侧只负责等 evaluate 返回
function buildMutationQuietExpression(hardCapMs: number, quietMs: number): string {
  return `(async () => {
      return await new Promise((resolve) => {
        const deadline = Date.now() + ${Math.max(0, Math.floor(hardCapMs))};
        let settled = false;
        let timer = null;
        let observer = null;
        const finish = (isSettled, reason) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (observer) observer.disconnect();
          resolve({ settled: isSettled, reason });
        };
        const quietDone = () => finish(true, null);
        const capDone = () => finish(false, 'still-changing');
        try {
          observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(quietDone, ${Math.max(1, Math.floor(quietMs))});
          });
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          timer = setTimeout(quietDone, ${Math.max(1, Math.floor(quietMs))});
          setTimeout(capDone, Math.max(0, deadline - Date.now()));
        } catch (error) {
          finish(false, 'observer-unavailable');
        }
      });
    })()`
}

/**
 * 创建导航命令：goto、back、forward、reload，并负责等待页面稳定。
 */
export function createNavigationCommands(pageContext: PageInputContext) {
  const {
    state,
    getTargetTab,
    resolveFrameTarget,
    evaluateInTabContextBase,
    sendDebuggerCommand,
    sleep,
  } = pageContext

  async function waitForPageSettled(
    tabId: number,
    options: WaitForPageSettledOptions & { commandContext?: CommandExecutionContext } = {},
  ): Promise<{ settled: boolean; settleReason?: string; settledInMs?: number }> {
    const timeoutMs = options.timeoutMs ?? 10000
    const waitUntil = options.waitUntil || 'domquiet'
    const domQuietMs = options.domQuietMs ?? 100
    const startedAt = Date.now()
    const remaining = () => timeoutMs - (Date.now() - startedAt)

    while (remaining() > 0) {
      // 阶段一：等 readyState 至少到 interactive。导航后旧 document 可能短暂存活，
      // evaluate 也可能因上下文销毁失败，轮询重试即可
      let readyState: string | null = null
      while (remaining() > 0) {
        try {
          const { value } = await evaluateInTabContextBase<string>(tabId, 'document.readyState', {
            timeoutMs: 2000,
            commandContext: options.commandContext,
          })
          if (
            value === 'complete' ||
            (waitUntil !== 'load' && (value === 'interactive' || value === 'complete'))
          ) {
            readyState = value
            break
          }
        } catch {
          options.commandContext?.throwIfCancelled()
          // 导航中的上下文销毁/瞬时失败，继续轮询
        }
        await sleep(100)
      }
      if (!readyState) {
        return {
          settled: false,
          settleReason: `page never reached interactive within ${timeoutMs}ms`,
        }
      }

      if (waitUntil === 'domcontentloaded' || waitUntil === 'interactive' || waitUntil === 'load') {
        return { settled: true, settledInMs: Date.now() - startedAt }
      }

      if (waitUntil === 'networkidle') {
        const idleStartedAt = Date.now()
        while (remaining() > 0) {
          const inFlight = state.network.inFlightByTab.get(tabId)?.size || 0
          const lastActivity = state.network.lastActivityByTab.get(tabId) || idleStartedAt
          if (inFlight === 0 && Date.now() - lastActivity >= 500) {
            return { settled: true, settledInMs: Date.now() - startedAt }
          }
          await sleep(100)
        }
        return { settled: false, settleReason: `network did not become idle within ${timeoutMs}ms` }
      }

      // 阶段二：MutationObserver 连续 100ms 无变更视为稳定。
      // 期间页面再次导航（上下文销毁）则回到阶段一重试
      try {
        const { value } = await evaluateInTabContextBase<{
          settled: boolean
          reason?: string
        }>(tabId, buildMutationQuietExpression(remaining(), domQuietMs), {
          timeoutMs: remaining() + 5000,
          commandContext: options.commandContext,
        })
        if (value?.settled) {
          return { settled: true, settledInMs: Date.now() - startedAt }
        }
        return { settled: false, settleReason: value?.reason || 'page kept changing' }
      } catch (error) {
        options.commandContext?.throwIfCancelled()
        const message = error instanceof Error ? error.message : String(error)
        if (!/context was destroyed|cannot find context/i.test(message)) {
          return { settled: false, settleReason: message }
        }
      }
    }

    return { settled: false, settleReason: `timeout after ${timeoutMs}ms` }
  }

  // 等导航实际发生（pageEpoch 递增）。导航命令发出后旧 document 可能仍存活且
  // readyState=complete，必须先等 main-frame commit / same-document 导航事件
  // （connection.ts 监听 frameNavigated / navigatedWithinDocument 递增 epoch），
  // 再进 waitForPageSettled，否则会把旧文档的稳定误判成新页面已加载。
  // 只读 state 内的 epoch，不依赖 tab 查询，tab 关闭等异常天然容忍到超时
  async function waitForNavigationCommit(
    tabId: number,
    baselineEpoch: number,
    budgetMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (getPageEpoch(state, tabId) !== baselineEpoch) {
        return true
      }
      await sleep(100)
    }
    return false
  }

  // 点击后 500ms 窗口内轮询 pageEpoch / tab.url 是否变化，判断是否触发了导航
  async function detectNavigationAfterClick(
    tabId: number,
    beforeEpoch: number,
    beforeUrl: string | undefined,
  ): Promise<boolean> {
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      if (getPageEpoch(state, tabId) !== beforeEpoch) {
        return true
      }
      if (beforeUrl) {
        try {
          const tab = await getTargetTab(tabId)
          if (tab.url && tab.url !== beforeUrl) {
            return true
          }
        } catch {
          // tab 关闭等瞬时错误，继续轮询
        }
      }
      await sleep(100)
    }
    return false
  }

  async function navigateTo(
    tabId: TabInput,
    url: string,
    options: {
      timeoutMs?: number
      wait?: boolean
      waitUntil?: string
      settleTimeoutMs?: number
      domQuietMs?: number
    } = {},
  ): Promise<Record<string, unknown>> {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    // 基线必须在 invalidatePageRefs（已让 epoch +1）之后取：
    // 导航 commit 时 connection.ts 再 +1，轮询 epoch !== 基线即代表导航真正发生
    const baselineEpoch = getPageEpoch(state, tab.id)
    await sendDebuggerCommand(tab.id, 'Page.enable', {})
    await sendDebuggerCommand(tab.id, 'Page.navigate', { url })
    // --wait false 恢复旧的"发完即返回"行为
    const waitUntil = options.wait === false ? 'none' : options.waitUntil || 'domquiet'
    if (waitUntil === 'none') {
      return {
        tabId: tab.id,
        url,
        requestedUrl: url,
        outcome: 'dispatched',
        phase: 'dispatch',
      }
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS
    const startedAt = Date.now()
    // 先等导航 commit 再判稳定，避免旧 document 存活期间把旧页误判成新页面已加载
    const commit = await waitForNavigationCommit(tab.id, baselineEpoch, timeoutMs)
    if (!commit) {
      const observed = await getTargetTab(tab.id).catch(() => null)
      return {
        tabId: tab.id,
        url,
        requestedUrl: url,
        observedUrl: observed?.url || null,
        observedTitle: observed?.title || null,
        baselineEpoch,
        observedEpoch: getPageEpoch(state, tab.id),
        outcome: 'partial',
        phase: 'commit',
        settled: false,
        settleReason: 'navigation never committed',
      }
    }
    if (waitUntil === 'commit') {
      const observed = await getTargetTab(tab.id).catch(() => null)
      return {
        tabId: tab.id,
        url,
        requestedUrl: url,
        observedUrl: observed?.url || null,
        observedTitle: observed?.title || null,
        baselineEpoch,
        observedEpoch: getPageEpoch(state, tab.id),
        outcome: 'completed',
        phase: 'commit',
        settled: true,
      }
    }
    const settle = await waitForPageSettled(tab.id, {
      timeoutMs: Math.min(
        options.settleTimeoutMs ?? timeoutMs,
        Math.max(0, timeoutMs - (Date.now() - startedAt)),
      ),
      waitUntil,
      domQuietMs: options.domQuietMs,
    })
    const observed = await getTargetTab(tab.id).catch(() => null)
    return {
      tabId: tab.id,
      url,
      requestedUrl: url,
      observedUrl: observed?.url || null,
      observedTitle: observed?.title || null,
      baselineEpoch,
      observedEpoch: getPageEpoch(state, tab.id),
      outcome: settle.settled ? 'completed' : 'partial',
      phase: 'settle',
      settled: settle.settled,
      ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
    }
  }

  async function navigateBack(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    const baselineEpoch = getPageEpoch(state, tab.id)
    const history = await sendDebuggerCommand<{
      entries?: Array<{ id: number }>
      currentIndex?: number
    }>(tab.id, 'Page.getNavigationHistory')
    const entries = history.entries || []
    const currentIndex = history.currentIndex

    if (typeof currentIndex === 'number' && currentIndex > 0) {
      const targetIndex = currentIndex - 1
      const targetEntry = entries[targetIndex]
      if (targetEntry) {
        await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
          entryId: targetEntry.id,
        })
        const startedAt = Date.now()
        // 与 navigateTo 同理：先等导航 commit（epoch 变化）再判稳定，避免旧文档误判
        const commit = await waitForNavigationCommit(
          tab.id,
          baselineEpoch,
          DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS,
        )
        if (!commit) {
          return {
            navigated: true,
            back: true,
            settled: false,
            settleReason: 'navigation never committed',
          }
        }
        const settle = await waitForPageSettled(tab.id, {
          timeoutMs: Math.max(0, DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS - (Date.now() - startedAt)),
        })
        return {
          navigated: true,
          back: true,
          settled: settle.settled,
          ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
        }
      }
    }
    return { navigated: false, reason: 'no back history' }
  }

  async function navigateForward(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    const baselineEpoch = getPageEpoch(state, tab.id)
    const history = await sendDebuggerCommand<{
      entries?: Array<{ id: number }>
      currentIndex?: number
    }>(tab.id, 'Page.getNavigationHistory')
    const entries = history.entries || []
    const currentIndex = history.currentIndex

    if (typeof currentIndex === 'number' && currentIndex < entries.length - 1) {
      const targetIndex = currentIndex + 1
      const targetEntry = entries[targetIndex]
      if (targetEntry) {
        await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
          entryId: targetEntry.id,
        })
        const startedAt = Date.now()
        // 与 navigateTo 同理：先等导航 commit（epoch 变化）再判稳定，避免旧文档误判
        const commit = await waitForNavigationCommit(
          tab.id,
          baselineEpoch,
          DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS,
        )
        if (!commit) {
          return {
            navigated: true,
            forward: true,
            settled: false,
            settleReason: 'navigation never committed',
          }
        }
        const settle = await waitForPageSettled(tab.id, {
          timeoutMs: Math.max(0, DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS - (Date.now() - startedAt)),
        })
        return {
          navigated: true,
          forward: true,
          settled: settle.settled,
          ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
        }
      }
    }
    return { navigated: false, reason: 'no forward history' }
  }

  async function reloadPage(
    tabId: TabInput,
    options: { timeoutMs?: number; waitUntil?: string } = {},
  ): Promise<Record<string, unknown>> {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    const baselineEpoch = getPageEpoch(state, tab.id)
    await sendDebuggerCommand(tab.id, 'Page.reload', {})
    const startedAt = Date.now()
    // 与 navigateTo 同理：先等导航 commit（epoch 变化）再判稳定，避免旧文档误判
    const timeoutMs = options.timeoutMs ?? DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS
    const waitUntil = options.waitUntil || 'domquiet'
    if (waitUntil === 'none') return { reloaded: true, outcome: 'dispatched', phase: 'dispatch' }
    const commit = await waitForNavigationCommit(tab.id, baselineEpoch, timeoutMs)
    if (!commit) {
      return {
        reloaded: true,
        outcome: 'partial',
        phase: 'commit',
        baselineEpoch,
        observedEpoch: getPageEpoch(state, tab.id),
        settled: false,
        settleReason: 'navigation never committed',
      }
    }
    if (waitUntil === 'commit')
      return { reloaded: true, outcome: 'completed', phase: 'commit', settled: true }
    const settle = await waitForPageSettled(tab.id, {
      timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
      waitUntil,
    })
    return {
      reloaded: true,
      outcome: settle.settled ? 'completed' : 'partial',
      phase: 'settle',
      settled: settle.settled,
      ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
    }
  }

  async function switchToFrame(tabId: TabInput, selector: string) {
    const tab = await getTargetTab(tabId)
    if (['top', 'main', 'default'].includes(selector)) {
      clearSelectedFrame(state, tab.id)
      return {
        found: true,
        cleared: true,
        pageEpoch: getPageEpoch(state, tab.id),
        frame: null as null,
      }
    }

    const frame = await resolveFrameTarget(tab.id, selector)
    state.targeting.selectedFrames.set(tab.id, selector)
    return {
      found: true,
      pageEpoch: frame.pageEpoch,
      frame: {
        ref: frame.ref,
        selector: frame.selector,
        src: frame.src,
      },
    }
  }

  return {
    detectNavigationAfterClick,
    navigateBack,
    navigateForward,
    navigateTo,
    reloadPage,
    switchToFrame,
    waitForNavigationCommit,
    waitForPageSettled,
  }
}
