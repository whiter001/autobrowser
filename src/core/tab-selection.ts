interface TabLike {
  id: number
  active: boolean
}

/**
 * 浏览器内部页面的 URL 前缀。这些页面既不是用户的业务目标，
 * 也不接受大部分 CDP 交互，兜底选中它们会让"没指定 tab"的命令直接打到错误对象上。
 */
const INTERNAL_PAGE_PREFIXES = [
  'chrome-extension://',
  'chrome://',
  'edge://',
  'devtools://',
  'about:',
  'chrome-search://',
]

export function isInternalBrowserPage(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || !url) {
    return false
  }
  const normalized = url.trim().toLowerCase()
  return INTERNAL_PAGE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
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
 * 未显式指定 tab 时的兜底选择：跳过浏览器自身页面（扩展管理页、devtools、about:blank 等）。
 * 全部都是内部页面时返回 null，让调用方报"没有可用目标"，而不是悄悄操作扩展页。
 */
export function pickFallbackTab<T extends TabLike & { url?: string }>(
  tabs: readonly T[],
): T | null {
  const usable = tabs.filter((tab) => tab && !isInternalBrowserPage(tab.url))
  return pickLastNonActiveTab(usable)
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
