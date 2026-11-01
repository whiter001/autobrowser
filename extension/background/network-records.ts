import type { ExtensionState, NetworkRequestRecord } from './types.js'

/** 全局请求列表的绝对上限，与 HAR 配置无关，防止长时间运行时内存无界增长 */
const GLOBAL_REQUEST_HARD_CAP = 10_000

/** 已被全局缓冲淘汰的请求对象：淘汰后不再允许异步回写 body */
export const evictedRequests = new WeakSet<NetworkRequestRecord>()

/**
 * 把任意 headers 值统一成字符串键值对；未提供时返回空对象，省去调用方到处判空。
 */
export function normalizeHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!headers || typeof headers !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [String(name), String(value ?? '')]),
  )
}

/**
 * 把 headers 展开成 HAR 需要的 [{name, value}] 形式。
 */
export function normalizeHeaderPairs(
  headers: Record<string, string>,
): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

/**
 * 生成 `tabId:requestId` 复合键；无标签的请求用 global 前缀，以区分全局抓包与页面抓包。
 */
export function createNetworkRequestKey(tabId: number | null, requestId: string): string {
  return `${tabId === null ? 'global' : tabId}:${requestId}`
}

/**
 * 按 id 合并写入请求记录：CDP 会分多次事件补全同一条请求，这里保证后到的事件覆盖前值。
 */
export function upsertNetworkRequest(
  state: ExtensionState,
  record: NetworkRequestRecord,
): NetworkRequestRecord {
  const key = String(record.id || '')
  if (!key) {
    return record
  }

  const existing: NetworkRequestRecord = state.network.requestMap.get(key) || { id: key }
  // 保持单次请求对象身份，异步 body 只写回该对象，不按可复用的 CDP id 覆盖新请求。
  const merged = Object.assign(existing, record)
  state.network.requestMap.set(key, merged)

  const index = state.network.requestIndex.get(key)
  if (index !== undefined) {
    state.network.requests[index] = merged
  } else {
    state.network.requestIndex.set(key, state.network.requests.length)
    state.network.requests.push(merged)
  }

  // 全局缓冲只受硬上限约束：HAR 的 maxRequests 是某次 capture 的导出窗口，
  // 若在这里裁剪会毁掉与 HAR 无关的跨 tab 历史（且 stop 后无法恢复）。
  if (state.network.requests.length > GLOBAL_REQUEST_HARD_CAP) {
    const removed = state.network.requests.splice(
      0,
      state.network.requests.length - GLOBAL_REQUEST_HARD_CAP,
    )
    for (const item of removed) {
      if (item && typeof item.id === 'string') {
        evictedRequests.add(item)
        state.network.requestMap.delete(item.id)
      }
    }
    // splice 会让所有下标前移，裁剪不频繁，直接整体重建下标表最简单可靠
    state.network.requestIndex.clear()
    for (let i = 0; i < state.network.requests.length; i += 1) {
      const itemId = state.network.requests[i]?.id
      if (typeof itemId === 'string') {
        state.network.requestIndex.set(itemId, i)
      }
    }
  }

  return merged
}

/**
 * 优先按复合键精确取，失败后按裸 requestId 兜底，兼容不同来源写入的记录。
 */
export function getNetworkRequestById(
  state: ExtensionState,
  requestId: string,
  tabId?: number | null,
): NetworkRequestRecord | null {
  if (!requestId) {
    return null
  }

  const exact = state.network.requestMap.get(requestId)
  if (exact && (typeof tabId !== 'number' || exact.tabId === tabId)) {
    return exact
  }
  const matches = state.network.requests.filter(
    (item) =>
      (item?.requestId === requestId || item?.id === requestId) &&
      (typeof tabId !== 'number' || item.tabId === tabId),
  )
  if (new Set(matches.map((item) => item.tabId)).size > 1) {
    throw new Error(
      `network request id is ambiguous across tabs: ${requestId}; use the full tabId:requestId id`,
    )
  }
  return (
    matches.find((item) => item.id === createNetworkRequestKey(item.tabId ?? null, requestId)) ||
    matches.at(-1) ||
    null
  )
}

/**
 * 输出请求摘要；只有 includeDetails 时才附带请求/响应细节，用于控制响应体积。
 */
export function summarizeNetworkRequest(
  record: NetworkRequestRecord,
  includeDetails = false,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: record.id,
    requestId: record.requestId,
    tabId: record.tabId,
    pageEpoch: record.pageEpoch ?? null,
    url: record.url,
    method: record.method,
    resourceType: record.resourceType,
    status: record.status ?? null,
    statusText: record.statusText ?? null,
    routeId: record.routeId ?? null,
    routeAction: record.routeAction ?? null,
    finishedAt: record.finishedAt ?? null,
    startedAt: record.startedAt ?? null,
    durationMs: record.durationMs ?? null,
    errorText: record.errorText ?? null,
    requestBodyTruncated: Boolean(record.postDataTruncated),
    requestBodyBytes: record.postDataBytes ?? null,
    responseBodyTruncated: Boolean(record.responseBodyTruncated),
    responseBodyBytes: record.responseBodyBytes ?? null,
    responseMimeType: record.responseMimeType ?? null,
  }
  if (includeDetails) {
    summary.requestHeaders = record.requestHeaders ?? null
    summary.responseHeaders = record.responseHeaders ?? null
    summary.requestBody = typeof record.postData === 'string' ? record.postData : null
    summary.responseBody = typeof record.responseBody === 'string' ? record.responseBody : null
  }
  return summary
}

function parseNetworkStatusFilter(
  statusFilter: string,
): (status: number | null | undefined) => boolean {
  const tokens = String(statusFilter || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    return () => true
  }

  return (status) => {
    const numericStatus = Number(status || 0)
    return tokens.some((token) => {
      if (/^\dxx$/i.test(token)) {
        return Math.floor(numericStatus / 100) === Number(token[0])
      }

      if (/^\d{3}-\d{3}$/.test(token)) {
        const [start, end] = token.split('-').map((value) => Number(value))
        return numericStatus >= start && numericStatus <= end
      }

      return numericStatus === Number(token)
    })
  }
}

/**
 * 按文本、资源类型等过滤条件判断请求是否命中，供 list 与 HAR 导出复用。
 */
export function matchesNetworkRequestFilters(
  record: NetworkRequestRecord,
  filters: Record<string, unknown>,
): boolean {
  const filterText = String(filters.filter || '')
    .trim()
    .toLowerCase()
  const typeFilter = String(filters.type || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  const methodFilter = String(filters.method || '')
    .trim()
    .toUpperCase()
  const statusMatches = parseNetworkStatusFilter(String(filters.status || ''))
  if (typeof filters.tabId === 'number' && record.tabId !== filters.tabId) return false
  if (typeof filters.pageEpoch === 'number' && record.pageEpoch !== filters.pageEpoch) return false
  if (
    filters.currentEpochs &&
    typeof filters.currentEpochs === 'object' &&
    typeof record.tabId === 'number'
  ) {
    const currentEpoch = (filters.currentEpochs as Record<number, number>)[record.tabId]
    if (typeof currentEpoch === 'number' && record.pageEpoch !== currentEpoch) return false
  }

  if (filterText) {
    const haystack = [
      record.id,
      record.requestId,
      record.url,
      record.method,
      record.resourceType,
      record.statusText,
      record.errorText,
    ]
      .map((value) => String(value || '').toLowerCase())
      .join(' ')

    if (!haystack.includes(filterText)) {
      return false
    }
  }

  if (typeFilter.length > 0) {
    const requestType = String(record.resourceType || '')
      .trim()
      .toLowerCase()
    if (!typeFilter.includes(requestType)) {
      return false
    }
  }

  if (methodFilter && String(record.method || '').toUpperCase() !== methodFilter) {
    return false
  }

  if (!statusMatches(record.status)) {
    return false
  }

  return true
}
