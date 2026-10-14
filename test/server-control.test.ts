import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { getStatus } from '../src/cli/client.js'
import { waitForServerStatus } from '../src/cli/server-control.js'

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
