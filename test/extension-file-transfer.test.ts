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
  const controller = new AbortController()
  if (cancelledAfterMs <= 0) controller.abort(new Error('cancelled'))
  else setTimeout(() => controller.abort(new Error('cancelled')), cancelledAfterMs)
  return {
    get cancelled() {
      return controller.signal.aborted
    },
    signal: controller.signal,
    deadlineAt: null,
    throwIfCancelled() {
      if (this.cancelled) throw controller.signal.reason
    },
  }
}

function createRetryTransfer(sourceFetch: (init?: RequestInit) => Promise<Response>) {
  const sent: SentMessage[] = []
  const socket = createSocket(sent)
  let sourceCalls = 0
  let uploadCalls = 0
  const signals: Array<AbortSignal | null | undefined> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/files/')) {
      uploadCalls += 1
      return new Response(JSON.stringify({ ok: true, result: { receivedBytes: 3 } }))
    }
    sourceCalls += 1
    signals.push(init?.signal)
    expect(init?.credentials).toBe('include')
    return sourceFetch(init)
  }) as typeof fetch
  const transfer = createFileTransferDomain({
    state: createState(socket),
    fetchImpl,
    retryDelayMs: 0,
  })
  const originalSend = socket.send
  socket.send = (data) => {
    originalSend(data)
    const message = JSON.parse(data) as SentMessage
    if (message.type === 'file.upload') {
      queueMicrotask(() => transfer.confirmRegistration(message.transferId!, true))
    }
  }
  return { transfer, sent, signals, sourceCalls: () => sourceCalls, uploadCalls: () => uploadCalls }
}

const retryDownloadArgs = {
  url: 'https://example.com/file',
  requestId: 'retry_cmd',
  retryDelayMs: 0,
}

describe('extension download network retries', () => {
  test('retries Failed to fetch and succeeds without replaying the upload', async () => {
    let calls = 0
    const fixture = createRetryTransfer(async () => {
      if (++calls === 1) throw new TypeError('Failed to fetch')
      return new Response('abc')
    })
    const result = await fixture.transfer.download(retryDownloadArgs)
    expect(result).toEqual({
      sourceUrl: retryDownloadArgs.url,
      finalUrl: retryDownloadArgs.url,
      contentType: null,
      bytes: 3,
      sha256: sha256(new TextEncoder().encode('abc')),
    })
    expect(fixture.sourceCalls()).toBe(2)
    expect(fixture.uploadCalls()).toBe(1)
    expect(fixture.sent.filter((message) => message.type === 'file.upload')).toHaveLength(1)
    expect(fixture.signals[0]).toBe(fixture.signals[1])
  })

  test.each([429, 500, 503, 599])('retries HTTP %i then succeeds', async (status) => {
    let calls = 0
    const fixture = createRetryTransfer(async () =>
      ++calls === 1 ? new Response('retry', { status }) : new Response('abc'),
    )
    await fixture.transfer.download(retryDownloadArgs)
    expect(fixture.sourceCalls()).toBe(2)
    expect(fixture.uploadCalls()).toBe(1)
  })

  test.each([403, 404, 408])('does not retry HTTP %i', async (status) => {
    const fixture = createRetryTransfer(async () => new Response('denied', { status }))
    await expect(fixture.transfer.download(retryDownloadArgs)).rejects.toThrow(`HTTP ${status}`)
    expect(fixture.sourceCalls()).toBe(1)
    expect(fixture.sent).toEqual([])
  })

  test.each([0, 2, 5])('stops after %i extra network retries', async (retries) => {
    const fixture = createRetryTransfer(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fixture.transfer.download({ ...retryDownloadArgs, retries })).rejects.toThrow(
      'Failed to fetch',
    )
    expect(fixture.sourceCalls()).toBe(retries + 1)
    expect(fixture.sent).toEqual([])
  })

  test('defaults to two extra retries and exhausts HTTP failures', async () => {
    const fixture = createRetryTransfer(async () => new Response('unavailable', { status: 503 }))
    await expect(fixture.transfer.download(retryDownloadArgs)).rejects.toThrow('HTTP 503')
    expect(fixture.sourceCalls()).toBe(3)
  })

  test('does not retry non-network errors or body read failures', async () => {
    for (const bodyFailure of [false, true]) {
      const fixture = createRetryTransfer(async () => {
        if (!bodyFailure) throw new Error('invalid configuration')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('body failed'))
            },
          }),
        )
      })
      await expect(fixture.transfer.download(retryDownloadArgs)).rejects.toThrow(
        bodyFailure ? 'body failed' : 'invalid configuration',
      )
      expect(fixture.sourceCalls()).toBe(1)
      expect(fixture.sent).toEqual([])
    }
  })

  test('does not sleep beyond the original deadline', async () => {
    const fixture = createRetryTransfer(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(
      fixture.transfer.download({
        ...retryDownloadArgs,
        retryDelayMs: 60_000,
        deadlineAt: new Date(Date.now() + 500).toISOString(),
      }),
    ).rejects.toThrow('deadline')
    expect(fixture.sourceCalls()).toBe(1)
  })

  test('uses exponential backoff without resetting the deadline', async () => {
    const times: number[] = []
    const fixture = createRetryTransfer(async () => {
      times.push(Date.now())
      throw new TypeError('Failed to fetch')
    })
    await expect(
      fixture.transfer.download({
        ...retryDownloadArgs,
        retries: 3,
        retryDelayMs: 20,
        deadlineAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).rejects.toThrow('Failed to fetch')
    expect(times).toHaveLength(4)
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(20 * 2 ** (index - 1) - 1)
    }
  })

  test('retries named network errors', async () => {
    let calls = 0
    const fixture = createRetryTransfer(async () => {
      if (++calls === 1) throw new DOMException('network unavailable', 'NetworkError')
      return new Response('abc')
    })
    await fixture.transfer.download(retryDownloadArgs)
    expect(fixture.sourceCalls()).toBe(2)
  })

  test('does not retry a network rejection after the deadline', async () => {
    const fixture = createRetryTransfer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      throw new TypeError('Failed to fetch')
    })
    await expect(
      fixture.transfer.download({
        ...retryDownloadArgs,
        deadlineAt: new Date(Date.now() + 20).toISOString(),
      }),
    ).rejects.toThrow('deadline')
    expect(fixture.sourceCalls()).toBe(1)
  })

  test('checks an already elapsed deadline or cancellation before fetching', async () => {
    const fixture = createRetryTransfer(async () => new Response('abc'))
    await expect(
      fixture.transfer.download({
        ...retryDownloadArgs,
        deadlineAt: new Date(Date.now() - 1).toISOString(),
      }),
    ).rejects.toThrow('deadline')
    await expect(
      fixture.transfer.download({ ...retryDownloadArgs, context: createCancelledContext(0) }),
    ).rejects.toThrow('cancelled')
    expect(fixture.sourceCalls()).toBe(0)
  })

  test('cancels during backoff without fetching again', async () => {
    const fixture = createRetryTransfer(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(
      fixture.transfer.download({
        ...retryDownloadArgs,
        retryDelayMs: 1000,
        context: createCancelledContext(20),
      }),
    ).rejects.toThrow('cancelled')
    expect(fixture.sourceCalls()).toBe(1)
    expect(fixture.sent).toEqual([])
  })

  test('does not retry a network rejection after cancellation', async () => {
    const fixture = createRetryTransfer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      throw new TypeError('Failed to fetch')
    })
    await expect(
      fixture.transfer.download({ ...retryDownloadArgs, context: createCancelledContext(20) }),
    ).rejects.toThrow('cancelled')
    expect(fixture.sourceCalls()).toBe(1)
  })
})

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
    ).rejects.toThrow(/deadline exceeded|cancelled/)
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
    ).rejects.toThrow(/deadline exceeded|cancelled/)
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
