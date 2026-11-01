import { FILE_UPLOAD_CHUNK_SHA256_HEADER } from './file-transfer.js'
import { FileUploadError, FileUploadStore, type FileUploadProgress } from './file-upload.js'
import { parseTransferredResponse, ResponseTransferError } from './response-transfer.js'
import {
  ResponseUploadError,
  ResponseUploadStore,
  type ResponseUploadProgress,
} from './response-upload.js'
import type { ExtensionMetadata, PendingRequest } from './runtime-types.js'

/**
 * 运行时的大文件传输通道：response upload（超大响应）与 file upload（下载落盘）。
 *
 * 两个通道各自独立的偏移与摘要校验都在这里收口；HTTP 分段写入的进度查询、
 * 错误码映射与 pending 请求的联动通过依赖注入完成，运行时只需要提供
 * pending 请求表、当前连接以及"响应组装完成"的回调。
 */

interface RuntimeTransferOptions {
  /** 上传落盘的根目录（state 目录） */
  homeDir: string
  /** pending 命令表：上传偏移必须挂在仍然 pending 的请求上 */
  pendingRequests: Map<string, PendingRequest>
  /** 释放分片响应的装配状态 */
  releaseResponseAssembler: (requestId: string) => void
  /** 取得当前扩展连接，用于回传取消与上传登记结果 */
  getSocket: () => Bun.ServerWebSocket<ExtensionMetadata> | null
  /** 上传收齐后把组装好的响应交回运行时，走普通响应流程 */
  onResponseReady: (response: Record<string, unknown>) => void
}

interface RuntimeTransfer {
  /** 查询大响应已持久化的字节偏移 */
  responseUploadOffset: (transferId: string) => ResponseUploadProgress
  /** 写入一段大响应数据，完成后复用普通响应流程 */
  uploadResponse: (transferId: string, request: Request) => Promise<ResponseUploadProgress>
  /** 查询文件上传已确认的字节偏移 */
  fileUploadOffset: (transferId: string) => FileUploadProgress
  /** 写入一段文件数据，字节收齐后原子落盘到 CLI 指定的路径 */
  uploadFile: (transferId: string, request: Request) => Promise<FileUploadProgress>
  /** 处理扩展发来的 response.upload 登记消息 */
  handleResponseUploadRegistration: (id: string, message: Record<string, unknown>) => void
  /** 处理扩展发来的 file.upload 登记消息 */
  handleFileUploadRegistration: (message: Record<string, unknown>) => void
  /** 释放某个请求下已经登记的所有上传 */
  releaseRequest: (requestId: string) => void
  /** 拒绝一个 pending 请求并清理它的传输状态 */
  rejectTransfer: (id: string, error: Error, reason: string) => void
  /** 连接断开或被替换时清空所有上传登记 */
  clear: () => void
}

export async function createRuntimeTransfer(
  options: RuntimeTransferOptions,
): Promise<RuntimeTransfer> {
  const { pendingRequests } = options
  const responseUploads = await ResponseUploadStore.create(options.homeDir)
  const fileUploads = new FileUploadStore()

  function rejectTransfer(id: string, error: Error, reason: string): void {
    const pending = pendingRequests.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingRequests.delete(id)
    options.releaseResponseAssembler(id)
    void responseUploads.releaseRequest(id)
    void fileUploads.releaseRequest(id)
    pending.reject(error)
    try {
      options.getSocket()?.send(JSON.stringify({ type: 'cancel', id, reason }))
    } catch {
      // 请求已经拒绝，取消仅用于让扩展尽早停止传输。
    }
  }

  function releaseRequest(requestId: string): void {
    void responseUploads.releaseRequest(requestId)
    void fileUploads.releaseRequest(requestId)
  }

  /** 通知扩展文件上传登记结果，扩展据此决定是否开始 POST 字节 */
  function sendFileUploadReady(id: string, transferId: string, ok: boolean, error?: unknown): void {
    const socket = options.getSocket()
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(
        JSON.stringify({
          type: 'file.upload.ready',
          id,
          transferId,
          ok,
          ...(ok
            ? {}
            : {
                error: {
                  message:
                    error instanceof Error
                      ? error.message
                      : 'File upload was rejected by the relay',
                },
              }),
        }),
      )
    } catch {
      // socket 已断开，扩展会在上传失败后随命令一起结束。
    }
  }

  function handleResponseUploadRegistration(id: string, message: Record<string, unknown>): void {
    try {
      const upload = message as Record<string, unknown>
      if (
        typeof upload.transferId !== 'string' ||
        typeof upload.totalBytes !== 'number' ||
        typeof upload.sha256 !== 'string'
      )
        throw new ResponseTransferError('Invalid response upload metadata')
      responseUploads.register({
        requestId: id,
        transferId: upload.transferId,
        totalBytes: upload.totalBytes,
        sha256: upload.sha256,
      })
    } catch (error) {
      rejectTransfer(id, error as Error, 'invalid response upload')
    }
  }

  function handleFileUploadRegistration(message: Record<string, unknown>): void {
    const id = typeof message.id === 'string' ? message.id : ''
    const transferId = typeof message.transferId === 'string' ? message.transferId : ''
    try {
      const totalBytes = message.totalBytes
      const sha256 = message.sha256
      // 流式上传不提供整文件摘要（null/缺省），relay 收到全部字节后自己算
      if (
        !id ||
        typeof message.transferId !== 'string' ||
        typeof totalBytes !== 'number' ||
        (sha256 !== null && sha256 !== undefined && typeof sha256 !== 'string')
      )
        throw new FileUploadError('Invalid file upload metadata')
      const pending = pendingRequests.get(id)
      // 落盘路径只认 relay 自己保存的 pending download 参数，扩展另传的路径不采信
      if (!pending || pending.command !== 'download' || !pending.outputPath)
        throw new FileUploadError('File upload is not attached to a pending download command', 404)
      fileUploads.register({
        requestId: id,
        transferId,
        totalBytes,
        sha256: typeof sha256 === 'string' ? sha256 : null,
        outputPath: pending.outputPath,
      })
      sendFileUploadReady(id, transferId, true)
    } catch (error) {
      sendFileUploadReady(id, transferId, false, error)
      if (id) rejectTransfer(id, error as Error, 'invalid file upload')
    }
  }

  function responseUploadOffset(transferId: string): ResponseUploadProgress {
    const progress = responseUploads.offset(transferId)
    if (!pendingRequests.has(progress.requestId)) {
      void responseUploads.release(transferId)
      throw new ResponseUploadError('Response upload request is no longer pending', 404)
    }
    return progress
  }

  async function uploadResponse(
    transferId: string,
    request: Request,
  ): Promise<ResponseUploadProgress> {
    try {
      const result = await responseUploads.write(
        transferId,
        request.headers.get('content-range'),
        request.headers.get('content-length'),
        request.body,
      )
      responseUploadOffset(transferId)
      if (result.done) {
        let response: Record<string, unknown>
        try {
          response = parseTransferredResponse(result.text, result.requestId)
        } catch (error) {
          throw new ResponseUploadError(
            error instanceof Error ? error.message : 'Invalid transferred response',
            422,
          )
        }
        options.onResponseReady(response)
      }
      return {
        requestId: result.requestId,
        receivedBytes: result.receivedBytes,
        totalBytes: result.totalBytes,
      }
    } catch (error) {
      const uploadError =
        error instanceof ResponseUploadError
          ? error
          : new ResponseUploadError(
              error instanceof Error ? error.message : 'Response upload failed',
              500,
            )
      if (![404, 408, 409].includes(uploadError.httpStatus)) {
        try {
          const progress = responseUploads.offset(transferId)
          rejectTransfer(progress.requestId, uploadError, 'response upload failed')
        } catch {
          // 上传登记已清理时，没有 pending 请求需要拒绝。
        }
      }
      throw uploadError
    }
  }

  function fileUploadOffset(transferId: string): FileUploadProgress {
    const progress = fileUploads.offset(transferId)
    if (!pendingRequests.has(progress.requestId)) {
      void fileUploads.release(transferId)
      throw new FileUploadError('File upload request is no longer pending', 404)
    }
    return progress
  }

  async function uploadFile(transferId: string, request: Request): Promise<FileUploadProgress> {
    try {
      const result = await fileUploads.write(
        transferId,
        request.headers.get('content-range'),
        request.headers.get('content-length'),
        request.body,
        request.headers.get(FILE_UPLOAD_CHUNK_SHA256_HEADER),
      )
      // 命令已经取消/超时的话，这里会释放登记并丢弃临时文件
      fileUploadOffset(transferId)
      return {
        requestId: result.requestId,
        transferId: result.transferId,
        receivedBytes: result.receivedBytes,
        totalBytes: result.totalBytes,
        outputPath: result.outputPath,
        ...(result.sha256 ? { sha256: result.sha256 } : {}),
      }
    } catch (error) {
      const uploadError =
        error instanceof FileUploadError
          ? error
          : new FileUploadError(error instanceof Error ? error.message : 'File upload failed', 500)
      if (![404, 408, 409].includes(uploadError.httpStatus)) {
        try {
          const progress = fileUploads.offset(transferId)
          rejectTransfer(progress.requestId, uploadError, 'file upload failed')
        } catch {
          // 上传登记已清理时，没有 pending 请求需要拒绝。
        }
      }
      throw uploadError
    }
  }

  function clear(): void {
    void responseUploads.clear()
    void fileUploads.clear()
  }

  return {
    responseUploadOffset,
    uploadResponse,
    fileUploadOffset,
    uploadFile,
    handleResponseUploadRegistration,
    handleFileUploadRegistration,
    releaseRequest,
    rejectTransfer,
    clear,
  }
}
