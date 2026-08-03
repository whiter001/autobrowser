import { resolveAgentSelector } from '../../src/core/agent-selectors.js'
import { buildDeepDomTraversalHelpersSource } from './deep-dom.js'
import {
  clearSelectedFrame,
  getPageEpoch,
  invalidatePageRefs,
  withFrameSelectorOptions,
} from './targeting.js'
import type {
  EvaluateInTabContextOptions,
  ExtensionState,
  FrameExecutionContext,
  FrameSelector,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  TabInput,
  TabWithId,
} from './types.js'

interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

interface ElementActionResult extends Record<string, unknown> {
  found: boolean
  reason?: string
}

// 元素找不到时统一抛带 STALE_REFERENCE code 和 suggestedAction 的错误，
// 让调用方（AI Agent）能区分"选择器失效"和其它失败，并知道下一步该重新 snapshot
export function createElementNotFoundError(selector: string): Error {
  return Object.assign(new Error(`element not found: ${selector}`), {
    code: `STALE_REFERENCE`,
    suggestedAction: `The target element was not found. If this was from a previous snapshot reference like @eX, the page may have updated. Ensure you run 'snapshot' to get fresh element references.`,
  })
}

interface PageInputDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  resolveElementSelectorForTab: (
    tabId: TabInput,
    selector: string,
  ) => Promise<ResolvedSelectorTarget>
  resolveFrameTarget: (tabId: TabInput, selector: string) => Promise<ResolvedFrameTarget>
  getFrameExecutionContext: (
    tabId: TabInput,
    frameSelector: FrameSelector,
  ) => Promise<FrameExecutionContext>
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<{
    tab: TabWithId
    response: { result: unknown }
    value: TValue | null
  }>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
}

const PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE = buildDeepDomTraversalHelpersSource()
// 导航类命令（goto/open/back/forward/reload）等待"导航发生 + 页面稳定"的默认总预算
const DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS = 10000

// Input.insertText 每次往返一次 CDP。逐字符输入长文本时往返数过大，会撞上 30s
// 服务端超时；insertText 本身是"整段粘贴"语义而非逐键事件，分块只减少往返、
// 不改变最终输入内容，因此按块发送
const INSERT_TEXT_CHUNK_SIZE = 50

export interface FillFormField {
  selector: string
  value: string
}

// 序列化进页面执行的 fill 核心，按元素类型分派：
// - SELECT：按 option 文本（trim 后）或 option.value 匹配；未命中时列出前 10 个
//   可选项文本，让 AI 能根据真实选项自我纠正；
// - checkbox/radio：只接受 true/false（大小写不敏感），其它值直接报错；
// - 其余元素：仅当拥有 value 属性时赋值。
// 返回 { found, ... }；found:false + reason 由调用方转成带 selector 的 throw。
// 用 tagName/type 而非 instanceof，避免跨 iframe realm 的实例判断失效。
function applyFillValue(
  node: any,
  value: string,
): { found: boolean; reason?: string; checked?: boolean } {
  const tagName = typeof node?.tagName === 'string' ? node.tagName.toUpperCase() : ''
  const inputType = typeof node?.type === 'string' ? node.type.toLowerCase() : ''

  if (tagName === 'SELECT') {
    const options = Array.from((node.options as Array<{ text: string; value: string }>) || [])
    const trimmedValue = String(value).trim()
    const matched =
      options.find((option) => String(option.text).trim() === trimmedValue) ||
      options.find((option) => String(option.value) === String(value))
    if (!matched) {
      const available = options
        .slice(0, 10)
        .map((option) => String(option.text).trim())
        .join(', ')
      return {
        found: false,
        reason: `no option matches "${value}". available options: ${available || '(none)'}`,
      }
    }
    node.focus()
    node.value = matched.value
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
    return { found: true }
  }

  if (tagName === 'INPUT' && (inputType === 'checkbox' || inputType === 'radio')) {
    const normalized = String(value).trim().toLowerCase()
    if (normalized !== 'true' && normalized !== 'false') {
      return {
        found: false,
        reason: `checkbox/radio value must be "true" or "false" (got "${value}")`,
      }
    }
    node.focus()
    node.checked = normalized === 'true'
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
    return { found: true, checked: node.checked }
  }

  if (!('value' in node)) {
    return { found: false, reason: 'element does not accept value' }
  }

  node.focus()
  node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
  node.dispatchEvent(new Event('change', { bubbles: true }))
  return { found: true }
}

const FILL_VALUE_HELPER_SOURCE = `const applyFillValue = ${applyFillValue.toString()};`

export function createPageInputDomain({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  getFrameExecutionContext,
  evaluateInTabContext: evaluateInTabContextBase,
  sendDebuggerCommand,
}: PageInputDependencies) {
  const evaluateInTabContext = <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => {
    return evaluateInTabContextBase<TValue>(
      tabId,
      `${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}\n${expression}`,
      options,
    )
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // 页面内 MutationObserver 表达式：documentElement 连续 100ms 无变更即 settled。
  // 页面持续变更时由 hardCapMs 硬上限兜底 resolve（settled:false），
  // 实测 CDP Runtime.evaluate 的 timeout 无法中断 awaitPromise 的挂起等待，
  // 必须靠页面内定时器自兜底，扩展侧只负责等 evaluate 返回
  function buildMutationQuietExpression(hardCapMs: number): string {
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
            timer = setTimeout(quietDone, 100);
          });
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          timer = setTimeout(quietDone, 100);
          setTimeout(capDone, Math.max(0, deadline - Date.now()));
        } catch (error) {
          finish(false, 'observer-unavailable');
        }
      });
    })()`
  }

  interface WaitForPageSettledOptions {
    timeoutMs?: number
  }

  async function waitForPageSettled(
    tabId: number,
    options: WaitForPageSettledOptions = {},
  ): Promise<{ settled: boolean; settleReason?: string; settledInMs?: number }> {
    const timeoutMs = options.timeoutMs ?? 10000
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
          })
          if (value === 'interactive' || value === 'complete') {
            readyState = value
            break
          }
        } catch {
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

      // 阶段二：MutationObserver 连续 100ms 无变更视为稳定。
      // 期间页面再次导航（上下文销毁）则回到阶段一重试
      try {
        const { value } = await evaluateInTabContextBase<{
          settled: boolean
          reason?: string
        }>(tabId, buildMutationQuietExpression(remaining()), { timeoutMs: remaining() + 5000 })
        if (value?.settled) {
          return { settled: true, settledInMs: Date.now() - startedAt }
        }
        return { settled: false, settleReason: value?.reason || 'page kept changing' }
      } catch (error) {
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

  function parseKeyboardKey(key: string): { key: string; modifiers: number } {
    const modifiers = { shift: false, ctrl: false, alt: false, meta: false }
    let remaining = key

    if (remaining.includes('Control+')) {
      modifiers.ctrl = true
      remaining = remaining.replace('Control+', '')
    }
    if (remaining.includes('Shift+')) {
      modifiers.shift = true
      remaining = remaining.replace('Shift+', '')
    }
    if (remaining.includes('Alt+')) {
      modifiers.alt = true
      remaining = remaining.replace('Alt+', '')
    }
    if (remaining.includes('Meta+')) {
      modifiers.meta = true
      remaining = remaining.replace('Meta+', '')
    }

    let mask = 0
    if (modifiers.ctrl) mask |= 2
    if (modifiers.shift) mask |= 4
    if (modifiers.alt) mask |= 1
    if (modifiers.meta) mask |= 8

    return { key: remaining, modifiers: mask }
  }

  async function dispatchMouseClick(
    tabId: number,
    box: ElementBox,
    clickCount: number,
  ): Promise<void> {
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount,
    })
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount,
    })
  }

  async function dispatchKeyEvent(
    tabId: number,
    keyName: string,
    modifiers: number,
    type: 'keyDown' | 'keyUp',
  ): Promise<void> {
    await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
      type,
      key: keyName,
      code: keyName,
      modifiers,
    })
  }

  async function getElementBox(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<ElementBox>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height
        };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return value
  }

  async function dispatchInsertText(tabId: TabInput, text: string) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Input.insertText', {
      text: String(text || ''),
    })
    return { inserted: true, text }
  }

  async function insertTextSequentially(tabId: TabInput, text: string) {
    const normalizedText = String(text || '')
    // tab 只解析一次，否则每个块都会 tabs.get + debugger 各往返一次
    const tab = await getTargetTab(tabId)

    for (let offset = 0; offset < normalizedText.length; offset += INSERT_TEXT_CHUNK_SIZE) {
      await sendDebuggerCommand(tab.id, 'Input.insertText', {
        text: normalizedText.slice(offset, offset + INSERT_TEXT_CHUNK_SIZE),
      })
    }

    return { typed: true, text: normalizedText }
  }

  async function insertTextOnce(tabId: TabInput, text: string) {
    return await dispatchInsertText(tabId, text)
  }

  async function evaluateScript(
    tabId: TabInput,
    script: string,
    frameSelector: FrameSelector,
    timeoutMs?: number,
  ) {
    const { value } = await evaluateInTabContext(
      tabId,
      script,
      withFrameSelectorOptions(frameSelector, {
        userGesture: true,
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      }),
    )
    return value
  }

  async function navigateTo(
    tabId: TabInput,
    url: string,
    options: { timeoutMs?: number; wait?: boolean } = {},
  ) {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    // 基线必须在 invalidatePageRefs（已让 epoch +1）之后取：
    // 导航 commit 时 connection.ts 再 +1，轮询 epoch !== 基线即代表导航真正发生
    const baselineEpoch = getPageEpoch(state, tab.id)
    await sendDebuggerCommand(tab.id, 'Page.enable', {})
    await sendDebuggerCommand(tab.id, 'Page.navigate', { url })
    // --wait false 恢复旧的"发完即返回"行为
    if (options.wait === false) {
      return { tabId: tab.id, url }
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS
    const startedAt = Date.now()
    // 先等导航 commit 再判稳定，避免旧 document 存活期间把旧页误判成新页面已加载
    const commit = await waitForNavigationCommit(tab.id, baselineEpoch, timeoutMs)
    if (!commit) {
      return { tabId: tab.id, url, settled: false, settleReason: 'navigation never committed' }
    }
    const settle = await waitForPageSettled(tab.id, {
      timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
    })
    return {
      tabId: tab.id,
      url,
      settled: settle.settled,
      ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
    }
  }

  async function clickSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    timeoutMs = 10000,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const beforeEpoch = getPageEpoch(state, tab.id)
    const beforeUrl = tab.url
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        node.click();
        return { found: true, selector: ${JSON.stringify(selector)} };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (result?.found) {
      // 点击可能触发导航（链接/表单提交），检测到变化后等待页面稳定，并回显新 URL
      const navigated = await detectNavigationAfterClick(tab.id, beforeEpoch, beforeUrl)
      if (navigated) {
        const settle = await waitForPageSettled(tab.id, { timeoutMs })
        let currentUrl: string | null = null
        try {
          const currentTab = await getTargetTab(tab.id)
          currentUrl = currentTab.url || null
        } catch {
          // 点击后 tab 被关闭（如 window.open + 原页关闭），保持 null
        }
        return {
          ...result,
          navigatedToUrl: currentUrl,
          settled: settle.settled,
          ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
        }
      }
      return result
    }

    const box = await getElementBox(tab.id, selector, frameSelector)
    if (!box) {
      throw createElementNotFoundError(selector)
    }

    await dispatchMouseClick(tab.id, box, 1)
    return { found: true, selector }
  }

  async function hoverElement(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const box = await getElementBox(tab.id, selector, frameSelector)
    if (!box) {
      throw createElementNotFoundError(selector)
    }

    const { value } = await evaluateInTabContext<boolean>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const win = node.ownerDocument.defaultView;
        const opts = { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y };
        node.dispatchEvent(new PointerEvent('pointerover', opts));
        node.dispatchEvent(new MouseEvent('mouseover', opts));
        node.dispatchEvent(new PointerEvent('pointerenter', opts));
        node.dispatchEvent(new MouseEvent('mouseenter', opts));
        node.dispatchEvent(new MouseEvent('mousemove', opts));
        return true;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value) {
      return { found: true, selector }
    }

    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.x,
      y: box.y,
      button: 'none',
      clickCount: 0,
    })

    return { found: true, selector }
  }

  async function pressKey(tabId: TabInput, key: string) {
    const { key: keyName, modifiers } = parseKeyboardKey(key)
    const tab = await getTargetTab(tabId)

    // keyDown 成功后必须补 keyUp，否则页面逻辑上键会一直按着；
    // keyUp 失败不掩盖原始错误，只在原始无错时才抛出
    let keyUpError: unknown = null
    try {
      await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyDown')
    } finally {
      try {
        await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyUp')
      } catch (error) {
        keyUpError = error
      }
    }
    if (keyUpError !== null) {
      throw keyUpError
    }

    return { key, pressed: true }
  }

  async function focusElement(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.focus();
        return { found: true, focused: isDeepActiveElement(document, node) };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value?.found) {
      return value
    }

    throw createElementNotFoundError(selector)
  }

  async function selectOption(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.focus();
        node.value = ${JSON.stringify(value)};
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, value: node.value };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (result?.found) {
      return result
    }
    throw createElementNotFoundError(selector)
  }

  async function checkElement(
    tabId: TabInput,
    selector: string,
    checked: boolean,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.focus();
        node.checked = ${checked};
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, checked: node.checked };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (result?.found) {
      return result
    }
    throw createElementNotFoundError(selector)
  }

  async function scrollElement(
    tabId: TabInput,
    selector: string | null,
    deltaX = 0,
    deltaY = 100,
    frameSelector: FrameSelector,
  ) {
    let resolvedSelector = ''
    if (selector) {
      ;({ resolvedSelector } = await resolveElementSelectorForTab(tabId, selector))
    }
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tabId,
      `(() => {
        ${
          selector
            ? `
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        `
            : ''
        }
        window.scrollBy(${deltaX}, ${deltaY});
        return { found: true, scrolled: true };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (selector && value && value.found === false) {
      throw createElementNotFoundError(selector)
    }

    return value || { found: true, scrolled: true }
  }

  async function dragElement(
    tabId: TabInput,
    startSelector: string,
    endSelector: string,
    frameSelector: FrameSelector,
  ) {
    const startBox = await getElementBox(tabId, startSelector, frameSelector)
    if (!startBox) {
      throw new Error(`start element not found: ${startSelector}`)
    }

    let endBox: ElementBox
    if (endSelector) {
      const resolvedEndBox = await getElementBox(tabId, endSelector, frameSelector)
      if (!resolvedEndBox) {
        throw new Error(`end element not found: ${endSelector}`)
      }
      endBox = resolvedEndBox
    } else {
      endBox = {
        x: startBox.x,
        y: startBox.y + 100,
        width: startBox.width,
        height: startBox.height,
      }
    }

    const tab = await getTargetTab(tabId)

    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startBox.x,
      y: startBox.y,
      button: 'left',
      clickCount: 1,
    })

    const steps = 10
    for (let i = 1; i <= steps; i++) {
      const x = startBox.x + (endBox.x - startBox.x) * (i / steps)
      const y = startBox.y + (endBox.y - startBox.y) * (i / steps)
      await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'left',
        clickCount: 1,
      })
    }

    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: endBox.x,
      y: endBox.y,
      button: 'left',
      clickCount: 1,
    })

    return { found: true, dragged: true }
  }

  async function uploadFiles(
    tabId: TabInput,
    selector: string,
    filePaths: string[],
    frameSelector: FrameSelector,
  ) {
    const { resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { tab, executionContextId } = await getFrameExecutionContext(tabId, frameSelector)
    const result = await sendDebuggerCommand<{
      result?: { objectId?: string }
      exceptionDetails?: {
        text?: string
        exception?: { description?: string }
      }
    }>(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        ${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && node.tagName === 'INPUT' && node.type === 'file' ? node : null;
      })()`,
      awaitPromise: true,
      returnByValue: false,
      ...(executionContextId ? { contextId: executionContextId } : {}),
    })

    // evaluate 抛异常时 result 是异常对象，其 objectId 若传给 setFileInputFiles 会产生误导性报错
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails
      throw new Error(
        `failed to resolve file input ${selector}: ${details.exception?.description || details.text || 'unknown error'}`,
      )
    }

    const objectId = result?.result?.objectId
    if (!objectId) {
      throw new Error(`file input not found: ${selector}`)
    }

    try {
      await sendDebuggerCommand(tab.id, 'DOM.setFileInputFiles', {
        files: filePaths,
        objectId,
      })
    } finally {
      await sendDebuggerCommand(tab.id, 'Runtime.releaseObject', {
        objectId,
      }).catch(() => {})
    }

    return { found: true, files: filePaths }
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

  async function reloadPage(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    const baselineEpoch = getPageEpoch(state, tab.id)
    await sendDebuggerCommand(tab.id, 'Page.reload', {})
    const startedAt = Date.now()
    // 与 navigateTo 同理：先等导航 commit（epoch 变化）再判稳定，避免旧文档误判
    const commit = await waitForNavigationCommit(
      tab.id,
      baselineEpoch,
      DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS,
    )
    if (!commit) {
      return { reloaded: true, settled: false, settleReason: 'navigation never committed' }
    }
    const settle = await waitForPageSettled(tab.id, {
      timeoutMs: Math.max(0, DEFAULT_NAVIGATION_WAIT_TIMEOUT_MS - (Date.now() - startedAt)),
    })
    return {
      reloaded: true,
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

  async function checkIsState(
    tabId: TabInput,
    selector: string,
    stateType: string,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const checkJs = {
      visible: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      })()`,
      enabled: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && !node.disabled;
      })()`,
      checked: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && node.checked === true;
      })()`,
      disabled: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && node.disabled === true;
      })()`,
      focused: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && isDeepActiveElement(document, node);
      })()`,
    }

    const normalizedStateType = stateType as keyof typeof checkJs
    const js = checkJs[normalizedStateType]
    if (!js) {
      throw new Error(`unknown state type: ${stateType}`)
    }

    const { value } = await evaluateInTabContext(
      tab.id,
      js,
      withFrameSelectorOptions(frameSelector),
    )
    return {
      found: true,
      state: stateType,
      value,
    }
  }

  async function getAttribute(
    tabId: TabInput,
    selector: string,
    attrName: string,
    frameSelector: FrameSelector,
  ) {
    if (attrName === 'cdp-url') {
      if (!state.connection.token) {
        throw new Error('missing token')
      }

      return {
        found: true,
        value: `ws://127.0.0.1:${state.connection.relayPort}/ws?token=${encodeURIComponent(state.connection.token)}`,
      }
    }

    const selectorContext = ['title', 'url'].includes(attrName)
      ? null
      : await resolveElementSelectorForTab(tabId, selector)
    const resolvedSelector = selectorContext?.resolvedSelector || resolveAgentSelector(selector)
    const resolvedTabId = selectorContext?.tab.id ?? tabId

    // 依赖目标元素的读取统一走这里：节点不存在时抛 STALE_REFERENCE，
    // 避免把"元素不存在"静默伪装成 found:true + value:null
    async function readElementValue<TValue>(valueExpression: string): Promise<TValue> {
      const { value } = await evaluateInTabContext<{ found: boolean; value: TValue }>(
        resolvedTabId,
        `(() => {
          const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
          if (!node) return { found: false };
          return { found: true, value: (${valueExpression}) };
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      if (!value?.found) {
        throw createElementNotFoundError(selector)
      }
      return value.value
    }

    if (attrName === 'text') {
      return { found: true, value: await readElementValue('node.textContent') }
    }

    if (attrName === 'html') {
      return { found: true, value: await readElementValue('node.innerHTML') }
    }

    if (attrName === 'value') {
      return { found: true, value: await readElementValue('node.value') }
    }

    if (attrName === 'title') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        'document.title',
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'url') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        'window.location.href',
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'count') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        `(() => {
          return deepQuerySelectorAll(document, ${JSON.stringify(resolvedSelector)}).length;
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'box') {
      return {
        found: true,
        value: await readElementValue(`(() => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`),
      }
    }

    if (attrName === 'styles') {
      return {
        found: true,
        value: await readElementValue(`(() => {
          const styles = window.getComputedStyle(node);
          return Object.fromEntries(Array.from(styles).map((name) => [name, styles.getPropertyValue(name)]));
        })()`),
      }
    }

    return {
      found: true,
      value: await readElementValue(`node.getAttribute(${JSON.stringify(attrName)})`),
    }
  }

  /** 单字段填充核心：解析 selector → 页面内执行三分支 fill 逻辑 → 按结果抛错 */
  async function fillElement(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ): Promise<ElementActionResult> {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        ${FILL_VALUE_HELPER_SOURCE}
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) {
          return { found: false };
        }

        const result = applyFillValue(node, ${JSON.stringify(value)});
        return { ...result, selector: ${JSON.stringify(selector)} };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (result?.found) {
      return result
    }

    if (result?.reason) {
      throw new Error(`cannot fill ${selector}: ${result.reason}`)
    }

    throw createElementNotFoundError(selector)
  }

  async function fillSelector(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) {
    return await fillElement(tabId, selector, value, frameSelector)
  }

  /** 批量填表：逐 field 串行执行 fillElement，单个失败不中断（语义同 batch 的
   *  continueOnError）。全部失败时也照常 200 返回，由 succeeded/failed 统计体现 */
  async function fillFields(
    tabId: TabInput,
    fields: FillFormField[],
    frameSelector: FrameSelector,
  ): Promise<{
    results: Array<{ selector: string; ok: boolean; error?: string }>
    succeeded: number
    failed: number
  }> {
    const results: Array<{ selector: string; ok: boolean; error?: string }> = []
    let succeeded = 0
    let failed = 0
    for (const field of fields) {
      try {
        await fillElement(tabId, field.selector, field.value, frameSelector)
        results.push({ selector: field.selector, ok: true })
        succeeded += 1
      } catch (error) {
        results.push({
          selector: field.selector,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        failed += 1
      }
    }
    return { results, succeeded, failed }
  }

  async function keyDownOnly(tabId: TabInput, key: string) {
    const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
    const tab = await getTargetTab(tabId)

    await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyDown')
    return { key, pressed: true, type: 'keydown' }
  }

  async function keyUpOnly(tabId: TabInput, key: string) {
    const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
    const tab = await getTargetTab(tabId)

    await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyUp')
    return { key, released: true, type: 'keyup' }
  }

  async function typeIntoSelector(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
    submit = false,
  ) {
    await focusElement(tabId, selector, frameSelector)
    const typed = await insertTextSequentially(tabId, value)
    // --submit 对齐 Playwright type 的语义：输入完成后补一次 Enter，触发表单提交
    if (submit) {
      await pressKey(tabId, 'Enter')
    }
    return {
      found: true,
      selector,
      ...typed,
      ...(submit ? { submitted: true } : {}),
    }
  }

  async function doubleClickSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) {
    const box = await getElementBox(tabId, selector, frameSelector)
    if (!box) {
      throw createElementNotFoundError(selector)
    }

    const tab = await getTargetTab(tabId)
    await dispatchMouseClick(tab.id, box, 2)

    return { found: true, selector, doubleClicked: true }
  }

  async function scrollIntoViewSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        try {
          const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
          if (!node) return { found: false, reason: 'element not found' };
          node.scrollIntoView({ block: 'center', inline: 'center' });
          return { found: true, selector: ${JSON.stringify(selector)} };
        } catch (error) {
          return {
            found: false,
            reason: error instanceof Error ? error.message : 'failed to scroll into view',
          };
        }
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value?.found) {
      return value
    }

    // 页面内执行异常（如滚动画廊报错）与元素缺失区分开，避免误报 STALE_REFERENCE
    if (value?.reason && value.reason !== 'element not found') {
      throw new Error(`failed to scroll into view: ${selector}: ${value.reason}`)
    }

    throw createElementNotFoundError(selector)
  }

  return {
    checkElement,
    checkIsState,
    clickSelector,
    doubleClickSelector,
    evaluateScript,
    fillElement,
    fillFields,
    fillSelector,
    focusElement,
    getAttribute,
    hoverElement,
    insertTextOnce,
    insertTextSequentially,
    keyDownOnly,
    keyUpOnly,
    navigateBack,
    navigateForward,
    navigateTo,
    pressKey,
    reloadPage,
    scrollElement,
    scrollIntoViewSelector,
    selectOption,
    switchToFrame,
    typeIntoSelector,
    uploadFiles,
    dragElement,
  }
}
