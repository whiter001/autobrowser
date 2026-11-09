import type {
  ExtensionState,
  NetworkRequestRecord,
  NetworkRoute,
  TabInput,
  TabWithId,
} from './types.js'
import { compareHarRecords } from '../../src/core/har.js'
import { paginateList } from './pagination.js'
import { getPageEpoch } from './targeting.js'
import { buildHar, buildHarEntry } from './network-har.js'
import {
  createBodyFetcher,
  encodeBase64,
  stringifyNetworkBody,
  summarizeStoredBody,
} from './network-body.js'
import {
  createHarCaptureController,
  DEFAULT_HAR_MAX_BODY_BYTES,
  DEFAULT_HAR_MAX_REQUESTS,
  getHarMaxBodyBytes,
} from './network-capture.js'
import {
  createNetworkRequestKey,
  evictedRequests,
  getNetworkRequestById,
  matchesNetworkRequestFilters,
  normalizeHeaderPairs,
  normalizeHeaders,
  summarizeNetworkRequest,
  upsertNetworkRequest,
} from './network-records.js'

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

interface NetworkRouteOptions {
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

function findMatchingNetworkRoute(state: ExtensionState, url: string): NetworkRoute | null {
  return state.network.routes.find((route) => matchesNetworkRoute(route.pattern, url)) || null
}

/** 未被 requestWillBeSent 消费的拦截条目上限，防止只被 mock/abort 的请求长期堆积 */
const PENDING_INTERCEPTION_MAX = 512

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

/**
 * 创建网络域：请求列表与详情、拦截规则，以及 HAR 录制导出。
 */
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
  const captureController = createHarCaptureController({ state, storageLocalGet, storageLocalSet })
  const captureWindowCache = new WeakMap<
    object,
    { requestCount: number; members: Set<NetworkRequestRecord> }
  >()
  const bodyFetcher = createBodyFetcher({
    state,
    sendRawDebuggerCommand,
    shouldFetchBody: (record, capture) => {
      if (!capture || capture.maxRequests === null) return true
      const requestCount = state.network.requests.length
      let cached = captureWindowCache.get(capture)
      if (!cached || cached.requestCount !== requestCount) {
        cached = {
          requestCount,
          members: new Set(captureController.captureRequests(capture)),
        }
        captureWindowCache.set(capture, cached)
      }
      return cached.members.has(record)
    },
  })
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

  async function refreshInterceptors(onlyTabId?: number): Promise<void> {
    const tabIds =
      onlyTabId === undefined
        ? Array.from(state.targeting.attachedTabs)
        : state.targeting.attachedTabs.has(onlyTabId)
          ? [onlyTabId]
          : []
    await Promise.allSettled(
      tabIds.map(async (tabId) => {
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
      const capture = captureController.getCapture()
      const capturedHarId =
        state.network.harRecording &&
        capture &&
        (capture.tabId === null || capture.tabId === tabId) &&
        captureController.captureMatchesUrl(capture, String(request.url || ''))
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

      const capture = captureController.getCapture()
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
          (capture.tabId === null || capture.tabId === tabId) &&
          captureController.captureMatchesUrl(capture, networkRequest.url)
            ? capture.id
            : '',
      })
      bodyFetcher.pumpBodyQueue()
      captureController.scheduleHarCheckpoint()
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

      const capture = captureController.getCapture()
      if (record && state.network.harRecording && capture && record.harCaptureId === capture.id) {
        void bodyFetcher.fetchRequestBody(record, capture)
      }
      captureController.scheduleHarCheckpoint()
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
      captureController.scheduleHarCheckpoint()
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

  function listRoutes(pageIdx?: number, pageSize?: number, limit?: number, cursor?: string) {
    const { items, pagination } = paginateList(state.network.routes, pageIdx, pageSize, {
      limit,
      cursor,
      defaultLimit: 50,
      maxLimit: 200,
      queryKey: 'routes',
      getKey: (route) => String(route.id),
    })
    return { routes: items, total: state.network.routes.length, pagination }
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
    const filtered = state.network.requests.filter((record) =>
      matchesNetworkRequestFilters(record, filters),
    )
    // newest 只在过滤之后反转，未排序时保持记录写入顺序（oldest）；不改动源数组
    const requests = filters.sort === 'newest' ? [...filtered].reverse() : filtered
    const summarized = requests.map((record) =>
      summarizeNetworkRequest(record, filters.includeDetails === true),
    )
    // 分页作用在过滤/摘要之后；越界 pageIdx 回退第一页并带 invalidPage 标记
    const { pageIdx, pageSize, limit, cursor, ...queryKey } = filters
    const { items, pagination } = paginateList(
      summarized,
      pageIdx as number | undefined,
      pageSize as number | undefined,
      {
        limit: limit as number | undefined,
        cursor: cursor as string | undefined,
        queryKey,
        getKey: (item) => String(item.ref || item.id),
      },
    )
    const result: Record<string, unknown> = {
      total: requests.length,
      requests: items,
      empty: items.length === 0,
      ...(items.length === 0
        ? { emptyReason: state.network.requests.length === 0 ? 'NO_DATA' : 'FILTERED_OUT' }
        : {}),
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
      if (/^r\d+$/i.test(requestId)) {
        throw Object.assign(new Error(`network request ref is stale or unknown: ${requestId}`), {
          code: 'STALE_REQUEST_REF',
          suggestedAction: 'Run network requests again and use a ref from the current result.',
        })
      }
      throw new Error(`network request not found: ${requestId}`)
    }
    const capture = captureController.getCapture()
    await bodyFetcher.fetchRequestBody(
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
    options: {
      maxRequests?: number | null
      maxBodyBytes?: number | null
      includePattern?: string
      excludePattern?: string
    } = {},
  ): Promise<Record<string, unknown>> {
    const tab = await getTargetTab(tabId)
    bodyFetcher.resetBodyCapture()
    await sendDebuggerCommand(tab.id, 'Network.enable', {})
    state.network.harRecording = true
    state.network.harStartedAt = new Date().toISOString()
    state.network.harMaxRequests =
      options.maxRequests === undefined ? DEFAULT_HAR_MAX_REQUESTS : options.maxRequests
    state.network.harMaxBodyBytes =
      options.maxBodyBytes === undefined ? DEFAULT_HAR_MAX_BODY_BYTES : options.maxBodyBytes
    const session = captureController.createCapture(tab.id, options)
    captureController.setCapture(session)
    await captureController.writeHarCheckpoint()
    return {
      recording: true,
      captureId: session.id,
      captureTabId: tab.id,
      includePattern: session.includePattern,
      excludePattern: session.excludePattern,
      startedAt: session.startedAt,
      maxRequests: session.maxRequests,
      maxBodyBytes: session.maxBodyBytes,
    }
  }

  async function stopHar(
    options: { captureId?: string; includeUrls?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const session = captureController.getCapture()
    if (options.captureId !== undefined) {
      if (typeof options.captureId !== 'string' || !options.captureId.trim()) {
        throw new Error('captureId must be a non-empty string')
      }
      if (!state.network.harRecording || !session) {
        throw new Error('HAR capture is not recording')
      }
      if (options.captureId !== captureController.getCaptureId(session)) {
        throw new Error('HAR captureId does not match the active capture')
      }
    }
    if (options.includeUrls !== undefined && typeof options.includeUrls !== 'boolean') {
      throw new Error('includeUrls must be a boolean')
    }
    const startedAt = session?.startedAt ?? state.network.harStartedAt
    const stoppedAt = new Date().toISOString()
    // 快照持有旧记录对象与该 capture 的逻辑等待，不受后续 start/同 key 请求影响。
    const requests = captureController.captureRequests(session)
    const pending = [...(session?.pending || [])]
    state.network.harRecording = false
    state.network.harStartedAt = null
    state.network.harMaxRequests = DEFAULT_HAR_MAX_REQUESTS
    state.network.harMaxBodyBytes = DEFAULT_HAR_MAX_BODY_BYTES
    captureController.clearCheckpointTimer()
    await Promise.allSettled(pending)

    const retained = requests.filter((record) => !evictedRequests.has(record))
    let checkpointError: string | null = null
    try {
      if (captureController.getCapture() === session && !state.network.harRecording) {
        await captureController.writeHarCheckpoint(
          captureController.checkpointPayload(false, session, retained),
        )
      }
    } catch (error) {
      checkpointError = error instanceof Error ? error.message : String(error)
    }
    return {
      recording: false,
      captureId: captureController.getCaptureId(session),
      ...(options.includeUrls
        ? { urls: [...new Set(retained.flatMap((record) => (record.url ? [record.url] : [])))] }
        : {}),
      captureTabId: session?.tabId ?? null,
      includePattern: session?.includePattern ?? null,
      excludePattern: session?.excludePattern ?? null,
      startedAt,
      stoppedAt,
      requestCount: retained.length,
      bodyCapture: bodyFetcher.getBodyCaptureStatus(),
      har: buildHar(retained),
      checkpoint: checkpointError ? { saved: false, error: checkpointError } : { saved: true },
      ...(checkpointError
        ? {
            suggestedAction:
              'HAR export succeeded, but the checkpoint could not be saved. Use the returned HAR from this stop result; for long captures, restart with lower --har-max-body-bytes/--har-max-requests instead of --har-unlimited.',
          }
        : {}),
    }
  }

  async function getHarStatus(): Promise<Record<string, unknown>> {
    const checkpoint = await captureController.readHarCheckpoint()
    const requestCount = Array.isArray(checkpoint?.requests) ? checkpoint.requests.length : 0
    const capture = captureController.getCapture()
    const lastCheckpointError = captureController.getLastCheckpointError()
    return {
      recording: state.network.harRecording,
      captureId: captureController.getCaptureId(capture),
      captureTabId: capture?.tabId ?? null,
      captureRequestCount: captureController.captureRequests(capture).length,
      startedAt: state.network.harStartedAt,
      requestCount: state.network.requests.length,
      bodyCapture: bodyFetcher.getBodyCaptureStatus(),
      checkpoint: checkpoint
        ? {
            available: true,
            recoverable: requestCount > 0,
            recording: checkpoint.recording === true,
            captureId: typeof checkpoint.captureId === 'string' ? checkpoint.captureId : null,
            captureTabId:
              typeof checkpoint.captureTabId === 'number' ? checkpoint.captureTabId : null,
            startedAt: checkpoint.startedAt ?? null,
            updatedAt: checkpoint.updatedAt ?? null,
            requestCount,
            ...(lastCheckpointError ? { error: lastCheckpointError } : {}),
          }
        : {
            available: false,
            recoverable: false,
            captureId: null,
            ...(lastCheckpointError ? { error: lastCheckpointError } : {}),
          },
    }
  }

  async function recoverHar(): Promise<Record<string, unknown>> {
    const checkpoint = await captureController.readHarCheckpoint()
    const requests = Array.isArray(checkpoint?.requests)
      ? (checkpoint.requests as NetworkRequestRecord[])
      : []
    if (!checkpoint || requests.length === 0) {
      throw new Error('no HAR checkpoint is available')
    }
    return {
      recording: checkpoint.recording === true,
      captureId: typeof checkpoint.captureId === 'string' ? checkpoint.captureId : null,
      recovered: true,
      captureTabId: typeof checkpoint.captureTabId === 'number' ? checkpoint.captureTabId : null,
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
