import { suggestedDownloadFilename } from '../../src/core/download-filename.js'
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
  suggestedFilename: string
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

type DownloadStage = 'fetch' | 'read' | 'upload'

function transferError(
  message: string,
  code: string,
  details: Record<string, unknown>,
  suggestedAction: string,
): Error {
  return Object.assign(new Error(message), { code, details, suggestedAction, retryable: false })
}

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

    let stage: DownloadStage = 'fetch'
    let totalBytes: number | null = null
    let receivedBytes = 0
    let uploadedBytes = 0
    const controller = new AbortController()
    const deadlineMs = args.deadlineAt ? Date.parse(args.deadlineAt) : Number.NaN
    const deadlineTimer = Number.isFinite(deadlineMs)
      ? setTimeout(
          () => controller.abort(new Error('File transfer deadline exceeded')),
          Math.max(0, deadlineMs - Date.now()),
        )
      : undefined
    const onCommandCancel = () => {
      controller.abort(args.context?.signal.reason || new Error('File transfer was cancelled'))
    }
    if (args.context?.signal.aborted) onCommandCancel()
    args.context?.signal.addEventListener('abort', onCommandCancel, { once: true })

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
    const readSourceBytes = async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
      if (!response.body) {
        const buffer = await response.arrayBuffer()
        receivedBytes = buffer.byteLength
        return new Uint8Array(buffer)
      }

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const chunk = next.value || new Uint8Array(0)
        receivedBytes += chunk.byteLength
        chunks.push(chunk)
      }
      const bytes = new Uint8Array(receivedBytes)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
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
        const error = transferError(
          `Download failed with HTTP ${response.status} ${response.statusText}`.trim(),
          'DOWNLOAD_HTTP_ERROR',
          { status: response.status, sourceUrl: args.url },
          response.status === 410
            ? 'The signed download URL has expired or was already consumed. Return to the original /dl/ URL or book detail page to obtain a fresh link; do not keep retrying the final CDN URL.'
            : 'Check the source URL and page access, then retry the original download URL when appropriate.',
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
      totalBytes = readContentLength(response.headers.get('content-length'))
      // 长度已知时先看预算：超限的文件没必要读完再报错
      if (totalBytes !== null && totalBytes > MAX_FILE_UPLOAD_BYTES) {
        throw new Error('Downloaded file exceeds the 512MiB upload budget')
      }
      const transferId = crypto.randomUUID()
      const streamable =
        totalBytes !== null &&
        totalBytes > FILE_UPLOAD_STREAM_THRESHOLD_BYTES &&
        Boolean(response.body)

      if (streamable) {
        stage = 'read'
        // 大文件走流式：扩展按块读取并直传，内存里不保留完整文件
        const streamed = await uploadFileStream({
          socket,
          registry,
          relayPort: () => options.state.connection.relayPort,
          token: () => options.state.connection.token,
          requestId: args.requestId!,
          transferId,
          totalBytes: totalBytes!,
          source: response.body!,
          deadlineAt: Number.isFinite(deadlineMs) ? deadlineMs : null,
          signal: controller.signal,
          fetchImpl,
          onReadProgress: (bytes) => {
            receivedBytes = bytes
          },
          onProgress: (bytes) => {
            uploadedBytes = bytes
            stage = 'upload'
          },
          ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
        })
        return {
          sourceUrl: args.url,
          finalUrl: response.url || args.url,
          contentType: response.headers.get('content-type'),
          bytes: streamed.receivedBytes,
          sha256: streamed.sha256,
          suggestedFilename: suggestedDownloadFilename(
            response.url || args.url,
            response.headers.get('content-type'),
            response.headers.get('content-disposition'),
          ),
        }
      }

      stage = 'read'
      const bytes = await readSourceBytes(response)
      totalBytes ??= bytes.byteLength
      if (bytes.byteLength > MAX_FILE_UPLOAD_BYTES) {
        throw new Error('Downloaded file exceeds the 512MiB upload budget')
      }
      const sha256 = toHex(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer))

      stage = 'upload'
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
        onProgress: (confirmed) => {
          uploadedBytes = confirmed
        },
        ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
      })

      return {
        sourceUrl: args.url,
        finalUrl: response.url || args.url,
        contentType: response.headers.get('content-type'),
        bytes: bytes.byteLength,
        sha256,
        suggestedFilename: suggestedDownloadFilename(
          response.url || args.url,
          response.headers.get('content-type'),
          response.headers.get('content-disposition'),
        ),
      }
    } catch (error) {
      if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
        throw transferError(
          `Download deadline exceeded during ${stage}`,
          'DOWNLOAD_TIMEOUT',
          {
            sourceUrl: args.url,
            stage,
            receivedBytes,
            uploadedBytes,
            totalBytes,
            deadlineAt: args.deadlineAt,
          },
          'Retry the original download URL with a larger --timeout-ms. If this was a signed CDN URL, return to the original /dl/ URL or detail page for a fresh link instead of reusing the expired final URL.',
        )
      }
      throw error
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      args.context?.signal.removeEventListener('abort', onCommandCancel)
    }
  }

  return {
    download,
    confirmRegistration: (transferId, ok, message) => registry.confirm(transferId, ok, message),
    dispose: () => registry.dispose(),
  }
}
