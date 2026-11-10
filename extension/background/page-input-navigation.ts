import { clearSelectedFrame, getPageEpoch, invalidatePageRefs } from './targeting.js'
import type { CommandExecutionContext } from './command-queue.js'
import { isDeadlineExceeded, withHardDeadline } from './operation-context.js'
import type { TabInput } from './types.js'
import type { PageInputContext } from './page-input-context.js'

// 导航类命令（goto/open/back/forward/reload）等待"导航发生 + 页面稳定"的默认总预算
const DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS = 10000
// 导航指令本身（Page.reload / Page.navigate / navigateToHistoryEntry）的回执上界。
// 导航会销毁旧 renderer，chrome.debugger 的回调在目标上下文消失后可能永远不触发；
// 不设上界时扩展侧会一直挂着，relay 只能报 COMMAND_TIMEOUT，页面"其实已刷新"的事实被丢掉。
const NAVIGATION_DISPATCH_TIMEOUT_MS = 5000
// document.readyState 探测本身有 2s 的 CDP timeout，但它同样无法中断已经挂起的等待，
// 因此再加一档硬上界，让探测失败退化成"继续轮询"而不是整条命令卡死。
const READY_STATE_PROBE_HARD_TIMEOUT_MS = 3000
// 页内 MutationObserver 探测按剩余预算自兜底，这里只给 CDP 回执留一点额外余量
const SETTLE_PROBE_ALLOWANCE_MS = 6000

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
    updateTab,
    reloadTab,
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
          // 探测本身也可能挂起：导航销毁上下文时 CDP 回调可能丢失。硬上界让它退化成
          // 一次失败的轮询并继续重试，而不是把整条命令拖过 relay 预算。
          const { value } = await withHardDeadline(
            evaluateInTabContextBase<string>(tabId, 'document.readyState', {
              timeoutMs: 2000,
              commandContext: options.commandContext,
            }),
            Math.min(READY_STATE_PROBE_HARD_TIMEOUT_MS, Math.max(1, remaining())),
            'document.readyState probe',
          )
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
        // 页内定时器负责 hardCap 自兜底，这里只兜 CDP 回执丢失的极端情况
        const { value } = await withHardDeadline(
          evaluateInTabContextBase<{
            settled: boolean
            reason?: string
          }>(tabId, buildMutationQuietExpression(remaining(), domQuietMs), {
            timeoutMs: remaining() + 5000,
            commandContext: options.commandContext,
          }),
          remaining() + SETTLE_PROBE_ALLOWANCE_MS,
          'page settle probe',
        )
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

  // 导航 commit 由 connection.ts 监听 Page.frameNavigated / navigatedWithinDocument 推进 epoch，
  // 而 Page 域事件必须显式 enable。此前只有 goto/open 会打开 Page 域，reload/back/forward
  // 落在没跑过 goto 的 tab 上就永远等不到 commit，刷新成功也会被报成 partial。
  async function enablePageEvents(tabId: number): Promise<void> {
    await sendDebuggerCommand(tabId, 'Page.enable', {})
  }

  // 返回 true 表示"指令已发出但没有拿到 CDP 回执"：此时导航通常已经发生，
  // 继续等 commit 比直接判失败更有信息量；其它异常（tab 已关闭等）仍按原样抛出。
  async function dispatchNavigation(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    budgetMs = NAVIGATION_DISPATCH_TIMEOUT_MS,
  ): Promise<boolean> {
    try {
      await withHardDeadline(
        sendDebuggerCommand(tabId, method, params),
        Math.min(NAVIGATION_DISPATCH_TIMEOUT_MS, Math.max(1, budgetMs)),
        method,
      )
      return false
    } catch (error) {
      if (!isDeadlineExceeded(error)) throw error
      return true
    }
  }

  function isDifferentExtensionUrlError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /cannot access a chrome-extension:\/\/ URL of different extension/i.test(message)
  }

  async function dispatchWithTabsApiFallback(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    budgetMs: number,
    fallback?: () => Promise<void>,
  ): Promise<{ dispatchTimedOut: boolean; usedTabsApi: boolean }> {
    try {
      await enablePageEvents(tabId)
      const dispatchTimedOut = await dispatchNavigation(tabId, method, params, budgetMs)
      return { dispatchTimedOut, usedTabsApi: false }
    } catch (error) {
      // Chromium 会因页面嵌入其他扩展的 iframe 而拒绝 debugger.attach；tabs 导航不受此限制，
      // 先离开受限文档，后续稳定探测再重新 attach。只兜底这个明确错误，避免掩盖其它 CDP 故障。
      if (!fallback || !isDifferentExtensionUrlError(error)) throw error
      await fallback()
      return { dispatchTimedOut: false, usedTabsApi: true }
    }
  }

  async function waitForTabsApiCommit(
    tabId: number,
    budgetMs: number,
    requestedUrl?: string,
    previousUrl?: string,
  ): Promise<boolean> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      const observed = await getTargetTab(tabId).catch(() => null)
      const urlReached =
        !requestedUrl || observed?.url === requestedUrl || observed?.url !== previousUrl
      if (observed && observed.status !== 'loading' && urlReached) return true
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
    // 分发上界不能超过命令自身预算，否则短预算的调用会被分发阶段吃掉
    const timeoutMs = options.timeoutMs ?? DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS
    const dispatch = await dispatchWithTabsApiFallback(
      tab.id,
      'Page.navigate',
      { url },
      timeoutMs,
      updateTab
        ? async () => {
            await updateTab(tab.id, url)
          }
        : undefined,
    )
    // 指令没回执时不改写 outcome，只在结果里留痕，避免把"可能已导航"伪装成"没发出去"
    const dispatchNote = {
      ...(dispatch.dispatchTimedOut ? { dispatchTimedOut: true } : {}),
      ...(dispatch.usedTabsApi ? { dispatchChannel: 'tabs' } : {}),
    }
    // --wait false 恢复旧的"发完即返回"行为
    const waitUntil = options.wait === false ? 'none' : options.waitUntil || 'domquiet'
    if (waitUntil === 'none') {
      return {
        ...dispatchNote,
        tabId: tab.id,
        url,
        requestedUrl: url,
        outcome: 'dispatched',
        phase: 'dispatch',
      }
    }

    const startedAt = Date.now()
    // 先等导航 commit 再判稳定，避免旧 document 存活期间把旧页误判成新页面已加载
    const commit = dispatch.usedTabsApi
      ? await waitForTabsApiCommit(tab.id, timeoutMs, url, tab.url)
      : await waitForNavigationCommit(tab.id, baselineEpoch, timeoutMs)
    if (!commit) {
      const observed = await getTargetTab(tab.id).catch(() => null)
      return {
        ...dispatchNote,
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
        ...dispatchNote,
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
      ...dispatchNote,
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
    await enablePageEvents(tab.id)
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
        invalidatePageRefs(state, tab.id)
        const baselineEpoch = getPageEpoch(state, tab.id)
        const dispatchTimedOut = await dispatchNavigation(tab.id, 'Page.navigateToHistoryEntry', {
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
            ...(dispatchTimedOut ? { dispatchTimedOut } : {}),
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
          ...(dispatchTimedOut ? { dispatchTimedOut } : {}),
          settled: settle.settled,
          ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
        }
      }
    }
    return { navigated: false, reason: 'no back history' }
  }

  async function navigateForward(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    await enablePageEvents(tab.id)
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
        invalidatePageRefs(state, tab.id)
        const baselineEpoch = getPageEpoch(state, tab.id)
        const dispatchTimedOut = await dispatchNavigation(tab.id, 'Page.navigateToHistoryEntry', {
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
            ...(dispatchTimedOut ? { dispatchTimedOut } : {}),
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
          ...(dispatchTimedOut ? { dispatchTimedOut } : {}),
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS
    const dispatch = await dispatchWithTabsApiFallback(
      tab.id,
      'Page.reload',
      {},
      timeoutMs,
      reloadTab ? async () => await reloadTab(tab.id) : undefined,
    )
    const dispatchNote = {
      ...(dispatch.dispatchTimedOut ? { dispatchTimedOut: true } : {}),
      ...(dispatch.usedTabsApi ? { dispatchChannel: 'tabs' } : {}),
    }
    const startedAt = Date.now()
    // 与 navigateTo 同理：先等导航 commit（epoch 变化）再判稳定，避免旧文档误判
    const waitUntil = options.waitUntil || 'domquiet'
    if (waitUntil === 'none') {
      return {
        reloaded: true,
        outcome: 'dispatched',
        phase: 'dispatch',
        ...dispatchNote,
      }
    }
    const commit = dispatch.usedTabsApi
      ? await waitForTabsApiCommit(tab.id, timeoutMs)
      : await waitForNavigationCommit(tab.id, baselineEpoch, timeoutMs)
    // 所有分支都回显实际观测到的 URL / epoch：调用方才能回答"刷新到底发生了没有"，
    // 而不是在 partial 之后盲目重发 reload。committed 把"没提交"和"提交了但没稳定"分开。
    const observed = await getTargetTab(tab.id).catch(() => null)
    const progress = {
      waitUntil,
      baselineEpoch,
      observedEpoch: getPageEpoch(state, tab.id),
      observedUrl: observed?.url || null,
      observedTitle: observed?.title || null,
      ...dispatchNote,
    }
    if (!commit) {
      return {
        reloaded: true,
        outcome: 'partial',
        phase: 'commit',
        ...progress,
        committed: false,
        settled: false,
        settleReason: 'navigation never committed',
      }
    }
    if (waitUntil === 'commit') {
      return {
        reloaded: true,
        outcome: 'completed',
        phase: 'commit',
        ...progress,
        committed: true,
        settled: true,
      }
    }
    const settle = await waitForPageSettled(tab.id, {
      timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
      waitUntil,
    })
    return {
      reloaded: true,
      outcome: settle.settled ? 'completed' : 'partial',
      phase: 'settle',
      ...progress,
      committed: true,
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
