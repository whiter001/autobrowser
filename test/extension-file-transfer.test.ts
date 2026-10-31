import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createFileTransferDomain } from '../extension/background/file-transfer.js'
import { createFileUploadRegistry, uploadFileBytes } from '../extension/background/file-upload.js'
import type { CommandExecutionContext } from '../extension/background/command-queue.js'
import type { ExtensionState } from '../extension/background/types.js'

const RELAY_PORT = 57978
const TOKEN = 'file-transfer-token'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface SentMessage {
  type: string
  id?: string
  transferId?: string
  totalBytes?: number
  sha256?: string
}

function createSocket(sent: SentMessage[]) {
  return {
    readyState: 1,
    send(data: string) {
      sent.push(JSON.parse(data) as SentMessage)
    },
  }
}

function createState(socket: unknown, fileUploadSupported = true): ExtensionState {
  return {
    connection: { socket, relayPort: RELAY_PORT, token: TOKEN, fileUploadSupported },
  } as unknown as ExtensionState
}

function createCancelledContext(cancelledAfterMs: number): CommandExecutionContext {
  const startedAt = Date.now()
  return {
    get cancelled() {
      return Date.now() - startedAt >= cancelledAfterMs
    },
    deadlineAt: null,
    throwIfCancelled() {
      if (this.cancelled) throw new Error('cancelled')
    },
  }
}

describe('extension file transfer', () => {
  test('fetches with credentials, uploads the bytes and reports the metadata', async () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 2, 3])
    const sent: SentMessage[] = []
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const socket = createSocket(sent)
    const state = createState(socket)

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.includes('/files/')) {
        const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(
          new Headers(init?.headers).get('content-range')!,
        )
        const total = Number(range![3])
        return new Response(
          JSON.stringify({ ok: true, result: { receivedBytes: total, totalBytes: total } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      const response = new Response(bytes.buffer as ArrayBuffer, {
        headers: { 'content-type': 'image/png' },
      })
      Object.defineProperty(response, 'url', { value: 'https://example.com/final.png' })
      return response
    }) as typeof fetch

    const fileTransfer = createFileTransferDomain({ state, fetchImpl, retryDelayMs: 0 })
    // relay 的登记回执：扩展必须先拿到确认才开始上传字节
    const originalSend = socket.send
    socket.send = (data: string) => {
      originalSend(data)
      const message = JSON.parse(data) as SentMessage
      if (message.type === 'file.upload') {
        queueMicrotask(() => fileTransfer.confirmRegistration(message.transferId!, true))
      }
    }

    const result = await fileTransfer.download({
      url: 'https://example.com/image.png',
      requestId: 'cmd_1',
    })

    expect(result).toEqual({
      sourceUrl: 'https://example.com/image.png',
      finalUrl: 'https://example.com/final.png',
      contentType: 'image/png',
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    })

    const originRequest = requests[0]!
    expect(originRequest.init?.credentials).toBe('include')
    expect(originRequest.init?.signal).toBeTruthy()

    const registration = sent.find((message) => message.type === 'file.upload')!
    expect(registration).toMatchObject({
      id: 'cmd_1',
      totalBytes: bytes.byteLength,
      sha256: sha256(bytes),
    })

    const uploadRequest = requests.find((request) => request.url.includes('/files/'))!
    expect(uploadRequest.init?.method).toBe('POST')
    expect(new Headers(uploadRequest.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(new Headers(uploadRequest.init?.headers).get('content-range')).toBe(
      `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
    )
    const body = new Uint8Array(await new Response(uploadRequest.init?.body).arrayBuffer())
    expect(body).toEqual(bytes)
  })

  test('fails when the source responds with an error status', async () => {
    const sent: SentMessage[] = []
    const socket = createSocket(sent)
    const state = createState(socket)
    const fetchImpl = (async () =>
      new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch

    const fileTransfer = createFileTransferDomain({ state, fetchImpl })
    await expect(
      fileTransfer.download({ url: 'https://example.com/missing.png', requestId: 'cmd_2' }),
    ).rejects.toThrow(/HTTP 404/)
    // 源站失败时不应登记文件上传
    expect(sent.find((message) => message.type === 'file.upload')).toBeUndefined()
  })

  test('resumes from the offset confirmed by the relay', async () => {
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, index) => index))
    const sent: SentMessage[] = []
    const socket = createSocket(sent)
    const state = createState(socket)
    let posts = 0
    let confirmedOffset = 0

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/files/')) {
        return new Response(bytes.buffer as ArrayBuffer, {
          headers: { 'content-type': 'application/octet-stream' },
        })
      }
      if (init?.method !== 'POST') {
        // 断点续传前先查询 relay 已确认的偏移
        return new Response(
          JSON.stringify({ ok: true, result: { receivedBytes: confirmedOffset } }),
          { status: 200 },
        )
      }
      posts += 1
      if (posts === 1) {
        // 第一次整段上传被 relay 拒绝，但已经确认了前 40 字节
        confirmedOffset = 40
        return new Response(JSON.stringify({ ok: false }), { status: 409 })
      }
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(
        new Headers(init?.headers).get('content-range')!,
      )
      confirmedOffset = Number(range![2]) + 1
      return new Response(
        JSON.stringify({ ok: true, result: { receivedBytes: confirmedOffset } }),
        { status: 200 },
      )
    }) as typeof fetch

    const fileTransfer = createFileTransferDomain({ state, fetchImpl, retryDelayMs: 0 })
    const originalSend = socket.send
    socket.send = (data: string) => {
      originalSend(data)
      const message = JSON.parse(data) as SentMessage
      if (message.type === 'file.upload') {
        queueMicrotask(() => fileTransfer.confirmRegistration(message.transferId!, true))
      }
    }

    const result = await fileTransfer.download({
      url: 'https://example.com/image.bin',
      requestId: 'cmd_3',
    })
    expect(result.bytes).toBe(bytes.byteLength)
    expect(posts).toBe(2)
  })

  test('stops when the relay rejects the upload registration', async () => {
    const sent: SentMessage[] = []
    const socket = createSocket(sent)
    const state = createState(socket)
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/files/')) throw new Error('upload must not start')
      return new Response(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)
    }) as typeof fetch

    const fileTransfer = createFileTransferDomain({ state, fetchImpl })
    const originalSend = socket.send
    socket.send = (data: string) => {
      originalSend(data)
      const message = JSON.parse(data) as SentMessage
      if (message.type === 'file.upload') {
        queueMicrotask(() =>
          fileTransfer.confirmRegistration(message.transferId!, false, 'no pending download'),
        )
      }
    }

    await expect(
      fileTransfer.download({ url: 'https://example.com/image.bin', requestId: 'cmd_4' }),
    ).rejects.toThrow(/no pending download/)
  })

  test('aborts the fetch when the deadline elapses', async () => {
    const sent: SentMessage[] = []
    const socket = createSocket(sent)
    const state = createState(socket)
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch

    const fileTransfer = createFileTransferDomain({ state, fetchImpl })
    await expect(
      fileTransfer.download({
        url: 'https://example.com/slow.png',
        requestId: 'cmd_5',
        deadlineAt: new Date(Date.now() + 50).toISOString(),
      }),
    ).rejects.toThrow(/aborted/)
  })

  test('aborts the fetch when the command is cancelled', async () => {
    const sent: SentMessage[] = []
    const socket = createSocket(sent)
    const state = createState(socket)
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch

    const fileTransfer = createFileTransferDomain({ state, fetchImpl })
    await expect(
      fileTransfer.download({
        url: 'https://example.com/slow.png',
        requestId: 'cmd_6',
        context: createCancelledContext(20),
      }),
    ).rejects.toThrow(/aborted/)
  })

  test('refuses to transfer without a relay connection', async () => {
    const state = createState({ readyState: 3, send: () => {} })
    const fileTransfer = createFileTransferDomain({ state })
    await expect(
      fileTransfer.download({ url: 'https://example.com/image.png', requestId: 'cmd_7' }),
    ).rejects.toThrow(/no relay connection/)
  })

  test('refuses to transfer when the relay has no file upload channel', async () => {
    const sent: SentMessage[] = []
    const socket = createSocket(sent)
    const state = createState(socket, false)
    const fileTransfer = createFileTransferDomain({ state })
    await expect(
      fileTransfer.download({ url: 'https://example.com/image.png', requestId: 'cmd_8' }),
    ).rejects.toThrow(/does not support the file upload channel/)
  })
})

describe('file upload registration registry', () => {
  test('resolves on the relay ack and rejects when the connection is disposed', async () => {
    const registry = createFileUploadRegistry()
    const pending = registry.expect('transfer-ack-000001', 1000)
    registry.confirm('transfer-ack-000001', true)
    await expect(pending).resolves.toBeUndefined()

    const rejected = registry.expect('transfer-ack-000002', 1000)
    registry.confirm('transfer-ack-000002', false, 'no pending download')
    await expect(rejected).rejects.toThrow(/no pending download/)

    const cancelled = registry.expect('transfer-ack-000003', 1000)
    registry.dispose()
    await expect(cancelled).rejects.toThrow(/cancelled/)
  })

  test('cancels the registration when the relay rejects it', async () => {
    const registry = createFileUploadRegistry()
    const pending = registry.expect('transfer-cancel-00001', 1000)
    registry.cancel('transfer-cancel-00001', 'registration was not sent')
    await expect(pending).rejects.toThrow(/registration was not sent/)
    expect(registry.has('transfer-cancel-00001')).toBe(false)
  })
})

describe('extension file transfer registration failures', () => {
  test('fails fast and leaves no pending registration when the socket send throws', async () => {
    const registry = createFileUploadRegistry()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls += 1
      return new Response('')
    }) as unknown as typeof fetch
    const socket = {
      readyState: 1,
      send() {
        throw new Error('socket is closed')
      },
    }
    const transferId = 'transfer-send-fail-0001'
    const bytes = new Uint8Array([1, 2, 3])

    try {
      await expect(
        uploadFileBytes({
          socket,
          registry,
          relayPort: () => RELAY_PORT,
          token: () => TOKEN,
          requestId: 'cmd_9',
          transferId,
          totalBytes: bytes.byteLength,
          sha256: sha256(bytes),
          bytes,
          // 登记超时设得很短：登记若没被立刻撤销，这个定时器会拒绝一个没人观察的 promise
          deadlineAt: Date.now() + 30,
          fetchImpl,
          retryDelayMs: 0,
        }),
      ).rejects.toThrow(/Failed to send the file upload registration: socket is closed/)

      // 登记没发出去就不该有任何 HTTP 上传
      expect(fetchCalls).toBe(0)
      // 登记立刻撤销，不残留到超时
      expect(registry.has(transferId)).toBe(false)
      // 也不该留下未处理的 rejection
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(unhandled).toEqual([])
      // 同一个 transferId 可以重新登记
      const pending = registry.expect(transferId, 1000)
      registry.confirm(transferId, true)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
