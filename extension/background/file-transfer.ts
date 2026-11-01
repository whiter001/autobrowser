import type { CommandExecutionContext } from './command-queue.js'
import type { ExtensionState } from './types.js'
import {
  createFileUploadRegistry,
  uploadFileBytes,
  uploadFileStream,
  type FileUploadRegistry,
} from './file-upload.js'
import {
  FILE_UPLOAD_STREAM_THRESHOLD_BYTES,
  MAX_FILE_UPLOAD_BYTES,
  DEFAULT_DOWNLOAD_RETRIES,
  DEFAULT_DOWNLOAD_RETRY_DELAY_MS,
  MAX_DOWNLOAD_RETRIES,
  MAX_DOWNLOAD_RETRY_DELAY_MS,
} from '../../src/core/file-transfer.js'

interface FileTransferResult {
  /** CLI 请求的原始地址 */
  sourceUrl: string
  /** 跟随重定向后的最终地址 */
  finalUrl: string
  contentType: string | null
  bytes: number
  sha256: string
}

export interface FileTransferDomain {
  download: (args: {
    url: string
    retries?: number
    retryDelayMs?: number
    requestId?: string
    deadlineAt?: string | null
    context?: CommandExecutionContext
  }) => Promise<FileTransferResult>
  /** relay 的文件上传登记回执 */
  confirmRegistration: (transferId: string, ok: boolean, message?: string) => void
  dispose: () => void
}

interface FileTransferOptions {
  state: ExtensionState
  registry?: FileUploadRegistry
  fetchImpl?: typeof fetch
  retryDelayMs?: number
}

const CANCEL_POLL_INTERVAL_MS = 200

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** 解析 Content-Length；缺失或非法时返回 null，表示长度未知 */
function readContentLength(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return parsed
}

/**
 * 浏览器侧取文件并直传 relay：扩展用 background fetch 抓二进制，
 * 再走本地鉴权 HTTP 通道上传，二进制不进 WebSocket 也不走 response upload。
 */
export function createFileTransferDomain(options: FileTransferOptions): FileTransferDomain {
  const registry = options.registry || createFileUploadRegistry()
  const fetchImpl = options.fetchImpl || fetch

  async function download(args: {
    url: string
    retries?: number
    retryDelayMs?: number
    requestId?: string
    deadlineAt?: string | null
    context?: CommandExecutionContext
  }): Promise<FileTransferResult> {
    const socket = options.state.connection.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('no relay connection is available for the file transfer')
    }
    if (!options.state.connection.fileUploadSupported) {
      throw new Error('the connected relay does not support the file upload channel')
    }
    if (!args.requestId) {
      throw new Error('file transfer requires a command id')
    }

    const controller = new AbortController()
    const deadlineMs = args.deadlineAt ? Date.parse(args.deadlineAt) : Number.NaN
    const deadlineTimer = Number.isFinite(deadlineMs)
      ? setTimeout(
          () => controller.abort(new Error('File transfer deadline exceeded')),
          Math.max(0, deadlineMs - Date.now()),
        )
      : undefined
    // 命令被取消时队列不会中断底层任务，这里轮询取消标记并主动中止 fetch/上传
    const cancelTimer = args.context
      ? setInterval(() => {
          if (args.context?.cancelled) {
            controller.abort(new Error('File transfer was cancelled'))
          }
        }, CANCEL_POLL_INTERVAL_MS)
      : undefined

    const retries = args.retries ?? DEFAULT_DOWNLOAD_RETRIES
    const retryDelayMs = args.retryDelayMs ?? DEFAULT_DOWNLOAD_RETRY_DELAY_MS
    const checkActive = () => {
      if (args.context?.cancelled) controller.abort(new Error('File transfer was cancelled'))
      if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
        controller.abort(new Error('File transfer deadline exceeded'))
      }
      controller.signal.throwIfAborted()
    }
    const waitForRetry = async (attempt: number) => {
      checkActive()
      const delay = retryDelayMs * 2 ** attempt
      // 不开始一个注定耗尽剩余预算的 sleep，也不为重试重置 deadline。
      if (Number.isFinite(deadlineMs) && delay >= deadlineMs - Date.now()) {
        throw new Error('File transfer deadline exceeded')
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', onAbort)
          reject(controller.signal.reason)
        }
        const timer = setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort)
          resolve()
        }, delay)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      checkActive()
    }
    const fetchSource = async (): Promise<Response> => {
      for (let attempt = 0; ; attempt += 1) {
        checkActive()
        let response: Response
        try {
          response = await fetchImpl(args.url, {
            credentials: 'include',
            signal: controller.signal,
          })
        } catch (error) {
          checkActive()
          const networkError =
            error instanceof TypeError || (error instanceof Error && error.name === 'NetworkError')
          if (!networkError || attempt >= retries) throw error
          await waitForRetry(attempt)
          continue
        }
        checkActive()
        if (response.ok) return response
        // 丢弃失败响应，避免重试时留下未消费的连接/响应体。
        void response.body?.cancel().catch(() => undefined)
        const error = new Error(
          `Download failed with HTTP ${response.status} ${response.statusText}`.trim(),
        )
        const retryable =
          response.status === 429 || (response.status >= 500 && response.status <= 599)
        if (!retryable || attempt >= retries) throw error
        await waitForRetry(attempt)
      }
    }

    try {
      if (
        !Number.isInteger(retries) ||
        retries < 0 ||
        retries > MAX_DOWNLOAD_RETRIES ||
        !Number.isInteger(retryDelayMs) ||
        retryDelayMs < 0 ||
        retryDelayMs > MAX_DOWNLOAD_RETRY_DELAY_MS
      ) {
        throw new Error('Invalid download retry options')
      }
      // 仅重试获取响应头；响应体读取及上传均在重试循环之外，不能重放整个文件。
      const response = await fetchSource()
      const contentLength = readContentLength(response.headers.get('content-length'))
      // 长度已知时先看预算：超限的文件没必要读完再报错
      if (contentLength !== null && contentLength > MAX_FILE_UPLOAD_BYTES) {
        throw new Error('Downloaded file exceeds the 512MiB upload budget')
      }
      const transferId = crypto.randomUUID()
      const streamable =
        contentLength !== null &&
        contentLength > FILE_UPLOAD_STREAM_THRESHOLD_BYTES &&
        Boolean(response.body)

      if (streamable) {
        // 大文件走流式：扩展按块读取并直传，内存里不保留完整文件
        const streamed = await uploadFileStream({
          socket,
          registry,
          relayPort: () => options.state.connection.relayPort,
          token: () => options.state.connection.token,
          requestId: args.requestId!,
          transferId,
          totalBytes: contentLength,
          source: response.body!,
          deadlineAt: Number.isFinite(deadlineMs) ? deadlineMs : null,
          signal: controller.signal,
          fetchImpl,
          ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
        })
        return {
          sourceUrl: args.url,
          finalUrl: response.url || args.url,
          contentType: response.headers.get('content-type'),
          bytes: streamed.receivedBytes,
          sha256: streamed.sha256,
        }
      }

      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_FILE_UPLOAD_BYTES) {
        throw new Error('Downloaded file exceeds the 512MiB upload budget')
      }
      const bytes = new Uint8Array(buffer)
      const sha256 = toHex(await crypto.subtle.digest('SHA-256', buffer))

      await uploadFileBytes({
        socket,
        registry,
        relayPort: () => options.state.connection.relayPort,
        token: () => options.state.connection.token,
        requestId: args.requestId!,
        transferId,
        totalBytes: bytes.byteLength,
        sha256,
        bytes,
        deadlineAt: Number.isFinite(deadlineMs) ? deadlineMs : null,
        signal: controller.signal,
        fetchImpl,
        ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
      })

      return {
        sourceUrl: args.url,
        finalUrl: response.url || args.url,
        contentType: response.headers.get('content-type'),
        bytes: bytes.byteLength,
        sha256,
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (cancelTimer !== undefined) clearInterval(cancelTimer)
    }
  }

  return {
    download,
    confirmRegistration: (transferId, ok, message) => registry.confirm(transferId, ok, message),
    dispose: () => registry.dispose(),
  }
}
