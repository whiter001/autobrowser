import type { CommandExecutionContext } from './command-queue.js'
import type { FrameSelector, TabInput } from './types.js'
import type { PageInputContext } from './page-input-context.js'
import { getKeyboardKeyDescriptor, parseKeyboardKey } from './page-input-helpers.js'
import type { createElementCommands } from './page-input-element.js'

// Input.insertText 每次往返一次 CDP。逐字符输入长文本时往返数过大，会撞上 30s
// 服务端超时；insertText 本身是"整段粘贴"语义而非逐键事件，分块只减少往返、
// 不改变最终输入内容，因此按块发送
const INSERT_TEXT_CHUNK_SIZE = 50

// 键盘与文本输入命令：按键事件、文本插入和带提交语义的输入
export function createKeyboardCommands(
  pageContext: PageInputContext,
  element: ReturnType<typeof createElementCommands>,
) {
  const { getTargetTab, sendDebuggerCommand } = pageContext

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
    // --submit 对齐 Playwright type 的语义：输入完成后补一次 Enter，触发表单提交
    if (submit) {
      context?.throwIfCancelled()
      await pressKey(tabId, 'Enter', context)
    }
    return {
      found: true,
      selector,
      ...typed,
      ...(submit ? { submitted: true } : {}),
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
