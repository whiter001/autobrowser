import type { ErrorWithCode } from './types.js'

// 点击送达验证用到的页面脚本与错误工厂。
// 脚本都是自包含的 IIFE 表达式：扩展侧把它们交给 evaluateInTabContext 注入执行，
// 单测可以直接用假 DOM 执行同一份源码，而不是断言字符串片段。

/** 目标 ready 的等待上限：即使 click 的 timeoutMs 更大，也不会在准备阶段无限等 */
export const CLICK_READY_MAX_WAIT_MS = 5000
/** ready 轮询间隔；两次采样用于确认几何稳定 */
export const CLICK_READY_POLL_INTERVAL_MS = 50
/** mousePressed 之后等待事件探针落账的上限 */
export const CLICK_DELIVERY_SETTLE_MS = 150
/** mouseReleased 之后补采 mouseup/click 的上限 */
export const CLICK_DELIVERY_RELEASE_SETTLE_MS = 100
/** 事件坐标与目标中心允许的像素误差 */
export const CLICK_DELIVERY_COORD_TOLERANCE = 1
/** 探针在 window 上的符号键；安装与清理必须使用同一个字符串 */
const DELIVERY_PROBE_KEY = 'autobrowser.click.delivery'

export interface ClickRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ClickPoint {
  x: number
  y: number
}

export interface ClickBlockerInfo {
  tag: string
  id: string | null
  className: string | null
  text: string | null
}

/** 页面内 ready 检测的返回结构；unstable 由扩展侧根据连续采样判定 */
export interface ClickReadinessResult {
  ready: boolean
  reason: string
  rect?: ClickRect | null
  center?: ClickPoint | null
  blocker?: ClickBlockerInfo | null
}

export interface ClickDeliveryProbeInstallResult {
  found: boolean
  installed: boolean
  center?: ClickPoint | null
}

export interface ClickDeliveryProbeReport {
  found: boolean
  installed: boolean
  delivered: boolean
  blocked: ClickBlockerInfo | null
  blockedEvent: string | null
  events: string[]
  center?: ClickPoint | null
}

export type ClickDeliveryStatus = 'delivered' | 'not_delivered' | 'unknown' | 'not_ready'

export interface ClickDeliverySummary {
  status: ClickDeliveryStatus
  reason: string
  events: string[]
  blocker: ClickBlockerInfo | null
  [key: string]: unknown
}

export interface ClickDeliverySuccess {
  status: 'delivered'
  trusted: true
  events: string[]
}

const SELECTOR_PLACEHOLDER = '__AUTOBROWSER_CLICK_SELECTOR__'

// 页面里共用的描述逻辑：把遮盖元素压缩成可读证据，避免把整个 DOM 传回 relay
const BLOCKER_DESCRIBE_SOURCE = `const describe = (value) => {
    if (!value) return null;
    const tag = typeof value.tagName === 'string' ? value.tagName.toLowerCase() : String(value.nodeName || '').toLowerCase();
    const className = typeof value.className === 'string' ? value.className.trim().split(/\\s+/).slice(0, 3).join(' ') : '';
    const text = typeof value.textContent === 'string' ? value.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : '';
    return { tag, id: value.id || null, className: className || null, text: text || null };
  };`

// 事件/shadow 命中判断：从节点沿 composed 树向上找到目标，覆盖 shadow host 的情况
const COMPOSE_SOURCE = `const compose = (start, target) => {
    let current = start;
    for (let depth = 0; current && depth < 50; depth += 1) {
      if (current === target) return true;
      const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
      if (root && root.host) { current = root.host; continue; }
      current = current.parentNode || null;
    }
    return false;
  };`

function readinessBody(): string {
  return `(() => {
  const node = deepQuerySelector(document, ${SELECTOR_PLACEHOLDER});
  if (!node) return { ready: false, reason: 'not_found' };
  if (node.isConnected === false) return { ready: false, reason: 'detached' };
  const doc = node.ownerDocument || document;
  const view = doc.defaultView || (typeof window === 'undefined' ? null : window);
  const style = view && typeof view.getComputedStyle === 'function'
    ? view.getComputedStyle(node)
    : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) {
    return { ready: false, reason: 'not_visible' };
  }
  if (node.disabled === true) return { ready: false, reason: 'disabled' };
  if (typeof node.getAttribute === 'function' && node.getAttribute('aria-disabled') === 'true') {
    return { ready: false, reason: 'disabled' };
  }
  if (node.inert === true) return { ready: false, reason: 'disabled' };
  if (typeof node.closest === 'function' && node.closest('[inert], [aria-disabled="true"], fieldset[disabled]')) {
    return { ready: false, reason: 'disabled' };
  }
  const rect = node.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { ready: false, reason: 'not_visible' };
  }
  const viewportWidth = view ? view.innerWidth : 0;
  const viewportHeight = view ? view.innerHeight : 0;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (viewportWidth > 0 && viewportHeight > 0 && (x < 0 || y < 0 || x > viewportWidth || y > viewportHeight)) {
    return { ready: false, reason: 'out_of_view' };
  }
  ${BLOCKER_DESCRIBE_SOURCE}
  ${COMPOSE_SOURCE}
  const hit = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : node;
  if (!hit) return { ready: false, reason: 'out_of_view' };
  if (hit !== node && !compose(hit, node)) {
    return { ready: false, reason: 'obstructed', blocker: describe(hit) };
  }
  return {
    ready: true,
    reason: 'ready',
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    center: { x, y }
  };
})()`
}

/** ready 检测脚本：查询、可见性、禁用/inert、视口与遮挡都在页面里一次算清 */
export function buildClickReadinessSource(selector: string): string {
  return readinessBody().replaceAll(SELECTOR_PLACEHOLDER, JSON.stringify(selector))
}

function probeBody(): string {
  return `(() => {
  const key = Symbol.for('${DELIVERY_PROBE_KEY}');
  const prior = window[key];
  if (prior && typeof prior.cleanup === 'function') {
    try { prior.cleanup(); } catch (error) {}
  }
  const node = deepQuerySelector(document, ${SELECTOR_PLACEHOLDER});
  if (!node) return { found: false, installed: false };
  const rect = node.getBoundingClientRect();
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const state = {
    found: true,
    installed: true,
    center,
    events: [],
    delivered: false,
    blocked: null,
    blockedEvent: null
  };
  const seen = new WeakSet();
  const types = ['pointerdown', 'mousedown', 'mouseup', 'click'];
  ${BLOCKER_DESCRIBE_SOURCE}
  ${COMPOSE_SOURCE}
  const record = (event) => {
    // 只认浏览器 trusted 输入；脚本合成的事件（isTrusted=false）不能当送达证据
    if (!event || event.isTrusted !== true) return;
    if (seen.has(event)) return;
    seen.add(event);
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return;
    if (
      Math.abs(event.clientX - center.x) > ${CLICK_DELIVERY_COORD_TOLERANCE} ||
      Math.abs(event.clientY - center.y) > ${CLICK_DELIVERY_COORD_TOLERANCE}
    ) {
      return;
    }
    const type = String(event.type || '');
    if (type && state.events.indexOf(type) < 0) state.events.push(type);
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const onTarget = (Array.isArray(path) && path.indexOf(node) >= 0) || compose(event.target, node);
    if (onTarget) {
      // 只有按下类事件能证明 trusted 输入落在目标上；mouseup/click 只能作补充证据
      if (type === 'pointerdown' || type === 'mousedown') state.delivered = true;
      return;
    }
    const hit = (Array.isArray(path) && path.length > 0 ? path[0] : event.target) || null;
    if (!state.blocked) {
      state.blocked = describe(hit);
      state.blockedEvent = type;
    }
    // 命中错误目标时立刻拦截，避免覆盖层/错位元素收到 click 副作用
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    else if (typeof event.stopPropagation === 'function') event.stopPropagation();
  };
  const listeners = [];
  const attach = (scope) => {
    if (!scope || typeof scope.addEventListener !== 'function') return;
    const listener = (event) => record(event);
    for (const type of types) {
      scope.addEventListener(type, listener, true);
      listeners.push([scope, type, listener]);
    }
  };
  // 目标所在的 closed shadow root 只对节点自身监听可见，因此两处都挂；WeakSet 负责去重
  attach(node);
  const view = node.ownerDocument && node.ownerDocument.defaultView;
  if (view) attach(view);
  if (typeof window !== 'undefined' && window !== view) attach(window);
  state.cleanup = () => {
    for (const entry of listeners) {
      try { entry[0].removeEventListener(entry[1], entry[2], true); } catch (error) {}
    }
    listeners.length = 0;
    if (window[key] === state) {
      try { delete window[key]; } catch (error) { window[key] = undefined; }
    }
  };
  window[key] = state;
  return { found: true, installed: true, center };
})()`
}

/** 安装送达探针：在目标与 window 捕获阶段监听，命中错误目标时阻断其事件 */
export function buildClickDeliveryProbeSource(selector: string): string {
  return probeBody().replaceAll(SELECTOR_PLACEHOLDER, JSON.stringify(selector))
}

/** 读取探针状态但不清理：mousePressed 后先取一次证据，mouseReleased 后再补一次 */
export function buildClickDeliveryReportSource(): string {
  return `(() => {
  const probe = window[Symbol.for('${DELIVERY_PROBE_KEY}')];
  if (!probe) return { found: false, installed: false };
  return {
    found: true,
    installed: true,
    delivered: probe.delivered === true,
    blocked: probe.blocked || null,
    blockedEvent: probe.blockedEvent || null,
    events: Array.isArray(probe.events) ? probe.events.slice() : [],
    center: probe.center || null
  };
})()`
}

/** 移除探针和它注册的监听；收尾脚本不依赖上一条命令的上下文 */
export function buildClickDeliveryCleanupSource(): string {
  return `(() => {
  const key = Symbol.for('${DELIVERY_PROBE_KEY}');
  const probe = window[key];
  if (!probe) return { found: false, cleaned: false };
  if (typeof probe.cleanup === 'function') probe.cleanup();
  try { delete window[key]; } catch (error) { window[key] = undefined; }
  return { found: true, cleaned: true };
})()`
}

function createDeliveryError(
  message: string,
  code: string,
  selector: string,
  delivery: ClickDeliverySummary,
  suggestedAction: string,
): ErrorWithCode {
  return Object.assign(new Error(message), {
    code,
    details: { selector, delivery },
    suggestedAction,
  }) as ErrorWithCode
}

const READINESS_HINTS: Record<string, string> = {
  not_found:
    "No element matched the selector. Check the selector or selected frame, or run 'snapshot' again for a fresh @eN ref.",
  detached:
    "The element left the document before any input was sent. Re-run 'snapshot' and target the current element.",
  disabled:
    'The element is disabled, aria-disabled or inert. Wait for it to become enabled instead of bypassing the UI state.',
  not_visible:
    'The element has no rendered box (display:none, visibility:hidden or zero size). Wait for it to render or target a visible ancestor.',
  out_of_view:
    "The element center is outside the viewport. Scroll it into view ('scrollintoview <selector>') before retrying.",
  obstructed:
    'details.delivery.blocker is the element covering the target center. Dismiss the overlay/dialog or choose a target that is actually on top.',
  unstable:
    'The target box kept changing between samples (animation, scrolling or re-layout). Let it settle, then retry.',
  page_changed:
    "The page navigated or its execution context was destroyed while waiting for readiness. Confirm the new page ('get url'/'snapshot'), then retry against the current document.",
}

export function createClickNotReadyError(
  selector: string,
  delivery: ClickDeliverySummary,
): ErrorWithCode {
  return createDeliveryError(
    `click target is not ready: ${selector}`,
    'CLICK_NOT_READY',
    selector,
    delivery,
    `${READINESS_HINTS[delivery.reason] || READINESS_HINTS.not_found} No mouse input was sent, so nothing was clicked.`,
  )
}

export function createClickNotDeliveredError(
  selector: string,
  delivery: ClickDeliverySummary,
): ErrorWithCode {
  return createDeliveryError(
    `click input was not delivered to the target: ${selector}`,
    'CLICK_NOT_DELIVERED',
    selector,
    delivery,
    'details.delivery.blocker is the element that received the trusted pointer event; its event was suppressed. Remove the overlay or target the correct element, then retry. autobrowser will not replay the click through DOM node.click().',
  )
}

export function createClickDeliveryUnknownError(
  selector: string,
  delivery: ClickDeliverySummary,
): ErrorWithCode {
  return createDeliveryError(
    `click delivery could not be confirmed: ${selector}`,
    'CLICK_DELIVERY_UNKNOWN',
    selector,
    delivery,
    "Mouse input was dispatched, but no trusted pointerdown/mousedown proof was captured (the page may have navigated/closed, or the CDP acknowledgement was lost). Check 'status', 'command list' and the current page before retrying; never replay the click blindly.",
  )
}

/** 把 CDP 原错误附到 delivery 证据上，保证调用方仍看得到底层错误 */
export function attachDeliveryToError(error: unknown, delivery: ClickDeliverySummary): unknown {
  if (!error || typeof error !== 'object') return error
  const target = error as ErrorWithCode
  const existing =
    target.details && typeof target.details === 'object' && !Array.isArray(target.details)
      ? (target.details as Record<string, unknown>)
      : {}
  target.details = { ...existing, delivery }
  return target
}
