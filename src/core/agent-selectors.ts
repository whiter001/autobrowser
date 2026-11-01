export const AGENT_ELEMENT_REF_ATTRIBUTE = 'data-autobrowser-ref'

const AGENT_ELEMENT_REF_PATTERN = /^@e(\d+)(?:#p(\d+))?$/i

interface AgentElementRefInfo {
  ref: string
  pageEpoch: number | null
}

/**
 * 把元素序号格式化为 @eN 引用；传入 pageEpoch 时附加 #pN 后缀用于过期检测。
 * 序号或代次非法时抛错，避免把无效引用写进响应让 agent 继续用。
 */
export function formatAgentElementRef(index: number, pageEpoch?: number | null): string {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error(`invalid agent element ref index: ${index}`)
  }

  const baseRef = `@e${index}`
  if (pageEpoch === undefined || pageEpoch === null) {
    return baseRef
  }

  if (!Number.isInteger(pageEpoch) || pageEpoch <= 0) {
    throw new Error(`invalid agent element page epoch: ${pageEpoch}`)
  }

  return `${baseRef}#p${pageEpoch}`
}

/**
 * 解析 @eN[#pM] 引用，返回内部使用的 eN 与可选代次；非引用返回 null。
 * 内部去掉 @ 前缀，是因为选择器侧按属性值匹配，前缀只服务于 agent 可读性。
 */
export function parseAgentElementRefInfo(
  selector: string | null | undefined,
): AgentElementRefInfo | null {
  const normalized = String(selector || '').trim()
  const match = AGENT_ELEMENT_REF_PATTERN.exec(normalized)
  if (!match) {
    return null
  }

  return {
    ref: `e${match[1]}`,
    pageEpoch: match[2] ? Number(match[2]) : null,
  }
}

/**
 * 只取引用主体（eN），忽略代次后缀，供不需要过期判断的调用方使用。
 */
export function parseAgentElementRef(selector: string | null | undefined): string | null {
  return parseAgentElementRefInfo(selector)?.ref || null
}

/**
 * 判断给定选择器是否是 @eN 引用（其它 CSS/文本选择器一律视为否）。
 */
export function isAgentElementRef(selector: string | null | undefined): boolean {
  return parseAgentElementRef(selector) !== null
}

/**
 * 取出引用携带的页面代次；未携带时返回 null，表示该引用不参与代次校验。
 */
export function getAgentElementRefPageEpoch(selector: string | null | undefined): number | null {
  return parseAgentElementRefInfo(selector)?.pageEpoch ?? null
}

/**
 * 判断元素引用是否过期：只有显式带代次且与当前代次不符才算过期。
 * 未带代次的引用按旧协议处理为有效，防止老客户端被误判。
 */
export function isStaleAgentElementRef(
  selector: string | null | undefined,
  currentPageEpoch: number,
): boolean {
  const pageEpoch = getAgentElementRefPageEpoch(selector)
  if (pageEpoch === null) {
    return false
  }

  return pageEpoch !== currentPageEpoch
}

/**
 * 把 @eN 引用转换成 data-autobrowser-ref 属性选择器，其它选择器原样返回（含 trim）。
 * 统一清洗空白是因为 agent 常带着换行或首尾空格粘贴引用。
 */
export function resolveAgentSelector(selector: string | null | undefined): string {
  const normalized = String(selector || '').trim()
  const refInfo = parseAgentElementRefInfo(normalized)
  if (!refInfo) {
    return normalized
  }

  return `[${AGENT_ELEMENT_REF_ATTRIBUTE}="${refInfo.ref}"]`
}
