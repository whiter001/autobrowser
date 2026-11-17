import { describe, expect, test } from 'bun:test'
import { createPageInputDomain } from '../extension/background/page-input.js'
import { createExtensionState } from '../extension/background/state.js'

// 受控组件（Ant Design Vue / React）模拟：
// 1) 事件回调里同步把 DOM 的 checked 回滚成模型值；
// 2) 模型更新与重渲染发生在下一帧，重渲染可能替换或移除节点。

class FakeEvent {
  type: string
  bubbles: boolean

  constructor(type: string, init?: { bubbles?: boolean }) {
    this.type = type
    this.bubbles = init?.bubbles === true
  }
}

class FakeInput {
  checked: boolean
  focusCount = 0

  constructor(
    readonly selector: string,
    checked: boolean,
    readonly onEvent: (input: FakeInput, event: FakeEvent) => void,
  ) {
    this.checked = checked
  }

  focus(): void {
    this.focusCount += 1
  }

  matches(selector: string): boolean {
    return selector === this.selector
  }

  dispatchEvent(event: FakeEvent): boolean {
    this.onEvent(this, event)
    return true
  }
}

interface ControlledOptions {
  selector?: string
  checked?: boolean
  /** 组件是否接受这次变更，返回 false 表示模型回滚 */
  acceptChange?: (requested: boolean) => boolean
  /** 自定义重渲染行为，默认把受控值写回当前节点 */
  render?: (harness: ControlledCheckbox) => void
}

class ControlledCheckbox {
  readonly selector: string
  controlled: boolean
  node: FakeInput | null
  readonly events: string[] = []
  /** 事件派发后同步读到的 checked（受控组件回滚后的旧值） */
  syncCheckedAfterDispatch: boolean | null = null
  renderCount = 0

  private readonly acceptChange: (requested: boolean) => boolean
  private readonly renderHook?: (harness: ControlledCheckbox) => void

  constructor(options: ControlledOptions = {}) {
    this.selector = options.selector ?? '.ant-checkbox-input'
    this.controlled = options.checked ?? false
    this.acceptChange = options.acceptChange ?? (() => true)
    this.renderHook = options.render
    this.node = this.createNode()
  }

  private createNode(): FakeInput {
    return new FakeInput(this.selector, this.controlled, (input, event) => {
      this.events.push(event.type)
      if (event.type !== 'change') return
      const requested = input.checked
      // 受控组件在事件回调里同步回滚 DOM 值
      input.checked = this.controlled
      this.syncCheckedAfterDispatch = input.checked
      // 模型更新与重渲染在下一帧发生
      queueMicrotask(() => {
        if (this.acceptChange(requested)) {
          this.controlled = requested
        }
        this.render()
      })
    })
  }

  render(): void {
    this.renderCount += 1
    if (this.renderHook) {
      this.renderHook(this)
      return
    }
    if (this.node) {
      this.node.checked = this.controlled
    }
  }
}

interface HarnessOptions {
  /** 页面侧的 requestAnimationFrame；默认下一帧回调，可换成永不回调来模拟后台标签页 */
  requestAnimationFrame?: (callback: (time: number) => void) => number
}

function createHarnessDomain(harness: ControlledCheckbox, options: HarnessOptions = {}) {
  const fakeDocument = {
    querySelectorAll(selector: string) {
      const node = harness.node
      if (!node) return []
      if (selector === '*') return [node]
      return node.matches(selector) ? [node] : []
    },
    activeElement: null,
  }
  const requestAnimationFrame =
    options.requestAnimationFrame ??
    ((callback: (time: number) => void) => {
      setTimeout(() => callback(Date.now()), 0)
      return 1
    })
  // 页面表达式在扩展里是拼出来的字符串，这里用 eval 在伪页面作用域里执行，
  // 注入的 document / requestAnimationFrame / Event 由参数提供。
  // oxlint-disable-next-line no-eval -- 需要复现页面里真实执行的注入脚本
  const runInPage = new Function(
    'document',
    'requestAnimationFrame',
    'Event',
    'source',
    'return eval(source)',
  )

  const pageInput = createPageInputDomain({
    state: createExtensionState(1),
    getTargetTab: async () => ({ id: 1 }) as never,
    resolveElementSelectorForTab: async (_tabId: unknown, selector: string) =>
      ({ tab: { id: 1 }, resolvedSelector: selector }) as never,
    resolveFrameTarget: async () => ({}) as never,
    getFrameExecutionContext: async () => ({}) as never,
    evaluateInTabContext: async (_tabId: unknown, source: string) => {
      const value = await runInPage(fakeDocument, requestAnimationFrame, FakeEvent, source)
      return { value } as never
    },
  } as never)

  return pageInput
}

describe('checkElement 返回下一帧的真实勾选状态', () => {
  test('受控组件同步回滚后仍返回勾选成功（不是回滚后的旧值）', async () => {
    const harness = new ControlledCheckbox({ checked: false })
    const pageInput = createHarnessDomain(harness)

    const result = await pageInput.checkElement(1, '.ant-checkbox-input', true, null)

    expect(result).toEqual({ found: true, checked: true })
    // 事件派发后同步读到的是回滚后的旧值，说明返回值来自下一帧而不是即时读取
    expect(harness.syncCheckedAfterDispatch).toBe(false)
    expect(harness.renderCount).toBe(1)
  })

  test('取消勾选同样返回下一帧的真实状态', async () => {
    const harness = new ControlledCheckbox({ checked: true })
    const pageInput = createHarnessDomain(harness)

    const result = await pageInput.checkElement(1, '.ant-checkbox-input', false, null)

    expect(result).toEqual({ found: true, checked: false })
    expect(harness.syncCheckedAfterDispatch).toBe(true)
  })

  test('重渲染替换节点后读取新节点的状态', async () => {
    let replacement: FakeInput | null = null
    const harness = new ControlledCheckbox({
      checked: false,
      render: (current) => {
        // 受控值写回新节点，旧节点停留在回滚后的旧值
        replacement = new FakeInput(current.selector, current.controlled, () => {})
        current.node = replacement
      },
    })
    const pageInput = createHarnessDomain(harness)

    const result = await pageInput.checkElement(1, '.ant-checkbox-input', true, null)

    expect(result).toEqual({ found: true, checked: true })
    expect(replacement).not.toBeNull()
    expect(harness.node).toBe(replacement)
  })

  test('节点在重渲染后被移除时返回请求值而不是伪造 found:false', async () => {
    const harness = new ControlledCheckbox({
      checked: false,
      render: (current) => {
        current.node = null
      },
    })
    const pageInput = createHarnessDomain(harness)

    const result = await pageInput.checkElement(1, '.ant-checkbox-input', true, null)

    expect(result).toEqual({ found: true, checked: true })
  })

  test('受控组件拒绝变更时返回回滚后的状态，不误报成功', async () => {
    const harness = new ControlledCheckbox({
      checked: false,
      acceptChange: () => false,
    })
    const pageInput = createHarnessDomain(harness)

    const result = await pageInput.checkElement(1, '.ant-checkbox-input', true, null)

    expect(result).toEqual({ found: true, checked: false })
  })

  test('保持 input → change 的事件顺序并在事件前聚焦', async () => {
    const harness = new ControlledCheckbox({ checked: false })
    const pageInput = createHarnessDomain(harness)

    await pageInput.checkElement(1, '.ant-checkbox-input', true, null)

    expect(harness.events).toEqual(['input', 'change'])
    expect(harness.node?.focusCount).toBe(1)
  })

  test('初始就找不到元素时仍然报 ELEMENT_NOT_FOUND', async () => {
    const harness = new ControlledCheckbox({ checked: false })
    const pageInput = createHarnessDomain(harness)
    harness.node = null

    await expect(
      pageInput.checkElement(1, '.ant-checkbox-input', true, null),
    ).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
  })

  test('后台标签页 rAF 不回调时由定时器兜底，仍返回更新后的真实状态', async () => {
    const harness = new ControlledCheckbox({ checked: false })
    let rafRegistered = 0
    const pageInput = createHarnessDomain(harness, {
      // 模拟后台标签页：rAF 注册了但永不回调，等待只能靠 setTimeout 兜底
      requestAnimationFrame: () => {
        rafRegistered += 1
        return 1
      },
    })

    const result = await pageInput.checkElement(1, '.ant-checkbox-input', true, null)

    expect(rafRegistered).toBe(1)
    expect(result).toEqual({ found: true, checked: true })
    // 事件派发后同步读到的仍是回滚旧值，说明返回值来自兜底等待后的重新读取
    expect(harness.syncCheckedAfterDispatch).toBe(false)
    expect(harness.renderCount).toBe(1)
  })
})
