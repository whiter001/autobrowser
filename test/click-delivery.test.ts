import { describe, expect, test } from 'bun:test'
import { validateCommandArgs } from '../src/core/command-spec.js'
import { parseClickArgs } from '../src/cli/commands/elements.js'
import { AutobrowserMcpServer } from '../src/cli/mcp.js'
import {
  createPointerCommands,
  recordCreatedTab,
} from '../extension/background/page-input-pointer.js'
import {
  buildClickDeliveryCleanupSource,
  buildClickDeliveryProbeSource,
  buildClickDeliveryReportSource,
  buildClickReadinessSource,
} from '../extension/background/page-input-click-delivery.js'
import { createExtensionState } from '../extension/background/state.js'
import type { ExtensionState } from '../extension/background/types.js'
import type { CommandResponse } from '../src/cli/client.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

/**
 * click --verify-delivery：
 * 页面脚本用轻量假 DOM 真实执行，扩展侧用 createPointerCommands 走完整流程，
 * 而不是只断言源码字符串里出现了某些片段。
 */

interface FakeListener {
  type: string
  fn: (event: FakeEvent) => void
  capture: boolean
}

class FakeEventTarget {
  listeners: FakeListener[] = []

  addEventListener(type: string, fn: (event: FakeEvent) => void, capture = false): void {
    this.listeners.push({ type, fn, capture })
  }

  removeEventListener(type: string, fn: (event: FakeEvent) => void, capture = false): void {
    const index = this.listeners.findIndex(
      (listener) => listener.type === type && listener.fn === fn && listener.capture === capture,
    )
    if (index >= 0) this.listeners.splice(index, 1)
  }

  emit(event: FakeEvent): void {
    for (const listener of this.listeners) {
      if (listener.type === event.type) listener.fn(event)
    }
  }

  listenerCount(): number {
    return this.listeners.length
  }
}

interface FakeRect {
  left: number
  top: number
  width: number
  height: number
}

class FakeElement extends FakeEventTarget {
  tagName = 'DIV'
  id = ''
  className = ''
  textContent = ''
  isConnected = true
  disabled = false
  inert = false
  rect: FakeRect = { left: 0, top: 0, width: 100, height: 50 }
  attributes: Record<string, string> = {}
  parentNode: FakeElement | null = null
  ownerDocument: FakeDocument
  rootNode: { host?: FakeElement } | null = null
  driftWidth = false
  clicked = 0
  private drift = 0

  constructor(ownerDocument: FakeDocument) {
    super()
    this.ownerDocument = ownerDocument
  }

  getBoundingClientRect() {
    let width = this.rect.width
    if (this.driftWidth) {
      this.drift += 1
      width += this.drift % 2
    }
    return {
      x: this.rect.left,
      y: this.rect.top,
      left: this.rect.left,
      top: this.rect.top,
      width,
      height: this.rect.height,
      right: this.rect.left + width,
      bottom: this.rect.top + this.rect.height,
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes
  }

  closest(selector: string): FakeElement | null {
    const matches = (current: FakeElement | null): FakeElement | null => {
      if (!current) return null
      if (
        selector.includes('[aria-disabled="true"]') &&
        current.getAttribute('aria-disabled') === 'true'
      ) {
        return current
      }
      if (selector.includes('[inert]') && current.inert) return current
      if (
        selector.includes('fieldset[disabled]') &&
        current.tagName === 'FIELDSET' &&
        current.disabled
      ) {
        return current
      }
      return matches(current.parentNode)
    }
    return matches(this)
  }

  getRootNode(): unknown {
    return this.rootNode ?? this.ownerDocument
  }

  scrollIntoView(): void {}

  click(): void {
    this.clicked += 1
  }
}

class FakeWindow extends FakeEventTarget {
  innerWidth = 1280
  innerHeight = 720

  getComputedStyle(node: FakeElement) {
    return {
      display: node.attributes['data-display'] ?? 'block',
      visibility: node.attributes['data-visibility'] ?? 'visible',
    }
  }
}

class FakeDocument extends FakeEventTarget {
  defaultView: FakeWindow
  hit: FakeElement | null = null

  constructor(window: FakeWindow) {
    super()
    this.defaultView = window
  }

  elementFromPoint(): FakeElement | null {
    return this.hit
  }
}

class FakeEvent {
  type: string
  isTrusted: boolean
  clientX: number
  clientY: number
  target: FakeElement
  defaultPrevented = false
  propagationStopped = false
  immediateStopped = false
  private path: unknown[]

  constructor(init: {
    type: string
    target: FakeElement
    clientX: number
    clientY: number
    isTrusted: boolean
    path: unknown[]
  }) {
    this.type = init.type
    this.target = init.target
    this.clientX = init.clientX
    this.clientY = init.clientY
    this.isTrusted = init.isTrusted
    this.path = init.path
  }

  composedPath(): unknown[] {
    return this.path
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }

  stopImmediatePropagation(): void {
    this.immediateStopped = true
    this.propagationStopped = true
  }
}

class FakeDom {
  window = new FakeWindow()
  document = new FakeDocument(this.window)
  readonly nodes = new Map<string, FakeElement>()

  addElement(selector: string): FakeElement {
    const element = new FakeElement(this.document)
    this.nodes.set(selector, element)
    return element
  }

  readonly query = (_root: unknown, selector: string): FakeElement | null =>
    this.nodes.get(selector) ?? null

  run(source: string): unknown {
    const factory = new Function(
      'document',
      'window',
      'deepQuerySelector',
      'source',
      'return eval(source)',
    ) as (...args: unknown[]) => unknown
    return factory(this.document, this.window, this.query, source)
  }

  fire(
    type: string,
    target: FakeElement,
    options: { x: number; y: number; isTrusted?: boolean; path?: unknown[] },
  ): FakeEvent {
    const event = new FakeEvent({
      type,
      target,
      clientX: options.x,
      clientY: options.y,
      isTrusted: options.isTrusted !== false,
      path: options.path ?? [target, this.document, this.window],
    })
    // 与真实 DOM 一样，window 捕获阶段先于目标自身监听；被 stopImmediate 后不再下传
    this.window.emit(event)
    if (!event.immediateStopped) target.emit(event)
    return event
  }
}

function createTargetDom() {
  const dom = new FakeDom()
  const target = dom.addElement('#btn')
  target.textContent = 'Save'
  dom.document.hit = target
  return { dom, target }
}

describe('click readiness script', () => {
  test('reports ready with the target center when visible, stable and unobstructed', () => {
    const { dom, target } = createTargetDom()

    const result = dom.run(buildClickReadinessSource('#btn')) as Record<string, unknown>

    expect(result).toEqual({
      ready: true,
      reason: 'ready',
      rect: { x: 0, y: 0, width: 100, height: 50 },
      center: { x: 50, y: 25 },
    })
    expect(target.listenerCount()).toBe(0)
  })

  test('reports disabled for disabled, aria-disabled, inert and disabled fieldset targets', () => {
    for (const mutate of [
      (node: FakeElement) => {
        node.disabled = true
      },
      (node: FakeElement) => {
        node.attributes['aria-disabled'] = 'true'
      },
      (node: FakeElement) => {
        node.inert = true
      },
      (node: FakeElement) => {
        const fieldset = new FakeElement(node.ownerDocument)
        fieldset.tagName = 'FIELDSET'
        fieldset.disabled = true
        node.parentNode = fieldset
      },
    ]) {
      const { dom, target } = createTargetDom()
      mutate(target)
      expect(dom.run(buildClickReadinessSource('#btn'))).toMatchObject({
        ready: false,
        reason: 'disabled',
      })
    }
  })

  test('reports not_visible for display:none, visibility:hidden and zero-size boxes', () => {
    const hidden = createTargetDom()
    hidden.target.attributes['data-display'] = 'none'
    expect(hidden.dom.run(buildClickReadinessSource('#btn'))).toMatchObject({
      ready: false,
      reason: 'not_visible',
    })

    const invisible = createTargetDom()
    invisible.target.attributes['data-visibility'] = 'hidden'
    expect(invisible.dom.run(buildClickReadinessSource('#btn'))).toMatchObject({
      ready: false,
      reason: 'not_visible',
    })

    const empty = createTargetDom()
    empty.target.rect = { left: 0, top: 0, width: 0, height: 0 }
    expect(empty.dom.run(buildClickReadinessSource('#btn'))).toMatchObject({
      ready: false,
      reason: 'not_visible',
    })
  })

  test('reports out_of_view when the center is outside the viewport', () => {
    const { dom, target } = createTargetDom()
    target.rect = { left: 2000, top: 100, width: 100, height: 50 }

    expect(dom.run(buildClickReadinessSource('#btn'))).toMatchObject({
      ready: false,
      reason: 'out_of_view',
    })
  })

  test('reports obstructed with the covering element', () => {
    const { dom } = createTargetDom()
    const overlay = dom.addElement('#overlay')
    overlay.tagName = 'DIV'
    overlay.id = 'overlay'
    overlay.className = 'modal-mask'
    overlay.textContent = 'Loading'
    dom.document.hit = overlay

    expect(dom.run(buildClickReadinessSource('#btn'))).toMatchObject({
      ready: false,
      reason: 'obstructed',
      blocker: { tag: 'div', id: 'overlay', className: 'modal-mask', text: 'Loading' },
    })
  })

  test('accepts a shadow descendant as the hit target', () => {
    const { dom, target } = createTargetDom()
    const inner = new FakeElement(dom.document)
    inner.rootNode = { host: target }
    dom.document.hit = inner

    expect(dom.run(buildClickReadinessSource('#btn'))).toMatchObject({ ready: true })
  })

  test('reports detached and not_found separately', () => {
    const detached = createTargetDom()
    detached.target.isConnected = false
    expect(detached.dom.run(buildClickReadinessSource('#btn'))).toMatchObject({
      ready: false,
      reason: 'detached',
    })

    const missing = new FakeDom()
    expect(missing.run(buildClickReadinessSource('#btn'))).toMatchObject({
      ready: false,
      reason: 'not_found',
    })
  })
})

describe('click delivery probe script', () => {
  test('records trusted pointerdown/mousedown on the target and cleans up listeners', () => {
    const { dom, target } = createTargetDom()
    const installed = dom.run(buildClickDeliveryProbeSource('#btn'))
    expect(installed).toMatchObject({ found: true, installed: true, center: { x: 50, y: 25 } })

    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      dom.fire(type, target, { x: 50, y: 25 })
    }

    const report = dom.run(buildClickDeliveryReportSource()) as Record<string, unknown>
    expect(report).toMatchObject({
      found: true,
      delivered: true,
      blocked: null,
      events: ['pointerdown', 'mousedown', 'mouseup', 'click'],
    })
    // 同一事件在 window 与目标节点各触发一次，WeakSet 保证只记一条
    expect(report.events).toHaveLength(4)

    expect(dom.run(buildClickDeliveryCleanupSource())).toMatchObject({ cleaned: true })
    expect(dom.window.listenerCount()).toBe(0)
    expect(target.listenerCount()).toBe(0)
    expect(dom.run(buildClickDeliveryReportSource())).toMatchObject({ found: false })
  })

  test('ignores untrusted and off-center events', () => {
    const { dom, target } = createTargetDom()
    dom.run(buildClickDeliveryProbeSource('#btn'))

    dom.fire('pointerdown', target, { x: 50, y: 25, isTrusted: false })
    dom.fire('mousedown', target, { x: 12, y: 25 })

    expect(dom.run(buildClickDeliveryReportSource())).toMatchObject({
      delivered: false,
      events: [],
    })
  })

  test('blocks a trusted event that lands on another element', () => {
    const { dom } = createTargetDom()
    const overlay = dom.addElement('#overlay')
    overlay.id = 'overlay'
    overlay.className = 'mask'
    overlay.textContent = 'Loading'
    dom.run(buildClickDeliveryProbeSource('#btn'))

    const event = dom.fire('pointerdown', overlay, {
      x: 50,
      y: 25,
      path: [overlay, dom.document, dom.window],
    })

    expect(event.defaultPrevented).toBe(true)
    expect(event.immediateStopped).toBe(true)
    expect(dom.run(buildClickDeliveryReportSource())).toMatchObject({
      delivered: false,
      blocked: { tag: 'div', id: 'overlay', className: 'mask', text: 'Loading' },
      blockedEvent: 'pointerdown',
      events: ['pointerdown'],
    })
  })

  test('treats a closed-shadow descendant as reaching the target via compose fallback', () => {
    const { dom, target } = createTargetDom()
    const inner = new FakeElement(dom.document)
    inner.rootNode = { host: target }
    dom.run(buildClickDeliveryProbeSource('#btn'))

    // 路径对外不可见（closed shadow），只能靠 getRootNode().host 回溯到目标
    dom.fire('pointerdown', inner, { x: 50, y: 25, path: [inner] })

    expect(dom.run(buildClickDeliveryReportSource())).toMatchObject({
      delivered: true,
      events: ['pointerdown'],
    })
  })
})

type DispatchMode = 'deliver' | 'block' | 'none' | 'untrusted' | 'cdp-error-after-delivery'

interface ClickHarnessOptions {
  mode?: DispatchMode
  timeoutMs?: number
  unstable?: boolean
  disabled?: boolean
  hidden?: boolean
  obstructed?: boolean
  newTabId?: number
  navigateDuringReadiness?: boolean
}

function createClickHarness(options: ClickHarnessOptions = {}) {
  const state: ExtensionState = createExtensionState(1)
  const dom = new FakeDom()
  const target = dom.addElement('#btn')
  const overlay = dom.addElement('#overlay')
  overlay.id = 'overlay'
  overlay.textContent = 'Loading'
  dom.document.hit = target
  if (options.unstable) target.driftWidth = true
  if (options.disabled) target.disabled = true
  if (options.hidden) target.attributes['data-display'] = 'none'
  if (options.obstructed) dom.document.hit = overlay

  const tab = { id: 1, url: 'https://example.test/source' }
  const debuggerCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const evaluateCalls: string[] = []
  const mode = options.mode ?? 'deliver'

  const sendDebuggerCommand = async (
    _tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => {
    debuggerCalls.push({ method, params })
    if (method !== 'Input.dispatchMouseEvent') return undefined
    const type = String(params?.type || '')
    if (type !== 'mousePressed' && type !== 'mouseReleased') return undefined
    if (mode === 'none') return undefined

    const x = Number(params?.x)
    const y = Number(params?.y)
    const eventTarget = mode === 'block' ? overlay : target
    const path = mode === 'block' ? [overlay, dom.document, dom.window] : undefined
    const types = type === 'mousePressed' ? ['pointerdown', 'mousedown'] : ['mouseup', 'click']
    for (const eventType of types) {
      dom.fire(eventType, eventTarget, {
        x,
        y,
        isTrusted: mode !== 'untrusted',
        ...(path ? { path } : {}),
      })
    }
    if (mode === 'cdp-error-after-delivery' && type === 'mousePressed') {
      const error = new Error('input acknowledgement lost') as Error & { code: string }
      error.code = 'CDP_DEADLINE_EXCEEDED'
      throw error
    }
    if (type === 'mouseReleased' && typeof options.newTabId === 'number') {
      recordCreatedTab(state, { id: options.newTabId, openerTabId: 1 })
    }
    return undefined
  }

  const pageInput = createPointerCommands(
    {
      state,
      getTargetTab: async () => tab,
      resolveElementSelectorForTab: async () => ({ tab, resolvedSelector: '#btn' }),
      resolveFrameTarget: async () => {
        throw new Error('unused in click delivery tests')
      },
      evaluateInTabContext: async (_tabId: number, expression: string) => {
        evaluateCalls.push(expression)
        if (options.navigateDuringReadiness && expression.includes("reason: 'not_visible'")) {
          const error = new Error('execution context destroyed by navigation') as Error & {
            code: string
          }
          error.code = 'EVAL_CONTEXT_DESTROYED'
          throw error
        }
        return {
          tab,
          response: { result: undefined },
          value: dom.run(expression),
        }
      },
      sendDebuggerCommand,
      sleep: async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)),
    } as never,
    {
      detectNavigationAfterClick: async () => false,
      waitForPageSettled: async () => ({ settled: true }),
    } as never,
  )

  return {
    dom,
    target,
    pageInput,
    debuggerCalls,
    evaluateCalls,
    click: async (
      verifyDelivery: boolean,
      followNewTab = false,
      timeoutMs = options.timeoutMs ?? 100,
    ) =>
      await pageInput.clickSelector(
        1,
        '#btn',
        null,
        timeoutMs,
        undefined,
        followNewTab,
        verifyDelivery,
      ),
  }
}

describe('clickSelector --verify-delivery', () => {
  test('delivers trusted input to a ready target and reports delivery evidence', async () => {
    const harness = createClickHarness()

    const result = (await harness.click(true)) as Record<string, unknown>

    expect(result).toMatchObject({
      found: true,
      selector: '#btn',
      delivery: {
        status: 'delivered',
        trusted: true,
        events: ['pointerdown', 'mousedown', 'mouseup', 'click'],
      },
    })
    expect(result).not.toHaveProperty('domFallback')
    expect(result).not.toHaveProperty('clicked')
    // 验证路径绝不回退 DOM click
    expect(harness.evaluateCalls.every((source) => !source.includes('node.click()'))).toBe(true)
    // 探针与观察器都必须清理干净
    expect(harness.dom.window.listenerCount()).toBe(0)
    expect(harness.target.listenerCount()).toBe(0)
  })

  test('emits no mouse input when the target is disabled', async () => {
    const harness = createClickHarness({ disabled: true })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CLICK_NOT_READY',
      details: { delivery: { status: 'not_ready', reason: 'disabled', events: [] } },
    })
    expect(harness.debuggerCalls).toEqual([])
  })

  test('emits no mouse input when the target is not visible', async () => {
    const harness = createClickHarness({ hidden: true })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CLICK_NOT_READY',
      details: { delivery: { reason: 'not_visible' } },
    })
    expect(harness.debuggerCalls).toEqual([])
  })

  test('reports CLICK_NOT_READY with page_changed when the page navigates while waiting', async () => {
    const harness = createClickHarness({ navigateDuringReadiness: true })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CLICK_NOT_READY',
      details: { delivery: { reason: 'page_changed', events: [] } },
    })
    expect(harness.debuggerCalls).toEqual([])
  })

  test('emits no mouse input while geometry keeps changing', async () => {
    const harness = createClickHarness({ unstable: true, timeoutMs: 80 })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CLICK_NOT_READY',
      details: { delivery: { reason: 'unstable' } },
    })
    expect(harness.debuggerCalls).toEqual([])
  })

  test('emits no mouse input when another element covers the target', async () => {
    const harness = createClickHarness({ obstructed: true })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CLICK_NOT_READY',
      details: {
        delivery: {
          reason: 'obstructed',
          blocker: { tag: 'div', id: 'overlay', text: 'Loading' },
        },
      },
    })
    expect(harness.debuggerCalls).toEqual([])
  })

  test('reports CLICK_NOT_DELIVERED when the probe hits another element, without DOM replay', async () => {
    const harness = createClickHarness({ mode: 'block' })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CLICK_NOT_DELIVERED',
      details: {
        delivery: {
          status: 'not_delivered',
          reason: 'blocked',
          blocker: { tag: 'div', id: 'overlay', text: 'Loading' },
        },
      },
    })
    expect(harness.evaluateCalls.every((source) => !source.includes('node.click()'))).toBe(true)
    expect(harness.target.clicked).toBe(0)
  })

  test('reports CLICK_DELIVERY_UNKNOWN when input produced no evidence, without replay', async () => {
    const harness = createClickHarness({ mode: 'none' })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CLICK_DELIVERY_UNKNOWN',
      details: { delivery: { status: 'unknown', reason: 'no_evidence', events: [] } },
    })
    const mouseCalls = harness.debuggerCalls.filter(
      (call) => call.method === 'Input.dispatchMouseEvent',
    )
    // 只按键一次：不盲目重放
    expect(mouseCalls.map((call) => call.params?.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ])
    expect(harness.evaluateCalls.every((source) => !source.includes('node.click()'))).toBe(true)
  })

  test('ignores untrusted synthetic events as delivery evidence', async () => {
    const harness = createClickHarness({ mode: 'untrusted' })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CLICK_DELIVERY_UNKNOWN',
      details: { delivery: { status: 'unknown', events: [] } },
    })
  })

  test('keeps the original CDP error but attaches delivered evidence', async () => {
    const harness = createClickHarness({ mode: 'cdp-error-after-delivery' })

    await expect(harness.click(true)).rejects.toMatchObject({
      code: 'CDP_DEADLINE_EXCEEDED',
      message: 'input acknowledgement lost',
      details: { delivery: { status: 'delivered', trusted: true } },
    })
  })

  test('keeps new-tab reporting compatible with followNewTab', async () => {
    const harness = createClickHarness({ newTabId: 7 })

    const result = (await harness.click(true, true)) as Record<string, unknown>

    expect(result).toMatchObject({
      newTabId: 7,
      newTabHandle: 't7',
      delivery: { status: 'delivered', trusted: true },
    })
  })

  test('leaves the default click path unchanged, including DOM fallback', async () => {
    const harness = createClickHarness()

    const result = (await harness.click(false)) as Record<string, unknown>
    expect(result).toEqual({ found: true, selector: '#btn' })
    expect(
      harness.evaluateCalls.some((source) => source.includes('autobrowser.click.observation')),
    ).toBe(true)
    expect(harness.evaluateCalls.some((source) => source.includes('click.delivery'))).toBe(false)

    const fallbackHarness = createClickHarness()
    fallbackHarness.target.rect = { left: 0, top: 0, width: 0, height: 0 }
    const fallback = (await fallbackHarness.click(false)) as Record<string, unknown>
    // 旧行为：坐标拿不到时直接 node.click()，结果不带 domFallback（只有 CDP 路径才会标）
    expect(fallback).toEqual({ found: true, selector: '#btn' })
    expect(fallbackHarness.target.clicked).toBe(1)
  })
})

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    async json() {
      return payload
    },
    async text() {
      return `${JSON.stringify(payload)}\n`
    },
  }
}

describe('click --verify-delivery CLI and protocol', () => {
  test('parseClickArgs accepts verify-delivery alone and with follow-new-tab', () => {
    expect(parseClickArgs(['#submit', '--verify-delivery'])).toEqual({
      selector: '#submit',
      followNewTab: false,
      verifyDelivery: true,
    })
    expect(parseClickArgs(['#new-tab', '--follow-new-tab', '--verify-delivery'])).toEqual({
      selector: '#new-tab',
      followNewTab: true,
      verifyDelivery: true,
    })
    expect(parseClickArgs(['--verify-delivery', '#submit'])).toMatchObject({
      verifyDelivery: true,
    })
  })

  test('parseClickArgs rejects duplicate verify-delivery flags', () => {
    expect(() => parseClickArgs(['#submit', '--verify-delivery', '--verify-delivery'])).toThrow(
      'duplicate click option: --verify-delivery',
    )
  })

  test('parseClickArgs accepts --timeout-ms alone and combined with other flags', () => {
    expect(parseClickArgs(['#submit', '--timeout-ms', '2500'])).toEqual({
      selector: '#submit',
      followNewTab: false,
      verifyDelivery: false,
      timeoutMs: 2500,
    })
    expect(
      parseClickArgs([
        '#new-tab',
        '--follow-new-tab',
        '--verify-delivery',
        '--timeout-ms',
        '1800000',
      ]),
    ).toEqual({
      selector: '#new-tab',
      followNewTab: true,
      verifyDelivery: true,
      timeoutMs: 1800000,
    })
  })

  test('parseClickArgs rejects missing, duplicate and out-of-range --timeout-ms', () => {
    expect(() => parseClickArgs(['#submit', '--timeout-ms'])).toThrow('missing timeout ms value')
    expect(() =>
      parseClickArgs(['#submit', '--timeout-ms', '1000', '--timeout-ms', '2000']),
    ).toThrow('duplicate click option: --timeout-ms')
    expect(() => parseClickArgs(['#submit', '--timeout-ms', '0'])).toThrow(
      'invalid timeout ms "0": expected >= 1',
    )
    expect(() => parseClickArgs(['#submit', '--timeout-ms', '-5'])).toThrow(
      'invalid timeout ms "-5": expected >= 1',
    )
    expect(() => parseClickArgs(['#submit', '--timeout-ms', '1.5'])).toThrow(
      'invalid timeout ms "1.5": expected an integer',
    )
    expect(() => parseClickArgs(['#submit', '--timeout-ms', '1800001'])).toThrow(
      'invalid timeout ms "1800001": expected <= 1800000',
    )
    expect(() => parseClickArgs(['#submit', '--timeout-ms', 'abc'])).toThrow(
      'invalid timeout ms "abc": expected a finite number',
    )
  })

  test('maps invalid --timeout-ms to CLI_INVALID_ARGUMENT before dispatch', async () => {
    for (const argv of [
      ['click', '#submit', '--timeout-ms', '0'],
      ['click', '#submit', '--timeout-ms'],
    ]) {
      const result = await runCli(argv)
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(cliErrorPayload(result.stdout).error.code).toBe('CLI_INVALID_ARGUMENT')
    }
  })

  test('forwards timeoutMs together with followNewTab and verifyDelivery', async () => {
    const commands: Array<{ command: string; args: Record<string, unknown> }> = []
    await runCli(
      ['click', '#new-tab', '--follow-new-tab', '--verify-delivery', '--timeout-ms', '2500'],
      { ok: true, result: { found: true } },
      {
        fetchImpl: async (_url, init) => {
          const body = init.body ? JSON.parse(String(init.body)) : {}
          commands.push({ command: String(body.command), args: body.args ?? {} })
          return jsonResponse({ ok: true, result: { found: true } })
        },
      },
    )

    expect(commands[0]).toEqual({
      command: 'click',
      args: {
        selector: '#new-tab',
        followNewTab: true,
        verifyDelivery: true,
        timeoutMs: 2500,
      },
    })
  })

  test('forwards verifyDelivery to the relay command', async () => {
    const result = await runCli(
      ['click', '#submit', '--verify-delivery'],
      { ok: true, result: { found: true, delivery: { status: 'delivered' } } },
      {
        fetchImpl: async () =>
          jsonResponse({
            ok: true,
            result: { found: true, delivery: { status: 'delivered' } },
          }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0]?.body).toEqual({
      command: 'click',
      args: { selector: '#submit', verifyDelivery: true },
    })
  })

  test('forwards both followNewTab and verifyDelivery', async () => {
    const commands: Array<{ command: string; args: Record<string, unknown> }> = []
    await runCli(
      ['click', '#new-tab', '--follow-new-tab', '--verify-delivery'],
      { ok: true, result: { found: true } },
      {
        fetchImpl: async (_url, init) => {
          const body = init.body ? JSON.parse(String(init.body)) : {}
          commands.push({ command: String(body.command), args: body.args ?? {} })
          return jsonResponse({ ok: true, result: { found: true } })
        },
      },
    )

    expect(commands[0]).toEqual({
      command: 'click',
      args: { selector: '#new-tab', followNewTab: true, verifyDelivery: true },
    })
  })

  test('validates verifyDelivery on click and inside batch steps', () => {
    expect(() =>
      validateCommandArgs('click', { selector: '#x', verifyDelivery: true }),
    ).not.toThrow()
    expect(() =>
      validateCommandArgs('click', { selector: '#x', verifyDelivery: false }),
    ).not.toThrow()
    expect(() => validateCommandArgs('click', { selector: '#x', verifyDelivery: 'yes' })).toThrow(
      /verifyDelivery must be a boolean/,
    )
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'click', args: { selector: '#x', verifyDelivery: true } }],
      }),
    ).not.toThrow()
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'click', args: { selector: '#x', verifyDelivery: 'yes' } }],
      }),
    ).toThrow(/verifyDelivery must be a boolean/)
  })

  test('MCP click exposes verify_delivery/timeout_ms and maps them to protocol fields', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = []
    const server = new AutobrowserMcpServer({
      requestCommand: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args })
        return { ok: true, result: { delivered: true } } as CommandResponse
      },
    })

    const click = new Map(server.listTools().map((tool) => [tool.name, tool])).get('click')!
    const properties = click.inputSchema.properties as Record<string, unknown>
    expect(properties.verify_delivery).toBeDefined()
    expect(properties.timeout_ms).toBeDefined()

    await server.callTool('click', {
      selector: '#submit',
      verify_delivery: true,
      timeout_ms: 2500,
    })
    expect(calls).toEqual([
      {
        command: 'click',
        args: { selector: '#submit', verifyDelivery: true, timeoutMs: 2500 },
      },
    ])

    await server.callTool('click', { selector: '#plain', timeout_ms: 1200 })
    expect(calls.at(-1)).toEqual({
      command: 'click',
      args: { selector: '#plain', timeoutMs: 1200 },
    })
  })

  test('CLI surfaces CLICK_NOT_READY suggestedAction from the relay error', async () => {
    const result = await runCli(
      ['click', '#submit', '--verify-delivery'],
      {
        ok: false,
        error: {
          code: 'CLICK_NOT_READY',
          message: 'click target is not ready: #submit',
          details: { delivery: { status: 'not_ready', reason: 'obstructed' } },
          suggestedAction: 'blocker is the element covering the target center',
        },
      },
      {
        fetchImpl: async () =>
          jsonResponse({
            ok: false,
            error: {
              code: 'CLICK_NOT_READY',
              message: 'click target is not ready: #submit',
              details: { delivery: { status: 'not_ready', reason: 'obstructed' } },
              suggestedAction: 'blocker is the element covering the target center',
            },
          }),
      },
    )

    expect(result.exitCode).toBe(1)
    expect(cliErrorPayload(result.stdout).error).toMatchObject({
      code: 'CLICK_NOT_READY',
      suggestedAction: 'blocker is the element covering the target center',
    })
  })
})
