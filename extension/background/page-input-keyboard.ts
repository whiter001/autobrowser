import type { CommandExecutionContext } from './command-queue.js'
import type { FrameSelector, TabInput } from './types.js'
import type { PageInputContext } from './page-input-context.js'
import { getKeyboardKeyDescriptor, parseKeyboardKey } from './page-input-helpers.js'
import type { createElementCommands } from './page-input-element.js'

// Input.insertText 每次往返一次 CDP。逐字符输入长文本时往返数过大，会撞上 30s
// 服务端超时；insertText 本身是"整段粘贴"语义而非逐键事件，分块只减少往返、
// 不改变最终输入内容，因此按块发送
const INSERT_TEXT_CHUNK_SIZE = 50

// --submit 之后观察导航的时长与轮询间隔。Enter 触发的提交多在几百毫秒内发生，
// 观察到 URL 变化就立即返回，只有确认没有导航时才等满这个窗口。
const SUBMIT_NAVIGATION_TIMEOUT_MS = 1500
const SUBMIT_NAVIGATION_POLL_MS = 120
const SUBMIT_LOCATION_EVALUATE_TIMEOUT_MS = 2000
// 导航过程中页面执行上下文会短暂不可用，连续多次取不到才认定页面已经离开
const SUBMIT_LOCATION_FAILURE_LIMIT = 3

// 键盘与文本输入命令：按键事件、文本插入和带提交语义的输入

/**
 * 创建键盘命令：press、type、inserttext 及按键组合。
 */
export function createKeyboardCommands(
  pageContext: PageInputContext,
  element: ReturnType<typeof createElementCommands>,
) {
  const { getTargetTab, sendDebuggerCommand, evaluateInTabContextBase, sleep } = pageContext

  async function dispatchKeyEvent(
    tabId: number,
    keyName: string,
    modifiers: number,
    type: 'keyDown' | 'keyUp',
    context?: CommandExecutionContext,
  ): Promise<void> {
    const descriptor = getKeyboardKeyDescriptor(keyName)
    context?.throwIfCancelled()
    // Ant Design 等组件依赖 keyCode；CDP 仅传 key/code 时该值为 0，
    // 必须同时提供虚拟键码才能与手动键盘输入保持一致。
    await sendDebuggerCommand(
      tabId,
      'Input.dispatchKeyEvent',
      {
        type,
        key: descriptor.key,
        code: descriptor.code,
        modifiers,
        windowsVirtualKeyCode: descriptor.keyCode,
        nativeVirtualKeyCode: descriptor.keyCode,
      },
      context,
    )
  }

  async function dispatchInsertText(
    tabId: TabInput,
    text: string,
    context?: CommandExecutionContext,
  ) {
    const tab = await getTargetTab(tabId)
    context?.throwIfCancelled()
    await sendDebuggerCommand(
      tab.id,
      'Input.insertText',
      {
        text: String(text || ''),
      },
      context,
    )
    return { inserted: true, text }
  }

  async function insertTextSequentially(
    tabId: TabInput,
    text: string,
    context?: CommandExecutionContext,
  ) {
    const normalizedText = String(text || '')
    // tab 只解析一次，否则每个块都会 tabs.get + debugger 各往返一次
    const tab = await getTargetTab(tabId)

    for (let offset = 0; offset < normalizedText.length; offset += INSERT_TEXT_CHUNK_SIZE) {
      context?.throwIfCancelled()
      await sendDebuggerCommand(
        tab.id,
        'Input.insertText',
        {
          text: normalizedText.slice(offset, offset + INSERT_TEXT_CHUNK_SIZE),
        },
        context,
      )
    }

    return { typed: true, text: normalizedText }
  }

  async function insertTextOnce(tabId: TabInput, text: string, context?: CommandExecutionContext) {
    return await dispatchInsertText(tabId, text, context)
  }

  async function pressKey(tabId: TabInput, key: string, context?: CommandExecutionContext) {
    const { key: keyName, modifiers } = parseKeyboardKey(key)
    const tab = await getTargetTab(tabId)

    // keyDown 成功后必须补 keyUp，否则页面逻辑上键会一直按着；
    // keyUp 失败不掩盖原始错误，只在原始无错时才抛出
    let keyUpError: unknown = null
    try {
      await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyDown', context)
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
    context?.throwIfCancelled()

    return { key, pressed: true }
  }

  async function keyDownOnly(tabId: TabInput, key: string, context?: CommandExecutionContext) {
    const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
    const tab = await getTargetTab(tabId)

    await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyDown', context)
    return { key, pressed: true, type: 'keydown' }
  }

  async function keyUpOnly(tabId: TabInput, key: string, context?: CommandExecutionContext) {
    const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
    const tab = await getTargetTab(tabId)

    await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyUp', context)
    return { key, released: true, type: 'keyup' }
  }

  /** 读取目标 frame 的当前地址；页面正在导航或上下文不可用时返回 null */
  async function readFrameLocation(
    tabId: TabInput,
    frameSelector: FrameSelector,
  ): Promise<string | null> {
    try {
      const { value } = await evaluateInTabContextBase<string>(tabId, 'location.href', {
        ...(frameSelector ? { frameSelector } : {}),
        timeoutMs: SUBMIT_LOCATION_EVALUATE_TIMEOUT_MS,
      })
      return typeof value === 'string' ? value : null
    } catch {
      return null
    }
  }

  /**
   * 观察 Enter 之后是否发生了导航。
   *
   * "按了 Enter" 和 "表单真的提交了" 是两件事：Vue 之类的组件不会因 Enter 提交，
   * 标准表单也可能存在多个提交入口。因此这里只如实报告是否观察到页面离开，
   * 判断权留给调用方。
   */
  async function detectNavigation(
    tabId: TabInput,
    frameSelector: FrameSelector,
    before: string | null,
    context?: CommandExecutionContext,
  ): Promise<boolean> {
    const deadline = Date.now() + SUBMIT_NAVIGATION_TIMEOUT_MS
    let failures = 0
    while (Date.now() < deadline) {
      await sleep(SUBMIT_NAVIGATION_POLL_MS)
      // 等待期间命令被取消时立即退出，不占用剩余预算
      context?.throwIfCancelled()
      const now = await readFrameLocation(tabId, frameSelector)
      if (now === null) {
        failures += 1
        if (failures >= SUBMIT_LOCATION_FAILURE_LIMIT) return true
        continue
      }
      failures = 0
      if (before !== null && now !== before) return true
    }
    return false
  }

  async function typeIntoSelector(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
    submit = false,
    context?: CommandExecutionContext,
  ) {
    await element.focusElement(tabId, selector, frameSelector, context)
    context?.throwIfCancelled()
    const typed = await insertTextSequentially(tabId, value, context)
    if (!submit) {
      return {
        found: true,
        selector,
        ...typed,
      }
    }
    context?.throwIfCancelled()
    const before = await readFrameLocation(tabId, frameSelector)
    await pressKey(tabId, 'Enter', context)
    const navigationDetected = await detectNavigation(tabId, frameSelector, before, context)
    return {
      found: true,
      selector,
      ...typed,
      // submitted 只表示 Enter 已经发出；navigationDetected 才是"页面确实离开了"
      submitted: true,
      navigationDetected,
      ...(navigationDetected
        ? {}
        : {
            suggestedAction:
              'Enter 已发送，但没有观察到页面导航：表单可能由脚本处理，或需要显式点击提交按钮。用 wait --text/--url 确认结果，或 click 提交按钮后重试。',
          }),
    }
  }

  return {
    insertTextOnce,
    insertTextSequentially,
    keyDownOnly,
    keyUpOnly,
    pressKey,
    typeIntoSelector,
  }
}
