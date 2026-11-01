interface TabLike {
  id: number
  active: boolean
}

/**
 * 关闭标签后挑选接管目标的规则：优先最后一个非激活标签，
 * 否则退回最后一个标签，保证总有可落点。
 */
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

/**
 * 标签被关闭后清空指向它的当前目标；其它标签不受影响。
 */
export function clearRemovedTabId(
  currentTabId: number | null,
  removedTabId: number,
): number | null {
  return currentTabId === removedTabId ? null : currentTabId
}
