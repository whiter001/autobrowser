import type {
  ExtensionState,
  NetworkRequestRecord,
  NetworkRoute,
  TabInput,
  TabWithId,
} from './types.js'
import { buildHarPayload, compareHarRecords } from '../../src/core/har.js'
import { paginateList } from './pagination.js'

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
  /** ResourceTiming：各阶段相对 requestTime 的秒数偏移，HAR timings 近似映射用 */
  timing?: Record<string, number>
}

interface FetchRequestPausedParams {
  requestId?: string
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
  const merged: NetworkRequestRecord = { ...existing, ...record }
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
): NetworkRequestRecord | null {
  if (!requestId) {
    return null
  }

  const exact = state.network.requestMap.get(requestId)
  if (exact) {
    return exact
  }

  return (
    state.network.requests.find(
      (item) => item?.requestId === requestId || item?.id === requestId,
    ) || null
  )
}

function summarizeNetworkRequest(record: NetworkRequestRecord): Record<string, unknown> {
  return {
    id: record.id,
    requestId: record.requestId,
    tabId: record.tabId,
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
    requestHeaders: record.requestHeaders ?? null,
    responseHeaders: record.responseHeaders ?? null,
    requestBody: typeof record.postData === 'string' ? record.postData : null,
    requestBodyTruncated: Boolean(record.postDataTruncated),
    requestBodyBytes: record.postDataBytes ?? null,
    responseBody: typeof record.responseBody === 'string' ? record.responseBody : null,
    responseBodyTruncated: Boolean(record.responseBodyTruncated),
    responseBodyBytes: record.responseBodyBytes ?? null,
    responseMimeType: record.responseMimeType ?? null,
  }
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

/** ResourceTiming 阶段差（秒 → 毫秒，四舍五入到整数毫秒），任一端点缺失返回 null */
function timingDelta(
  timing: Record<string, number>,
  fromKey: string,
  toKey: string,
): number | null {
  const from = timing[fromKey]
  const to = timing[toKey]
  if (typeof from !== 'number' || typeof to !== 'number') {
    return null
  }
  return Math.max(0, Math.round((to - from) * 1000))
}

/**
 * HAR timings 映射（DevTools HAR 也是近似值，参考其惯例）：
 * - blocked = 首个连接阶段 - requestTime；dns/connect/ssl/send/wait 用对应阶段差，
 *   wait = receiveHeadersEnd - sendEnd；
 * - receive 沿用事件时间戳（loadingFinished - responseReceived）的 receiveMs 近似；
 * - 有 timing 时缺失的阶段记 -1（DevTools 惯例），完全没有 timing 时保持旧的
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

  const requestTime = typeof timing.requestTime === 'number' ? timing.requestTime : null
  const deltaFromRequest = (key: string): number | null => {
    if (requestTime === null) {
      return null
    }
    const value = timing[key]
    return typeof value === 'number' ? Math.max(0, Math.round((value - requestTime) * 1000)) : null
  }

  const blocked =
    deltaFromRequest('proxyEnd') ??
    deltaFromRequest('connectStart') ??
    deltaFromRequest('requestStart')
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
    send: send ?? 0,
    wait: wait ?? (typeof record.waitMs === 'number' ? record.waitMs : 0),
    receive: typeof record.receiveMs === 'number' ? record.receiveMs : 0,
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

  if (responseBodyTruncated) {
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
      redirectURL: '',
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
  return buildHarPayload(records.map((record) => buildHarEntry(record)))
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
}: NetworkDomainDependencies) {
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
    const requestId = String(payload.requestId || '')
    if (!requestId) {
      return
    }

    try {
      const route = findMatchingNetworkRoute(state, String(request.url || ''))
      const key = createNetworkRequestKey(tabId, requestId)
      const requestBodySummary =
        typeof request.postData === 'string'
          ? summarizeStoredBody(request.postData, false, getHarMaxBodyBytes(state))
          : null
      const record = upsertNetworkRequest(state, {
        id: key,
        requestId,
        tabId,
        url: String(request.url || ''),
        method: String(request.method || 'GET'),
        resourceType: String(payload.resourceType || payload.requestStage || ''),
        requestHeaders: normalizeHeaders(request.headers),
        postData: requestBodySummary?.text,
        postDataTruncated: requestBodySummary?.truncated,
        postDataBytes: requestBodySummary?.byteLength,
        startedAt: new Date().toISOString(),
        requestWillBeSentAt: typeof payload.timestamp === 'number' ? payload.timestamp : null,
        routeId: route?.id || null,
        routeAction: route?.abort ? 'abort' : route?.body !== undefined ? 'mock' : 'continue',
      })

      if (route?.abort) {
        try {
          await sendRawDebuggerCommand(tabId, 'Fetch.failRequest', {
            requestId,
            errorReason: 'Failed',
          })
          return
        } catch (error) {
          console.error('failed to abort network request', error)
          await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', { requestId })
          return
        }
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
            requestId,
            responseCode: mockStatus,
            ...(HTTP_STATUS_PHRASES[mockStatus]
              ? { responsePhrase: HTTP_STATUS_PHRASES[mockStatus] }
              : {}),
            responseHeaders: mockHeaders,
            body: encodeBase64(body.text),
          })
          upsertNetworkRequest(state, {
            ...record,
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
          return
        } catch (error) {
          console.error('failed to fulfill network request', error)
          await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', { requestId })
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
        await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', { requestId, headers })
        return
      }

      await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', { requestId })
    } catch (error) {
      console.error('failed to process paused network request', error)
    }
  }

  async function finalizeRequestBody(tabId: number, requestId: string): Promise<void> {
    const key = createNetworkRequestKey(tabId, requestId)
    const record = getNetworkRequestById(state, key)
    if (!record) {
      return
    }

    try {
      const result = await sendRawDebuggerCommand<{ body?: string; base64Encoded?: boolean }>(
        tabId,
        'Network.getResponseBody',
        { requestId },
      )
      const responseBody = String(result?.body || '')
      const responseBodySummary = summarizeStoredBody(
        responseBody,
        Boolean(result?.base64Encoded),
        getHarMaxBodyBytes(state),
      )
      const bodyRecord = upsertNetworkRequest(state, {
        ...record,
        responseBody: responseBodySummary.text,
        responseBodyTruncated: responseBodySummary.truncated,
        responseBodyBytes: responseBodySummary.byteLength,
        responseBodyBase64: Boolean(result?.base64Encoded),
      })

      if (!bodyRecord.responseMimeType) {
        bodyRecord.responseMimeType = 'application/octet-stream'
      }
    } catch {
      // Best effort only.
    }
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

      const requestBodySummary =
        typeof payload.request?.postData === 'string'
          ? summarizeStoredBody(payload.request.postData, false, getHarMaxBodyBytes(state))
          : null

      upsertNetworkRequest(state, {
        id: createNetworkRequestKey(tabId, requestId),
        requestId,
        tabId,
        url: String(payload.request?.url || ''),
        method: String(payload.request?.method || 'GET'),
        resourceType: String(payload.type || ''),
        requestHeaders: normalizeHeaders(payload.request?.headers),
        postData: requestBodySummary?.text,
        postDataTruncated: requestBodySummary?.truncated,
        postDataBytes: requestBodySummary?.byteLength,
        startedAt: new Date().toISOString(),
        requestWillBeSentAt: typeof payload.timestamp === 'number' ? payload.timestamp : null,
        wallTime: typeof payload.wallTime === 'number' ? payload.wallTime : null,
        documentUrl: String(payload.documentURL || ''),
      })
      return
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

      const key = createNetworkRequestKey(tabId, requestId)
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

      const bodyFetch = finalizeRequestBody(tabId, requestId)
      // fire-and-forget 的 body 抓取要登记下来，stopHar 导出前会等待它们 settle，
      // 否则“页面加载完立刻 network har stop”时 HAR 会大面积缺响应体
      state.network.pendingBodyFetches.add(bodyFetch)
      void bodyFetch.finally(() => {
        state.network.pendingBodyFetches.delete(bodyFetch)
      })
      return
    }

    if (method === 'Network.loadingFailed') {
      const requestId = String(payload.requestId || '')
      if (!requestId) {
        return
      }

      upsertNetworkRequest(state, {
        id: createNetworkRequestKey(tabId, requestId),
        requestId,
        tabId,
        errorText: String(payload.errorText || 'request failed'),
        canceled: Boolean(payload.canceled),
        finishedAt: new Date().toISOString(),
      })
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
    const summarized = requests.map((record) => summarizeNetworkRequest(record))
    // 分页作用在过滤/摘要之后；越界 pageIdx 回退第一页并带 invalidPage 标记
    const { items, pagination } = paginateList(
      summarized,
      filters.pageIdx as number | undefined,
      filters.pageSize as number | undefined,
    )
    return {
      total: requests.length,
      requests: items,
      pagination,
    }
  }

  function getRequestDetail(requestId: string): Record<string, unknown> {
    const record = getNetworkRequestById(state, String(requestId || ''))
    if (!record) {
      throw new Error(`network request not found: ${requestId}`)
    }

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
    return {
      recording: true,
      startedAt: state.network.harStartedAt,
      maxRequests: state.network.harMaxRequests,
      maxBodyBytes: state.network.harMaxBodyBytes,
    }
  }

  async function stopHar(): Promise<Record<string, unknown>> {
    // 先停记录再等 body：stop 之后 loadingFinished 不再触发新的抓取，
    // 等待当前已注册的 promise 即可（它们是 CDP 请求，自身会超时 settle）
    const startedAt = state.network.harStartedAt
    const stoppedAt = new Date().toISOString()
    state.network.harRecording = false
    state.network.harStartedAt = null
    state.network.harMaxRequests = DEFAULT_HAR_MAX_REQUESTS
    state.network.harMaxBodyBytes = DEFAULT_HAR_MAX_BODY_BYTES

    if (state.network.pendingBodyFetches.size > 0) {
      await Promise.allSettled(state.network.pendingBodyFetches)
    }

    const requests = state.network.requests.filter((record) => {
      if (!startedAt) {
        return true
      }

      return String(record.startedAt || '') >= startedAt
    })

    const harRequests = [...requests].sort((left, right) => compareHarRecords(left, right))

    return {
      recording: false,
      startedAt,
      stoppedAt,
      requestCount: requests.length,
      // 直接在扩展侧生成 HAR，避免 CLI 为了导出再逐条回拉 request detail，形成 N+1 往返。
      har: buildHar(harRequests),
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
  }
}
