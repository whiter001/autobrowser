import { resolveAgentSelector } from './agent-selectors.js'

export const AGENT_FRAME_REF_ATTRIBUTE = 'data-autobrowser-frame'
export const AGENT_FRAME_REF_PREFIX = '@f'

const AGENT_TAB_HANDLE_PATTERN = /^t(\d+)$/i
const AGENT_FRAME_REF_PATTERN = /^@f(\d+)(?:#p(\d+))?$/i

interface AgentFrameRefInfo {
  ref: string
  pageEpoch: number | null
}

/**
 * 把 Chrome tabId 格式化为 agent 可引用的句柄（t<tabId>）。
 * ID 非法时直接抛错，避免上层把 t0/t-1 当成合法目标继续下发。
 */
export function formatAgentTabHandle(index: number): string {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error(`invalid agent tab handle index: ${index}`)
  }

  return `t${index}`
}

/**
 * 识别字符串里的 tab 句柄并归一化为小写 tN，非句柄返回 null。
 * 宽容大小写是因为 agent 生成的引用大小写不稳定，但内部只认一种写法。
 */
export function parseAgentTabHandle(value: string | null | undefined): string | null {
  const match = AGENT_TAB_HANDLE_PATTERN.exec(String(value || '').trim())
  if (!match) {
    return null
  }

  return `t${match[1]}`
}

/**
 * 判断给定值是否是 tab 句柄，供参数校验做快速前置检查。
 */
export function isAgentTabHandle(value: string | null | undefined): boolean {
  return parseAgentTabHandle(value) !== null
}

/**
 * 生成 frame 引用 @fN；传入 pageEpoch 时附加 #pN 后缀，用于后续的过期检测。
 * 不传 epoch 表示这个引用不做代次校验，兼容只关心 frame 序号的调用方。
 */
export function formatAgentFrameRef(index: number, pageEpoch?: number | null): string {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error(`invalid agent frame ref index: ${index}`)
  }

  const baseRef = `${AGENT_FRAME_REF_PREFIX}${index}`
  if (pageEpoch === undefined || pageEpoch === null) {
    return baseRef
  }

  if (!Number.isInteger(pageEpoch) || pageEpoch <= 0) {
    throw new Error(`invalid agent frame page epoch: ${pageEpoch}`)
  }

  return `${baseRef}#p${pageEpoch}`
}

/**
 * 解析 frame 引用，返回去掉 @ 前缀的 fN 与可选代次。
 * 内部统一用 fN 是因为选择器侧按属性值匹配，不需要 @ 前缀。
 */
export function parseAgentFrameRefInfo(value: string | null | undefined): AgentFrameRefInfo | null {
  const match = AGENT_FRAME_REF_PATTERN.exec(String(value || '').trim())
  if (!match) {
    return null
  }

  return {
    ref: `f${match[1]}`,
    pageEpoch: match[2] ? Number(match[2]) : null,
  }
}

/**
 * 只取 frame 引用的主体部分（fN），忽略代次后缀。
 */
export function parseAgentFrameRef(value: string | null | undefined): string | null {
  return parseAgentFrameRefInfo(value)?.ref || null
}

/**
 * 判断给定值是否是 frame 引用。
 */
export function isAgentFrameRef(value: string | null | undefined): boolean {
  return parseAgentFrameRef(value) !== null
}

/**
 * 取出引用里携带的页面代次；未携带时返回 null，表示该引用不参与代次校验。
 */
export function getAgentFrameRefPageEpoch(value: string | null | undefined): number | null {
  return parseAgentFrameRefInfo(value)?.pageEpoch ?? null
}

/**
 * 判断引用是否已过期：只有引用显式带代次且与当前代次不符才算过期。
 * 未带代次的旧引用一律视为有效，避免旧客户端因为缺少后缀被误判为过期。
 */
export function isStaleAgentFrameRef(
  value: string | null | undefined,
  currentPageEpoch: number,
): boolean {
  const pageEpoch = getAgentFrameRefPageEpoch(value)
  if (pageEpoch === null) {
    return false
  }

  return pageEpoch !== currentPageEpoch
}

/**
 * 把 frame 引用转换成 data-autobrowser-frame 属性选择器；
 * 非 frame 引用回落到元素选择器解析，让调用方可以用同一入口处理 @eN 与 @fN。
 */
export function resolveAgentFrameSelector(value: string | null | undefined): string {
  const frameRef = parseAgentFrameRefInfo(value)
  if (!frameRef) {
    return resolveAgentSelector(value)
  }

  return `[${AGENT_FRAME_REF_ATTRIBUTE}="${frameRef.ref}"]`
}
