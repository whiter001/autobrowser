import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createUploadResponseSender } from '../extension/background/response-upload.js'
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

describe('HTTP response upload integration', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  test('round trips a large response through real WebSocket, resumable HTTP and IPC', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-upload-integration-'))
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }))
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const server = await startServers({ homeDir, relayPort, ipcPort, token: 'upload-token' })
    cleanup.push(() => server.stop())
    const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/ws?token=upload-token`)
    cleanup.push(() => socket.close())
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)))
      socket.onerror = () => reject(new Error('test websocket failed'))
    })
    expect(hello.capabilities).toMatchObject({ responseUpload: 1 })

    let firstPost = true
    let posts = 0
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return await fetch(input, init)
      posts += 1
      if (!firstPost) return await fetch(input, init)
      firstPost = false
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer())
      const headers = new Headers(init.headers)
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get('content-range')!)!
      const start = Number(range[1])
      const total = Number(range[3])
      const end = start + Math.floor(bytes.byteLength / 2) - 1
      headers.set('content-range', `bytes ${start}-${end}/${total}`)
      return await fetch(input, { ...init, headers, body: bytes.slice(0, end - start + 1) })
    }) as typeof fetch
    const sender = createUploadResponseSender(socket, {
      relayPort: () => relayPort,
      token: () => 'upload-token',
      supportsUpload: () => true,
      fetchImpl,
      retryDelayMs: 0,
    })
    cleanup.push(() => sender.dispose())
    const expected = { content: '中文😀\\\"\n'.repeat(100_000) }
    socket.onmessage = (event) => {
      const command = JSON.parse(String(event.data))
      if (command.type !== 'command') return
      void sender.send(
        { type: 'response', id: command.id, ok: true, result: expected },
        command.deadlineAt,
      )
    }

    const unauthorized = await fetch(
      `http://127.0.0.1:${relayPort}/responses/transfer-unknown-0001`,
    )
    expect(unauthorized.status).toBe(401)
    const ipcResponse = await fetch(`http://127.0.0.1:${ipcPort}/command`, {
      method: 'POST',
      headers: { authorization: 'Bearer upload-token', 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'snapshot' }),
    })
    expect(ipcResponse.status).toBe(200)
    expect(await ipcResponse.json()).toEqual({ ok: true, result: expected })
    expect(posts).toBe(2)
    expect(await readdir(path.join(homeDir, '.autobrowser', 'responses'))).toEqual([])
  }, 15_000)
})
