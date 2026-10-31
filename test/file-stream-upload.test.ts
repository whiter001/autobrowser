import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createFileTransferDomain } from '../extension/background/file-transfer.js'
import { createFileUploadRegistry, uploadFileStream } from '../extension/background/file-upload.js'
import type { ExtensionState } from '../extension/background/types.js'
import { startServers } from '../src/server.js'

const RELAY_PORT = 57979
const TOKEN = 'file-stream-token'
/** 与扩展侧的流式阈值一致：超过它的下载必须走流式路径 */
const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024
const PATTERN_MODULO = 251

function patternByte(index: number): number {
  return index % PATTERN_MODULO
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 按需产出确定性的字节流，不事先把整个文件放进内存 */
function createSourceStream(totalBytes: number, pieceSize = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(pieceSize, totalBytes - offset)
      const piece = new Uint8Array(size)
      for (let index = 0; index < size; index += 1) piece[index] = patternByte(offset + index)
      offset += size
      controller.enqueue(piece)
    },
  })
}

function expectedDigest(totalBytes: number): string {
  const hash = createHash('sha256')
  const piece = new Uint8Array(64 * 1024)
  for (let offset = 0; offset < totalBytes; offset += piece.byteLength) {
    const size = Math.min(piece.byteLength, totalBytes - offset)
    for (let index = 0; index < size; index += 1) piece[index] = patternByte(offset + index)
    hash.update(piece.subarray(0, size))
  }
  return hash.digest('hex')
}

/** 整份字节：需要源站返回固定长度响应时用 */
function createSourceBytes(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes)
  for (let index = 0; index < totalBytes; index += 1) bytes[index] = patternByte(index)
  return bytes
}

interface RelayPost {
  range: string
  digest: string | null
  complete: boolean
  body: Uint8Array
}

interface RelayState {
  received: number
  hash: ReturnType<typeof createHash>
}

/**
 * 假的 relay HTTP 通道：校验每段摘要、只接受接在已确认偏移之后的分段，
 * 并在收齐后返回整文件摘要。
 */
function createRelayMock(
  totalBytes: number,
  hook?: (
    post: RelayPost,
    index: number,
    state: RelayState,
  ) => { status: number; message?: string } | undefined,
) {
  const state: RelayState = { received: 0, hash: createHash('sha256') }
  const posts: RelayPost[] = []
  let digest: string | null = null

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('/files/')) throw new Error(`unexpected request: ${url}`)
    const headers = new Headers(init?.headers)
    const method = (init?.method || 'GET').toUpperCase()
    if (method === 'GET') {
      return new Response(
        JSON.stringify({ ok: true, result: { receivedBytes: state.received, totalBytes } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer())
    const post: RelayPost = {
      range: headers.get('content-range') || '',
      digest: headers.get('x-file-chunk-sha256'),
      complete: headers.get('x-file-complete') === '1',
      body,
    }
    const index = posts.length
    posts.push(post)
    const override = hook?.(post, index, state)
    if (override) {
      return new Response(
        JSON.stringify({ ok: false, error: { message: override.message || 'conflict' } }),
        { status: override.status },
      )
    }
    // buffered 路径不带分段摘要，流式路径必须带且校验通过
    if (post.digest && post.digest !== sha256(body)) {
      return new Response(
        JSON.stringify({ ok: false, error: { message: 'chunk digest mismatch' } }),
        { status: 422 },
      )
    }
    const start = Number(/bytes (\d+)-/.exec(post.range)?.[1])
    if (start !== state.received) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { message: 'offset mismatch' },
          receivedBytes: state.received,
        }),
        { status: 409 },
      )
    }
    state.hash.update(body)
    state.received += body.byteLength
    const done = state.received === totalBytes
    if (done) digest = state.hash.digest('hex')
    const result: Record<string, unknown> = {
      receivedBytes: state.received,
      totalBytes,
      ...(digest ? { sha256: digest } : {}),
    }
    return new Response(JSON.stringify({ ok: true, result }), {
      status: done ? 200 : 202,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  return { fetchImpl, posts, state }
}

function createSocket(sent: unknown[]): { readyState: number; send(data: string): void } {
  return {
    readyState: 1,
    send(data: string) {
      sent.push(JSON.parse(data))
    },
  }
}

function createState(socket: unknown): ExtensionState {
  return {
    connection: { socket, relayPort: RELAY_PORT, token: TOKEN, fileUploadSupported: true },
  } as unknown as ExtensionState
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a test port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

describe('streaming file upload (extension side)', () => {
  test('downloads a large file without ever calling arrayBuffer', async () => {
    const totalBytes = STREAM_THRESHOLD_BYTES + 4096
    const sent: Array<Record<string, unknown>> = []
    const socket = createSocket(sent)
    const state = createState(socket)
    const relay = createRelayMock(totalBytes)

    let arrayBufferCalls = 0
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/files/')) return await relay.fetchImpl(input, init)
      const response = new Response(createSourceStream(totalBytes), {
        headers: {
          'content-length': String(totalBytes),
          'content-type': 'application/octet-stream',
        },
      })
      // 流式路径一旦调用 arrayBuffer 就说明整个文件被读进了内存
      Object.defineProperty(response, 'arrayBuffer', {
        value: async () => {
          arrayBufferCalls += 1
          throw new Error('arrayBuffer must not be called for large downloads')
        },
      })
      return response
    }) as typeof fetch

    const fileTransfer = createFileTransferDomain({ state, fetchImpl, retryDelayMs: 0 })
    const originalSend = socket.send
    socket.send = (data: string) => {
      originalSend(data)
      const message = JSON.parse(data) as Record<string, unknown>
      if (message.type === 'file.upload') {
        queueMicrotask(() => fileTransfer.confirmRegistration(message.transferId as string, true))
      }
    }

    const result = await fileTransfer.download({
      url: 'https://example.com/large.bin',
      requestId: 'cmd_stream_1',
    })

    expect(arrayBufferCalls).toBe(0)
    expect(result.bytes).toBe(totalBytes)
    // 摘要由 relay 边写边算后回传
    expect(result.sha256).toBe(expectedDigest(totalBytes))

    // 登记不带整文件摘要，只有已知总长度
    const registration = sent.find((message) => message.type === 'file.upload')!
    expect(registration).toMatchObject({ id: 'cmd_stream_1', totalBytes, sha256: null })

    // 每段都带自己的摘要，最后一段明确标记完成
    expect(relay.posts.length).toBe(2)
    for (const post of relay.posts) {
      expect(post.digest).toBe(sha256(post.body))
    }
    expect(relay.posts[0]!.range).toBe(`bytes 0-${STREAM_THRESHOLD_BYTES - 1}/${totalBytes}`)
    expect(relay.posts[0]!.complete).toBe(false)
    expect(relay.posts[1]!.complete).toBe(true)
    expect(relay.posts[1]!.range).toBe(
      `bytes ${STREAM_THRESHOLD_BYTES}-${totalBytes - 1}/${totalBytes}`,
    )
  }, 30_000)

  test('keeps small downloads on the buffered path', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const sent: Array<Record<string, unknown>> = []
    const socket = createSocket(sent)
    const state = createState(socket)
    const relay = createRelayMock(bytes.byteLength)

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/files/')) return await relay.fetchImpl(input, init)
      return new Response(bytes.buffer as ArrayBuffer, {
        headers: { 'content-type': 'application/octet-stream' },
      })
    }) as typeof fetch

    const fileTransfer = createFileTransferDomain({ state, fetchImpl, retryDelayMs: 0 })
    const originalSend = socket.send
    socket.send = (data: string) => {
      originalSend(data)
      const message = JSON.parse(data) as Record<string, unknown>
      if (message.type === 'file.upload') {
        queueMicrotask(() => fileTransfer.confirmRegistration(message.transferId as string, true))
      }
    }

    const result = await fileTransfer.download({
      url: 'https://example.com/small.bin',
      requestId: 'cmd_stream_2',
    })
    expect(result.sha256).toBe(sha256(bytes))
    // buffered 路径自己算摘要并写进登记
    expect(sent.find((message) => message.type === 'file.upload')).toMatchObject({
      sha256: sha256(bytes),
    })
  })

  test('resumes a chunk from the authoritative offset without replaying confirmed bytes', async () => {
    const totalBytes = 2048
    const chunkBytes = 1024
    const relay = createRelayMock(totalBytes, (post, index, state) => {
      if (index !== 0) return undefined
      // 模拟第一段只落盘了一部分就失败：relay 已确认 100 字节
      state.hash.update(post.body.subarray(0, 100))
      state.received = 100
      return { status: 500, message: 'segment failed' }
    })

    const registry = createFileUploadRegistry()
    const sent: Array<Record<string, unknown>> = []
    const socket = createSocket(sent)
    const transferId = 'transfer-stream-resume1'

    const upload = uploadFileStream({
      socket,
      registry,
      relayPort: () => RELAY_PORT,
      token: () => TOKEN,
      requestId: 'cmd_stream_3',
      transferId,
      totalBytes,
      source: createSourceStream(totalBytes),
      chunkBytes,
      fetchImpl: relay.fetchImpl,
      retryDelayMs: 0,
    })
    queueMicrotask(() => registry.confirm(transferId, true))

    const result = await upload
    expect(result.receivedBytes).toBe(totalBytes)
    expect(result.sha256).toBe(expectedDigest(totalBytes))

    // 第一段失败一次后重发，加上剩下的第二段，一共三次 POST
    expect(relay.posts.length).toBe(3)
    // 第二次只重发保留块里尚未确认的剩余部分，不重放已确认的 100 字节
    expect(relay.posts[1]!.range).toBe(`bytes 100-${chunkBytes - 1}/${totalBytes}`)
    expect(relay.posts[1]!.body.byteLength).toBe(chunkBytes - 100)
    expect(relay.posts[1]!.digest).toBe(sha256(relay.posts[1]!.body))
    expect(relay.state.received).toBe(totalBytes)
  })

  test('fails when the relay rejects a chunk digest', async () => {
    const totalBytes = 2048
    const relay = createRelayMock(totalBytes, () => ({
      status: 422,
      message: 'chunk digest mismatch',
    }))
    const registry = createFileUploadRegistry()
    const sent: Array<Record<string, unknown>> = []
    const socket = createSocket(sent)
    const transferId = 'transfer-stream-digest1'

    const upload = uploadFileStream({
      socket,
      registry,
      relayPort: () => RELAY_PORT,
      token: () => TOKEN,
      requestId: 'cmd_stream_4',
      transferId,
      totalBytes,
      source: createSourceStream(totalBytes),
      chunkBytes: 1024,
      fetchImpl: relay.fetchImpl,
      retryDelayMs: 0,
    })
    queueMicrotask(() => registry.confirm(transferId, true))

    await expect(upload).rejects.toThrow(/HTTP 422/)
  })
})

describe('streaming file download integration', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  test('streams a large file through the real relay into the target path', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-file-stream-'))
    cleanup.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await rm(homeDir, { recursive: true, force: true })
    })
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const originPort = await getFreePort()
    const token = 'file-stream-integration-token'
    const totalBytes = STREAM_THRESHOLD_BYTES + 8192

    const origin = Bun.serve({
      hostname: '127.0.0.1',
      port: originPort,
      // 固定长度的响应才会带上 Content-Length，扩展据此判断能否走流式路径
      fetch: () =>
        new Response(createSourceBytes(totalBytes).buffer as ArrayBuffer, {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    })
    cleanup.push(() => origin.stop(true))

    const server = await startServers({ homeDir, relayPort, ipcPort, token })
    cleanup.push(() => server.stop())

    const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/ws?token=${token}`)
    cleanup.push(() => socket.close())
    await new Promise((resolve, reject) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)))
      socket.onerror = () => reject(new Error('test websocket failed'))
    })

    const outputPath = path.join(homeDir, 'downloads', 'large.bin')
    // 记录扩展发出的登记消息：流式登记不带整文件摘要，可以证明走的是流式路径
    const registrations: Array<Record<string, unknown>> = []
    const socketProxy = {
      get readyState() {
        return socket.readyState
      },
      send(data: string) {
        const message = JSON.parse(data) as Record<string, unknown>
        if (message.type === 'file.upload') registrations.push(message)
        socket.send(data)
      },
    }
    const state = {
      connection: { socket: socketProxy, relayPort, token, fileUploadSupported: true },
    } as unknown as ExtensionState
    const fileTransfer = createFileTransferDomain({ state, retryDelayMs: 0 })

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'file.upload.ready') {
        fileTransfer.confirmRegistration(
          message.transferId,
          message.ok === true,
          message.error?.message,
        )
        return
      }
      if (message.type !== 'command') return
      void (async () => {
        try {
          const result = await fileTransfer.download({
            url: String(message.args?.url || ''),
            requestId: message.id,
            deadlineAt: message.deadlineAt,
          })
          socket.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result }))
        } catch (error) {
          socket.send(
            JSON.stringify({
              type: 'response',
              id: message.id,
              ok: false,
              error: { message: error instanceof Error ? error.message : String(error) },
            }),
          )
        }
      })()
    }

    const ipcResponse = await fetch(`http://127.0.0.1:${ipcPort}/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        command: 'download',
        args: { url: `http://127.0.0.1:${originPort}/large.bin`, outputPath },
      }),
    })
    expect(ipcResponse.status).toBe(200)
    const payload = (await ipcResponse.json()) as {
      ok: boolean
      result: Record<string, unknown>
    }
    expect(payload.ok).toBe(true)
    expect(payload.result).toMatchObject({
      path: outputPath,
      bytes: totalBytes,
      sha256: expectedDigest(totalBytes),
    })
    // 登记不带整文件摘要：摘要由 relay 边写边算，大文件确实走了流式路径
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({ totalBytes, sha256: null })
    const written = await readFile(outputPath)
    expect(written.byteLength).toBe(totalBytes)
    expect(sha256(new Uint8Array(written))).toBe(expectedDigest(totalBytes))
    // 成功后目标目录里只剩最终文件，没有临时文件残留
    expect(await readdir(path.dirname(outputPath))).toEqual(['large.bin'])
  }, 60_000)
})
