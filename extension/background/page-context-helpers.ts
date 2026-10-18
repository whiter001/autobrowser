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

/**
 * 按 tree scope（getRootNode）分组建立名称索引。
 * 不同 shadow root 允许存在相同 id，全局索引会让先出现的 label 串到另一个 root（Save/Delete 名称污染）。
 *
 * coveredRoot 是本次遍历的根：只有当它本身就是某个 tree scope 的根时，该 scope 才算完整覆盖，
 * 此时未命中即是确定负结果，不再做任何回退查询（完整页面 snapshot/find 因此零额外查询）。
 * 子树截取只覆盖子树：id 仍可用原生 getElementById 在同 root 内解析；
 * label 改为每个 tree scope 至多一次 querySelectorAll('label[for]') 补全并缓存（含负命中），
 * 既能拿到子树外的 label，又不会为每个 id 拼 CSS 或重复扫描 root。
 * 缺少 getRootNode 的旧 stub 退化为单一桶，保持原行为。
 */
export function createPageNameIndex(nodes: Iterable<Element>, coveredRoot?: object | null) {
  type ScopeBuckets = Map<object | null, Map<string, Element>>
  const ids: ScopeBuckets = new Map()
  const labels: ScopeBuckets = new Map()
  // 子树截取场景按 scope 惰性补全的 label 索引，补全后负命中也缓存，避免重复扫描。
  const backfilled: ScopeBuckets = new Map()
  const rootOf = (node: Element): object | null =>
    typeof node.getRootNode === 'function' ? (node.getRootNode() as object) || null : null

  const put = (buckets: ScopeBuckets, root: object | null, key: string, node: Element) => {
    let bucket = buckets.get(root)
    if (!bucket) {
      bucket = new Map<string, Element>()
      buckets.set(root, bucket)
    }
    if (!bucket.has(key)) bucket.set(key, node)
  }

  for (const node of nodes) {
    const root = rootOf(node)
    if (node.id) put(ids, root, node.id, node)
    const target = node.tagName.toLowerCase() === 'label' ? node.getAttribute('for') : null
    if (target) put(labels, root, target, node)
  }

  const isCovered = (root: object | null) => root !== null && root === coveredRoot

  const lookupId = (node: Element, id: string): Element | null => {
    if (!id) return null
    const root = rootOf(node)
    const indexed = root ? ids.get(root)?.get(id) : ids.get(null)?.get(id)
    if (indexed) return indexed
    const native = (root as { getElementById?: (id: string) => Element | null } | null)
      ?.getElementById
    return native ? native.call(root, id) || null : null
  }

  const lookupLabel = (node: Element, id: string): Element | null => {
    if (!id) return null
    const root = rootOf(node)
    const indexed = root ? labels.get(root)?.get(id) : labels.get(null)?.get(id)
    if (indexed) return indexed
    if (root === null || isCovered(root)) return null
    if (!backfilled.has(root)) {
      // 整 scope 补一次 label[for]，之后所有 id 命中/负命中都走缓存。
      const bucket = new Map<string, Element>()
      const queryAll = (
        root as { querySelectorAll?: (selector: string) => Iterable<Element> | null }
      )?.querySelectorAll
      for (const label of queryAll ? queryAll.call(root, 'label[for]') || [] : []) {
        const target = label.getAttribute('for')
        if (target && !bucket.has(target)) bucket.set(target, label)
      }
      backfilled.set(root, bucket)
    }
    return backfilled.get(root)?.get(id) || null
  }

  return { lookupId, lookupLabel }
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
