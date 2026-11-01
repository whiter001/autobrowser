import { buildHarPayload, compareHarRecords } from '../../src/core/har.js'
import type { NetworkRequestRecord } from './types.js'
import { estimateTextByteLength } from './network-body.js'
import {
  createNetworkRequestKey,
  normalizeHeaderPairs,
  normalizeHeaders,
} from './network-records.js'

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

export function buildHarEntry(record: NetworkRequestRecord): Record<string, unknown> {
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

export function buildHar(records: NetworkRequestRecord[]): Record<string, unknown> {
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
