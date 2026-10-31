import {
  FILE_UPLOAD_CHUNK_BYTES,
  FILE_UPLOAD_CHUNK_SHA256_HEADER,
  FILE_UPLOAD_COMPLETE_HEADER,
  FILE_SHA256_PATTERN,
  MAX_FILE_UPLOAD_BYTES,
  fileByteRange,
  fileContentRange,
} from '../../src/core/file-transfer.js'

export interface FileUploadSocket {
  readonly readyState: number
  send(data: string): void
}

export interface FileUploadRegistry {
  /** 等待 relay 确认本次文件上传登记；必须在发送登记消息之前调用 */
  expect: (transferId: string, timeoutMs: number) => Promise<void>
  /** relay 的登记回执 */
  confirm: (transferId: string, ok: boolean, message?: string) => void
  /** 登记无法发出时立刻撤销等待，避免残留登记直到超时 */
  cancel: (transferId: string, message?: string) => void
  /** 当前是否仍在等待某个 transferId 的登记回执 */
  has: (transferId: string) => boolean
  /** 连接断开或命令取消时唤醒所有等待者 */
  dispose: () => void
}

export interface FileUploadOptions {
  socket: FileUploadSocket
  registry: FileUploadRegistry
  relayPort: () => number
  token: () => string
  requestId: string
  transferId: string
  totalBytes: number
  sha256: string
  bytes: Uint8Array<ArrayBuffer>
  /** 绝对时间戳（毫秒），超过后必须停止上传 */
  deadlineAt?: number | null
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  retryDelayMs?: number
  maxRetries?: number
}

export interface FileUploadResult {
  transferId: string
  receivedBytes: number
  totalBytes: number
}

export interface FileStreamUploadOptions {
  socket: FileUploadSocket
  registry: FileUploadRegistry
  relayPort: () => number
  token: () => string
  requestId: string
  transferId: string
  /** 已知总长度；流式上传不把整个文件留在内存里 */
  totalBytes: number
  /** 源字节流，按块读取 */
  source: ReadableStream<Uint8Array>
  /** 绝对时间戳（毫秒），超过后必须停止上传 */
  deadlineAt?: number | null
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  retryDelayMs?: number
  maxRetries?: number
  chunkBytes?: number
}

export interface FileStreamUploadResult {
  transferId: string
  receivedBytes: number
  totalBytes: number
  /** relay 边写边算出的整文件摘要 */
  sha256: string
}

const DEFAULT_MAX_RETRIES = 3

/** 可重试的 HTTP 状态：停滞、超时和 offset 冲突都可以从已确认偏移续传 */
const RETRYABLE_STATUS = new Set([408, 409])

export class FileUploadClientError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'FileUploadClientError'
  }
}

interface PendingRegistration {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createFileUploadRegistry(): FileUploadRegistry {
  const pending = new Map<string, PendingRegistration>()

  // 取出并移除等待项，调用方决定如何结束它
  function take(transferId: string): PendingRegistration | undefined {
    const entry = pending.get(transferId)
    if (!entry) return undefined
    pending.delete(transferId)
    clearTimeout(entry.timer)
    return entry
  }

  return {
    expect(transferId: string, timeoutMs: number) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(transferId)
            reject(new FileUploadClientError('File upload registration timed out'))
          },
          Math.max(0, timeoutMs),
        )
        pending.set(transferId, { resolve, reject, timer })
      })
    },
    confirm(transferId: string, ok: boolean, message?: string) {
      const entry = take(transferId)
      if (!entry) return
      if (ok) {
        entry.resolve()
        return
      }
      entry.reject(
        new FileUploadClientError(message || 'File upload registration was rejected by the relay'),
      )
    },
    cancel(transferId: string, message?: string) {
      const entry = take(transferId)
      if (!entry) return
      entry.reject(new FileUploadClientError(message || 'File upload registration was cancelled'))
    },
    has(transferId: string) {
      return pending.has(transferId)
    },
    dispose() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new FileUploadClientError('File upload registration was cancelled'))
      }
      pending.clear()
    },
  }
}

interface UploadResultPayload {
  receivedBytes: number
  sha256: string | null
}

async function readUploadResult(response: Response): Promise<UploadResultPayload> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new FileUploadClientError('File upload returned invalid JSON')
  }
  const result = (payload as { result?: { receivedBytes?: unknown; sha256?: unknown } }).result
  if (
    !result ||
    typeof result.receivedBytes !== 'number' ||
    !Number.isSafeInteger(result.receivedBytes) ||
    result.receivedBytes < 0
  )
    throw new FileUploadClientError('File upload returned an invalid offset')
  const sha256 =
    typeof result.sha256 === 'string' && FILE_SHA256_PATTERN.test(result.sha256)
      ? result.sha256
      : null
  return { receivedBytes: result.receivedBytes, sha256 }
}

async function readConfirmedOffset(response: Response): Promise<number> {
  return (await readUploadResult(response)).receivedBytes
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    const aborted = () => {
      clearTimeout(timer)
      reject(new FileUploadClientError('File upload was cancelled'))
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

/** 读取源流的一块；取消信号到达时立刻中断等待 */
async function readSource(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (!signal) return await reader.read()
  if (signal.aborted) throw new FileUploadClientError('File upload was cancelled')
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          void reader.cancel().catch(() => {})
          reject(new FileUploadClientError('File upload was cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 把二进制直传到 relay 的本地 HTTP 文件通道：先在 WebSocket 上登记，
 * 再按 Content-Range 顺序分段 POST；失败时以 relay 确认的偏移续传。
 */
export async function uploadFileBytes(options: FileUploadOptions): Promise<FileUploadResult> {
  const fetchImpl = options.fetchImpl || fetch
  const retryDelayMs = options.retryDelayMs ?? 100
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const totalBytes = options.totalBytes
  const bytes = options.bytes
  const endpoint = () => `http://127.0.0.1:${options.relayPort()}/files/${options.transferId}`

  if (bytes.byteLength !== totalBytes) {
    throw new FileUploadClientError('File upload byte length does not match totalBytes')
  }
  if (totalBytes > MAX_FILE_UPLOAD_BYTES) {
    throw new FileUploadClientError('File exceeds the 512MiB upload budget')
  }

  const ready = options.registry.expect(
    options.transferId,
    Math.max(0, (options.deadlineAt ?? Date.now() + 30_000) - Date.now()),
  )
  // 提前挂上观察者：登记失败时 ready 会被拒绝，没人观察就会变成 unhandled rejection
  const readyObserved = ready.catch(() => {})
  try {
    options.socket.send(
      JSON.stringify({
        type: 'file.upload',
        id: options.requestId,
        transferId: options.transferId,
        totalBytes,
        sha256: options.sha256,
      }),
    )
  } catch (error) {
    // 登记没发出去就立刻撤销等待并唤醒等待者，不能让它残留到超时
    options.registry.cancel(options.transferId, 'File upload registration was not sent')
    await readyObserved
    throw new FileUploadClientError(
      `Failed to send the file upload registration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  await ready

  async function queryOffset(): Promise<number | null> {
    try {
      const response = await fetchImpl(endpoint(), {
        headers: { authorization: `Bearer ${options.token()}` },
        signal: options.signal,
      })
      if (!response.ok) return null
      return await readConfirmedOffset(response)
    } catch {
      return null
    }
  }

  let offset = 0
  let retries = 0
  // 空文件也要发一次确认请求，relay 需要据此创建目标文件
  let firstSegment = true
  while (firstSegment || offset < totalBytes) {
    firstSegment = false
    try {
      const end = Math.min(offset + FILE_UPLOAD_CHUNK_BYTES, totalBytes)
      const chunk = totalBytes === 0 ? new Uint8Array(0) : bytes.subarray(offset, end)
      const response = await fetchImpl(endpoint(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token()}`,
          'content-range': fileContentRange(offset, totalBytes),
          'content-type': 'application/octet-stream',
        },
        body: chunk,
        signal: options.signal,
      })
      if (!response.ok) {
        throw new FileUploadClientError(
          `File upload failed with HTTP ${response.status}`,
          RETRYABLE_STATUS.has(response.status) || response.status >= 500,
        )
      }
      const receivedBytes = await readConfirmedOffset(response)
      if (receivedBytes < offset || receivedBytes > totalBytes)
        throw new FileUploadClientError('File upload returned an out-of-range confirmed offset')
      if (receivedBytes === offset && receivedBytes < totalBytes)
        throw new FileUploadClientError('File upload did not advance the confirmed offset', true)
      offset = receivedBytes
      retries = 0
    } catch (error) {
      if (error instanceof FileUploadClientError && !error.retryable) throw error
      if (options.signal?.aborted) throw new FileUploadClientError('File upload was cancelled')
      if (retries >= maxRetries)
        throw new FileUploadClientError('File upload failed after resume attempts')
      retries += 1
      await delay(retryDelayMs, options.signal)
      const confirmed = await queryOffset()
      // relay 确认的偏移才是权威值：本地猜测可能落后于实际已落盘的字节
      if (confirmed !== null) {
        if (confirmed < 0 || confirmed > totalBytes)
          throw new FileUploadClientError('File upload returned an out-of-range resume offset')
        offset = confirmed
      }
    }
  }

  return { transferId: options.transferId, receivedBytes: offset, totalBytes }
}

/**
 * 大文件流式上传：扩展按固定大小的块把源流直传 relay，任何时刻内存里只保留当前一块。
 * 每块带自己的 SHA-256，relay 校验通过后才确认偏移；失败时以 relay 确认的偏移为准，
 * 只需重发保留块尚未确认的剩余部分，不会重放已确认的字节。
 */
export async function uploadFileStream(
  options: FileStreamUploadOptions,
): Promise<FileStreamUploadResult> {
  const fetchImpl = options.fetchImpl || fetch
  const retryDelayMs = options.retryDelayMs ?? 100
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const totalBytes = options.totalBytes
  const chunkBytes = Math.max(
    1,
    Math.min(options.chunkBytes ?? FILE_UPLOAD_CHUNK_BYTES, FILE_UPLOAD_CHUNK_BYTES),
  )
  const endpoint = () => `http://127.0.0.1:${options.relayPort()}/files/${options.transferId}`

  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new FileUploadClientError('File upload requires a known positive totalBytes')
  }
  if (totalBytes > MAX_FILE_UPLOAD_BYTES) {
    throw new FileUploadClientError('File exceeds the 512MiB upload budget')
  }

  const ready = options.registry.expect(
    options.transferId,
    Math.max(0, (options.deadlineAt ?? Date.now() + 30_000) - Date.now()),
  )
  const readyObserved = ready.catch(() => {})
  try {
    // 流式上传没有整文件摘要：relay 收到全部字节后自己边写边算
    options.socket.send(
      JSON.stringify({
        type: 'file.upload',
        id: options.requestId,
        transferId: options.transferId,
        totalBytes,
        sha256: null,
        stream: true,
      }),
    )
  } catch (error) {
    options.registry.cancel(options.transferId, 'File upload registration was not sent')
    await readyObserved
    throw new FileUploadClientError(
      `Failed to send the file upload registration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  await ready

  async function queryProgress(): Promise<UploadResultPayload | null> {
    try {
      const response = await fetchImpl(endpoint(), {
        headers: { authorization: `Bearer ${options.token()}` },
        signal: options.signal,
      })
      if (!response.ok) return null
      return await readUploadResult(response)
    } catch {
      return null
    }
  }

  const reader = options.source.getReader()
  // 单块缓冲：整个上传过程里扩展最多持有 chunkBytes 字节
  const chunk = new Uint8Array(chunkBytes)
  let chunkLength = 0
  let chunkStart = 0
  let readBytes = 0
  let confirmed = 0
  let eof = false
  let carry: Uint8Array | null = null
  let finalSha256: string | null = null

  async function fillChunk(): Promise<void> {
    while (!eof && chunkLength < chunkBytes) {
      // 源流给的块可能比剩余空间还大，多出来的部分留到下一块，不能丢字节
      let part = carry
      carry = null
      if (!part) {
        const next = await readSource(reader, options.signal)
        if (next.done) {
          eof = true
          break
        }
        part = next.value ?? null
      }
      if (!part || part.byteLength === 0) continue
      const capacity = Math.min(chunkBytes - chunkLength, totalBytes - readBytes)
      if (capacity <= 0) {
        eof = true
        break
      }
      const take = Math.min(part.byteLength, capacity)
      chunk.set(part.subarray(0, take), chunkLength)
      chunkLength += take
      readBytes += take
      if (take < part.byteLength) carry = part.subarray(take)
    }
  }

  /** 发送当前保留块；返回 relay 给出的整文件摘要（只有最后一段才有） */
  async function sendChunk(): Promise<string | null> {
    let from = chunkStart
    let attempts = 0
    let stalls = 0
    for (;;) {
      if (confirmed >= chunkStart + chunkLength) return finalSha256
      const payload = chunk.subarray(from - chunkStart, chunkLength)
      const digest = await sha256Hex(payload)
      const complete = from + payload.byteLength === totalBytes
      const before = confirmed
      try {
        const response = await fetchImpl(endpoint(), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token()}`,
            'content-range': fileByteRange(from, payload.byteLength, totalBytes),
            'content-type': 'application/octet-stream',
            [FILE_UPLOAD_CHUNK_SHA256_HEADER]: digest,
            ...(complete ? { [FILE_UPLOAD_COMPLETE_HEADER]: '1' } : {}),
          },
          body: payload,
          signal: options.signal,
        })
        if (!response.ok) {
          throw new FileUploadClientError(
            `File upload failed with HTTP ${response.status}`,
            RETRYABLE_STATUS.has(response.status) || response.status >= 500,
          )
        }
        const result = await readUploadResult(response)
        confirmed = result.receivedBytes
        if (result.sha256) finalSha256 = result.sha256
        if (confirmed < chunkStart)
          throw new FileUploadClientError(
            'File upload confirmed an offset before the retained chunk',
          )
        if (confirmed > chunkStart + chunkLength)
          throw new FileUploadClientError('File upload confirmed an offset beyond the sent chunk')
        if (confirmed > before) {
          stalls = 0
        } else {
          stalls += 1
          if (stalls > maxRetries)
            throw new FileUploadClientError(
              'File upload did not advance the confirmed offset',
              true,
            )
        }
        if (confirmed === chunkStart + chunkLength) return finalSha256
        // 只确认了一部分：保留块还在手里，只需重发尚未确认的剩余部分
        from = confirmed
      } catch (error) {
        if (error instanceof FileUploadClientError && !error.retryable) throw error
        if (options.signal?.aborted) throw new FileUploadClientError('File upload was cancelled')
        if (attempts >= maxRetries)
          throw new FileUploadClientError('File upload failed after resume attempts')
        attempts += 1
        await delay(retryDelayMs, options.signal)
        // relay 确认的偏移才是权威值：本地猜测可能落后于实际已落盘的字节
        const progress = await queryProgress()
        if (progress) {
          if (progress.receivedBytes < chunkStart)
            throw new FileUploadClientError(
              'File upload lost confirmed bytes of the retained chunk',
            )
          if (progress.receivedBytes > chunkStart + chunkLength)
            throw new FileUploadClientError('File upload confirmed an offset beyond the sent chunk')
          confirmed = progress.receivedBytes
          if (progress.sha256) finalSha256 = progress.sha256
          from = progress.receivedBytes
          if (confirmed === chunkStart + chunkLength) return finalSha256
        }
      }
    }
  }

  try {
    for (;;) {
      await fillChunk()
      if (chunkLength === 0) break
      const digest = await sendChunk()
      if (digest) finalSha256 = digest
      // 该块已被 relay 确认，缓冲可以整体丢弃
      chunkStart += chunkLength
      chunkLength = 0
      if (chunkStart >= totalBytes) break
    }
  } finally {
    reader.releaseLock()
  }

  if (readBytes !== totalBytes)
    throw new FileUploadClientError('File upload ended before all bytes were read')
  if (confirmed !== totalBytes)
    throw new FileUploadClientError('File upload ended before all bytes were confirmed')
  if (!finalSha256) {
    // 最后一段的响应可能丢了，回查一次权威进度拿回 relay 算出的摘要
    const progress = await queryProgress()
    if (progress?.sha256) finalSha256 = progress.sha256
  }
  if (!finalSha256) throw new FileUploadClientError('File upload did not return a digest')

  return {
    transferId: options.transferId,
    receivedBytes: confirmed,
    totalBytes,
    sha256: finalSha256,
  }
}
