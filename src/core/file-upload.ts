import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  EMPTY_FILE_CONTENT_RANGE,
  FILE_SHA256_PATTERN,
  FILE_TRANSFER_ID_PATTERN,
  FILE_UPLOAD_CHUNK_BYTES,
  FILE_UPLOAD_IDLE_TIMEOUT_MS,
  MAX_FILE_UPLOAD_BYTES,
} from './file-transfer.js'

export { FILE_UPLOAD_IDLE_TIMEOUT_MS, MAX_FILE_UPLOAD_BYTES }

const MAX_FILE_UPLOADS = 128

const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/

export interface FileUploadProgress {
  requestId: string
  transferId: string
  receivedBytes: number
  totalBytes: number
  outputPath: string
  /** 已知时给出整文件摘要：buffered 路径来自扩展，流式路径由 relay 边写边算 */
  sha256?: string
}

export class FileUploadError extends Error {
  readonly httpStatus: number
  readonly receivedBytes?: number
  readonly code: string

  constructor(
    message: string,
    httpStatus = 400,
    receivedBytes?: number,
    code = 'FILE_UPLOAD_ERROR',
  ) {
    super(message)
    this.name = 'FileUploadError'
    this.httpStatus = httpStatus
    this.receivedBytes = receivedBytes
    this.code = code
  }
}

function transferError(error: unknown, fallbackStatus = 500): FileUploadError {
  if (error instanceof FileUploadError) return error
  return new FileUploadError(
    error instanceof Error ? error.message : 'File upload failed',
    fallbackStatus,
  )
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {})
      reject(new FileUploadError('File upload made no progress', 408))
    }, idleTimeoutMs)
  })
  try {
    return await Promise.race([reader.read(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Uint8Array)
  return hash.digest('hex')
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface IncomingFileUpload {
  requestId: string
  transferId: string
  totalBytes: number
  /** 扩展提供的整文件摘要；流式上传为 null，由 relay 边写边算 */
  sha256: string | null
  /** 流式上传时 relay 自己维护的整文件摘要状态 */
  hash: Hash | null
  /** relay 已算出的整文件摘要 */
  computedSha256: string | null
  outputPath: string
  /** 临时文件与目标同目录，保证最后的 rename 是同一文件系统内的原子替换 */
  tempPath: string
  receivedBytes: number
  writing: boolean
  released: boolean
  finalized: boolean
}

/**
 * 专用文件上传通道：扩展用 HTTP 分段把二进制直传到 relay，relay 落盘到 CLI 指定的路径。
 * 与 response upload 完全独立，不复用它的 JSON 语义。
 */
export class FileUploadStore {
  private readonly uploads = new Map<string, IncomingFileUpload>()
  private reservedBytes = 0

  constructor(private readonly idleTimeoutMs: number = FILE_UPLOAD_IDLE_TIMEOUT_MS) {}

  register(input: {
    requestId: string
    transferId: string
    totalBytes: number
    /** null 表示流式上传：整文件摘要由 relay 边写边算 */
    sha256: string | null
    outputPath: string
  }): void {
    const { requestId, transferId, totalBytes, sha256, outputPath } = input
    if (!FILE_TRANSFER_ID_PATTERN.test(transferId))
      throw new FileUploadError('Invalid file transferId')
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0)
      throw new FileUploadError('Invalid file totalBytes')
    if (sha256 !== null && !FILE_SHA256_PATTERN.test(sha256))
      throw new FileUploadError('Invalid file SHA-256')
    if (!outputPath || !path.isAbsolute(outputPath))
      throw new FileUploadError('File output path must be absolute')
    if (this.uploads.has(transferId)) throw new FileUploadError('Duplicate file upload')
    for (const upload of this.uploads.values()) {
      if (upload.requestId === requestId)
        throw new FileUploadError('File upload has already started for this request')
    }
    if (
      totalBytes > MAX_FILE_UPLOAD_BYTES ||
      this.reservedBytes + totalBytes > MAX_FILE_UPLOAD_BYTES ||
      this.uploads.size >= MAX_FILE_UPLOADS
    )
      throw new FileUploadError(
        'File exceeds the 512MiB upload budget or concurrent upload limit',
        413,
      )
    this.uploads.set(transferId, {
      requestId,
      transferId,
      totalBytes,
      sha256,
      hash: sha256 === null ? createHash('sha256') : null,
      computedSha256: null,
      outputPath,
      tempPath: buildTempPath(outputPath, transferId),
      receivedBytes: 0,
      writing: false,
      released: false,
      finalized: false,
    })
    this.reservedBytes += totalBytes
  }

  offset(transferId: string): FileUploadProgress {
    const upload = this.uploads.get(transferId)
    if (!upload) throw new FileUploadError('Unknown file upload', 404)
    return toProgress(upload)
  }

  async release(transferId: string): Promise<void> {
    const upload = this.uploads.get(transferId)
    if (!upload) return
    upload.released = true
    this.uploads.delete(transferId)
    this.reservedBytes -= upload.totalBytes
    await rm(upload.tempPath, { force: true }).catch(() => {})
  }

  async releaseRequest(requestId: string): Promise<void> {
    const transfers = [...this.uploads.entries()]
      .filter(([, upload]) => upload.requestId === requestId)
      .map(([transferId]) => transferId)
    await Promise.all(transfers.map((transferId) => this.release(transferId)))
  }

  async clear(): Promise<void> {
    await Promise.all([...this.uploads.keys()].map((transferId) => this.release(transferId)))
  }

  async write(
    transferId: string,
    contentRange: string | null,
    contentLength: string | null,
    body: ReadableStream<Uint8Array> | null,
    chunkSha256: string | null = null,
  ): Promise<FileUploadProgress & { done: boolean }> {
    const upload = this.uploads.get(transferId)
    if (!upload) throw new FileUploadError('Unknown file upload', 404)
    if (upload.writing)
      throw new FileUploadError('File upload is already being written', 409, upload.receivedBytes)
    if (upload.finalized)
      throw new FileUploadError('File upload has already been completed', 409, upload.receivedBytes)

    const expectedBytes = resolveExpectedBytes(upload, contentRange)
    if (contentLength !== null && Number(contentLength) !== expectedBytes)
      throw new FileUploadError('File Content-Length does not match its byte range')
    const streaming = upload.sha256 === null
    if (streaming && expectedBytes > 0 && !chunkSha256)
      throw new FileUploadError('Streaming file uploads require a chunk SHA-256', 400)
    // 流式分段先整段收进内存再校验摘要，必须限制单段大小避免 relay 内存被撑爆
    if (streaming && expectedBytes > FILE_UPLOAD_CHUNK_BYTES)
      throw new FileUploadError('File upload segment is too large', 400)

    upload.writing = true
    let file: Awaited<ReturnType<typeof open>> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      await mkdir(path.dirname(upload.outputPath), { recursive: true })
      file = await open(upload.tempPath, upload.receivedBytes === 0 ? 'w' : 'r+', 0o600)
      if (expectedBytes > 0) {
        if (!body) throw new FileUploadError('Missing file upload body')
        reader = body.getReader()
        if (streaming) {
          // 摘要必须先校验再落盘：校验失败时临时文件与已确认偏移都不能前进
          const payload = await this.readSegment(reader, expectedBytes)
          if (upload.released) throw new FileUploadError('File upload was cancelled', 404)
          if (chunkSha256 && sha256Bytes(payload) !== chunkSha256)
            throw new FileUploadError('File upload chunk SHA-256 does not match', 422)
          await writeAll(file, payload, upload.receivedBytes)
          upload.hash?.update(payload)
          upload.receivedBytes += payload.byteLength
        } else {
          let remaining = expectedBytes
          while (remaining > 0) {
            if (upload.released) throw new FileUploadError('File upload was cancelled', 404)
            let next: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
            try {
              next = await readWithIdleTimeout(reader, this.idleTimeoutMs)
            } catch (error) {
              throw transferError(error, 408)
            }
            if (next.done) throw new FileUploadError('File upload body ended early', 408)
            const chunk = next.value
            if (!chunk.byteLength) continue
            if (chunk.byteLength > remaining)
              throw new FileUploadError('File upload exceeds its declared byte range')
            let written = 0
            while (written < chunk.byteLength) {
              const result = await file.write(
                chunk,
                written,
                chunk.byteLength - written,
                upload.receivedBytes + written,
              )
              if (result.bytesWritten <= 0)
                throw new Error('File upload file write made no progress')
              written += result.bytesWritten
            }
            upload.receivedBytes += chunk.byteLength
            remaining -= chunk.byteLength
          }
          if (chunkSha256) {
            // buffered 路径是边读边写的，只能回读刚落盘的那一段来核对摘要
            const start = upload.receivedBytes - expectedBytes
            const digest = await readRegionDigest(file, start, expectedBytes)
            if (digest !== chunkSha256) {
              await file.truncate(start)
              upload.receivedBytes = start
              throw new FileUploadError('File upload chunk SHA-256 does not match', 422, start)
            }
          }
        }
      }
      await file.sync()
      await file.close()
      file = undefined

      const progress = toProgress(upload)
      if (upload.receivedBytes < upload.totalBytes) return { ...progress, done: false }
      const fileStat = await stat(upload.tempPath)
      if (fileStat.size !== upload.totalBytes)
        throw new FileUploadError('File upload size does not match', 422, upload.receivedBytes)
      let digest = upload.computedSha256
      if (digest === null) {
        // 流式上传的摘要是 relay 一路累加算出来的，buffered 路径仍然核对扩展给的摘要
        const computed =
          upload.sha256 === null ? upload.hash!.digest('hex') : await sha256File(upload.tempPath)
        if (upload.sha256 !== null && computed !== upload.sha256)
          throw new FileUploadError('File upload SHA-256 does not match', 422)
        digest = computed
        upload.computedSha256 = computed
      }
      if (upload.released) throw new FileUploadError('File upload was cancelled', 404)
      // 同目录 rename 是原子替换：要么旧文件保持不变，要么新文件完整出现
      await rename(upload.tempPath, upload.outputPath)
      upload.finalized = true
      return { ...toProgress(upload), done: true }
    } catch (error) {
      throw transferError(error)
    } finally {
      if (reader) reader.releaseLock()
      if (file) await file.close().catch(() => {})
      upload.writing = false
      if (upload.released) await rm(upload.tempPath, { force: true }).catch(() => {})
    }
  }

  /** 收齐一段请求体再交出去校验；超长或提前结束都会直接失败 */
  private async readSegment(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    expectedBytes: number,
  ): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    let size = 0
    while (size < expectedBytes) {
      let next: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
      try {
        next = await readWithIdleTimeout(reader, this.idleTimeoutMs)
      } catch (error) {
        throw transferError(error, 408)
      }
      if (next.done) throw new FileUploadError('File upload body ended early', 408)
      const chunk = next.value
      if (!chunk.byteLength) continue
      if (chunk.byteLength > expectedBytes - size)
        throw new FileUploadError('File upload exceeds its declared byte range')
      parts.push(chunk)
      size += chunk.byteLength
    }
    const payload = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      payload.set(part, offset)
      offset += part.byteLength
    }
    return payload
  }
}

function toProgress(upload: IncomingFileUpload): FileUploadProgress {
  const sha256 = upload.computedSha256 ?? upload.sha256
  return {
    requestId: upload.requestId,
    transferId: upload.transferId,
    receivedBytes: upload.receivedBytes,
    totalBytes: upload.totalBytes,
    outputPath: upload.outputPath,
    ...(sha256 ? { sha256 } : {}),
  }
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0
  while (written < bytes.byteLength) {
    const result = await file.write(bytes, written, bytes.byteLength - written, position + written)
    if (result.bytesWritten <= 0) throw new Error('File upload file write made no progress')
    written += result.bytesWritten
  }
}

async function readRegionDigest(
  file: Awaited<ReturnType<typeof open>>,
  start: number,
  length: number,
): Promise<string> {
  const hash = createHash('sha256')
  const buffer = new Uint8Array(Math.min(length, 1024 * 1024))
  let read = 0
  while (read < length) {
    const size = Math.min(buffer.byteLength, length - read)
    const result = await file.read(buffer, 0, size, start + read)
    if (result.bytesRead <= 0) break
    hash.update(buffer.subarray(0, result.bytesRead))
    read += result.bytesRead
  }
  return hash.digest('hex')
}

function buildTempPath(outputPath: string, transferId: string): string {
  return path.join(path.dirname(outputPath), `.autobrowser-upload-${transferId}.tmp`)
}

/** 解析本次请求允许写入的区间，并确认它正好接在已确认偏移之后 */
function resolveExpectedBytes(upload: IncomingFileUpload, contentRange: string | null): number {
  if (upload.totalBytes === 0) {
    if (contentRange !== EMPTY_FILE_CONTENT_RANGE)
      throw new FileUploadError('Invalid file Content-Range', 400, upload.receivedBytes)
    return 0
  }
  const match = CONTENT_RANGE_PATTERN.exec(contentRange || '')
  if (!match) throw new FileUploadError('Invalid file Content-Range', 400, upload.receivedBytes)
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    end >= total ||
    total !== upload.totalBytes
  )
    throw new FileUploadError('Invalid file byte range', 400, upload.receivedBytes)
  if (start !== upload.receivedBytes)
    throw new FileUploadError('File upload offset does not match', 409, upload.receivedBytes)
  return end - start + 1
}
