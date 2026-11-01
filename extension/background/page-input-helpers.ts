import type { ErrorWithCode } from './types.js'

// 元素找不到时统一抛带 STALE_REFERENCE code 和 suggestedAction 的错误，
// 让调用方（AI Agent）能区分"选择器失效"和其它失败，并知道下一步该重新 snapshot

/**
 * 构造带 code 与 suggestedAction 的“元素不存在”错误，
 * 直接提示 agent 重新 snapshot 取新引用，而不是让它反复重试旧选择器。
 */
export function createElementNotFoundError(selector: string): Error {
  return Object.assign(new Error(`element not found: ${selector}`), {
    code: `STALE_REFERENCE`,
    suggestedAction: `The target element was not found. If this was from a previous snapshot reference like @eX, the page may have updated. Ensure you run 'snapshot' to get fresh element references.`,
  })
}

const evalResultEncoder = new TextEncoder()

// 结果大小按 relay 实际发送的 JSON 文本（UTF-8）计算；undefined 视为 0 字节。
// 不可序列化的值（循环引用等）本就无法 relay，返回 null 让后续序列化报告原有错误
function measureEvalResultBytes(value: unknown): number | null {
  if (value === undefined) return 0
  try {
    return evalResultEncoder.encode(JSON.stringify(value) ?? '').byteLength
  } catch {
    return null
  }
}

// 只在显式传入 --max-result-bytes 时生效，且只报错不截断，保持 eval 返回原样

/**
 * eval 结果超过字节上限时抛错，防止大对象把响应通道撑爆。
 */
export function assertEvalResultWithinLimit(value: unknown, maxResultBytes?: number): void {
  if (maxResultBytes === undefined) return
  const bytes = measureEvalResultBytes(value)
  if (bytes === null || bytes <= maxResultBytes) return

  const error = new Error(
    `eval result is ${bytes} bytes, exceeding the ${maxResultBytes}-byte limit`,
  ) as ErrorWithCode
  error.code = 'EVAL_RESULT_TOO_LARGE'
  error.details = { bytes, maxResultBytes }
  error.suggestedAction =
    'Reduce the returned value (return only the fields you need, aggregate in the page, or paginate the data) or raise --max-result-bytes. Results above 256KiB are sent through the shared response upload deadline, so oversized payloads risk a transfer timeout.'
  throw error
}

// 序列化进页面执行的 fill 核心，按元素类型分派：
// - SELECT：按 option 文本（trim 后）或 option.value 匹配；未命中时列出前 10 个
//   可选项文本，让 AI 能根据真实选项自我纠正；
// - checkbox/radio：只接受 true/false（大小写不敏感），其它值直接报错；
// - contenteditable：按纯文本写入；其余元素仅当拥有 value 属性时赋值。
// 返回 { found, ... }；found:false + reason 由调用方转成带 selector 的 throw。
// 用 tagName/type 而非 instanceof，避免跨 iframe realm 的实例判断失效。

/**
 * 按元素类型选择写入方式（select / checkbox / radio / contenteditable / 普通输入），
 * 返回是否真正写入以及失败原因。
 */
export function applyFillValue(
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

  if (node.isContentEditable && tagName !== 'INPUT' && tagName !== 'TEXTAREA') {
    node.focus()
    node.textContent = value
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
    return { found: true }
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

export const FILL_VALUE_HELPER_SOURCE = `const applyFillValue = ${applyFillValue.toString()};`

const SPECIAL_KEY_DEFINITIONS: Record<string, { key?: string; code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  NumpadEnter: { code: 'NumpadEnter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Insert: { code: 'Insert', keyCode: 45 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
  CapsLock: { code: 'CapsLock', keyCode: 20 },
  NumLock: { code: 'NumLock', keyCode: 144 },
  ScrollLock: { code: 'ScrollLock', keyCode: 145 },
  Pause: { code: 'Pause', keyCode: 19 },
  PrintScreen: { code: 'PrintScreen', keyCode: 44 },
  ContextMenu: { code: 'ContextMenu', keyCode: 93 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  ' ': { code: 'Space', keyCode: 32 },
  ';': { code: 'Semicolon', keyCode: 186 },
  '=': { code: 'Equal', keyCode: 187 },
  ',': { code: 'Comma', keyCode: 188 },
  '-': { code: 'Minus', keyCode: 189 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ']': { code: 'BracketRight', keyCode: 221 },
  "'": { code: 'Quote', keyCode: 222 },
}

/**
 * 把按键名解析成 CDP 需要的 key/code/keyCode：单字符走 KeyX 规则，其余查特殊键表。
 */
export function getKeyboardKeyDescriptor(keyName: string) {
  const special = SPECIAL_KEY_DEFINITIONS[keyName]
  if (special) return { key: special.key || keyName, ...special }

  if (/^[a-z]$/i.test(keyName)) {
    const upper = keyName.toUpperCase()
    return { key: keyName, code: `Key${upper}`, keyCode: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(keyName)) {
    return { key: keyName, code: `Digit${keyName}`, keyCode: keyName.charCodeAt(0) }
  }
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(keyName)
  if (functionKey) {
    return { key: keyName, code: keyName, keyCode: 111 + Number(functionKey[1]) }
  }
  return { key: keyName, code: keyName, keyCode: 0 }
}

/**
 * 解析 `Control+Shift+K` 这类组合键，输出基础键名与修饰位掩码。
 */
export function parseKeyboardKey(key: string): { key: string; modifiers: number } {
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
