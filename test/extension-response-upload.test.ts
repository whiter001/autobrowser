import { describe, expect, test } from 'bun:test'
import { createUploadResponseSender } from '../extension/background/response-upload.js'
import { RESPONSE_INLINE_BYTES } from '../src/core/response-transfer.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function mockSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    payloads: [] as string[],
    send(payload: string) {
      this.payloads.push(payload)
    },
    close() {
      this.readyState = 3
    },
  }
}

function options(socket: ReturnType<typeof mockSocket>, fetchImpl: typeof fetch, supports = true) {
  return {
    relayPort: () => 57978,
    token: () => 'test-token',
    supportsUpload: () => supports,
    fetchImpl,
    retryDelayMs: 0,
  }
}

function largeResponse(id = 'large') {
  return {
    type: 'response' as const,
    id,
    ok: true,
    result: '中文😀'.repeat(Math.ceil(RESPONSE_INLINE_BYTES / 4)),
  }
}

describe('extension HTTP response sender', () => {
  test('keeps small responses inline and legacy relays on WebSocket chunks', async () => {
    const unusedFetch = (() => {
      throw new Error('fetch should not be called')
    }) as unknown as typeof fetch
    const smallSocket = mockSocket()
    const smallSender = createUploadResponseSender(smallSocket, options(smallSocket, unusedFetch))
    const small = { type: 'response' as const, id: 'small', ok: true, result: 'ok' }
    await smallSender.send(small)
    expect(smallSocket.payloads).toEqual([JSON.stringify(small)])
    smallSender.dispose()

    const legacySocket = mockSocket()
    const legacySender = createUploadResponseSender(
      legacySocket,
      options(legacySocket, unusedFetch, false),
    )
    await legacySender.send(largeResponse())
    expect(JSON.parse(legacySocket.payloads[0]!).type).toBe('response.start')
    expect(JSON.parse(legacySocket.payloads.at(-1)!).type).toBe('response.end')
    legacySender.dispose()
  })

  test('uploads the exact UTF-8 response with digest metadata', async () => {
    const socket = mockSocket()
    let uploaded = new Uint8Array()
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer())
      return Response.json({
        ok: true,
        result: {
          requestId: 'large',
          receivedBytes: uploaded.byteLength,
          totalBytes: uploaded.byteLength,
        },
      })
    }) as typeof fetch
    const sender = createUploadResponseSender(socket, options(socket, fetchImpl))
    const response = largeResponse()
    await sender.send(response)
    const metadata = JSON.parse(socket.payloads[0]!)
    expect(metadata).toMatchObject({
      type: 'response.upload',
      id: 'large',
      totalBytes: encoder.encode(JSON.stringify(response)).byteLength,
    })
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(decoder.decode(uploaded)).toBe(JSON.stringify(response))
    expect(socket.payloads).toHaveLength(1)
    sender.dispose()
  })

  test('queries the authoritative offset and resumes after a network failure', async () => {
    const socket = mockSocket()
    const ranges: string[] = []
    let posts = 0
    let totalBytes = 0
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        return Response.json({
          ok: true,
          result: { requestId: 'large', receivedBytes: 17, totalBytes },
        })
      }
      posts += 1
      const range = init.headers as Record<string, string>
      ranges.push(range['content-range']!)
      totalBytes = Number(range['content-range']!.split('/')[1])
      if (posts === 1) throw new TypeError('connection reset')
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer())
      return Response.json({
        ok: true,
        result: { requestId: 'large', receivedBytes: 17 + bytes.byteLength, totalBytes },
      })
    }) as typeof fetch
    const sender = createUploadResponseSender(socket, options(socket, fetchImpl))
    await sender.send(largeResponse())
    expect(posts).toBe(2)
    expect(ranges[0]!.startsWith('bytes 0-')).toBe(true)
    expect(ranges[1]!.startsWith('bytes 17-')).toBe(true)
    sender.dispose()
  })

  test('honors expired deadlines and aborts an active upload on cancellation', async () => {
    const socket = mockSocket()
    const sender = createUploadResponseSender(socket, options(socket, fetch))
    await expect(sender.send(largeResponse('expired'), '1970-01-01T00:00:00.000Z')).rejects.toThrow(
      'deadline',
    )

    let rejectFetch: ((error: unknown) => void) | undefined
    const pendingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        )
      })
    }) as typeof fetch
    const cancelledSender = createUploadResponseSender(socket, options(socket, pendingFetch))
    const outcome = cancelledSender
      .send(largeResponse('cancelled'))
      .catch((error: unknown) => error)
    for (let attempt = 0; attempt < 20 && !rejectFetch; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5))
    expect(rejectFetch).toBeDefined()
    cancelledSender.cancel('cancelled')
    expect(await outcome).toMatchObject({ code: 'RESPONSE_TRANSFER_ERROR' })
    cancelledSender.dispose()
    sender.dispose()
  })
})
