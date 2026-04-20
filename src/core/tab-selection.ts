export interface TabLike {
  id: number
  active: boolean
}

export function pickLastNonActiveTab<T extends TabLike>(tabs: readonly T[]): T | null {
  let lastTab: T | null = null
  let lastNonActiveTab: T | null = null

  for (const tab of tabs) {
    if (!tab || typeof tab.id !== 'number') {
      continue
    }

    lastTab = tab
    if (!tab.active) {
      lastNonActiveTab = tab
    }
  }

  return lastNonActiveTab || lastTab
}

export function clearRemovedTabId(
  currentTabId: number | null,
  removedTabId: number,
): number | null {
  return currentTabId === removedTabId ? null : currentTabId
}
