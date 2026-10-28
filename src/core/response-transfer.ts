// 此模块同时由扩展和 relay 使用，不能引入 Node/Bun 专属 API。
export const MAX_RESPONSE_BYTES = 512 * 1024 * 1024
export const RESPONSE_CHUNK_CHARS = 64 * 1024
export const RESPONSE_INLINE_BYTES = 256 * 1024
export const RESPONSE_BUFFER_BYTES = 1024 * 1024
const MAX_TRANSFERS = 128
const SEND_TIMEOUT_MS = 30_000
const encoder = new TextEncoder()

export class ResponseTransferError extends Error {
  readonly suggestedAction: string

  constructor(
    message: string,
    readonly code: 'RESPONSE_TOO_LARGE' | 'RESPONSE_TRANSFER_ERROR' = 'RESPONSE_TRANSFER_ERROR',
  ) {
    super(message)
    this.name = 'ResponseTransferError'
    this.suggestedAction =
      code === 'RESPONSE_TOO_LARGE'
        ? 'Request a smaller result (narrow the query or capture fewer network requests), and wait for other transfers to finish before retrying. Do not blindly replay side-effecting commands.'
        : "Check 'status' and 'command list', reconnect or update both relay and extension, then request the result again. Inspect the page before retrying side-effecting commands."
  }
}

export function responseByteLength(text: string): number {
  let bytes = 0
  // 分段编码只用于计数，避免为 512MiB 响应再分配一个同样大的临时字节数组。
  for (const chunk of responseChunks(text)) bytes += encoder.encode(chunk).byteLength
  return bytes
}

export function* responseChunks(text: string): Generator<string> {
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + RESPONSE_CHUNK_CHARS, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    yield text.slice(offset, end)
    offset = end
  }
}

interface IncomingTransfer {
  totalBytes: number
  receivedBytes: number
  chunks: string[]
}

export class ResponseAssembler {
  private readonly transfers = new Map<string, IncomingTransfer>()
  private reservedBytes = 0

  release(id: string): void {
    const transfer = this.transfers.get(id)
    if (!transfer) return
    this.reservedBytes -= transfer.totalBytes
    this.transfers.delete(id)
  }

  clear(): void {
    this.transfers.clear()
    this.reservedBytes = 0
  }

  // 调用方必须先确认 id 仍在 pending 中；未知/已取消请求绝不进入重组器。
  accept(message: Record<string, unknown>): Record<string, unknown> | null {
    const id = message.id as string
    try {
      if (message.type === 'response.start') {
        if (this.transfers.has(id)) throw new ResponseTransferError('Duplicate response start')
        const totalBytes = message.totalBytes
        if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes <= 0)
          throw new ResponseTransferError('Invalid response totalBytes')
        if (
          totalBytes > MAX_RESPONSE_BYTES ||
          this.reservedBytes + totalBytes > MAX_RESPONSE_BYTES ||
          this.transfers.size >= MAX_TRANSFERS
        )
          throw new ResponseTransferError(
            'Response exceeds the 512MiB transfer budget or concurrent transfer limit',
            'RESPONSE_TOO_LARGE',
          )
        if (message.sequence !== 0)
          throw new ResponseTransferError('Invalid response start sequence')
        this.transfers.set(id, { totalBytes, receivedBytes: 0, chunks: [] })
        this.reservedBytes += totalBytes
        return null
      }

      const transfer = this.transfers.get(id)
      if (!transfer) throw new ResponseTransferError('Response transfer has not started')
      if (message.sequence !== transfer.chunks.length)
        throw new ResponseTransferError('Out-of-order or duplicate response chunk')

      if (message.type === 'response.chunk') {
        const data = message.data
        if (typeof data !== 'string' || !data.length || data.length > RESPONSE_CHUNK_CHARS)
          throw new ResponseTransferError('Invalid response chunk size')
        const bytes = responseByteLength(data)
        if (message.byteLength !== bytes)
          throw new ResponseTransferError('Response chunk byteLength does not match its data')
        if (transfer.receivedBytes + bytes > transfer.totalBytes)
          throw new ResponseTransferError('Response exceeds its declared totalBytes')
        // 限制块数/对象开销，不能用大量单字符块绕过字节预算。
        if (
          transfer.receivedBytes + bytes < transfer.totalBytes &&
          data.length < RESPONSE_CHUNK_CHARS - 1
        )
          throw new ResponseTransferError('Non-final response chunk is too small')
        transfer.receivedBytes += bytes
        transfer.chunks.push(data)
        return null
      }

      if (message.type !== 'response.end')
        throw new ResponseTransferError('Unknown response transfer frame')
      if (
        message.totalBytes !== transfer.totalBytes ||
        transfer.receivedBytes !== transfer.totalBytes
      )
        throw new ResponseTransferError('Incomplete response or mismatched totalBytes')
      const text = transfer.chunks.join('')
      if (responseByteLength(text) !== transfer.totalBytes)
        throw new ResponseTransferError('Reassembled response byteLength does not match totalBytes')
      let response: unknown
      try {
        response = JSON.parse(text)
      } catch {
        throw new ResponseTransferError('Transferred response is not valid JSON')
      }
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        (response as Record<string, unknown>).type !== 'response' ||
        (response as Record<string, unknown>).id !== id
      )
        throw new ResponseTransferError('Transferred response envelope does not match its request')
      this.release(id)
      return response as Record<string, unknown>
    } catch (error) {
      this.release(id)
      throw error
    }
  }
}

interface ResponseSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(): void
}

interface SendJob {
  id: string
  text: string
  bytes: number
  deadline: number
  chunks: Generator<string> | null
  sequence: number
  started: boolean
  ended: boolean
  resolve: () => void
  reject: (error: Error) => void
}

export function createResponseSender(socket: ResponseSocket) {
  const jobs: SendJob[] = []
  let reservedBytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  function remove(job: SendJob, error?: Error): void {
    const index = jobs.indexOf(job)
    if (index < 0) return
    jobs.splice(index, 1)
    reservedBytes -= job.bytes
    job.text = ''
    job.chunks = null
    if (error) job.reject(error)
    else job.resolve()
  }

  function dispose(error = new ResponseTransferError('Response socket closed')): void {
    stopped = true
    clearTimeout(timer)
    timer = undefined
    while (jobs.length) remove(jobs[0]!, error)
  }

  function fail(error: ResponseTransferError): void {
    dispose(error)
    // 浏览器没有 terminate；关闭连接，并保证其发送缓冲始终不超过一个有界窗口。
    try {
      socket.close()
    } catch {
      // 已关闭的 socket 无需再次清理。
    }
  }

  function pump(): void {
    timer = undefined
    if (stopped || !jobs.length) return
    if (socket.readyState !== 1) {
      dispose()
      return
    }
    const now = Date.now()
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      const job = jobs[index]!
      if (now >= job.deadline) {
        if (job.started) {
          fail(new ResponseTransferError('Response transfer deadline exceeded'))
          return
        }
        remove(job, new ResponseTransferError('Response transfer deadline exceeded before sending'))
      }
    }
    try {
      // 所有响应共用一个发送窗口；不为并发命令各自启动独立的背压循环。
      for (let sent = 0; jobs.length && sent < 8; sent += 1) {
        const job = jobs[0]!
        const buffered = socket.bufferedAmount || 0
        if (job.ended) {
          if (buffered > 0) break
          remove(job)
          continue
        }
        // 最坏转义后每块 < 400KiB，预留足够空间再生成下一块。
        if (buffered > RESPONSE_BUFFER_BYTES - RESPONSE_CHUNK_CHARS * 6 - 1024) break
        let payload: string
        if (job.bytes <= RESPONSE_INLINE_BYTES) {
          payload = job.text
          job.ended = true
        } else if (!job.started) {
          payload = JSON.stringify({
            type: 'response.start',
            id: job.id,
            sequence: 0,
            totalBytes: job.bytes,
          })
        } else {
          const next = job.chunks!.next()
          if (next.done) {
            payload = JSON.stringify({
              type: 'response.end',
              id: job.id,
              sequence: job.sequence,
              totalBytes: job.bytes,
            })
            job.ended = true
          } else {
            payload = JSON.stringify({
              type: 'response.chunk',
              id: job.id,
              sequence: job.sequence++,
              byteLength: responseByteLength(next.value),
              data: next.value,
            })
          }
        }
        job.started = true
        socket.send(payload)
      }
    } catch {
      fail(new ResponseTransferError('Failed to send response over the socket'))
      return
    }
    if (jobs.length) timer = setTimeout(pump, 5)
  }

  return {
    dispose,
    cancel(id: string): void {
      const job = jobs.find((entry) => entry.id === id)
      if (job) remove(job, new ResponseTransferError('Response transfer cancelled by relay'))
      if (!jobs.length) {
        clearTimeout(timer)
        timer = undefined
      }
    },
    send(
      response: { type: 'response'; id: string; ok: boolean; result?: unknown; error?: unknown },
      deadlineAt?: string,
    ): Promise<void> {
      if (stopped || socket.readyState !== 1)
        return Promise.reject(new ResponseTransferError('Response socket is not open'))
      if (jobs.length >= MAX_TRANSFERS)
        return Promise.reject(
          new ResponseTransferError('Too many queued responses', 'RESPONSE_TOO_LARGE'),
        )
      const requestedDeadline = Date.parse(deadlineAt || '')
      const deadline = Math.min(
        Number.isFinite(requestedDeadline) ? requestedDeadline : Infinity,
        Date.now() + SEND_TIMEOUT_MS,
      )
      if (deadline <= Date.now())
        return Promise.reject(
          new ResponseTransferError('Response transfer deadline already exceeded'),
        )
      let text: string
      try {
        text = JSON.stringify(response)
      } catch (error) {
        return Promise.reject(
          new ResponseTransferError(
            'Response could not be serialized; reduce its size or return JSON-compatible data',
            error instanceof RangeError ? 'RESPONSE_TOO_LARGE' : 'RESPONSE_TRANSFER_ERROR',
          ),
        )
      }
      const bytes = responseByteLength(text)
      if (bytes > MAX_RESPONSE_BYTES || reservedBytes + bytes > MAX_RESPONSE_BYTES)
        return Promise.reject(
          new ResponseTransferError(
            'Response exceeds the 512MiB send budget',
            'RESPONSE_TOO_LARGE',
          ),
        )
      return new Promise((resolve, reject) => {
        reservedBytes += bytes
        jobs.push({
          id: response.id,
          text,
          bytes,
          deadline,
          chunks: bytes > RESPONSE_INLINE_BYTES ? responseChunks(text) : null,
          sequence: 0,
          started: false,
          ended: false,
          resolve,
          reject,
        })
        if (!timer) pump()
      })
    },
  }
}
