import type { ExtensionState, NetworkRequestRecord } from './types.js'
import { getPageEpoch } from './targeting.js'
import { createNetworkRequestKey, evictedRequests } from './network-records.js'
import { DEFAULT_HAR_MAX_BODY_BYTES } from './network-capture.js'
import type { HarCapture } from './network-capture.js'

const BODY_FETCH_CONCURRENCY = 4
const BODY_FETCH_QUEUE_LIMIT = 1000
const BODY_FETCH_TIMEOUT_MS = 10_000

/** 估算文本的 UTF-8 字节长度。 */
export function estimateTextByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function truncateTextByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) return ''
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/, '')
}

/** 按上限截断已存响应体。base64 体用长度 * 0.75 估算解码后大小。 */
export function summarizeStoredBody(
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
  if (base64Encoded) return { text: '', byteLength, truncated: true }
  return {
    text: truncateTextByBytes(body, maxBytes),
    byteLength,
    truncated: true,
  }
}

/** 把响应体转成可存储文本；已是字符串时不再 JSON.stringify。 */
export function stringifyNetworkBody(body: unknown): { text: string; base64Encoded: boolean } {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`
  return { text, base64Encoded: false }
}

/** 分块编码再 btoa，避免超大字节数组一次性展开导致调用栈溢出。 */
export function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const chunk = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

interface BodyFetchTask {
  record: NetworkRequestRecord
  capture: HarCapture | null
  maxBodyBytes: number | null
  generation: number
  done: Promise<void>
  finish: (error?: string) => void
  settled: boolean
}

interface BodyCaptureStatus {
  degraded: boolean
  reason: string | null
  droppedQueued: number
  active: number
  queued: number
}

interface BodyFetcher {
  fetchRequestBody(record: NetworkRequestRecord, session: HarCapture | null): Promise<void>
  pumpBodyQueue(): void
  getBodyCaptureStatus(): BodyCaptureStatus
  resetBodyCapture(): void
}

function isBodyQuotaError(message: string): boolean {
  return /Resource::kQuotaBytes|quota exceeded/i.test(message)
}

/** 响应体抓取调度器：配额错误熔断排队工作，逻辑超时仍不伪装成已取消底层 CDP。 */
export function createBodyFetcher({
  state,
  sendRawDebuggerCommand,
  shouldFetchBody = () => true,
}: {
  state: ExtensionState
  sendRawDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
  shouldFetchBody?: (record: NetworkRequestRecord, capture: HarCapture | null) => boolean
}): BodyFetcher {
  const bodyTasks = new WeakMap<NetworkRequestRecord, BodyFetchTask>()
  const bodyQueue: BodyFetchTask[] = []
  let activeBodyFetches = 0
  let circuitReason: string | null = null
  let droppedQueued = 0
  let generation = 0

  function circuitError(): string {
    return `body capture unavailable after ${circuitReason || 'quota exhaustion'}`
  }

  function bodyUnavailable(
    record: NetworkRequestRecord,
    capture: HarCapture | null,
  ): string | null {
    if (evictedRequests.has(record)) return 'request was evicted before body retrieval'
    if (record.redirectArchived) return 'redirect hop body is no longer available from CDP'
    if (!shouldFetchBody(record, capture))
      return 'request is outside the HAR capture request window'
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

  function tripCircuit(reason: string): void {
    if (circuitReason) return
    circuitReason = reason
    const dropped = bodyQueue.splice(0)
    droppedQueued += dropped.length
    for (const task of dropped) task.finish(circuitError())
  }

  function pumpBodyQueue(): void {
    if (circuitReason) {
      tripCircuit(circuitReason)
      return
    }
    for (let index = bodyQueue.length - 1; index >= 0; index -= 1) {
      const task = bodyQueue[index]!
      const reason = bodyUnavailable(task.record, task.capture)
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
      const message = error instanceof Error ? error.message : String(error)
      // 旧 capture 的迟到错误不能熔断已经开始的新 capture。
      if (task.generation === generation && isBodyQuotaError(message)) tripCircuit(message)
      task.finish(message)
    } finally {
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
    if (circuitReason) {
      record.responseBodyError = circuitError()
      return Promise.resolve()
    }
    const reason = bodyUnavailable(record, session)
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
      generation,
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

  function getBodyCaptureStatus(): BodyCaptureStatus {
    return {
      degraded: circuitReason !== null,
      reason: circuitReason,
      droppedQueued,
      active: activeBodyFetches,
      queued: bodyQueue.length,
    }
  }

  function resetBodyCapture(): void {
    generation += 1
    circuitReason = null
    droppedQueued = 0
  }

  return {
    fetchRequestBody,
    pumpBodyQueue,
    getBodyCaptureStatus,
    resetBodyCapture,
  }
}
