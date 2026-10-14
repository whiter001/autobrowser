export function collapseWhitespace(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function splitWhitespaceTokens(value: unknown): string[] {
  const normalized = collapseWhitespace(value)
  return normalized ? normalized.split(/\s+/) : []
}

export function parsePageContextElementRefIndex(value: unknown): number | null {
  const match = /^e(\d+)$/.exec(collapseWhitespace(value))
  return match ? Number(match[1]) : null
}

// 状态挂在 document 而不是存活节点上，删除最高编号、清空页面均不能回收编号。
export function getPageObservationState(document: object, epoch: number) {
  const owner = document as {
    __autobrowserObservation?: {
      epoch: number
      id: string
      highWater: Record<string, number>
    }
  }
  if (!owner.__autobrowserObservation || owner.__autobrowserObservation.epoch !== epoch) {
    // getRandomValues 在 HTTP 页面也可用；randomUUID 仅安全上下文提供。
    const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
      part.toString(16),
    ).join('-')
    owner.__autobrowserObservation = { epoch, id, highWater: {} }
  }
  return owner.__autobrowserObservation
}

export function createPageNameIndex(nodes: Iterable<Element>) {
  const ids = new Map<string, Element>()
  const labels = new Map<string, Element>()
  for (const node of nodes) {
    if (node.id && !ids.has(node.id)) ids.set(node.id, node)
    const target = node.tagName.toLowerCase() === 'label' ? node.getAttribute('for') : null
    if (target && !labels.has(target)) labels.set(target, node)
  }
  return { ids, labels }
}

// 先切 UTF-16 长度再编码，避免为巨型属性分配同样巨大的编码缓冲区。
export function boundPageText(value: unknown, maxBytes = 1024): string {
  const text = String(value ?? '').slice(0, maxBytes)
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) low = mid
    else high = mid - 1
  }
  const end = low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!) ? low - 1 : low
  return text.slice(0, end)
}
