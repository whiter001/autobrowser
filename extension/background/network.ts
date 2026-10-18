import type {
  ExtensionState,
  NetworkRequestRecord,
  NetworkRoute,
  TabInput,
  TabWithId,
} from './types.js'
import { buildHarPayload, compareHarRecords } from '../../src/core/har.js'
import { paginateList } from './pagination.js'
import { getPageEpoch } from './targeting.js'

type SendDebuggerCommand = <TResult = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
) => Promise<TResult>

interface NetworkDomainDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  sendRawDebuggerCommand: SendDebuggerCommand
  sendDebuggerCommand: SendDebuggerCommand
  storageLocalGet?: (key: string) => Promise<Record<string, unknown>>
  storageLocalSet?: (items: Record<string, unknown>) => Promise<void>
}

interface NetworkDebuggerSource {
  tabId?: number
}

interface NetworkRequestPayload {
  url?: string
  method?: string
  headers?: Record<string, unknown>
  postData?: string
}

interface NetworkResponsePayload {
  status?: number
  statusText?: string
  headers?: Record<string, unknown>
  mimeType?: string
  /** 协议版本（如 h2 / http/1.1），HAR httpVersion 用 */
  protocol?: string
  /** ResourceTiming：requestTime 是秒基准，其余阶段已是相对请求开始的毫秒偏移 */
  timing?: Record<string, number>
}

interface FetchRequestPausedParams {
  requestId?: string
  /** 指向同一条请求的 Network.requestId，用于把 Fetch 与 Network 事件合并成一条记录 */
  networkId?: string
  /** redirect 前一跳的 Fetch.requestId（Network.requestId 在整条链中不变） */
  redirectedRequestId?: string
  request?: NetworkRequestPayload
  resourceType?: string
  requestStage?: string
  timestamp?: number
}

export interface NetworkRouteOptions {
  abort?: boolean
  body?: unknown
  status?: number
  contentType?: string
  headers?: Record<string, string>
  removeHeaders?: string[]
}

/** 常见状态码对应的 reason phrase，未知状态码则不传（Fetch.fulfillRequest 的 responsePhrase 可省略） */
const HTTP_STATUS_PHRASES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  418: "I'm a Teapot",
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

interface NetworkEventParams {
  requestId?: string
  request?: NetworkRequestPayload
  response?: NetworkResponsePayload
  redirectResponse?: NetworkResponsePayload & { encodedDataLength?: number }
  type?: string
  timestamp?: number
  wallTime?: number
  documentURL?: string
  errorText?: string
  canceled?: boolean
  encodedDataLength?: number
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function createNetworkRouteId(): string {
  return `route_${crypto.randomUUID().replaceAll('-', '')}`
}

/** fragment 不参与请求身份比较：Fetch 与 Network 事件可能给出不同形态的同一 URL */
function stripUrlFragment(url: string): string {
  const hashIndex = url.indexOf('#')
  return hashIndex === -1 ? url : url.slice(0, hashIndex)
}

function createNetworkRequestKey(tabId: number | null, requestId: string): string {
  return `${tabId === null ? 'global' : tabId}:${requestId}`
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  if (!headers || typeof headers !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [String(name), String(value ?? '')]),
  )
}

function normalizeHeaderPairs(
  headers: Record<string, string>,
): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const chunk = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

function stringifyNetworkBody(body: unknown): { text: string; base64Encoded: boolean } {
  // 若 body 已经是字符串则直接使用，避免 JSON.stringify 产生双重引号。
  const text = typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`
  return { text, base64Encoded: false }
}

const DEFAULT_HAR_MAX_REQUESTS = 1000
const DEFAULT_HAR_MAX_BODY_BYTES = 256 * 1024
/** 全局请求列表的绝对上限，与 HAR 配置无关，防止长时间运行时内存无界增长 */
const GLOBAL_REQUEST_HARD_CAP = 10_000
const HAR_CHECKPOINT_STORAGE_KEY = 'autobrowser.harCheckpoint'
const BODY_FETCH_CONCURRENCY = 4
const BODY_FETCH_QUEUE_LIMIT = 1000
const BODY_FETCH_TIMEOUT_MS = 10_000
/** 未被 requestWillBeSent 消费的拦截条目上限，防止只被 mock/abort 的请求长期堆积 */
const PENDING_INTERCEPTION_MAX = 512
const evictedRequests = new WeakSet<NetworkRequestRecord>()

/**
 * 一次 Fetch 拦截的上下文。按 networkId 暂存到对应的 Network 事件到达为止：
 * 先按 Fetch hop 身份分开记录，再用 URL/方法匹配 Network 确认事件。
 */
interface PendingInterception {
  key: string
  url: string
  method: string
  /** 本次拦截写入的记录对象，回写响应时按 identity 校验，不按 key 盲写 */
  record: NetworkRequestRecord
  /** Fetch-first 的上一跳，已提前归档改键，等待 Network 的 redirectResponse */
  predecessor: NetworkRequestRecord | null
  /** 同一 networkId 又有新的拦截事件：本次结果不再回写 */
  superseded: boolean
}

interface HarCapture {
  id: string
  tabId: number | null
  startedAt: string | null
  maxRequests: number | null
  maxBodyBytes: number | null
  pending: Set<Promise<void>>
}

interface BodyFetchTask {
  record: NetworkRequestRecord
  capture: HarCapture | null
  maxBodyBytes: number | null
  done: Promise<void>
  finish: (error?: string) => void
  settled: boolean
}

function estimateTextByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function truncateTextByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) {
    return ''
  }

  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)

  if (bytes.length <= maxBytes) {
    return text
  }

  const decoder = new TextDecoder('utf-8', { fatal: false })
  // Use maxBytes as array length to decode back to string safely
  // The decoder deals with boundary multi-byte characters and might output a replacement character
  // but it avoids O(N) single-character loops.
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/, '')
}

function summarizeStoredBody(
  body: string,
  base64Encoded: boolean,
  maxBytes: number | null,
): { text: string; byteLength: number; truncated: boolean } {
  const byteLength = base64Encoded
    ? Math.max(0, Math.floor(body.length * 0.75))
    : estimateTextByteLength(body)

  if (maxBytes === null || byteLength <= maxBytes) {
    return { text: body, byteLength, truncated: false }
  }

  if (base64Encoded) {
    return { text: '', byteLength, truncated: true }
  }

  return {
    text: truncateTextByBytes(body, maxBytes),
    byteLength,
    truncated: true,
  }
}

function getHarMaxRequests(state: ExtensionState): number | null {
  return state.network.harMaxRequests === null
    ? null
    : (state.network.harMaxRequests ?? DEFAULT_HAR_MAX_REQUESTS)
}

function getHarMaxBodyBytes(state: ExtensionState): number | null {
  return state.network.harMaxBodyBytes === null
    ? null
    : (state.network.harMaxBodyBytes ?? DEFAULT_HAR_MAX_BODY_BYTES)
}

function matchesNetworkRoute(pattern: string, url: string): boolean {
  const normalizedPattern = String(pattern || '').trim()
  if (!normalizedPattern) {
    return false
  }

  if (normalizedPattern === '*') {
    return true
  }

  return String(url || '').includes(normalizedPattern)
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

function findMatchingNetworkRoute(state: ExtensionState, url: string): NetworkRoute | null {
  return state.network.routes.find((route) => matchesNetworkRoute(route.pattern, url)) || null
}

function upsertNetworkRequest(
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

  // 先应用 HAR 配置的 maxRequests 限制，再应用全局硬上限，两者取较严格的一方
  const harLimit = getHarMaxRequests(state)
  const effectiveLimit =
    harLimit === null ? GLOBAL_REQUEST_HARD_CAP : Math.min(harLimit, GLOBAL_REQUEST_HARD_CAP)
  if (state.network.requests.length > effectiveLimit) {
    const removed = state.network.requests.splice(0, state.network.requests.length - effectiveLimit)
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

function getNetworkRequestById(
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

function summarizeNetworkRequest(
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

/** 从 URL 解析 query 参数数组（HAR queryString 字段），无 query 时返回空数组 */
function parseQueryString(url: string | undefined): Array<{ name: string; value: string }> {
  if (!url) {
    return []
  }

  try {
    const parsed = new URL(url, 'http://localhost')
    const query: Array<{ name: string; value: string }> = []
    parsed.searchParams.forEach((value, name) => {
      query.push({ name, value })
    })
    return query
  } catch {
    // URL 无法解析（如 blob:/data:），没有可拆分的 query
    return []
  }
}

/** CDP 的 protocol 值（h2/http/1.1）转 HAR 惯例的 HTTP 版本号写法，缺失时回退 HTTP/1.1 */
function normalizeHttpVersion(protocol: string | undefined): string {
  const normalized = String(protocol || '')
    .trim()
    .toLowerCase()
  if (normalized.startsWith('h2')) {
    return 'HTTP/2'
  }
  if (normalized.startsWith('h3')) {
    return 'HTTP/3'
  }
  if (normalized.startsWith('http/1')) {
    return 'HTTP/1.1'
  }
  return 'HTTP/1.1'
}

/**
 * CDP Network.ResourceTiming 只有 requestTime 是秒基准，其余字段（dnsStart/connectStart/...）
 * 已经是相对请求开始的毫秒偏移，因此阶段差不能再乘 1000，也不能拿 requestTime 当基准去减。
 */
function timingOffset(timing: Record<string, number>, key: string): number | null {
  const value = timing[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 阶段差（毫秒），端点缺失或出现负值（乱序/不可信数据）视为不可用 */
function timingDelta(
  timing: Record<string, number>,
  fromKey: string,
  toKey: string,
): number | null {
  const from = timingOffset(timing, fromKey)
  const to = timingOffset(timing, toKey)
  if (from === null || to === null) {
    return null
  }
  const delta = Math.round(to - from)
  return delta >= 0 ? delta : null
}

/**
 * HAR timings 映射（DevTools HAR 也是近似值，参考其惯例）：
 * - blocked = 首个可用阶段偏移（dnsStart → connectStart → sslStart → sendStart）；
 * - dns/connect/ssl/send/wait 用对应阶段差（毫秒），wait = receiveHeadersEnd - sendEnd；
 * - receive 沿用事件时间戳（loadingFinished - responseReceived）的 receiveMs 近似；
 * - 有 timing 时缺失的阶段记 -1（HAR 惯例的“不可用”），完全没有 timing 时保持旧的
 *   send/wait/receive 形状，避免破坏老数据。
 */
function buildHarTimings(record: NetworkRequestRecord): Record<string, number> {
  const timing = record.timing
  if (!timing || typeof timing !== 'object') {
    return {
      send: 0,
      wait: typeof record.waitMs === 'number' ? record.waitMs : 0,
      receive: typeof record.receiveMs === 'number' ? record.receiveMs : 0,
    }
  }

  const blocked =
    timingOffset(timing, 'dnsStart') ??
    timingOffset(timing, 'connectStart') ??
    timingOffset(timing, 'sslStart') ??
    timingOffset(timing, 'sendStart')
  const dns = timingDelta(timing, 'dnsStart', 'dnsEnd')
  const connect = timingDelta(timing, 'connectStart', 'connectEnd')
  const ssl = timingDelta(timing, 'sslStart', 'sslEnd')
  const send = timingDelta(timing, 'sendStart', 'sendEnd')
  const wait = timingDelta(timing, 'sendEnd', 'receiveHeadersEnd')

  return {
    blocked: blocked ?? -1,
    dns: dns ?? -1,
    connect: connect ?? -1,
    ssl: ssl ?? -1,
    send: send ?? -1,
    wait: wait ?? (typeof record.waitMs === 'number' ? record.waitMs : -1),
    receive: typeof record.receiveMs === 'number' ? record.receiveMs : -1,
  }
}

function buildHarEntry(record: NetworkRequestRecord): Record<string, unknown> {
  const requestHeaders = normalizeHeaderPairs(normalizeHeaders(record.requestHeaders))
  const responseHeaders = normalizeHeaderPairs(normalizeHeaders(record.responseHeaders))
  const requestBody = typeof record.postData === 'string' ? record.postData : ''
  const requestBodyTruncated = Boolean(record.postDataTruncated)
  const requestBodyBytes =
    typeof record.postDataBytes === 'number'
      ? record.postDataBytes
      : estimateTextByteLength(requestBody)
  const responseBody = typeof record.responseBody === 'string' ? record.responseBody : ''
  const responseBodyBase64 = Boolean(record.responseBodyBase64)
  const responseBodyTruncated = Boolean(record.responseBodyTruncated)
  const responseBodyError =
    typeof record.responseBodyError === 'string' ? record.responseBodyError : ''
  const responseBodyBytes =
    typeof record.responseBodyBytes === 'number'
      ? record.responseBodyBytes
      : responseBodyBase64
        ? Math.max(0, Math.floor(responseBody.length * 0.75))
        : estimateTextByteLength(responseBody)
  const responseMimeType = String(record.responseMimeType || 'application/octet-stream')
  const responseContent: Record<string, unknown> = {
    size: responseBodyBytes,
    mimeType: responseMimeType,
  }

  if (responseBodyError) {
    responseContent.comment = `body unavailable: ${responseBodyError}`
  } else if (responseBodyTruncated) {
    responseContent.comment = 'body truncated by autobrowser'
  }

  if (responseBody) {
    responseContent.text = responseBody
    if (responseBodyBase64 && !responseBodyTruncated) {
      responseContent.encoding = 'base64'
    }
  }

  // 请求/响应 cookie 不做解析：从 header 还原 Set-Cookie/Cookie 成本高、收益低，
  // 需要时可直接看 requestHeaders/responseHeaders
  return {
    startedDateTime: record.startedAt,
    time: typeof record.durationMs === 'number' ? record.durationMs : 0,
    request: {
      method: record.method || 'GET',
      url: record.url || '',
      httpVersion: normalizeHttpVersion(record.protocol),
      cookies: [],
      headers: requestHeaders,
      queryString: parseQueryString(record.url),
      headersSize: -1,
      bodySize: requestBodyBytes,
      postData:
        typeof record.postData === 'string'
          ? {
              mimeType: 'application/json',
              text: requestBody,
              ...(requestBodyTruncated
                ? {
                    comment: 'body truncated by autobrowser',
                  }
                : {}),
            }
          : undefined,
    },
    response: {
      status: Number(record.status || 0),
      statusText: String(record.statusText || ''),
      httpVersion: normalizeHttpVersion(record.protocol),
      cookies: [],
      headers: responseHeaders,
      content: responseContent,
      redirectURL:
        responseHeaders.find((header) => header.name.toLowerCase() === 'location')?.value || '',
      headersSize: -1,
      bodySize: responseBodyBytes,
    },
    cache: {},
    timings: buildHarTimings(record),
    pageref:
      record.tabId === null || record.tabId === undefined ? undefined : `tab-${record.tabId}`,
  }
}

function buildHar(records: NetworkRequestRecord[]): Record<string, unknown> {
  const ordered = [...records].sort((left, right) => {
    // 同毫秒多跳不能按随机归档 id 排序；先按原始请求分组再按跳序排列。
    const compared = compareHarRecords(
      {
        ...left,
        id: left.requestId ? createNetworkRequestKey(left.tabId ?? null, left.requestId) : left.id,
      },
      {
        ...right,
        id: right.requestId
          ? createNetworkRequestKey(right.tabId ?? null, right.requestId)
          : right.id,
      },
    )
    return compared || Number(left.hopSequence || 0) - Number(right.hopSequence || 0)
  })
  return buildHarPayload(ordered.map((record) => buildHarEntry(record)))
}

function matchesNetworkRequestFilters(
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

export function createNetworkDomain({
  state,
  getTargetTab,
  sendRawDebuggerCommand,
  sendDebuggerCommand,
  storageLocalGet = async (key) =>
    typeof chrome === 'undefined' || !chrome.storage?.local
      ? {}
      : await chrome.storage.local.get(key),
  storageLocalSet = async (items) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set(items)
    }
  },
}: NetworkDomainDependencies) {
  let checkpointTimer: ReturnType<typeof setTimeout> | null = null
  let capture: HarCapture | null = state.network.harRecording ? createCapture(null) : null
  let checkpointWrites: Promise<void> = Promise.resolve()
  const bodyTasks = new WeakMap<NetworkRequestRecord, BodyFetchTask>()
  const bodyQueue: BodyFetchTask[] = []
  let activeBodyFetches = 0
  /** 等待对应 Network 事件确认的拦截条目 */
  const pendingInterceptions = new Map<string, PendingInterception>()
  /** Fetch id 按 hop 唯一；绑在对象上，Network-first 新对象不会继承上一跳身份，淘汰后可回收 */
  const fetchRequestIds = new WeakMap<NetworkRequestRecord, string>()

  /** 记录是否仍是它在缓冲里的当前代次（没被淘汰、归档或被新代次顶掉） */
  function isLiveRecord(record: NetworkRequestRecord | null): record is NetworkRequestRecord {
    if (!record || evictedRequests.has(record) || record.redirectArchived) {
      return false
    }
    const id = String(record.id || '')
    return Boolean(id) && state.network.requestMap.get(id) === record
  }

  /** 同一次请求的判定：URL（忽略 fragment）与方法都要一致 */
  function sameRequest(record: { url?: string; method?: string }, url: string, method: string) {
    return stripUrlFragment(record.url ?? '') === stripUrlFragment(url) && record.method === method
  }

  /** redirect 的上一跳：原地改键保留数组顺序，把 networkId 让给新跳 */
  function detachArchivedRecord(record: NetworkRequestRecord): NetworkRequestRecord {
    const oldId = String(record.id || '')
    const index = state.network.requestIndex.get(oldId)
    const archived: NetworkRequestRecord = { ...record, id: `${oldId}:hop:${crypto.randomUUID()}` }
    state.network.requestMap.delete(oldId)
    state.network.requestIndex.delete(oldId)
    state.network.requestMap.set(archived.id!, archived)
    if (index !== undefined) {
      state.network.requests[index] = archived
      state.network.requestIndex.set(archived.id!, index)
    }
    return archived
  }

  function applyRedirectResponse(
    record: NetworkRequestRecord,
    response: NetworkResponsePayload & { encodedDataLength?: number },
    timestamp: number | undefined,
  ): void {
    const durationMs =
      typeof record.requestWillBeSentAt === 'number' && typeof timestamp === 'number'
        ? Math.max(0, (timestamp - record.requestWillBeSentAt) * 1000)
        : null
    record.redirectArchived = true
    record.responseBodyError = 'redirect hop body is no longer available from CDP'
    Object.assign(record, {
      status: Number(response.status || 0),
      statusText: String(response.statusText || ''),
      responseHeaders: normalizeHeaders(response.headers),
      responseMimeType: String(response.mimeType || 'application/octet-stream'),
      protocol: String(response.protocol || ''),
      timing: response.timing ? { ...response.timing } : undefined,
      responseReceivedAt: timestamp ?? null,
      finishedAt: new Date().toISOString(),
      durationMs,
      waitMs: durationMs,
      receiveMs: 0,
      encodedDataLength: response.encodedDataLength ?? null,
    })
  }

  function registerPendingInterception(pending: PendingInterception): void {
    const previous = pendingInterceptions.get(pending.key)
    // 只有指向别的 hop / 别的代次才算被顶掉；同一次请求的多次拦截共用一条记录
    if (previous && previous.record !== pending.record) {
      previous.superseded = true
    }
    pendingInterceptions.set(pending.key, pending)
    while (pendingInterceptions.size > PENDING_INTERCEPTION_MAX) {
      const oldest = pendingInterceptions.keys().next()
      if (oldest.done) break
      pendingInterceptions.delete(oldest.value)
    }
  }

  function createCapture(tabId: number | null): HarCapture {
    return {
      id: crypto.randomUUID(),
      tabId,
      startedAt: state.network.harStartedAt,
      maxRequests: getHarMaxRequests(state),
      maxBodyBytes: getHarMaxBodyBytes(state),
      pending: new Set(),
    }
  }

  function captureRequests(session: HarCapture | null): NetworkRequestRecord[] {
    return state.network.requests.filter((record) =>
      session
        ? (session.tabId === null || record.tabId === session.tabId) &&
          (record.harCaptureId === session.id ||
            (record.harCaptureId === undefined &&
              (!session.startedAt || String(record.startedAt || '') >= session.startedAt)))
        : true,
    )
  }

  function checkpointPayload(
    recording = state.network.harRecording,
    session = capture,
    requests = captureRequests(session),
  ): Record<string, unknown> {
    return {
      recording,
      startedAt: session?.startedAt ?? state.network.harStartedAt,
      maxRequests: session ? session.maxRequests : state.network.harMaxRequests,
      maxBodyBytes: session ? session.maxBodyBytes : state.network.harMaxBodyBytes,
      updatedAt: new Date().toISOString(),
      requests,
    }
  }

  async function writeHarCheckpoint(payload = checkpointPayload()): Promise<void> {
    // 串行落盘避免旧 stop 的慢写覆盖新 capture 的 checkpoint。
    const write = checkpointWrites.then(() =>
      storageLocalSet({
        [HAR_CHECKPOINT_STORAGE_KEY]: payload,
      }),
    )
    checkpointWrites = write.catch(() => {})
    await write
  }

  function scheduleHarCheckpoint(): void {
    if (!state.network.harRecording || checkpointTimer) return
    checkpointTimer = setTimeout(() => {
      checkpointTimer = null
      void writeHarCheckpoint().catch((error) => console.error('failed to checkpoint HAR', error))
    }, 500)
  }

  async function readHarCheckpoint(): Promise<Record<string, unknown> | null> {
    const result = await storageLocalGet(HAR_CHECKPOINT_STORAGE_KEY)
    const checkpoint = result?.[HAR_CHECKPOINT_STORAGE_KEY]
    return checkpoint && typeof checkpoint === 'object'
      ? (checkpoint as Record<string, unknown>)
      : null
  }
  async function refreshInterceptors(): Promise<void> {
    await Promise.allSettled(
      Array.from(state.targeting.attachedTabs).map(async (tabId) => {
        if (state.network.routes.length === 0) {
          await sendRawDebuggerCommand(tabId, 'Fetch.disable', {})
          return
        }

        await sendRawDebuggerCommand(tabId, 'Fetch.enable', {
          patterns: [{ urlPattern: '*' }],
          handleAuthRequests: false,
        })
      }),
    )
  }

  async function handleRequestPaused(tabId: number, params: unknown): Promise<void> {
    const payload = asObject(params) as FetchRequestPausedParams
    const request = payload.request || {}
    // Fetch.* 命令及 hop 身份用 fetchRequestId；当前记录挂在 networkId 上，避免跨域重复记录
    const fetchRequestId = String(payload.requestId || '')
    if (!fetchRequestId) {
      return
    }
    const networkId =
      typeof payload.networkId === 'string' && payload.networkId ? payload.networkId : ''

    try {
      const route = findMatchingNetworkRoute(state, String(request.url || ''))
      const requestId = networkId || fetchRequestId
      const key = createNetworkRequestKey(tabId, requestId)
      const requestBodySummary =
        typeof request.postData === 'string'
          ? summarizeStoredBody(request.postData, false, getHarMaxBodyBytes(state))
          : null
      const capturedHarId =
        state.network.harRecording && capture && (capture.tabId === null || capture.tabId === tabId)
          ? capture.id
          : ''
      const existing = state.network.requestMap.get(key)
      const fetchRequest = {
        url: String(request.url || ''),
        method: String(request.method || 'GET'),
        resourceType: String(payload.resourceType || payload.requestStage || ''),
        requestHeaders: normalizeHeaders(request.headers),
      }
      const routeAction = route?.abort ? 'abort' : route?.body !== undefined ? 'mock' : 'continue'

      // Network id 在 redirect 链中复用，URL/方法也可能完全相同，必须看 Fetch hop 身份。
      // Network-first 已为下一跳建了新对象（没有旧 Fetch id），不能仅因 redirectedRequestId 存在就再拆一跳。
      const existingFetchId = existing ? fetchRequestIds.get(existing) : undefined
      const redirectsExisting =
        existingFetchId !== undefined && payload.redirectedRequestId === existingFetchId
      let predecessor: NetworkRequestRecord | null = null
      let mergeTarget: NetworkRequestRecord | null = null
      if (
        existing &&
        (!existing.finishedAt || redirectsExisting || existingFetchId === fetchRequestId)
      ) {
        if (
          !redirectsExisting &&
          (existingFetchId === undefined || existingFetchId === fetchRequestId) &&
          sameRequest(existing, fetchRequest.url, fetchRequest.method)
        ) {
          mergeTarget = existing
          predecessor = pendingInterceptions.get(key)?.predecessor ?? null
        } else {
          predecessor = detachArchivedRecord(existing)
        }
      } else if (existing) {
        // 已结束且无 redirect 关联的同 id 记录属于上一条请求（CDP id 可复用）
        state.network.requestMap.delete(key)
      }

      // 请求元数据以 Network 事件为准：已有记录时只用 Fetch 侧独有的信息补空，绝不覆盖
      const recordPatch: NetworkRequestRecord = mergeTarget
        ? {
            url: mergeTarget.url ?? fetchRequest.url,
            method: mergeTarget.method ?? fetchRequest.method,
            resourceType: mergeTarget.resourceType || fetchRequest.resourceType,
            requestHeaders:
              Object.keys(mergeTarget.requestHeaders || {}).length > 0
                ? mergeTarget.requestHeaders
                : fetchRequest.requestHeaders,
            ...(mergeTarget.postData == null && requestBodySummary
              ? {
                  postData: requestBodySummary.text,
                  postDataTruncated: requestBodySummary.truncated,
                  postDataBytes: requestBodySummary.byteLength,
                }
              : {}),
          }
        : {
            ...fetchRequest,
            postData: requestBodySummary?.text,
            postDataTruncated: requestBodySummary?.truncated,
            postDataBytes: requestBodySummary?.byteLength,
            startedAt: new Date().toISOString(),
            requestWillBeSentAt: typeof payload.timestamp === 'number' ? payload.timestamp : null,
            harCaptureId: capturedHarId,
          }

      const record = upsertNetworkRequest(state, {
        ...recordPatch,
        id: key,
        requestId,
        tabId,
        pageEpoch: mergeTarget?.pageEpoch ?? getPageEpoch(state, tabId),
        routeId: route?.id || null,
        routeAction,
      })

      fetchRequestIds.set(record, fetchRequestId)
      registerPendingInterception({
        key,
        url: fetchRequest.url,
        method: fetchRequest.method,
        record,
        predecessor,
        superseded: false,
      })
      const pending = pendingInterceptions.get(key)!

      if (route?.abort) {
        try {
          await sendRawDebuggerCommand(tabId, 'Fetch.failRequest', {
            requestId: fetchRequestId,
            errorReason: 'Failed',
          })
        } catch (error) {
          console.error('failed to abort network request', error)
          await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', {
            requestId: fetchRequestId,
          })
        }
        return
      }

      if (route && route.body !== undefined) {
        const body = stringifyNetworkBody(route.body)
        const responseBodySummary = summarizeStoredBody(
          body.text,
          body.base64Encoded,
          getHarMaxBodyBytes(state),
        )
        const mockStatus = route.status ?? 200
        const mockContentType = route.contentType ?? 'application/json; charset=utf-8'
        // 显式 --header 允许覆盖默认 content-type
        const mockHeaders = normalizeHeaderPairs({
          'content-type': mockContentType,
          ...route.headers,
        })
        try {
          await sendRawDebuggerCommand(tabId, 'Fetch.fulfillRequest', {
            requestId: fetchRequestId,
            responseCode: mockStatus,
            ...(HTTP_STATUS_PHRASES[mockStatus]
              ? { responsePhrase: HTTP_STATUS_PHRASES[mockStatus] }
              : {}),
            responseHeaders: mockHeaders,
            body: encodeBase64(body.text),
          })
          // 只写响应侧字段，且只写回本次拦截捕获的那个对象：
          // 记录被淘汰、归档或同 id 换代时既不复活也不污染新记录
          if (!pending.superseded && isLiveRecord(record)) {
            Object.assign(record, {
              responseBody: responseBodySummary.text,
              responseBodyTruncated: responseBodySummary.truncated,
              responseBodyBytes: responseBodySummary.byteLength,
              responseBodyBase64: false,
              responseMimeType: mockContentType,
              status: mockStatus,
              statusText: HTTP_STATUS_PHRASES[mockStatus] || '',
              finishedAt: new Date().toISOString(),
              durationMs: 0,
            })
          }
          return
        } catch (error) {
          console.error('failed to fulfill network request', error)
          await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', {
            requestId: fetchRequestId,
          })
          return
        }
      }

      // removeHeaders 是请求头修改：删除指定头后用 Fetch.continueRequest 的 headers 放行
      if (route?.removeHeaders && route.removeHeaders.length > 0) {
        const removedNames = new Set(route.removeHeaders.map((name) => name.toLowerCase()))
        const headers = normalizeHeaderPairs(
          Object.fromEntries(
            Object.entries(normalizeHeaders(request.headers)).filter(
              ([name]) => !removedNames.has(name.toLowerCase()),
            ),
          ),
        )
        await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', {
          requestId: fetchRequestId,
          headers,
        })
        return
      }

      await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', { requestId: fetchRequestId })
    } catch (error) {
      console.error('failed to process paused network request', error)
    }
  }

  function bodyUnavailable(record: NetworkRequestRecord): string | null {
    if (evictedRequests.has(record)) return 'request was evicted before body retrieval'
    if (record.redirectArchived) return 'redirect hop body is no longer available from CDP'
    if (typeof record.tabId !== 'number' || !record.requestId) return 'no live CDP request identity'
    if (
      state.network.requestMap.get(createNetworkRequestKey(record.tabId, record.requestId)) !==
      record
    ) {
      return 'historical request is no longer the live CDP request'
    }
    if (record.pageEpoch !== getPageEpoch(state, record.tabId))
      return 'historical page epoch; body is no longer available'
    if (record.errorText) return `request failed: ${record.errorText}`
    if (!record.finishedAt) return 'request has not finished; retry detail after loading finishes'
    return null
  }

  function pumpBodyQueue(): void {
    for (let index = bodyQueue.length - 1; index >= 0; index -= 1) {
      const task = bodyQueue[index]!
      const reason = bodyUnavailable(task.record)
      if (task.settled || reason) {
        bodyQueue.splice(index, 1)
        task.finish(reason || undefined)
      }
    }
    while (activeBodyFetches < BODY_FETCH_CONCURRENCY && bodyQueue.length > 0) {
      const task = bodyQueue.shift()!
      activeBodyFetches += 1
      void runBodyFetch(task)
    }
  }

  async function runBodyFetch(task: BodyFetchTask): Promise<void> {
    const { record } = task
    try {
      const result = await sendRawDebuggerCommand<{ body?: string; base64Encoded?: boolean }>(
        record.tabId as number,
        'Network.getResponseBody',
        { requestId: record.requestId },
      )
      // CDP 不支持流式截断；maxBodyBytes 只限制收到完整响应后的存储量。
      // stop 后仍可写自己的旧对象，但淘汰、重定向及逻辑超时后的结果丢弃。
      if (!task.settled && !evictedRequests.has(record) && !record.redirectArchived) {
        const summary = summarizeStoredBody(
          String(result?.body || ''),
          Boolean(result?.base64Encoded),
          task.maxBodyBytes,
        )
        Object.assign(record, {
          responseBody: summary.text,
          responseBodyTruncated: summary.truncated,
          responseBodyBytes: summary.byteLength,
          responseBodyBase64: Boolean(result?.base64Encoded),
          responseBodyError: undefined,
          responseMimeType: record.responseMimeType || 'application/octet-stream',
        })
      }
      task.finish()
    } catch (error) {
      task.finish(error instanceof Error ? error.message : String(error))
    } finally {
      // 超时不能释放真实 CDP 槽，否则卡死连接会持续累积底层请求。
      activeBodyFetches -= 1
      pumpBodyQueue()
    }
  }

  function fetchRequestBody(
    record: NetworkRequestRecord,
    session: HarCapture | null,
  ): Promise<void> {
    const existing = bodyTasks.get(record)
    if (existing) return existing.done
    if (typeof record.responseBody === 'string') return Promise.resolve()
    const reason = bodyUnavailable(record)
    if (reason) {
      record.responseBodyError = reason
      return Promise.resolve()
    }
    pumpBodyQueue()
    if (bodyQueue.length >= BODY_FETCH_QUEUE_LIMIT) {
      record.responseBodyError =
        'body fetch queue is full (1000 queued requests); retry detail later'
      return Promise.resolve()
    }
    let resolve!: () => void
    const done = new Promise<void>((complete) => {
      resolve = complete
    })
    const task: BodyFetchTask = {
      record,
      capture: session,
      maxBodyBytes: session ? session.maxBodyBytes : DEFAULT_HAR_MAX_BODY_BYTES,
      done,
      settled: false,
      finish: (error) => {
        if (task.settled) return
        task.settled = true
        clearTimeout(timer)
        if (error && !evictedRequests.has(record)) record.responseBodyError = error
        session?.pending.delete(done)
        state.network.pendingBodyFetches.delete(done)
        resolve()
      },
    }
    // 等待队列也计入预算，stop 不会被排队工作无限拖延。
    const timer = setTimeout(() => {
      task.finish('Network.getResponseBody timed out after 10000ms (including queue wait)')
      pumpBodyQueue()
    }, BODY_FETCH_TIMEOUT_MS)
    bodyTasks.set(record, task)
    session?.pending.add(done)
    state.network.pendingBodyFetches.add(done)
    bodyQueue.push(task)
    pumpBodyQueue()
    return done
  }

  async function handleEvent(
    source: NetworkDebuggerSource,
    method: string,
    params: unknown,
  ): Promise<void> {
    const tabId = typeof source?.tabId === 'number' ? source.tabId : null
    if (tabId === null) {
      return
    }

    const payload = asObject(params) as NetworkEventParams

    if (method === 'Network.requestWillBeSent') {
      const requestId = String(payload.requestId || '')
      if (!requestId) {
        return
      }
      const inFlight = state.network.inFlightByTab.get(tabId) || new Set<string>()
      inFlight.add(requestId)
      state.network.inFlightByTab.set(tabId, inFlight)
      state.network.lastActivityByTab.set(tabId, Date.now())

      const requestBodySummary =
        typeof payload.request?.postData === 'string'
          ? summarizeStoredBody(payload.request.postData, false, getHarMaxBodyBytes(state))
          : null

      const key = createNetworkRequestKey(tabId, requestId)
      const networkRequest = {
        url: String(payload.request?.url || ''),
        method: String(payload.request?.method || 'GET'),
        resourceType: String(payload.type || ''),
        requestHeaders: normalizeHeaders(payload.request?.headers),
      }
      const previous = state.network.requestMap.get(key)
      const pending = pendingInterceptions.get(key)
      const pendingMatches =
        pending !== undefined &&
        !pending.superseded &&
        pending.record === previous &&
        sameRequest(pending, networkRequest.url, networkRequest.method)
      // Fetch-first 已按 hop 身份让出前跳的 key：redirectResponse 只属于 predecessor，
      // key 上的当前对象（包括已完成的 mock）必须保留，不能再次归档或重建。
      const earlyArchivedHop =
        payload.redirectResponse && pendingMatches ? pending.predecessor : null
      const intercepted =
        pendingMatches &&
        (!payload.redirectResponse || earlyArchivedHop) &&
        isLiveRecord(pending.record)
          ? pending.record
          : null
      const sameGeneration = intercepted !== null && previous === intercepted

      const previousHop = earlyArchivedHop ?? previous
      if (payload.redirectResponse) {
        if (earlyArchivedHop) {
          applyRedirectResponse(earlyArchivedHop, payload.redirectResponse, payload.timestamp)
        } else if (previous) {
          applyRedirectResponse(previous, payload.redirectResponse, payload.timestamp)
          detachArchivedRecord(previous)
        }
      }
      if (sameGeneration) {
        pendingInterceptions.delete(key)
      } else {
        // 不匹配的条目属于别的 hop/别的代次；新请求必须使用新对象，旧任务只持有旧对象。
        if (pending) pendingInterceptions.delete(key)
        if (previous && !payload.redirectResponse) {
          state.network.requestMap.delete(key)
        }
      }

      upsertNetworkRequest(state, {
        id: key,
        requestId,
        tabId,
        pageEpoch: getPageEpoch(state, tabId),
        url: intercepted?.url ?? networkRequest.url,
        method: intercepted?.method ?? networkRequest.method,
        resourceType: networkRequest.resourceType || (intercepted?.resourceType ?? ''),
        // 拦截阶段先到时保留它抓到的请求头/请求体，Network 没给才用 Network 的
        requestHeaders:
          Object.keys(networkRequest.requestHeaders).length > 0 || !intercepted
            ? networkRequest.requestHeaders
            : (intercepted.requestHeaders ?? {}),
        postData: requestBodySummary?.text ?? intercepted?.postData,
        postDataTruncated: requestBodySummary?.truncated ?? intercepted?.postDataTruncated,
        postDataBytes: requestBodySummary?.byteLength ?? intercepted?.postDataBytes,
        // startedAt 取最早：拦截比真正发出更早发生，HAR 的起始时间不应被推后
        startedAt: intercepted?.startedAt ?? new Date().toISOString(),
        requestWillBeSentAt: typeof payload.timestamp === 'number' ? payload.timestamp : null,
        wallTime: typeof payload.wallTime === 'number' ? payload.wallTime : null,
        documentUrl: String(payload.documentURL || ''),
        hopSequence: payload.redirectResponse ? Number(previousHop?.hopSequence || 0) + 1 : 0,
        harCaptureId:
          state.network.harRecording &&
          capture &&
          (capture.tabId === null || capture.tabId === tabId)
            ? capture.id
            : '',
      })
      pumpBodyQueue()
      scheduleHarCheckpoint()
      return
    }

    if (
      method === 'Network.responseReceived' ||
      method === 'Network.loadingFinished' ||
      method === 'Network.loadingFailed'
    ) {
      const requestId = String(payload.requestId || '')
      if (!state.network.requestMap.has(createNetworkRequestKey(tabId, requestId))) {
        // 已被缓冲上限裁剪的请求不靠后续事件复活，但仍须结束 network-idle 计数。
        if (method !== 'Network.responseReceived') {
          state.network.inFlightByTab.get(tabId)?.delete(requestId)
          state.network.lastActivityByTab.set(tabId, Date.now())
        }
        return
      }
    }

    if (method === 'Network.responseReceived') {
      const requestId = String(payload.requestId || '')
      if (!requestId) {
        return
      }

      upsertNetworkRequest(state, {
        id: createNetworkRequestKey(tabId, requestId),
        requestId,
        tabId,
        status: Number(payload.response?.status || 0),
        statusText: String(payload.response?.statusText || ''),
        responseHeaders: normalizeHeaders(payload.response?.headers),
        responseMimeType: String(payload.response?.mimeType || 'application/octet-stream'),
        protocol: String(payload.response?.protocol || ''),
        timing:
          payload.response?.timing && typeof payload.response.timing === 'object'
            ? { ...payload.response.timing }
            : undefined,
        responseReceivedAt: typeof payload.timestamp === 'number' ? payload.timestamp : null,
      })
      return
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(payload.requestId || '')
      if (!requestId) {
        return
      }
      state.network.inFlightByTab.get(tabId)?.delete(requestId)
      state.network.lastActivityByTab.set(tabId, Date.now())

      const key = createNetworkRequestKey(tabId, requestId)
      // 请求已终结：还没被 requestWillBeSent 消费的拦截条目不再可能对应这次请求
      pendingInterceptions.delete(key)
      const record = getNetworkRequestById(state, key)
      const finishedAt = new Date().toISOString()
      const requestWillBeSentAt =
        typeof record?.requestWillBeSentAt === 'number' ? record.requestWillBeSentAt : null
      const responseReceivedAt =
        typeof record?.responseReceivedAt === 'number' ? record.responseReceivedAt : null
      const baseRecord = record || {}

      upsertNetworkRequest(state, {
        ...baseRecord,
        id: key,
        requestId,
        tabId,
        finishedAt,
        durationMs:
          requestWillBeSentAt !== null && typeof payload.timestamp === 'number'
            ? Math.max(0, (payload.timestamp - requestWillBeSentAt) * 1000)
            : null,
        waitMs:
          requestWillBeSentAt !== null && responseReceivedAt !== null
            ? Math.max(0, (responseReceivedAt - requestWillBeSentAt) * 1000)
            : null,
        receiveMs:
          responseReceivedAt !== null && typeof payload.timestamp === 'number'
            ? Math.max(0, (payload.timestamp - responseReceivedAt) * 1000)
            : null,
        encodedDataLength:
          typeof payload.encodedDataLength === 'number' ? payload.encodedDataLength : null,
      })

      if (record && state.network.harRecording && capture && record.harCaptureId === capture.id) {
        void fetchRequestBody(record, capture)
      }
      scheduleHarCheckpoint()
      return
    }

    if (method === 'Network.loadingFailed') {
      const requestId = String(payload.requestId || '')
      if (!requestId) {
        return
      }
      state.network.inFlightByTab.get(tabId)?.delete(requestId)
      state.network.lastActivityByTab.set(tabId, Date.now())

      const key = createNetworkRequestKey(tabId, requestId)
      // 失败的请求（含被 abort 掉的）不会再有 requestWillBeSent，残留条目必须清掉，
      // 否则同 id 的新代次会被误判成"同一次请求"
      pendingInterceptions.delete(key)
      upsertNetworkRequest(state, {
        id: key,
        requestId,
        tabId,
        errorText: String(payload.errorText || 'request failed'),
        canceled: Boolean(payload.canceled),
        finishedAt: new Date().toISOString(),
      })
      scheduleHarCheckpoint()
    }
  }

  async function routeRequest(
    tabId: TabInput,
    url: string,
    options: NetworkRouteOptions = {},
  ): Promise<{ route: NetworkRoute; routes: NetworkRoute[] }> {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Network.enable', {})
    const route: NetworkRoute = {
      id: createNetworkRouteId(),
      pattern: String(url || '').trim(),
      abort: Boolean(options.abort),
      body: options.body === undefined ? undefined : options.body,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.headers && Object.keys(options.headers).length > 0
        ? { headers: { ...options.headers } }
        : {}),
      ...(options.removeHeaders && options.removeHeaders.length > 0
        ? { removeHeaders: [...options.removeHeaders] }
        : {}),
      createdAt: new Date().toISOString(),
    }

    if (!route.pattern) {
      throw new Error('missing url pattern')
    }

    state.network.routes.push(route)
    await refreshInterceptors()

    return {
      route,
      routes: state.network.routes,
    }
  }

  function listRoutes(): { routes: NetworkRoute[] } {
    return { routes: state.network.routes }
  }

  async function unrouteRequest(tabId: TabInput, url: string): Promise<{ routes: NetworkRoute[] }> {
    if (tabId !== null && tabId !== undefined) {
      await getTargetTab(tabId)
    }

    if (url) {
      state.network.routes = state.network.routes.filter((route) => route.pattern !== String(url))
    } else {
      state.network.routes = []
    }

    await refreshInterceptors()

    return {
      routes: state.network.routes,
    }
  }

  function listRequests(filters: Record<string, unknown> = {}): Record<string, unknown> {
    const requests = state.network.requests.filter((record) =>
      matchesNetworkRequestFilters(record, filters),
    )
    const summarized = requests.map((record) =>
      summarizeNetworkRequest(record, filters.includeDetails === true),
    )
    // 分页作用在过滤/摘要之后；越界 pageIdx 回退第一页并带 invalidPage 标记
    const { items, pagination } = paginateList(
      summarized,
      filters.pageIdx as number | undefined,
      filters.pageSize as number | undefined,
    )
    const result: Record<string, unknown> = {
      total: requests.length,
      requests: items,
      pagination,
    }
    if (requests.length === 0 && filters.allTabs !== true && filters.allEpochs !== true) {
      result.meta = {
        suggestedAction:
          'No requests matched the current tab/current page epoch. Run network requests --all-tabs --all-epochs to inspect historical or cross-tab requests.',
      }
    }
    return result
  }

  async function getRequestDetail(
    requestId: string,
    tabId?: number | null,
  ): Promise<Record<string, unknown>> {
    const record = getNetworkRequestById(state, String(requestId || ''), tabId)
    if (!record) {
      throw new Error(`network request not found: ${requestId}`)
    }
    await fetchRequestBody(
      record,
      state.network.harRecording && record.harCaptureId === capture?.id ? capture : null,
    )

    return {
      request: record,
      summary: summarizeNetworkRequest(record),
      harEntry: buildHarEntry(record),
    }
  }

  async function startHar(
    tabId: TabInput,
    options: { maxRequests?: number | null; maxBodyBytes?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Network.enable', {})
    state.network.harRecording = true
    state.network.harStartedAt = new Date().toISOString()
    state.network.harMaxRequests =
      options.maxRequests === undefined ? DEFAULT_HAR_MAX_REQUESTS : options.maxRequests
    state.network.harMaxBodyBytes =
      options.maxBodyBytes === undefined ? DEFAULT_HAR_MAX_BODY_BYTES : options.maxBodyBytes
    capture = createCapture(tab.id)
    await writeHarCheckpoint()
    return {
      recording: true,
      startedAt: state.network.harStartedAt,
      maxRequests: state.network.harMaxRequests,
      maxBodyBytes: state.network.harMaxBodyBytes,
    }
  }

  async function stopHar(): Promise<Record<string, unknown>> {
    const session = capture
    const startedAt = session?.startedAt ?? state.network.harStartedAt
    const stoppedAt = new Date().toISOString()
    // 快照持有旧记录对象与该 capture 的逻辑等待，不受后续 start/同 key 请求影响。
    const requests = captureRequests(session)
    const pending = [...(session?.pending || [])]
    state.network.harRecording = false
    state.network.harStartedAt = null
    state.network.harMaxRequests = DEFAULT_HAR_MAX_REQUESTS
    state.network.harMaxBodyBytes = DEFAULT_HAR_MAX_BODY_BYTES
    if (checkpointTimer) {
      clearTimeout(checkpointTimer)
      checkpointTimer = null
    }
    await Promise.allSettled(pending)

    const retained = requests.filter((record) => !evictedRequests.has(record))
    let checkpointError: string | null = null
    try {
      if (capture === session && !state.network.harRecording) {
        await writeHarCheckpoint(checkpointPayload(false, session, retained))
      }
    } catch (error) {
      checkpointError = error instanceof Error ? error.message : String(error)
    }
    return {
      recording: false,
      startedAt,
      stoppedAt,
      requestCount: retained.length,
      har: buildHar(retained),
      ...(checkpointError
        ? {
            checkpoint: { saved: false, error: checkpointError },
            suggestedAction:
              'HAR export succeeded, but the checkpoint could not be saved. Use the returned HAR from this stop result; for long captures, restart with lower --har-max-body-bytes/--har-max-requests instead of --har-unlimited.',
          }
        : {}),
    }
  }

  async function getHarStatus(): Promise<Record<string, unknown>> {
    const checkpoint = await readHarCheckpoint()
    return {
      recording: state.network.harRecording,
      startedAt: state.network.harStartedAt,
      requestCount: state.network.requests.length,
      checkpoint: checkpoint
        ? {
            available: true,
            recording: checkpoint.recording === true,
            startedAt: checkpoint.startedAt ?? null,
            updatedAt: checkpoint.updatedAt ?? null,
            requestCount: Array.isArray(checkpoint.requests) ? checkpoint.requests.length : 0,
          }
        : { available: false },
    }
  }

  async function recoverHar(): Promise<Record<string, unknown>> {
    const checkpoint = await readHarCheckpoint()
    const requests = Array.isArray(checkpoint?.requests)
      ? (checkpoint.requests as NetworkRequestRecord[])
      : []
    if (!checkpoint || requests.length === 0) {
      throw new Error('no HAR checkpoint is available')
    }
    return {
      recording: checkpoint.recording === true,
      recovered: true,
      startedAt: checkpoint.startedAt ?? null,
      stoppedAt: checkpoint.updatedAt ?? null,
      requestCount: requests.length,
      har: buildHar([...requests].sort((left, right) => compareHarRecords(left, right))),
    }
  }

  return {
    refreshInterceptors,
    handleRequestPaused,
    handleEvent,
    routeRequest,
    unrouteRequest,
    listRoutes,
    listRequests,
    getRequestDetail,
    startHar,
    stopHar,
    getHarStatus,
    recoverHar,
  }
}
