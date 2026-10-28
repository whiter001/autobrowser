import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { getStateDir } from './protocol.js'
import { MAX_RESPONSE_BYTES, ResponseTransferError } from './response-transfer.js'

export const RESPONSE_UPLOAD_IDLE_TIMEOUT_MS = 15_000
const MAX_UPLOADS = 128
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/

interface IncomingUpload {
  requestId: string
  totalBytes: number
  sha256: string
  filePath: string
  receivedBytes: number
  writing: boolean
  released: boolean
}

export interface ResponseUploadProgress {
  requestId: string
  receivedBytes: number
  totalBytes: number
}

export type ResponseUploadResult =
  | (ResponseUploadProgress & { done: false })
  | (ResponseUploadProgress & { done: true; text: string })

export class ResponseUploadError extends ResponseTransferError {
  constructor(
    message: string,
    readonly httpStatus: number = 400,
    readonly receivedBytes?: number,
    code: 'RESPONSE_TOO_LARGE' | 'RESPONSE_TRANSFER_ERROR' = 'RESPONSE_TRANSFER_ERROR',
  ) {
    super(message, code)
    this.name = 'ResponseUploadError'
  }
}

function transferError(error: unknown, fallbackStatus = 500): ResponseUploadError {
  if (error instanceof ResponseUploadError) return error
  return new ResponseUploadError(
    error instanceof Error ? error.message : 'Response upload failed',
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
      reject(new ResponseUploadError('Response upload made no progress', 408))
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

export class ResponseUploadStore {
  private readonly uploads = new Map<string, IncomingUpload>()
  private reservedBytes = 0

  private constructor(
    private readonly directory: string,
    private readonly idleTimeoutMs: number,
  ) {}

  static async create(
    homeDir: string,
    idleTimeoutMs = RESPONSE_UPLOAD_IDLE_TIMEOUT_MS,
  ): Promise<ResponseUploadStore> {
    const directory = path.join(getStateDir(homeDir), 'responses')
    // 上传只服务于当前进程中的 pending 命令，重启后旧文件没有可恢复的调用方。
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    return new ResponseUploadStore(directory, idleTimeoutMs)
  }

  register(input: {
    requestId: string
    transferId: string
    totalBytes: number
    sha256: string
  }): void {
    const { requestId, transferId, totalBytes, sha256 } = input
    if (!TRANSFER_ID_PATTERN.test(transferId))
      throw new ResponseUploadError('Invalid response transferId')
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
      throw new ResponseUploadError('Invalid response totalBytes')
    if (!SHA256_PATTERN.test(sha256)) throw new ResponseUploadError('Invalid response SHA-256')
    if (this.uploads.has(transferId)) throw new ResponseUploadError('Duplicate response upload')
    for (const upload of this.uploads.values()) {
      if (upload.requestId === requestId)
        throw new ResponseUploadError('Response upload has already started')
    }
    if (
      totalBytes > MAX_RESPONSE_BYTES ||
      this.reservedBytes + totalBytes > MAX_RESPONSE_BYTES ||
      this.uploads.size >= MAX_UPLOADS
    )
      throw new ResponseUploadError(
        'Response exceeds the 512MiB upload budget or concurrent upload limit',
        413,
        undefined,
        'RESPONSE_TOO_LARGE',
      )
    this.uploads.set(transferId, {
      requestId,
      totalBytes,
      sha256,
      filePath: path.join(this.directory, `${transferId}.json`),
      receivedBytes: 0,
      writing: false,
      released: false,
    })
    this.reservedBytes += totalBytes
  }

  offset(transferId: string): ResponseUploadProgress {
    const upload = this.uploads.get(transferId)
    if (!upload) throw new ResponseUploadError('Unknown response upload', 404)
    return {
      requestId: upload.requestId,
      receivedBytes: upload.receivedBytes,
      totalBytes: upload.totalBytes,
    }
  }

  async release(transferId: string): Promise<void> {
    const upload = this.uploads.get(transferId)
    if (!upload) return
    upload.released = true
    this.uploads.delete(transferId)
    this.reservedBytes -= upload.totalBytes
    await rm(upload.filePath, { force: true }).catch(() => {})
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
  ): Promise<ResponseUploadResult> {
    const upload = this.uploads.get(transferId)
    if (!upload) throw new ResponseUploadError('Unknown response upload', 404)
    if (upload.writing)
      throw new ResponseUploadError(
        'Response upload is already being written',
        409,
        upload.receivedBytes,
      )
    const match = CONTENT_RANGE_PATTERN.exec(contentRange || '')
    if (!match) throw new ResponseUploadError('Invalid response Content-Range')
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
      throw new ResponseUploadError('Invalid response byte range')
    if (start !== upload.receivedBytes)
      throw new ResponseUploadError(
        'Response upload offset does not match',
        409,
        upload.receivedBytes,
      )
    const expectedBytes = end - start + 1
    if (contentLength !== null && Number(contentLength) !== expectedBytes)
      throw new ResponseUploadError('Response Content-Length does not match its byte range')
    if (!body) throw new ResponseUploadError('Missing response upload body')

    upload.writing = true
    let file: Awaited<ReturnType<typeof open>> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      file = await open(upload.filePath, start === 0 ? 'w' : 'r+', 0o600)
      reader = body.getReader()
      let remaining = expectedBytes
      while (remaining > 0) {
        if (upload.released) throw new ResponseUploadError('Response upload was cancelled', 404)
        let next: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
        try {
          next = await readWithIdleTimeout(reader, this.idleTimeoutMs)
        } catch (error) {
          throw transferError(error, 408)
        }
        if (next.done) throw new ResponseUploadError('Response upload body ended early', 408)
        const chunk = next.value
        if (!chunk.byteLength) continue
        if (chunk.byteLength > remaining)
          throw new ResponseUploadError('Response upload exceeds its declared byte range')
        let written = 0
        while (written < chunk.byteLength) {
          const result = await file.write(
            chunk,
            written,
            chunk.byteLength - written,
            upload.receivedBytes + written,
          )
          if (result.bytesWritten <= 0)
            throw new Error('Response upload file write made no progress')
          written += result.bytesWritten
        }
        upload.receivedBytes += chunk.byteLength
        remaining -= chunk.byteLength
      }
      await file.sync()
      const progress = {
        requestId: upload.requestId,
        receivedBytes: upload.receivedBytes,
        totalBytes: upload.totalBytes,
      }
      if (upload.receivedBytes < upload.totalBytes) return { ...progress, done: false }
      if ((await sha256File(upload.filePath)) !== upload.sha256)
        throw new ResponseUploadError('Response upload SHA-256 does not match', 422)
      const text = await readFile(upload.filePath, 'utf8')
      if (upload.released) throw new ResponseUploadError('Response upload was cancelled', 404)
      return { ...progress, done: true, text }
    } catch (error) {
      throw transferError(error)
    } finally {
      if (reader) reader.releaseLock()
      if (file) await file.close().catch(() => {})
      upload.writing = false
      if (upload.released) await rm(upload.filePath, { force: true }).catch(() => {})
    }
  }
}
