import { resolveAgentFrameSelector } from '../../src/core/agent-handles.js'
import {
  assertFreshFrameRef,
  getOrCreateTabHandle,
  getPageEpoch,
  resolveEffectiveFrameSelector,
  withFrameSelectorOptions,
} from './targeting.js'
import type { CommandExecutionContext } from './command-queue.js'
import type { ExtensionState, FrameSelector, NewTabRecord, TabInput } from './types.js'
import type { ElementActionResult, ElementBox, PageInputContext } from './page-input-context.js'
import { createElementNotFoundError } from './page-input-helpers.js'
import { isDeadlineExceeded } from './operation-context.js'
import type { createNavigationCommands } from './page-input-navigation.js'
import {
  CLICK_DELIVERY_RELEASE_SETTLE_MS,
  CLICK_DELIVERY_SETTLE_MS,
  CLICK_READY_MAX_WAIT_MS,
  CLICK_READY_POLL_INTERVAL_MS,
  attachDeliveryToError,
  buildClickDeliveryCleanupSource,
  buildClickDeliveryProbeSource,
  buildClickDeliveryReportSource,
  buildClickReadinessSource,
  createClickDeliveryUnknownError,
  createClickNotDeliveredError,
  createClickNotReadyError,
  type ClickBlockerInfo,
  type ClickDeliveryProbeInstallResult,
  type ClickDeliveryProbeReport,
  type ClickDeliverySummary,
  type ClickDeliverySuccess,
  type ClickPoint,
  type ClickReadinessResult,
  type ClickRect,
} from './page-input-click-delivery.js'

// 鼠标相关命令：坐标测量、点击/双击/悬停、拖拽、坐标移动与拖放数据投递。
// 坐标测量与导航等待都来自共享的 navigation 模块，避免重复实现

/** 新标签记录的时间窗：超过这个时间的记录不再参与"这次点击是否开了新标签"的判断 */
export const NEW_TAB_WINDOW_MS = 15000
/** 新标签记录的最大条数，避免长时间运行后无界增长 */
export const NEW_TAB_MAX_RECORDS = 20
/** 显式跟随时等待 onCreated 的最长时长 */
export const NEW_TAB_FOLLOW_WAIT_MS = 1000
/** 显式跟随时轮询新标签记录的间隔 */
export const NEW_TAB_FOLLOW_POLL_INTERVAL_MS = 50

/**
 * 记录一个新建标签页。
 *
 * 只保留 id / 打开者 / 创建时间三样东西：既足够判断"这次点击是不是开了新标签"，
 * 又不会把页面内容或 URL 之类的敏感数据留在内存里。
 */
export function recordCreatedTab(
  state: ExtensionState,
  tab: { id?: number; openerTabId?: number },
): void {
  if (typeof tab.id !== 'number') {
    return
  }

  const now = Date.now()
  pruneRecentlyCreatedTabs(state, now)
  state.targeting.recentlyCreatedTabs.push({
    id: tab.id,
    openerTabId: typeof tab.openerTabId === 'number' ? tab.openerTabId : null,
    createdAt: now,
  })
  // 超出上限时丢最旧的记录：FIFO 有界，内存不会随打开标签次数无限增长
  while (state.targeting.recentlyCreatedTabs.length > NEW_TAB_MAX_RECORDS) {
    state.targeting.recentlyCreatedTabs.shift()
  }
}

/** 丢弃超出时间窗的旧记录 */
export function pruneRecentlyCreatedTabs(state: ExtensionState, now = Date.now()): void {
  const records = state.targeting.recentlyCreatedTabs
  const cutoff = now - NEW_TAB_WINDOW_MS
  let expired = 0
  while (expired < records.length && (records[expired]?.createdAt ?? 0) < cutoff) {
    expired += 1
  }
  if (expired > 0) {
    records.splice(0, expired)
  }
}

/**
 * 找出由 sourceTabId 打开、且在 since 之后创建的新标签。
 *
 * 只认"打开者就是被点击的标签"的新标签：同页自己开的其它标签（用户手动新建、
 * 页面轮询开窗）不会被算成这次点击的结果。
 */
export function findNewTabOpenedBy(
  state: ExtensionState,
  sourceTabId: number,
  since: number,
  now = Date.now(),
): number | null {
  pruneRecentlyCreatedTabs(state, now)
  let matched: NewTabRecord | null = null
  for (const record of state.targeting.recentlyCreatedTabs) {
    if (record.openerTabId !== sourceTabId || record.createdAt < since) {
      continue
    }
    if (!matched || record.createdAt >= matched.createdAt) {
      matched = record
    }
  }
  return matched ? matched.id : null
}

function clickDownloadEvidence(
  state: ExtensionState,
  tabId: number,
  previousDownloads: Set<number>,
  previousRequests: Set<unknown>,
): Record<string, unknown> | null {
  const browserDownload = state.session.downloads
    .slice()
    .reverse()
    .find((item) => !previousDownloads.has(item.id))
  const fileResponse = state.network.requests
    .slice()
    .reverse()
    .find((request) => {
      if (previousRequests.has(request) || request.tabId !== tabId) return false
      const headers = Object.entries(request.responseHeaders || {}).map(([key, value]) => [
        key.toLowerCase(),
        String(value),
      ])
      const disposition = headers.find(([key]) => key === 'content-disposition')?.[1] || ''
      const mime = String(request.responseMimeType || '').toLowerCase()
      const attachment = /attachment/i.test(disposition)
      const downloadedDocument =
        request.resourceType === 'Document' &&
        Boolean(mime) &&
        !mime.includes('text/html') &&
        !mime.includes('application/xhtml') &&
        (request.errorText === 'net::ERR_ABORTED' || request.status === 200)
      return attachment || downloadedDocument
    })
  if (!browserDownload && !fileResponse) return null

  return {
    downloadDetected: true,
    downloadState: browserDownload?.state || 'unknown',
    ...(browserDownload?.id !== undefined ? { browserDownloadId: browserDownload.id } : {}),
    ...(browserDownload?.filename ? { downloadPath: browserDownload.filename } : {}),
    ...(fileResponse?.url || browserDownload?.url
      ? { downloadUrl: fileResponse?.url || browserDownload?.url }
      : {}),
    suggestedAction: browserDownload
      ? "Run 'downloads list' for the browser download state; only state=complete with a filename proves a saved file."
      : "A file response was detected, but no browser download record was observed. Use 'download <url> <output-path>' to save explicitly, or check 'downloads list'; this click does not prove the file was saved.",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readRect(value: unknown): ClickRect | null {
  if (!isRecord(value)) return null
  const { x, y, width, height } = value
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return null
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

function readPoint(value: unknown): ClickPoint | null {
  if (!isRecord(value)) return null
  const { x, y } = value
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function readBlocker(value: unknown): ClickBlockerInfo | null {
  if (!isRecord(value)) return null
  return {
    tag: typeof value.tag === 'string' ? value.tag : 'unknown',
    id: typeof value.id === 'string' ? value.id : null,
    className: typeof value.className === 'string' ? value.className : null,
    text: typeof value.text === 'string' ? value.text : null,
  }
}

function normalizeReadiness(value: unknown): ClickReadinessResult {
  if (!isRecord(value)) return { ready: false, reason: 'evaluation_failed' }
  return {
    ready: value.ready === true,
    reason: typeof value.reason === 'string' ? value.reason : 'unknown',
    rect: readRect(value.rect),
    center: readPoint(value.center),
    blocker: readBlocker(value.blocker),
  }
}

function normalizeProbeInstall(value: unknown): ClickDeliveryProbeInstallResult {
  if (!isRecord(value)) return { found: false, installed: false }
  return {
    found: value.found === true,
    installed: value.installed === true,
    center: readPoint(value.center),
  }
}

function normalizeProbeReport(value: unknown): ClickDeliveryProbeReport {
  if (!isRecord(value)) {
    return {
      found: false,
      installed: false,
      delivered: false,
      blocked: null,
      blockedEvent: null,
      events: [],
      center: null,
    }
  }
  return {
    found: value.found === true,
    installed: value.installed === true,
    delivered: value.delivered === true,
    blocked: readBlocker(value.blocked),
    blockedEvent: typeof value.blockedEvent === 'string' ? value.blockedEvent : null,
    events: Array.isArray(value.events)
      ? value.events.filter((item): item is string => typeof item === 'string')
      : [],
    center: readPoint(value.center),
  }
}

/** 几何稳定判定：亚像素抖动（0.5px 内）不算移动，避免动画收尾阶段永远不稳定 */
function rectStable(previous: ClickRect, next: ClickRect): boolean {
  return (
    Math.abs(previous.x - next.x) < 0.5 &&
    Math.abs(previous.y - next.y) < 0.5 &&
    Math.abs(previous.width - next.width) < 0.5 &&
    Math.abs(previous.height - next.height) < 0.5
  )
}

function centersMatch(box: ElementBox, center: ClickPoint): boolean {
  return Math.abs(box.x - center.x) <= 1 && Math.abs(box.y - center.y) <= 1
}

function describeCdpError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) }
  const code = (error as { code?: unknown }).code
  return {
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
  }
}

/**
 * 创建指针类命令：鼠标移动、按下抬起、滚轮与拖拽。
 */
export function createPointerCommands(
  pageContext: PageInputContext,
  navigation: ReturnType<typeof createNavigationCommands>,
) {
  const {
    state,
    getTargetTab,
    resolveElementSelectorForTab,
    resolveFrameTarget,
    evaluateInTabContext,
    sendDebuggerCommand,
    sleep,
  } = pageContext
  const mousePositions = new Map<number, { x: number; y: number }>()

  // 坐标测量会滚动父页/iframe/目标元素，属于副作用，取消后不能再发
  async function getElementBox(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    scrollIntoView: boolean | 'none' = false,
    context?: CommandExecutionContext,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const effectiveFrame = resolveEffectiveFrameSelector(state, tab, frameSelector)
    const frameExpression = effectiveFrame
      ? `const root = deepQuerySelector(document, ${JSON.stringify(resolveAgentFrameSelector(effectiveFrame))});
         const frame = root && (root.tagName === 'IFRAME' ? root : deepQuerySelector(root, 'iframe'));
         if (!frame) throw new Error('frame not found');`
      : ''
    if (effectiveFrame) assertFreshFrameRef(state, tab.id, effectiveFrame)
    if (effectiveFrame && scrollIntoView !== 'none') {
      // 必须先滚动父页，否则屏幕外 iframe 的 CDP frame 解析可能命中错误位置。
      context?.throwIfCancelled()
      await evaluateInTabContext(
        tab.id,
        `(() => {
          ${frameExpression}
          frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        })()`,
        { frameSelector: 'top', commandContext: context },
      )
    }
    context?.throwIfCancelled()
    const { value } = await evaluateInTabContext<ElementBox>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return null;
        ${scrollIntoView !== 'none' && (scrollIntoView || effectiveFrame) ? "node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });" : ''}
        const rect = node.getBoundingClientRect();
        ${scrollIntoView === true ? 'if (rect.width === 0 && rect.height === 0) return null;' : ''}
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height,
          downloadHint: node.hasAttribute('download') || (typeof node.href === 'string' && /\\/dl(?:\\/|$)|\\.(epub|mobi|pdf|zip|rar|7z|mp3|mp4)(?:$|[?#])/i.test(node.href)),
          downloadUrl: typeof node.href === 'string' ? node.href : undefined
        };
      })()`,
      withFrameSelectorOptions(effectiveFrame || 'top', { commandContext: context }),
    )
    if (!value || !effectiveFrame) return value

    // 子页滚动可能连带移动父页；重新取 frame 位置，并补上内容视口的边框偏移。
    const frame = await resolveFrameTarget(tab.id, effectiveFrame)
    context?.throwIfCancelled()
    const { value: border } = await evaluateInTabContext<{ left: number; top: number }>(
      tab.id,
      `(() => {
        ${frameExpression}
        return { left: frame.clientLeft, top: frame.clientTop };
      })()`,
      { frameSelector: 'top', commandContext: context },
    )
    if (!border) throw new Error(`frame not found: ${effectiveFrame}`)
    return { ...value, x: value.x + frame.left + border.left, y: value.y + frame.top + border.top }
  }

  async function dispatchMouseMove(
    tabId: number,
    box: ElementBox,
    context?: CommandExecutionContext,
  ): Promise<void> {
    // 先移动再按下，并显式维护 buttons 位掩码；部分 Chromium 会丢掉没有前置移动或按键状态的点击。
    context?.throwIfCancelled()
    await sendDebuggerCommand(
      tabId,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: box.x,
        y: box.y,
        button: 'none',
        buttons: 0,
        clickCount: 0,
        pointerType: 'mouse',
      },
      context,
    )
  }

  async function dispatchMousePress(
    tabId: number,
    box: ElementBox,
    clickCount: number,
    context?: CommandExecutionContext,
  ): Promise<void> {
    context?.throwIfCancelled()
    await sendDebuggerCommand(
      tabId,
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: box.x,
        y: box.y,
        button: 'left',
        buttons: 1,
        clickCount,
        pointerType: 'mouse',
      },
      context,
    )
  }

  async function dispatchMouseRelease(
    tabId: number,
    box: ElementBox,
    clickCount: number,
  ): Promise<void> {
    // 释放不传 context：收尾动作必须发出，不能因为取消把按键状态留在页面里
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      buttons: 0,
      clickCount,
      pointerType: 'mouse',
    })
  }

  async function dispatchMouseClick(
    tabId: number,
    box: ElementBox,
    clickCount: number,
    context?: CommandExecutionContext,
  ): Promise<void> {
    await dispatchMouseMove(tabId, box, context)
    await dispatchMousePress(tabId, box, clickCount, context)
    await dispatchMouseRelease(tabId, box, clickCount)
  }

  async function observeClickTarget(
    tabId: number,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ): Promise<void> {
    const { value } = await evaluateInTabContext<{ found: boolean }>(
      tabId,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(selector)});
        if (!node) return { found: false };
        const key = Symbol.for('autobrowser.click.observation');
        const events = [];
        const types = ['mousedown', 'mouseup', 'click'];
        const listener = (event) => events.push(event.type);
        for (const type of types) node.addEventListener(type, listener, true);
        node[key] = {
          events,
          cleanup: () => {
            for (const type of types) node.removeEventListener(type, listener, true);
          },
        };
        return { found: true };
      })()`,
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )
    if (!value?.found) throw createElementNotFoundError(selector)
  }

  async function finishObservedClick(
    tabId: number,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ): Promise<{ found: boolean; events: string[]; domClicked: boolean } | null> {
    const { value } = await evaluateInTabContext<{
      found: boolean
      events: string[]
      domClicked: boolean
    }>(
      tabId,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(selector)});
        if (!node) return { found: false, events: [], domClicked: false };
        const key = Symbol.for('autobrowser.click.observation');
        const observation = node[key];
        const events = observation ? [...observation.events] : [];
        if (observation) {
          observation.cleanup();
          delete node[key];
        }
        if (events.length > 0) return { found: true, events, domClicked: false };
        node.click();
        return { found: true, events, domClicked: true };
      })()`,
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )
    return value ?? null
  }

  /**
   * 找出这次点击打开的新标签。
   *
   * 默认只用当前已有的记录：没命中就直接返回，不给普通点击增加等待。
   * 显式跟随时（followNewTab）才补一段有界等待：chrome.tabs.onCreated 可能晚于
   * 点击返回到达，错过这一拍调用方就拿不到新标签句柄，跟随也就无从谈起。
   */
  async function detectNewTabAfterClick(
    sourceTabId: number,
    since: number,
    followNewTab: boolean,
    context?: CommandExecutionContext,
  ): Promise<number | null> {
    const found = findNewTabOpenedBy(state, sourceTabId, since)
    if (found !== null || !followNewTab) {
      return found
    }

    const deadline = Date.now() + NEW_TAB_FOLLOW_WAIT_MS
    while (Date.now() < deadline) {
      context?.throwIfCancelled()
      await sleep(NEW_TAB_FOLLOW_POLL_INTERVAL_MS)
      context?.throwIfCancelled()
      const late = findNewTabOpenedBy(state, sourceTabId, since)
      if (late !== null) {
        return late
      }
    }

    return null
  }

  /**
   * 等待目标真正可点：可见、启用、在视口内、未被遮挡，且几何连续两次一致。
   * 预算取 click 的 timeoutMs 与 CLICK_READY_MAX_WAIT_MS 的较小值；没发出输入，
   * 所以失败时只抛 CLICK_NOT_READY，不会触发任何 DOM 点击回退。
   */
  async function waitForClickReadiness(
    tabId: number,
    selector: string,
    resolvedSelector: string,
    evaluateOptions: Record<string, unknown>,
    timeoutMs: number,
    context?: CommandExecutionContext,
  ): Promise<void> {
    const budget = Math.max(1, Math.min(timeoutMs, CLICK_READY_MAX_WAIT_MS))
    const deadline = Date.now() + budget
    const source = buildClickReadinessSource(resolvedSelector)
    let previousRect: ClickRect | null = null
    let last: ClickReadinessResult = { ready: false, reason: 'not_found' }

    for (;;) {
      context?.throwIfCancelled()
      let value: unknown
      try {
        value = (await evaluateInTabContext(tabId, source, evaluateOptions)).value
      } catch (error) {
        // 等待期间页面导航会销毁执行上下文；此时没有发出任何输入，按 ready 失败报告
        if ((error as { code?: unknown }).code !== 'EVAL_CONTEXT_DESTROYED') throw error
        throw createClickNotReadyError(selector, {
          status: 'not_ready',
          reason: 'page_changed',
          events: [],
          blocker: null,
          error: describeCdpError(error),
          waitedMs: budget,
        })
      }
      last = normalizeReadiness(value)
      if (last.ready && last.rect) {
        if (previousRect && rectStable(previousRect, last.rect)) {
          return
        }
        previousRect = last.rect
      } else {
        // 几何不稳定或不可见时重新开始计数，避免用"上一次可见"的矩形误判稳定
        previousRect = null
      }
      if (Date.now() >= deadline) {
        const reason = last.ready ? 'unstable' : last.reason
        throw createClickNotReadyError(selector, {
          status: 'not_ready',
          reason,
          events: [],
          blocker: last.blocker ?? null,
          waitedMs: budget,
          ...(last.rect ? { rect: last.rect } : {}),
        })
      }
      await sleep(Math.max(1, Math.min(CLICK_READY_POLL_INTERVAL_MS, deadline - Date.now())))
    }
  }

  /**
   * 读取探针证据。输入已经发出，读取本身没有副作用，因此不传 commandContext：
   * 即使命令已被取消，也要尽量把"是否送达"的既成事实读回来。
   */
  async function readDeliveryReport(
    tabId: number,
    evaluateOptions: Record<string, unknown>,
    settleMs: number,
  ): Promise<ClickDeliveryProbeReport | null> {
    const source = buildClickDeliveryReportSource()
    const deadline = Date.now() + Math.max(0, settleMs)
    let last: ClickDeliveryProbeReport | null = null
    for (;;) {
      try {
        const { value } = await evaluateInTabContext(tabId, source, evaluateOptions)
        last = normalizeProbeReport(value)
      } catch {
        // 页面在点击后导航/关闭时旧执行上下文会消失；此前读到的证据仍然有效
        return last
      }
      if (last.delivered || last.blocked) return last
      if (Date.now() >= deadline) return last
      await sleep(Math.min(20, Math.max(1, deadline - Date.now())))
    }
  }

  async function cleanupDeliveryProbe(
    tabId: number,
    evaluateOptions: Record<string, unknown>,
  ): Promise<void> {
    try {
      await evaluateInTabContext(tabId, buildClickDeliveryCleanupSource(), evaluateOptions)
    } catch {
      // 导航/关闭会连带销毁页面全局，探针不会残留
    }
  }

  function mergeDeliveryReports(
    first: ClickDeliveryProbeReport | null,
    second: ClickDeliveryProbeReport | null,
  ): {
    delivered: boolean
    blocked: ClickBlockerInfo | null
    blockedEvent: string | null
    events: string[]
  } {
    const events: string[] = []
    for (const report of [first, second]) {
      for (const event of report?.events ?? []) {
        if (!events.includes(event)) events.push(event)
      }
    }
    return {
      delivered: first?.delivered === true || second?.delivered === true,
      blocked: first?.blocked ?? second?.blocked ?? null,
      blockedEvent: first?.blockedEvent ?? second?.blockedEvent ?? null,
      events,
    }
  }

  /**
   * verify-delivery 路径：ready → 布探针 → trusted CDP 输入 → 用探针证据判定送达。
   * 这条路径禁止 DOM fallback；只要发生过输入，就不再重放任何 DOM click。
   */
  async function performVerifiedClick(
    tabId: number,
    selector: string,
    resolvedSelector: string,
    frameSelector: FrameSelector,
    timeoutMs: number,
    context?: CommandExecutionContext,
    onBeforeInput?: () => Promise<void>,
  ): Promise<{ delivery: ClickDeliverySuccess; downloadHint: boolean; downloadUrl?: string }> {
    const tab = await getTargetTab(tabId)
    const effectiveFrame = resolveEffectiveFrameSelector(state, tab, frameSelector)
    const frameTarget = effectiveFrame || 'top'
    const readinessOptions = withFrameSelectorOptions(frameTarget, { commandContext: context })
    const inspectOptions = withFrameSelectorOptions(frameTarget, {})

    // 与默认路径一致：先滚动到视口再判断 ready；目标不存在时由 readiness 给出具体 reason
    await getElementBox(tabId, selector, frameSelector, true, context)
    await waitForClickReadiness(
      tabId,
      selector,
      resolvedSelector,
      readinessOptions,
      timeoutMs,
      context,
    )

    let box: ElementBox | null = null
    let probe: ClickDeliveryProbeInstallResult | null = null
    let aligned = false
    // iframe 的坐标是全局坐标，不能和页面内 center 直接比较；比较只在主文档有意义
    for (let attempt = 0; attempt < 3; attempt += 1) {
      context?.throwIfCancelled()
      box = await getElementBox(tabId, selector, frameSelector, 'none', context)
      if (!box) break
      const { value } = await evaluateInTabContext<ClickDeliveryProbeInstallResult>(
        tabId,
        buildClickDeliveryProbeSource(resolvedSelector),
        inspectOptions,
      )
      probe = normalizeProbeInstall(value)
      if (!probe.installed) break
      if (effectiveFrame) {
        aligned = true
        break
      }
      if (probe.center && centersMatch(box, probe.center)) {
        aligned = true
        break
      }
      // ready 之后布局又动了：重新测量并重装探针，避免按旧坐标输入
      await sleep(20)
    }

    if (!box) {
      // 极少数情况下目标在拿到探针后消失：安装过的监听必须清掉再报错
      if (probe?.installed) await cleanupDeliveryProbe(tabId, inspectOptions)
      throw createClickNotReadyError(selector, {
        status: 'not_ready',
        reason: 'detached',
        events: [],
        blocker: null,
      })
    }
    if (!probe?.installed) {
      throw createClickNotReadyError(selector, {
        status: 'not_ready',
        reason: 'not_found',
        events: [],
        blocker: null,
      })
    }
    if (!aligned) {
      // 坐标与探针中心对不上，说明 ready 之后目标仍在移动：清掉探针并宁可不发输入
      await cleanupDeliveryProbe(tabId, inspectOptions)
      throw createClickNotReadyError(selector, {
        status: 'not_ready',
        reason: 'unstable',
        events: [],
        blocker: null,
        dispatchedAt: null,
      })
    }

    let cdpError: unknown = null
    const send = async (action: () => Promise<void>) => {
      try {
        await action()
      } catch (error) {
        if (cdpError === null) cdpError = error
      }
    }

    // ready 可能等了几秒：导航/新标签的基线要在真正发输入前重捕，
    // 否则等待期间页面自己的导航会被误算成这次点击的产物
    await onBeforeInput?.()

    // 移动与按下分开：按下后立刻取一次证据，页面即使随即导航也能保留 trusted 按下记录
    await send(() => dispatchMouseMove(tabId, box, context))
    await send(() => dispatchMousePress(tabId, box, 1, context))
    const pressedReport = await readDeliveryReport(tabId, inspectOptions, CLICK_DELIVERY_SETTLE_MS)
    await send(() => dispatchMouseRelease(tabId, box, 1))
    const releasedReport = await readDeliveryReport(
      tabId,
      inspectOptions,
      CLICK_DELIVERY_RELEASE_SETTLE_MS,
    )
    await cleanupDeliveryProbe(tabId, inspectOptions)

    const evidence = mergeDeliveryReports(pressedReport, releasedReport)
    const delivery: ClickDeliverySuccess = {
      status: 'delivered',
      trusted: true,
      events: evidence.events,
    }
    if (evidence.delivered) {
      // 证据确认已投递，但 CDP 回执可能丢失；原错误必须冒泡，同时附上送达事实
      if (cdpError !== null) {
        throw attachDeliveryToError(cdpError, {
          ...delivery,
          reason: 'delivered',
          blocker: null,
          dispatchedAt: { x: box.x, y: box.y },
        })
      }
      return { delivery, downloadHint: box.downloadHint === true, downloadUrl: box.downloadUrl }
    }

    const summary: ClickDeliverySummary = {
      status: evidence.blocked ? 'not_delivered' : 'unknown',
      reason: evidence.blocked
        ? 'blocked'
        : cdpError !== null
          ? 'no_evidence_after_cdp_error'
          : 'no_evidence',
      events: evidence.events,
      blocker: evidence.blocked,
      dispatchedAt: { x: box.x, y: box.y },
      probeCenter: probe.center ?? null,
      ...(evidence.blockedEvent ? { blockedEvent: evidence.blockedEvent } : {}),
      ...(cdpError !== null ? { cdpError: describeCdpError(cdpError) } : {}),
    }
    if (evidence.blocked) {
      throw createClickNotDeliveredError(selector, summary)
    }
    throw createClickDeliveryUnknownError(selector, summary)
  }

  async function clickSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    timeoutMs = 10000,
    context?: CommandExecutionContext,
    followNewTab = false,
    verifyDelivery = false,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    let beforeEpoch = getPageEpoch(state, tab.id)
    let beforeUrl = tab.url
    let previousDownloads = new Set(state.session.downloads.map((item) => item.id))
    let previousRequests = new Set<unknown>(state.network.requests)
    // 点击开始时间：新标签必须在它之后创建才算这次点击的产物
    let clickStartedAt = Date.now()

    // verify 路径要等 ready；等待期间页面可能自行导航或开标签，
    // 真正发输入前重捕基线，避免把等待期的副作用算到这次点击上
    const captureClickBaseline = async () => {
      beforeEpoch = getPageEpoch(state, tab.id)
      try {
        beforeUrl = (await getTargetTab(tab.id)).url || beforeUrl
      } catch {
        // tab 已关闭时保留原 URL；后续导航判断会按 epoch 变化处理
      }
      previousDownloads = new Set(state.session.downloads.map((item) => item.id))
      previousRequests = new Set<unknown>(state.network.requests)
      clickStartedAt = Date.now()
    }

    let downloadHint: boolean
    let downloadUrl: string | undefined
    let domFallback = false
    let delivery: ClickDeliverySuccess | null = null

    if (verifyDelivery) {
      // verify 路径自己完成 ready/探针/输入，绝不回退到页面内 node.click()
      const verified = await performVerifiedClick(
        tab.id,
        selector,
        resolvedSelector,
        frameSelector,
        timeoutMs,
        context,
        captureClickBaseline,
      )
      downloadHint = verified.downloadHint
      downloadUrl = verified.downloadUrl
      delivery = verified.delivery
    } else {
      // CDP 优先：先 scrollIntoView 并取元素中心坐标，走 trusted 的 Input.dispatchMouseEvent；
      // 依赖 isTrusted 的页面（表单校验/统计埋点等）必须由真实输入事件触发
      const boxResult = await getElementBox(tab.id, selector, frameSelector, true, context)
      downloadHint = boxResult?.downloadHint === true
      downloadUrl = boxResult?.downloadUrl
      if (boxResult) {
        await observeClickTarget(tab.id, resolvedSelector, frameSelector, context)
        let cdpError: unknown = null
        try {
          await dispatchMouseClick(tab.id, boxResult, 1, context)
        } catch (error) {
          if (!isDeadlineExceeded(error)) throw error
          cdpError = error
        }
        let observed
        try {
          observed = await finishObservedClick(tab.id, resolvedSelector, frameSelector, context)
        } catch (error) {
          if (cdpError) throw cdpError
          throw error
        }
        // 已收到任一鼠标事件就不能再 DOM click；即使 CDP 回执丢失，也只能报告原错误。
        if (cdpError && (!observed?.found || observed.events.length > 0)) throw cdpError
        domFallback = observed?.domClicked === true
      } else {
        // 坐标拿不到（display:none 等不可见元素）时回退到页面内 node.click()
        context?.throwIfCancelled()
        const { value: jsResult } = await evaluateInTabContext<ElementActionResult>(
          tab.id,
          `(() => {
          const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
          if (!node) return { found: false };
          const downloadHint = node.hasAttribute('download') || (typeof node.href === 'string' && /\\/dl(?:\\/|$)|\\.(epub|mobi|pdf|zip|rar|7z|mp3|mp4)(?:$|[?#])/i.test(node.href));
          const downloadUrl = typeof node.href === 'string' ? node.href : undefined;
          node.click();
          return { found: true, downloadHint, downloadUrl, selector: ${JSON.stringify(selector)} };
        })()`,
          withFrameSelectorOptions(frameSelector, { commandContext: context }),
        )

        if (!jsResult?.found) {
          throw createElementNotFoundError(selector)
        }
        downloadHint ||= jsResult.downloadHint === true
        downloadUrl ||= typeof jsResult.downloadUrl === 'string' ? jsResult.downloadUrl : undefined
      }
    }

    // 点击可能触发导航（链接/表单提交），两条路径统一在这里检测并等待页面稳定
    context?.throwIfCancelled()
    const navigated = await navigation.detectNavigationAfterClick(tab.id, beforeEpoch, beforeUrl)
    let downloadEvidence = clickDownloadEvidence(state, tab.id, previousDownloads, previousRequests)
    const hasNewDocumentRequest = state.network.requests.some(
      (request) =>
        !previousRequests.has(request) &&
        request.tabId === tab.id &&
        request.resourceType === 'Document',
    )
    // 下载重定向可能晚于 500ms 导航窗口；只在已有下载提示或 Document 请求时延长观察。
    if (!navigated && !downloadEvidence && (downloadHint || hasNewDocumentRequest)) {
      const deadline = Date.now() + 2500
      while (!downloadEvidence && Date.now() < deadline) {
        context?.throwIfCancelled()
        await new Promise((resolve) => setTimeout(resolve, 100))
        downloadEvidence = clickDownloadEvidence(state, tab.id, previousDownloads, previousRequests)
      }
    }
    if (!downloadEvidence && downloadHint) {
      downloadEvidence = {
        downloadExpected: true,
        downloadState: 'unknown',
        ...(downloadUrl ? { downloadUrl } : {}),
        suggestedAction:
          "The clicked link is expected to start a download, but its browser state is unknown. Use 'downloads list' or save it explicitly with 'download <url> <output-path>'; this click does not prove the file was saved.",
      }
    }

    // target=_blank / window.open 打开的新标签：只报告，不动当前目标。
    // 是否接管新标签由调用方决定（CLI 的 --follow-new-tab 才显式跟随）。
    const newTabId = await detectNewTabAfterClick(tab.id, clickStartedAt, followNewTab, context)
    const newTabEvidence =
      typeof newTabId === 'number'
        ? { newTabId, newTabHandle: getOrCreateTabHandle(state, newTabId) }
        : {}
    if (navigated) {
      const settle = await navigation.waitForPageSettled(tab.id, {
        timeoutMs,
        commandContext: context,
      })
      let currentUrl: string | null = null
      try {
        const currentTab = await getTargetTab(tab.id)
        currentUrl = currentTab.url || null
      } catch {
        // 点击后 tab 被关闭（如 window.open + 原页关闭），保持 null
      }
      return {
        found: true,
        selector,
        ...(domFallback ? { domFallback: true } : {}),
        ...(delivery ? { delivery } : {}),
        navigatedToUrl: currentUrl,
        settled: settle.settled,
        ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
        ...newTabEvidence,
        ...downloadEvidence,
      }
    }
    return {
      found: true,
      selector,
      ...(domFallback ? { domFallback: true } : {}),
      ...(delivery ? { delivery } : {}),
      ...newTabEvidence,
      ...downloadEvidence,
    }
  }

  async function doubleClickSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const box = await getElementBox(tabId, selector, frameSelector, false, context)
    if (!box) {
      throw createElementNotFoundError(selector)
    }

    const tab = await getTargetTab(tabId)
    await dispatchMouseClick(tab.id, box, 2, context)

    return { found: true, selector, doubleClicked: true }
  }

  async function hoverElement(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const box = await getElementBox(tab.id, selector, frameSelector, false, context)
    if (!box) {
      throw createElementNotFoundError(selector)
    }

    context?.throwIfCancelled()
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
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )

    if (value) {
      return { found: true, selector }
    }

    context?.throwIfCancelled()
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: box.x,
        y: box.y,
        button: 'none',
        clickCount: 0,
      },
      context,
    )

    return { found: true, selector }
  }

  async function dragElement(
    tabId: TabInput,
    startSelector: string,
    endSelector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    let startBox = await getElementBox(tabId, startSelector, frameSelector, false, context)
    if (!startBox) {
      throw new Error(`start element not found: ${startSelector}`)
    }

    let endBox: ElementBox
    if (endSelector) {
      const resolvedEndBox = await getElementBox(tabId, endSelector, frameSelector, false, context)
      if (!resolvedEndBox) {
        throw new Error(`end element not found: ${endSelector}`)
      }
      const tab = await getTargetTab(tabId)
      if (resolveEffectiveFrameSelector(state, tab, frameSelector)) {
        // 终点滚动后起点坐标也可能变化；只重新测量，避免再次滚动使终点失效。
        startBox = await getElementBox(tab.id, startSelector, frameSelector, 'none', context)
        if (!startBox) throw new Error(`start element not found: ${startSelector}`)
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

    context?.throwIfCancelled()
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: startBox.x,
        y: startBox.y,
        button: 'left',
        clickCount: 1,
      },
      context,
    )

    const steps = 10
    const mouseRelease = {
      type: 'mouseReleased',
      x: endBox.x,
      y: endBox.y,
      button: 'left',
      clickCount: 1,
    }
    try {
      for (let i = 1; i <= steps; i++) {
        context?.throwIfCancelled()
        const x = startBox.x + (endBox.x - startBox.x) * (i / steps)
        const y = startBox.y + (endBox.y - startBox.y) * (i / steps)
        await sendDebuggerCommand(
          tab.id,
          'Input.dispatchMouseEvent',
          {
            type: 'mouseMoved',
            x,
            y,
            button: 'left',
            clickCount: 1,
          },
          context,
        )
      }
    } catch (error) {
      // 拖拽途中失败或被取消：按下的左键必须释放，页面不能停留在拖拽状态
      await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', mouseRelease).catch(() => {})
      throw error
    }

    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', mouseRelease)

    return { found: true, dragged: true }
  }

  async function dropData(
    tabId: TabInput,
    selector: string,
    data: Record<string, string>,
    files: Array<{ name: string; mimeType: string; dataBase64: string }>,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const { resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<{ found?: boolean; dropped?: boolean }>(
      tabId,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        const transfer = new DataTransfer();
        const textData = ${JSON.stringify(data)};
        for (const [mimeType, text] of Object.entries(textData)) transfer.setData(mimeType, text);
        const files = ${JSON.stringify(files)};
        for (const fileData of files) {
          const binary = atob(fileData.dataBase64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
          transfer.items.add(new File([bytes], fileData.name, { type: fileData.mimeType }));
        }
        const rect = node.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        for (const type of ['dragenter', 'dragover', 'drop']) {
          node.dispatchEvent(new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX,
            clientY
          }));
        }
        return { found: true, dropped: true };
      })()`,
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )
    if (!value?.found) throw createElementNotFoundError(selector)
    return { ...value, selector, textItems: Object.keys(data).length, fileCount: files.length }
  }

  async function mouseMove(
    tabId: TabInput,
    x: number,
    y: number,
    context?: CommandExecutionContext,
  ) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y },
      context,
    )
    mousePositions.set(tab.id, { x, y })
    return { moved: true, x, y }
  }

  async function mouseButton(
    tabId: TabInput,
    pressed: boolean,
    button: string,
    context?: CommandExecutionContext,
  ) {
    const tab = await getTargetTab(tabId)
    const point = mousePositions.get(tab.id) || { x: 0, y: 0 }
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      {
        type: pressed ? 'mousePressed' : 'mouseReleased',
        ...point,
        button,
        clickCount: 1,
      },
      context,
    )
    return { pressed, button, ...point }
  }

  async function mouseWheel(
    tabId: TabInput,
    deltaX: number,
    deltaY: number,
    context?: CommandExecutionContext,
  ) {
    const tab = await getTargetTab(tabId)
    const point = mousePositions.get(tab.id) || { x: 0, y: 0 }
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', ...point, deltaX, deltaY },
      context,
    )
    return { scrolled: true, deltaX, deltaY, ...point }
  }

  return {
    clickSelector,
    doubleClickSelector,
    dragElement,
    dropData,
    getElementBox,
    hoverElement,
    mouseButton,
    mouseMove,
    mouseWheel,
  }
}
