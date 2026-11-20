import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { getStatus } from '../src/cli/client.js'
import {
  buildServerLaunchArgs,
  waitForPortsToClose,
  waitForServerStatus,
} from '../src/cli/server-control.js'

const status = { relayPort: 12345, ipcPort: 12346, extensionConnected: false }

describe('server status polling deadlines', () => {
  const servers: Server[] = []
  const timers: Array<ReturnType<typeof setTimeout>> = []

  afterEach(async () => {
    for (const timer of timers.splice(0)) {
      clearTimeout(timer)
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections()
            server.close((error) => (error ? reject(error) : resolve()))
          }),
      ),
    )
  })

  function later(callback: () => void, ms: number): void {
    timers.push(setTimeout(callback, ms))
  }

  async function serve(handler: (response: ServerResponse) => void): Promise<string> {
    const server = createServer((_request, response) => handler(response))
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('failed to allocate test listener')
    }
    return `http://127.0.0.1:${address.port}`
  }

  test('getStatus remains compatible without a signal and accepts a signal', async () => {
    const url = await serve((response) => response.end(JSON.stringify(status)))
    expect(await getStatus(url)).toEqual(status)
    expect(await getStatus(url, new AbortController().signal)).toEqual(status)
    expect(await waitForServerStatus(url, status.relayPort, status.ipcPort)).toEqual(status)
  })

  for (const phase of ['headers', 'body'] as const) {
    test(`bounds delayed ${phase} by the total deadline`, async () => {
      let requests = 0
      const url = await serve((response) => {
        requests += 1
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.flushHeaders()
          response.write('{')
        }
        later(() => response.end(JSON.stringify(status).slice(phase === 'body' ? 1 : 0)), 600)
      })
      const startedAt = Date.now()
      expect(await waitForServerStatus(url, status.relayPort, status.ipcPort, 80)).toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(400)
      expect(requests).toBe(1)
    })

    test(`external abort interrupts delayed ${phase}`, async () => {
      const controller = new AbortController()
      let requests = 0
      const url = await serve((response) => {
        requests += 1
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.flushHeaders()
          response.write('{')
        }
        later(() => controller.abort(), 50)
        later(() => response.end(JSON.stringify(status).slice(phase === 'body' ? 1 : 0)), 600)
      })
      const startedAt = Date.now()
      expect(
        await waitForServerStatus(
          url,
          status.relayPort,
          status.ipcPort,
          2000,
          100,
          controller.signal,
        ),
      ).toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(400)
      expect(requests).toBe(1)
    })
  }

  test('getStatus forwards cancellation through response body parsing', async () => {
    const controller = new AbortController()
    const url = await serve((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.flushHeaders()
      response.write('{')
      later(() => controller.abort(), 50)
      later(() => response.end(JSON.stringify(status).slice(1)), 600)
    })
    const startedAt = Date.now()
    await expect(getStatus(url, controller.signal)).rejects.toThrow()
    expect(Date.now() - startedAt).toBeLessThan(400)
  })

  test('caps retry sleep at the remaining deadline', async () => {
    let requests = 0
    const url = await serve((response) => {
      requests += 1
      response.end('{}')
    })
    const startedAt = Date.now()
    expect(await waitForServerStatus(url, status.relayPort, status.ipcPort, 80, 1000)).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(400)
    expect(requests).toBe(1)
  })

  test('external abort interrupts retry sleep and pre-aborted calls make no request', async () => {
    const controller = new AbortController()
    let requests = 0
    const url = await serve((response) => {
      requests += 1
      response.end('{}')
      later(() => controller.abort(), 50)
    })
    const startedAt = Date.now()
    expect(
      await waitForServerStatus(
        url,
        status.relayPort,
        status.ipcPort,
        2000,
        1000,
        controller.signal,
      ),
    ).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(400)
    expect(
      await waitForServerStatus(
        url,
        status.relayPort,
        status.ipcPort,
        2000,
        1000,
        controller.signal,
      ),
    ).toBeNull()
    expect(requests).toBe(1)
  })

  test('retries invalid responses and returns a matching status before the deadline', async () => {
    let requests = 0
    const url = await serve((response) => {
      requests += 1
      response.end(requests === 1 ? 'invalid JSON' : JSON.stringify(status))
    })
    expect(await waitForServerStatus(url, status.relayPort, status.ipcPort, 1000, 10)).toEqual(
      status,
    )
    expect(requests).toBe(2)
  })
})

describe('background server launch arguments', () => {
  test('places named session and global options before the server command', () => {
    expect(
      buildServerLaunchArgs({ relayPort: 58000, ipcPort: 58001 }, 'extension-id', 'work'),
    ).toEqual([
      process.argv[1],
      '--session',
      'work',
      '--relay-port',
      '58000',
      '--ipc-port',
      '58001',
      '--extension-id',
      'extension-id',
      'server',
      '--serve',
    ])
  })

  test('keeps the default session launch free of a session flag', () => {
    const args = buildServerLaunchArgs({ relayPort: 57978, ipcPort: 57979 }, 'extension-id')
    expect(args).not.toContain('--session')
    expect(args.indexOf('server')).toBeGreaterThan(args.indexOf('--extension-id'))
  })
})

describe('waiting for stopped listeners to release ports', () => {
  async function listenOnFreePort(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createTcpServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('failed to allocate a listener')
    }

    // 测试里会先定时关闭再在 finally 里收尾，close 必须可重复调用。
    let closed = false
    return {
      port: address.port,
      close: () => {
        if (closed) return Promise.resolve()
        closed = true
        return new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
      },
    }
  }

  test('returns immediately once every port is free', async () => {
    const first = await listenOnFreePort()
    const second = await listenOnFreePort()
    const ports = [first.port, second.port]
    await first.close()
    await second.close()

    expect(await waitForPortsToClose(ports, 1000)).toBe(true)
  })

  test('keeps polling until the listener actually closes', async () => {
    const listener = await listenOnFreePort()
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      void listener.close()
    }, 60)

    try {
      expect(await waitForPortsToClose([listener.port], 2000, 10)).toBe(true)
      // 端口在第二轮轮询前一直可连，必须等到它真的关闭才算释放。
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40)
    } finally {
      clearTimeout(timer)
      await listener.close()
    }
  })

  test('reports a port that is still occupied after the deadline', async () => {
    const listener = await listenOnFreePort()

    try {
      expect(await waitForPortsToClose([listener.port], 150, 20)).toBe(false)
    } finally {
      await listener.close()
    }
  })
})
