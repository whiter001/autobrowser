import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createFileTransferDomain } from '../extension/background/file-transfer.js'
import type { ExtensionState } from '../extension/background/types.js'
import { startServers } from '../src/server.js'

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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface Harness {
  relayPort: number
  ipcPort: number
  token: string
  originUrl: string
  bytes: Uint8Array<ArrayBuffer>
  outputPath: string
  posts: number
  truncateFirstPost: number
  socket: WebSocket
  fileTransfer: ReturnType<typeof createFileTransferDomain>
}

describe('file download integration', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  async function createHarness(options: { truncateFirstPost?: number } = {}): Promise<Harness> {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-file-download-'))
    cleanup.push(async () => {
      // relay 的状态落盘是异步的，先等它写完再删目录，避免清理时报ENOENT
      await new Promise((resolve) => setTimeout(resolve, 50))
      await rm(homeDir, { recursive: true, force: true })
    })
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const originPort = await getFreePort()
    const token = 'file-download-token'

    // 源站返回非 UTF-8 二进制，确保落盘是逐字节精确的
    const bytes = new Uint8Array(Array.from({ length: 100_000 }, (_, index) => (index * 7) % 256))
    const origin = Bun.serve({
      hostname: '127.0.0.1',
      port: originPort,
      fetch: () =>
        new Response(bytes.buffer as ArrayBuffer, {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    })
    cleanup.push(() => origin.stop(true))

    const server = await startServers({ homeDir, relayPort, ipcPort, token })
    cleanup.push(() => server.stop())

    const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/ws?token=${token}`)
    cleanup.push(() => socket.close())
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)))
      socket.onerror = () => reject(new Error('test websocket failed'))
    })
    expect(hello.capabilities).toMatchObject({ responseUpload: 1, fileUpload: 1 })

    const harness: Harness = {
      relayPort,
      ipcPort,
      token,
      originUrl: `http://127.0.0.1:${originPort}/image.bin`,
      bytes,
      outputPath: path.join(homeDir, 'downloads', 'image.bin'),
      posts: 0,
      truncateFirstPost: options.truncateFirstPost ?? 0,
      socket,
      fileTransfer: undefined as unknown as ReturnType<typeof createFileTransferDomain>,
    }

    const state = {
      connection: { socket, relayPort, token, fileUploadSupported: true },
    } as unknown as ExtensionState

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/files/') || init?.method !== 'POST') return await fetch(input, init)
      harness.posts += 1
      if (!harness.truncateFirstPost) return await fetch(input, init)
      // 第一次只送一半字节，模拟中途断流：relay 会确认已落盘的偏移
      const chunk = new Uint8Array(await new Response(init.body).arrayBuffer())
      const headers = new Headers(init.headers)
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get('content-range')!)
      const start = Number(range![1])
      const total = Number(range![3])
      const truncated = chunk.slice(0, harness.truncateFirstPost)
      headers.set('content-range', `bytes ${start}-${start + truncated.byteLength - 1}/${total}`)
      harness.truncateFirstPost = 0
      return await fetch(input, { ...init, headers, body: truncated })
    }) as typeof fetch

    harness.fileTransfer = createFileTransferDomain({ state, fetchImpl, retryDelayMs: 0 })

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'file.upload.ready') {
        harness.fileTransfer.confirmRegistration(
          message.transferId,
          message.ok === true,
          message.error?.message,
        )
        return
      }
      if (message.type !== 'command') return
      void (async () => {
        try {
          const result = await harness.fileTransfer.download({
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

    return harness
  }

  test('rejects unauthenticated file uploads', async () => {
    const harness = await createHarness()
    const unauthorized = await fetch(
      `http://127.0.0.1:${harness.relayPort}/files/transfer-unknown-0001`,
    )
    expect(unauthorized.status).toBe(401)
    const unauthorizedPost = await fetch(
      `http://127.0.0.1:${harness.relayPort}/files/transfer-unknown-0001`,
      { method: 'POST', body: 'x' },
    )
    expect(unauthorizedPost.status).toBe(401)
  })

  test('downloads binary content to the requested path and reports the digest', async () => {
    const harness = await createHarness()
    const ipcResponse = await fetch(`http://127.0.0.1:${harness.ipcPort}/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harness.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        command: 'download',
        args: { url: harness.originUrl, outputPath: harness.outputPath },
      }),
    })
    expect(ipcResponse.status).toBe(200)
    const payload = (await ipcResponse.json()) as {
      ok: boolean
      result: Record<string, unknown>
    }
    expect(payload.ok).toBe(true)
    expect(payload.result).toMatchObject({
      path: harness.outputPath,
      sourceUrl: harness.originUrl,
      finalUrl: harness.originUrl,
      contentType: 'application/octet-stream',
      bytes: harness.bytes.byteLength,
      sha256: sha256(harness.bytes),
    })
    expect(new Uint8Array(await readFile(harness.outputPath))).toEqual(harness.bytes)
    // 成功后目标目录里只剩最终文件，没有临时文件残留
    expect(await readdir(path.dirname(harness.outputPath))).toEqual(['image.bin'])
  }, 15_000)

  test('resumes from the confirmed offset when a segment is cut short', async () => {
    const harness = await createHarness({ truncateFirstPost: 40_000 })
    const ipcResponse = await fetch(`http://127.0.0.1:${harness.ipcPort}/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harness.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        command: 'download',
        args: { url: harness.originUrl, outputPath: harness.outputPath },
      }),
    })
    expect(ipcResponse.status).toBe(200)
    const payload = (await ipcResponse.json()) as { ok: boolean; result: Record<string, unknown> }
    expect(payload.ok).toBe(true)
    expect(payload.result).toMatchObject({
      path: harness.outputPath,
      bytes: harness.bytes.byteLength,
      sha256: sha256(harness.bytes),
    })
    // 第一次只送了一半，第二次必须从 relay 确认的偏移续传
    expect(harness.posts).toBe(2)
    expect(new Uint8Array(await readFile(harness.outputPath))).toEqual(harness.bytes)
    expect(await readdir(path.dirname(harness.outputPath))).toEqual(['image.bin'])
  }, 15_000)
})
