import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
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

      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForWsClose(ws: WebSocket, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return
    }
    await delay(10)
  }
  throw new Error(`websocket did not close within ${timeoutMs}ms`)
}

describe('server shutdown', () => {
  const tempDirs: string[] = []
  const servers: Array<{ stop(): void }> = []

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.stop()
    }
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true })
      }),
    )
  })

  test('stop() closes active websocket connections and invokes onShutdown exactly once', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-server-shutdown-'))
    tempDirs.push(homeDir)
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    let shutdownCalls = 0
    const server = await startServers({
      homeDir,
      relayPort,
      ipcPort,
      token: 'shutdown-token',
      onShutdown: () => {
        shutdownCalls += 1
      },
    })
    servers.push(server)

    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws?token=shutdown-token`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('websocket failed to open'))
    })
    expect(server.runtime.snapshot().extensionConnected).toBe(true)

    server.stop()

    expect(shutdownCalls).toBe(1)
    await waitForWsClose(ws)
    // close 事件触发 detach，扩展被标记为断开
    expect(server.runtime.snapshot().extensionConnected).toBe(false)

    // 再次 stop 不应重复触发（防重入）
    server.stop()
    expect(shutdownCalls).toBe(1)
  })

  test('/shutdown endpoint triggers onShutdown so the --serve process can exit', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-server-shutdown-'))
    tempDirs.push(homeDir)
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    let shutdownCalls = 0
    const server = await startServers({
      homeDir,
      relayPort,
      ipcPort,
      token: 'shutdown-token',
      onShutdown: () => {
        shutdownCalls += 1
      },
    })
    servers.push(server)

    const response = await fetch(`http://127.0.0.1:${ipcPort}/shutdown`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer shutdown-token',
        'content-type': 'application/json',
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { stopping: true },
    })

    // requestShutdown 通过 setTimeout(0) 延迟到响应写回之后执行
    await delay(50)
    expect(shutdownCalls).toBe(1)
  })
})
