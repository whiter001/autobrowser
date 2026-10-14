export interface DeepDomNodeLike {
  id?: string | null
  shadowRoot?: DeepDomRootLike | null
  matches?: (selector: string) => boolean
}

export interface DeepDomRootLike {
  activeElement?: DeepDomNodeLike | null
  querySelectorAll: (selector: string) => ArrayLike<DeepDomNodeLike> | Iterable<DeepDomNodeLike>
}

function* toArray<T>(value: ArrayLike<T> | Iterable<T> | null | undefined): Iterable<T> {
  if (!value) return
  if (Symbol.iterator in value) {
    yield* value as Iterable<T>
  } else {
    const list = value as ArrayLike<T>
    for (let index = 0; index < list.length; index += 1) yield list[index]!
  }
}

function normalizeMaxDepth(maxDepth: number | null | undefined): number {
  if (typeof maxDepth !== 'number' || !Number.isFinite(maxDepth)) {
    return 25
  }

  return Math.max(0, Math.floor(maxDepth))
}

function normalizeMaxNodes(maxNodes: number | null | undefined): number {
  if (typeof maxNodes !== 'number' || !Number.isFinite(maxNodes)) {
    return 50_000
  }

  return Math.max(0, Math.floor(maxNodes))
}

/**
 * 递归遍历 DOM 和所有嵌套的 Shadow DOM，收集所有符合条件的元素。
 * @param root 遍历的根节点
 * @param maxDepth 最大递归深度，默认 25
 * @param maxNodes 最大收集节点数，默认 50,000
 */
export function deepCollectElements(
  root: DeepDomRootLike | null | undefined,
  maxDepth: number = 25,
  maxNodes: number = 50_000,
): DeepDomNodeLike[] {
  const results: DeepDomNodeLike[] = []
  const seen = new Set<DeepDomNodeLike>()
  const depthLimit = normalizeMaxDepth(maxDepth)
  const nodeLimit = normalizeMaxNodes(maxNodes)

  const visitRoot = (currentRoot: DeepDomRootLike | null | undefined, depth: number) => {
    if (!currentRoot || typeof currentRoot.querySelectorAll !== 'function') {
      return
    }

    const nodes = toArray(currentRoot.querySelectorAll('*'))

    for (const node of nodes) {
      if (results.length >= nodeLimit) {
        return
      }

      if (!node || seen.has(node)) {
        continue
      }

      seen.add(node)
      results.push(node)

      const shadowRoot = node.shadowRoot
      if (shadowRoot && depth < depthLimit) {
        visitRoot(shadowRoot, depth + 1)
      }
    }
  }

  visitRoot(root, 0)
  return results
}

/**
 * 跨越 Shadow DOM 边界执行 querySelectorAll。
 * 它会遍历所有嵌套的 Shadow Root 并应用选择器。
 * @param root 遍历的根节点
 * @param selector CSS 选择器
 * @param maxDepth 最大递归深度
 * @param maxNodes 最大结果集大小
 */
export function deepQuerySelectorAll(
  root: DeepDomRootLike | null | undefined,
  selector: string,
  maxDepth: number = 25,
  maxNodes: number = 50_000,
): DeepDomNodeLike[] {
  const results: DeepDomNodeLike[] = []
  const seen = new Set<DeepDomNodeLike>()
  const depthLimit = normalizeMaxDepth(maxDepth)
  const nodeLimit = normalizeMaxNodes(maxNodes)

  const visitRoot = (currentRoot: DeepDomRootLike | null | undefined, depth: number) => {
    if (!currentRoot || typeof currentRoot.querySelectorAll !== 'function') {
      return
    }

    // :scope 必须相对查询根求值，不能用 node.matches 改成相对候选节点。
    const scoped = selector.includes(':scope')
      ? new Set(toArray(currentRoot.querySelectorAll(selector)))
      : null
    for (const node of toArray(currentRoot.querySelectorAll('*'))) {
      if (results.length >= nodeLimit) {
        return
      }

      if (!node || seen.has(node)) {
        continue
      }

      seen.add(node)
      if (
        scoped ? scoped.has(node) : typeof node.matches === 'function' && node.matches(selector)
      ) {
        results.push(node)
        if (results.length >= nodeLimit) return
      }

      const shadowRoot = node.shadowRoot
      if (shadowRoot && depth < depthLimit) {
        visitRoot(shadowRoot, depth + 1)
      }
    }
  }

  visitRoot(root, 0)
  return results
}

export function deepQuerySelector(
  root: DeepDomRootLike | null | undefined,
  selector: string,
  maxDepth: number = 25,
): DeepDomNodeLike | null {
  return deepQuerySelectorAll(root, selector, maxDepth, 1)[0] || null
}

export function deepGetElementById(
  root: DeepDomRootLike | null | undefined,
  id: string | null | undefined,
  maxDepth: number = 25,
): DeepDomNodeLike | null {
  const normalizedId = String(id || '').trim()
  if (!normalizedId) {
    return null
  }

  const seen = new Set<DeepDomNodeLike>()
  const depthLimit = normalizeMaxDepth(maxDepth)
  const visit = (
    current: DeepDomRootLike | null | undefined,
    depth: number,
  ): DeepDomNodeLike | null => {
    if (!current) return null
    for (const node of toArray(current.querySelectorAll('*'))) {
      if (seen.has(node)) continue
      seen.add(node)
      if (String(node.id || '') === normalizedId) return node
      if (node.shadowRoot && depth < depthLimit) {
        const found = visit(node.shadowRoot, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return visit(root, 0)
}

export function isDeepActiveElement(
  root: DeepDomRootLike | null | undefined,
  node: DeepDomNodeLike | null | undefined,
  maxDepth: number = 25,
): boolean {
  if (!root || !node) {
    return false
  }

  const depthLimit = normalizeMaxDepth(maxDepth)
  let currentRoot: DeepDomRootLike | null | undefined = root

  for (let depth = 0; currentRoot && depth <= depthLimit; depth += 1) {
    const activeElement: DeepDomNodeLike | null = currentRoot.activeElement || null
    if (!activeElement) {
      return false
    }

    if (activeElement === node) {
      return true
    }

    currentRoot = activeElement.shadowRoot || null
  }

  return false
}

export function buildDeepDomTraversalHelpersSource(): string {
  return [
    toArray.toString(),
    normalizeMaxDepth.toString(),
    normalizeMaxNodes.toString(),
    deepCollectElements.toString(),
    deepQuerySelectorAll.toString(),
    deepQuerySelector.toString(),
    deepGetElementById.toString(),
    isDeepActiveElement.toString(),
  ].join('\n\n')
}
