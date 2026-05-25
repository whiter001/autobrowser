export interface DeepDomNodeLike {
  id?: string | null
  shadowRoot?: DeepDomRootLike | null
}

export interface DeepDomRootLike {
  activeElement?: DeepDomNodeLike | null
  querySelectorAll: (selector: string) => ArrayLike<DeepDomNodeLike> | Iterable<DeepDomNodeLike>
}

function toArray<T>(value: ArrayLike<T> | Iterable<T> | null | undefined): T[] {
  return value ? Array.from(value as ArrayLike<T> | Iterable<T>) : []
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

    for (const node of toArray(currentRoot.querySelectorAll(selector))) {
      if (results.length >= nodeLimit) {
        return
      }

      if (!node || seen.has(node)) {
        continue
      }

      seen.add(node)
      results.push(node)
    }

    if (depth >= depthLimit || results.length >= nodeLimit) {
      return
    }

    for (const node of toArray(currentRoot.querySelectorAll('*'))) {
      if (results.length >= nodeLimit) {
        return
      }
      if (node?.shadowRoot) {
        visitRoot(node.shadowRoot, depth + 1)
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

  return (
    deepCollectElements(root, maxDepth).find((node) => String(node.id || '') === normalizedId) ||
    null
  )
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
    deepCollectElements.toString(),
    deepQuerySelectorAll.toString(),
    deepQuerySelector.toString(),
    deepGetElementById.toString(),
    isDeepActiveElement.toString(),
  ].join('\n\n')
}
