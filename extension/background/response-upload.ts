import {
  createResponseSender,
  MAX_RESPONSE_BYTES,
  RESPONSE_INLINE_BYTES,
  ResponseTransferError,
} from '../../src/core/response-transfer.js'

interface ResponseEnvelope {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: unknown
}

interface UploadSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(): void
}

interface UploadSenderOptions {
  relayPort: () => number
  token: () => string
  supportsUpload: () => boolean
  fetchImpl?: typeof fetch
  retryDelayMs?: number
}

interface ActiveUpload {
  cancelled: boolean
  controller: AbortController
}

const MAX_UPLOAD_RETRIES = 3
const encoder = new TextEncoder()

function uploadError(message: string): ResponseTransferError {
  return new ResponseTransferError(message)
}

async function responseProgress(response: Response): Promise<number> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw uploadError('Response upload returned invalid JSON')
  }
  const result = (payload as { result?: { receivedBytes?: unknown } }).result
  if (
    !result ||
    typeof result.receivedBytes !== 'number' ||
    !Number.isSafeInteger(result.receivedBytes) ||
    result.receivedBytes < 0
  )
    throw uploadError('Response upload returned an invalid offset')
  return result.receivedBytes
}

export function createUploadResponseSender(socket: UploadSocket, options: UploadSenderOptions) {
  const fallback = createResponseSender(socket)
  const fetchImpl = options.fetchImpl || fetch
  const retryDelayMs = options.retryDelayMs ?? 100
  const activeUploads = new Map<string, ActiveUpload>()
  let stopped = false

  function ensureActive(id: string, upload: ActiveUpload, deadline: number): void {
    if (stopped || upload.cancelled || socket.readyState !== 1)
      throw uploadError('Response upload was cancelled')
    if (Date.now() >= deadline) throw uploadError('Response upload deadline exceeded')
  }

  async function waitBeforeRetry(upload: ActiveUpload, signal: AbortSignal): Promise<void> {
    if (retryDelayMs <= 0) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', aborted)
        resolve()
      }, retryDelayMs)
      const aborted = () => {
        clearTimeout(timer)
        reject(uploadError('Response upload was cancelled'))
      }
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  async function queryOffset(transferId: string, signal: AbortSignal): Promise<number | null> {
    try {
      const response = await fetchImpl(
        `http://127.0.0.1:${options.relayPort()}/responses/${transferId}`,
        {
          headers: { authorization: `Bearer ${options.token()}` },
          signal,
        },
      )
      if (!response.ok) return null
      return await responseProgress(response)
    } catch {
      return null
    }
  }

  async function upload(
    response: ResponseEnvelope,
    bytes: Uint8Array,
    deadline: number,
  ): Promise<void> {
    const active: ActiveUpload = { cancelled: false, controller: new AbortController() }
    activeUploads.set(response.id, active)
    const signal = active.controller.signal
    const deadlineTimer = setTimeout(
      () => active.controller.abort(),
      Math.max(0, deadline - Date.now()),
    )
    try {
      ensureActive(response.id, active, deadline)
      const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
      const sha256 = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
      ensureActive(response.id, active, deadline)
      const transferId = crypto.randomUUID()
      socket.send(
        JSON.stringify({
          type: 'response.upload',
          id: response.id,
          transferId,
          totalBytes: bytes.byteLength,
          sha256,
        }),
      )

      let offset = 0
      let retries = 0
      while (offset < bytes.byteLength) {
        ensureActive(response.id, active, deadline)
        try {
          const end = bytes.byteLength - 1
          const httpResponse = await fetchImpl(
            `http://127.0.0.1:${options.relayPort()}/responses/${transferId}`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${options.token()}`,
                'content-range': `bytes ${offset}-${end}/${bytes.byteLength}`,
                'content-type': 'application/octet-stream',
              },
              body: bytes.slice(offset),
              signal,
            },
          )
          if (!httpResponse.ok) {
            if (![404, 408, 409].includes(httpResponse.status) && httpResponse.status < 500)
              throw uploadError(`Response upload failed with HTTP ${httpResponse.status}`)
            throw new Error(`Retryable response upload HTTP ${httpResponse.status}`)
          }
          const receivedBytes = await responseProgress(httpResponse)
          if (receivedBytes <= offset || receivedBytes > bytes.byteLength)
            throw uploadError('Response upload did not advance the confirmed offset')
          if (httpResponse.status === 200 && receivedBytes !== bytes.byteLength)
            throw uploadError('Response upload completed before all bytes were received')
          offset = receivedBytes
          retries = 0
        } catch (error) {
          if (error instanceof ResponseTransferError) throw error
          ensureActive(response.id, active, deadline)
          if (retries >= MAX_UPLOAD_RETRIES)
            throw uploadError('Response upload failed after resume attempts')
          retries += 1
          await waitBeforeRetry(active, signal)
          const confirmedOffset = await queryOffset(transferId, signal)
          if (confirmedOffset !== null) {
            if (confirmedOffset < 0 || confirmedOffset > bytes.byteLength)
              throw uploadError('Response upload returned an out-of-range resume offset')
            offset = confirmedOffset
          }
        }
      }
    } finally {
      clearTimeout(deadlineTimer)
      activeUploads.delete(response.id)
    }
  }

  return {
    dispose(error?: ResponseTransferError): void {
      stopped = true
      for (const upload of activeUploads.values()) {
        upload.cancelled = true
        upload.controller.abort()
      }
      activeUploads.clear()
      fallback.dispose(error)
    },
    cancel(id: string): void {
      const upload = activeUploads.get(id)
      if (upload) {
        upload.cancelled = true
        upload.controller.abort()
      }
      fallback.cancel(id)
    },
    async send(response: ResponseEnvelope, deadlineAt?: string): Promise<void> {
      if (stopped || !options.supportsUpload()) return await fallback.send(response, deadlineAt)
      let text: string
      try {
        text = JSON.stringify(response)
      } catch (error) {
        throw new ResponseTransferError(
          'Response could not be serialized; reduce its size or return JSON-compatible data',
          error instanceof RangeError ? 'RESPONSE_TOO_LARGE' : 'RESPONSE_TRANSFER_ERROR',
        )
      }
      const bytes = encoder.encode(text)
      if (bytes.byteLength <= RESPONSE_INLINE_BYTES)
        return await fallback.send(response, deadlineAt)
      if (bytes.byteLength > MAX_RESPONSE_BYTES)
        throw new ResponseTransferError(
          'Response exceeds the 512MiB send budget',
          'RESPONSE_TOO_LARGE',
        )
      const requestedDeadline = Date.parse(deadlineAt || '')
      const deadline = Number.isFinite(requestedDeadline) ? requestedDeadline : Date.now() + 30_000
      if (deadline <= Date.now()) throw uploadError('Response upload deadline already exceeded')
      await upload(response, bytes, deadline)
    },
  }
}
