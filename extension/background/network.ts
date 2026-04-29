import type {
  ExtensionState,
  NetworkRequestRecord,
  NetworkRoute,
  TabInput,
  TabWithId,
} from './types.js'
import { buildHarPayload, compareHarRecords } from '../../src/core/har.js'

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
}

interface FetchRequestPausedParams {
  requestId?: string
  request?: NetworkRequestPayload
  resourceType?: string
  requestStage?: string
  timestamp?: number
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
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function stringifyNetworkBody(body: unknown): { text: string; base64Encoded: boolean } {
  const text = `${JSON.stringify(body, null, 2)}\n`
  return { text, base64Encoded: false }
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

  const index = state.network.requests.findIndex((item) => item.id === key)
  if (index >= 0) {
    state.network.requests[index] = merged
  } else {
    state.network.requests.push(merged)
  }

  if (state.network.requests.length > 1000) {
    const removed = state.network.requests.splice(0, state.network.requests.length - 1000)
    for (const item of removed) {
      if (item && typeof item.id === 'string') {
        state.network.requestMap.delete(item.id)
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
  }
}

function buildHarEntry(record: NetworkRequestRecord): Record<string, unknown> {
  const requestHeaders = normalizeHeaderPairs(normalizeHeaders(record.requestHeaders))
  const responseHeaders = normalizeHeaderPairs(normalizeHeaders(record.responseHeaders))
  const responseBody = typeof record.responseBody === 'string' ? record.responseBody : ''
  const responseBodyBase64 = Boolean(record.responseBodyBase64)
  const responseMimeType = String(record.responseMimeType || 'application/octet-stream')
  const bodySize = responseBodyBase64
    ? Math.max(0, Math.floor(responseBody.length * 0.75))
    : new TextEncoder().encode(responseBody).length

  return {
    startedDateTime: record.startedAt,
    time: typeof record.durationMs === 'number' ? record.durationMs : 0,
    request: {
      method: record.method || 'GET',
      url: record.url || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: requestHeaders,
      queryString: [],
      headersSize: -1,
      bodySize:
        typeof record.postData === 'string' ? new TextEncoder().encode(record.postData).length : 0,
      postData:
        typeof record.postData === 'string'
          ? {
              mimeType: 'application/json',
              text: record.postData,
            }
          : undefined,
    },
    response: {
      status: Number(record.status || 0),
      statusText: String(record.statusText || ''),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: responseHeaders,
      content: {
        size: bodySize,
        mimeType: responseMimeType,
        text: responseBody,
        encoding: responseBodyBase64 ? 'base64' : undefined,
      },
      redirectURL: '',
      headersSize: -1,
      bodySize,
    },
    cache: {},
    timings: {
      send: 0,
      wait: typeof record.waitMs === 'number' ? record.waitMs : 0,
      receive: typeof record.receiveMs === 'number' ? record.receiveMs : 0,
    },
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
      Array.from(state.attachedTabs).map(async (tabId) => {
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
      const record = upsertNetworkRequest(state, {
        id: key,
        requestId,
        tabId,
        url: String(request.url || ''),
        method: String(request.method || 'GET'),
        resourceType: String(payload.resourceType || payload.requestStage || ''),
        requestHeaders: normalizeHeaders(request.headers),
        postData: typeof request.postData === 'string' ? request.postData : undefined,
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
        try {
          await sendRawDebuggerCommand(tabId, 'Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responsePhrase: 'OK',
            responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
            body: encodeBase64(body.text),
          })
          upsertNetworkRequest(state, {
            ...record,
            responseBody: body.text,
            responseBodyBase64: false,
            responseMimeType: 'application/json; charset=utf-8',
            status: 200,
            statusText: 'OK',
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
      const bodyRecord = upsertNetworkRequest(state, {
        ...record,
        responseBody,
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

      upsertNetworkRequest(state, {
        id: createNetworkRequestKey(tabId, requestId),
        requestId,
        tabId,
        url: String(payload.request?.url || ''),
        method: String(payload.request?.method || 'GET'),
        resourceType: String(payload.type || ''),
        requestHeaders: normalizeHeaders(payload.request?.headers),
        postData:
          typeof payload.request?.postData === 'string' ? payload.request.postData : undefined,
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

      void finalizeRequestBody(tabId, requestId)
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
    abort = false,
    body: unknown = undefined,
  ): Promise<{ route: NetworkRoute; routes: NetworkRoute[] }> {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Network.enable', {})
    const route: NetworkRoute = {
      id: createNetworkRouteId(),
      pattern: String(url || '').trim(),
      abort: Boolean(abort),
      body: body === undefined ? undefined : body,
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
    return {
      total: requests.length,
      requests: requests.map((record) => summarizeNetworkRequest(record)),
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

  async function startHar(tabId: TabInput): Promise<Record<string, unknown>> {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Network.enable', {})
    state.network.harRecording = true
    state.network.harStartedAt = new Date().toISOString()
    return {
      recording: true,
      startedAt: state.network.harStartedAt,
    }
  }

  function stopHar(): Record<string, unknown> {
    const startedAt = state.network.harStartedAt
    const stoppedAt = new Date().toISOString()
    state.network.harRecording = false
    state.network.harStartedAt = null

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
    listRequests,
    getRequestDetail,
    startHar,
    stopHar,
  }
}
