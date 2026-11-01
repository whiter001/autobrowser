import { buildDeepDomTraversalHelpersSource } from './deep-dom.js'
import {
  boundPageText,
  collapseWhitespace,
  createPageNameIndex,
  getPageObservationState,
  parsePageContextElementRefIndex,
  splitWhitespaceTokens,
} from './page-context-helpers.js'

/**
 * 稳定 ref 分配（纯函数，通过 toString() 嵌入页面上下文执行，不能引用模块级闭包变量）。
 * 已有 ref 沿用；全页 refNodes 只用于提升 document/epoch 持久高水位，
 * 新节点从该高水位 +1 分配。snapshot/find 共用状态，删除最大编号或全部节点均不回收编号。
 */
export function computeStableRefIndexes<
  TNode extends {
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
  },
>(
  refNodes: TNode[],
  candidates: TNode[],
  attribute: string,
  prefix: string,
  parseIndex: (value: string | null) => number | null,
  highWater: Record<string, number> = {},
): Map<TNode, number> {
  let nextIndex = highWater[prefix] || 0
  for (const node of refNodes) {
    const parsed = parseIndex(node.getAttribute(attribute))
    if (parsed !== null) nextIndex = Math.max(nextIndex, parsed)
  }

  const indexes = new Map<TNode, number>()
  for (const node of candidates) {
    const existing = parseIndex(node.getAttribute(attribute))
    if (existing !== null) {
      nextIndex = Math.max(nextIndex, existing)
      indexes.set(node, existing)
      continue
    }
    nextIndex += 1
    node.setAttribute(attribute, prefix + nextIndex)
    indexes.set(node, nextIndex)
  }
  highWater[prefix] = nextIndex
  return indexes
}

// 同一算法用于页内构造与扩展防御；逐字段/条目计费，不反复序列化整个增长中的结果。

/**
 * 快照超过字节上限时按预算重新装箱：字符串按字段截断（text 5KB、其余 1KB），
 * 数组按剩余预算逐项保留，放不下就丢弃后续项——宁可丢尾部数据也不返回超预算响应。
 */
export function truncateSnapshotToByteLimit(
  result: Record<string, unknown>,
  maxBytes = 200_000,
): Record<string, unknown> {
  const encoder = new TextEncoder()
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length
  if (size(result) <= maxBytes) return result
  const output: Record<string, unknown> = {}
  let remaining = maxBytes - 2048
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) continue
    const bounded =
      typeof value === 'string' ? boundPageText(value, key === 'text' ? 5000 : 1024) : value
    const cost = size(bounded) + size(key) + 2
    if (cost <= remaining) {
      output[key] = bounded
      remaining -= cost
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (!Array.isArray(value)) continue
    const kept: unknown[] = []
    remaining -= size(key) + 4
    for (const item of value) {
      const cost = size(item) + 1
      if (cost > remaining) break
      kept.push(item)
      remaining -= cost
    }
    output[key] = kept
  }
  output.truncated = true
  output.totalElements =
    result.totalElements ?? (Array.isArray(result.elements) ? result.elements.length : 0)
  output.returnedElements = Array.isArray(output.elements) ? output.elements.length : 0
  output.suggestedAction =
    'Narrow snapshot with selector/roles; use changed:true to receive undisclosed elements.'
  return output
}

// command-spec 路径下这些字段是可选的，undefined 时 Math.floor 会得到 NaN，
// 导致 limit 变成 NaN 而静默返回 0 条；这里统一兜底到与 CLI 一致的默认值

/**
 * 把 feed 数量参数归一到非负整数，非法值回落到默认值。
 */
export function normalizeFeedCount(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(0, Math.floor(value))
}

export const PAGE_CONTEXT_TEXT_HELPERS_SOURCE = [
  collapseWhitespace.toString(),
  splitWhitespaceTokens.toString(),
].join('\n')

export const PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE = buildDeepDomTraversalHelpersSource()

export const PAGE_CONTEXT_FIND_HELPERS_SOURCE = [
  PAGE_CONTEXT_TEXT_HELPERS_SOURCE,
  PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE,
  parsePageContextElementRefIndex.toString(),
  computeStableRefIndexes.toString(),
  getPageObservationState.toString(),
  createPageNameIndex.toString(),
  boundPageText.toString(),
].join('\n')

export const PAGE_CONTEXT_SNAPSHOT_HELPERS_SOURCE = [
  PAGE_CONTEXT_FIND_HELPERS_SOURCE,
  truncateSnapshotToByteLimit.toString(),
].join('\n')
