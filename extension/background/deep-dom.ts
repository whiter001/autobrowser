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

export function deepCollectElements(root: DeepDomRootLike | null | undefined): DeepDomNodeLike[] {
  const results: DeepDomNodeLike[] = []
  const seen = new Set<DeepDomNodeLike>()

  const visitRoot = (currentRoot: DeepDomRootLike | null | undefined) => {
    if (!currentRoot || typeof currentRoot.querySelectorAll !== 'function') {
      return
    }

    for (const node of toArray(currentRoot.querySelectorAll('*'))) {
      if (!node || seen.has(node)) {
        continue
      }

      seen.add(node)
      results.push(node)

      const shadowRoot = node.shadowRoot
      if (shadowRoot) {
        visitRoot(shadowRoot)
      }
    }
  }

  visitRoot(root)
  return results
}

export function deepQuerySelectorAll(
  root: DeepDomRootLike | null | undefined,
  selector: string,
): DeepDomNodeLike[] {
  const results: DeepDomNodeLike[] = []
  const seen = new Set<DeepDomNodeLike>()

  const visitRoot = (currentRoot: DeepDomRootLike | null | undefined) => {
    if (!currentRoot || typeof currentRoot.querySelectorAll !== 'function') {
      return
    }

    for (const node of toArray(currentRoot.querySelectorAll(selector))) {
      if (!node || seen.has(node)) {
        continue
      }

      seen.add(node)
      results.push(node)
    }

    for (const node of toArray(currentRoot.querySelectorAll('*'))) {
      if (node?.shadowRoot) {
        visitRoot(node.shadowRoot)
      }
    }
  }

  visitRoot(root)
  return results
}

export function deepQuerySelector(
  root: DeepDomRootLike | null | undefined,
  selector: string,
): DeepDomNodeLike | null {
  return deepQuerySelectorAll(root, selector)[0] || null
}

export function deepGetElementById(
  root: DeepDomRootLike | null | undefined,
  id: string | null | undefined,
): DeepDomNodeLike | null {
  const normalizedId = String(id || '').trim()
  if (!normalizedId) {
    return null
  }

  return deepCollectElements(root).find((node) => String(node.id || '') === normalizedId) || null
}

export function isDeepActiveElement(
  root: DeepDomRootLike | null | undefined,
  node: DeepDomNodeLike | null | undefined,
): boolean {
  if (!root || !node) {
    return false
  }

  const activeElement = root.activeElement || null
  if (!activeElement) {
    return false
  }

  if (activeElement === node) {
    return true
  }

  return Boolean(activeElement.shadowRoot && isDeepActiveElement(activeElement.shadowRoot, node))
}

export function buildDeepDomTraversalHelpersSource(): string {
  return [
    toArray.toString(),
    deepCollectElements.toString(),
    deepQuerySelectorAll.toString(),
    deepQuerySelector.toString(),
    deepGetElementById.toString(),
    isDeepActiveElement.toString(),
  ].join('\n\n')
}
