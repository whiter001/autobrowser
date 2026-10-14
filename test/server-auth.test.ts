import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
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

async function rawRequest(port: number, route: string, host: string | null): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => socket.destroy(new Error('test request timed out')))
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        `GET ${route} HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}Connection: close\r\n\r\n`,
      )
    })
    socket.on('data', (chunk) => {
      response += chunk
    })
    socket.once('end', () => resolve(response))
  })
}

describe('server command authentication', () => {
  const tempDirs: string[] = []
  const servers: Array<Awaited<ReturnType<typeof startServers>>> = []

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.stop()
      await server.runtime.persist()
    }
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true })
      }),
    )
  })

  test('requires a bearer token for IPC command requests', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-server-auth-'))
    tempDirs.push(homeDir)
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const server = await startServers({
      homeDir,
      relayPort,
      ipcPort,
      token: 'command-token',
    })
    servers.push(server)
    const commandUrl = `http://127.0.0.1:${ipcPort}/command`

    const missingTokenResponse = await fetch(commandUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'status' }),
    })
    expect(missingTokenResponse.status).toBe(401)
    await expect(missingTokenResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    })

    const authorizedResponse = await fetch(commandUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer command-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ command: 'status' }),
    })
    expect(authorizedResponse.status).toBe(200)
    await expect(authorizedResponse.json()).resolves.toMatchObject({ ok: true })
  })

  test('both listeners reject untrusted, malformed, missing, and wrong-port Hosts', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-host-test-'))
    tempDirs.push(homeDir)
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const server = await startServers({ homeDir, relayPort, ipcPort, token: 'host-token' })
    servers.push(server)

    for (const port of [relayPort, ipcPort]) {
      const otherPort = port === relayPort ? ipcPort : relayPort
      for (const host of [
        null,
        '',
        `attacker.example:${port}`,
        `localhost.attacker.example:${port}`,
        `127.0.0.1.attacker.example:${port}`,
        `[::]:${port}`,
        `0.0.0.0:${port}`,
        `127.1:${port}`,
        `127.0.0.1:${otherPort}`,
        'localhost',
        `localhost:${port}/`,
        `user@localhost:${port}`,
        `localhost:${port},localhost:${port}`,
        `localhost:0${port}`,
        'localhost:65536',
      ]) {
        const response = await rawRequest(port, '/status', host)
        // Bun 在 fetch 回调之前就会拒绝 HTTP/1.1 缺失 Host 的请求。
        expect({ host, status: response.split('\r\n')[0] }).toEqual({
          host,
          status: host === null ? 'HTTP/1.1 400 Bad Request' : 'HTTP/1.1 403 Forbidden',
        })
        expect(response).not.toContain('host-token')
      }
      for (const host of [
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `LOCALHOST:${port}`,
        `[::1]:${port}`,
      ]) {
        expect((await rawRequest(port, '/status', host)).startsWith('HTTP/1.1 200')).toBe(true)
      }
    }
    for (const route of ['/', '/connect', '/ws?token=host-token']) {
      expect(
        (await rawRequest(relayPort, route, `attacker.example:${relayPort}`)).startsWith(
          'HTTP/1.1 403',
        ),
      ).toBe(true)
    }
    for (const route of ['/command', '/shutdown']) {
      const response = await fetch(`http://127.0.0.1:${ipcPort}${route}`, {
        method: 'POST',
        headers: { host: `attacker.example:${ipcPort}`, authorization: 'Bearer host-token' },
        body: JSON.stringify({ command: 'status' }),
      })
      expect(response.status).toBe(403)
    }
  })

  test('loopback connect, extension-origin websocket, and authenticated commands still work', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-host-test-'))
    tempDirs.push(homeDir)
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const server = await startServers({ homeDir, relayPort, ipcPort, token: 'host-token' })
    servers.push(server)
    const origin = 'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep'
    const connect = await fetch(`http://127.0.0.1:${relayPort}/connect`, { headers: { origin } })
    expect(connect.status).toBe(200)
    expect(await connect.text()).toContain('host-token')
    expect((await fetch(`http://127.0.0.1:${relayPort}/ws?token=wrong`)).status).toBe(401)
    const BunWebSocket = WebSocket as unknown as {
      new (url: string, options: Bun.WebSocketOptions): WebSocket
    }
    const socket = new BunWebSocket(`ws://127.0.0.1:${relayPort}/ws?token=host-token`, {
      headers: { origin },
    })
    try {
      const hello = await new Promise<string>((resolve, reject) => {
        socket.onmessage = (event) => resolve(String(event.data))
        socket.onerror = () => reject(new Error('test websocket failed'))
      })
      expect(JSON.parse(hello).type).toBe('hello')
      socket.onmessage = (event) => {
        const command = JSON.parse(String(event.data))
        if (command.type === 'command') {
          socket.send(
            JSON.stringify({ type: 'response', id: command.id, ok: true, result: { done: true } }),
          )
        }
      }
      const response = await fetch(`http://127.0.0.1:${ipcPort}/command`, {
        method: 'POST',
        headers: { origin, authorization: 'Bearer host-token', 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'goto', args: { url: 'https://example.com' } }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, result: { done: true } })
    } finally {
      socket.close()
    }
  })

  test('public status and persisted state redact nested batch and fillform secrets', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-redaction-test-'))
    tempDirs.push(homeDir)
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const server = await startServers({ homeDir, relayPort, ipcPort })
    servers.push(server)
    for (const command of [
      { command: 'fillform', args: { fields: [{ selector: '#password', value: 'form-secret' }] } },
      {
        command: 'batch',
        args: {
          steps: [
            {
              id: 'fill-step',
              command: 'fill',
              args: { selector: '#password', value: 'fill-secret' },
            },
            {
              id: 'nested-step',
              command: 'batch',
              args: {
                steps: [
                  { command: 'eval', args: { script: 'eval-secret' } },
                  {
                    command: 'fillform',
                    args: { fields: [{ selector: '#email', value: 'form-secret' }] },
                  },
                ],
              },
            },
          ],
        },
      },
    ]) {
      const original = structuredClone(command)
      server.runtime.setLastCommand(command.command, command.args)
      await server.runtime.persist()
      expect(command).toEqual(original)
      const outputs = [await readFile(path.join(homeDir, '.autobrowser', 'state.json'), 'utf8')]
      for (const port of [relayPort, ipcPort]) {
        const response = await fetch(`http://127.0.0.1:${port}/status`)
        expect(response.status).toBe(200)
        outputs.push(await response.text())
      }
      for (const output of outputs) {
        for (const secret of ['fill-secret', 'eval-secret', 'form-secret']) {
          expect(output).not.toContain(secret)
        }
        expect(output).toContain('[redacted]')
        expect(output).toContain('#password')
        if (command.command === 'batch') {
          expect(output).toContain('nested-step')
          expect(output).toContain('#email')
        }
      }
    }
  })

  test('public /status endpoints do not expose the token', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-status-token-'))
    tempDirs.push(homeDir)
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const server = await startServers({
      homeDir,
      relayPort,
      ipcPort,
      token: 'secret-token',
    })
    servers.push(server)

    for (const port of [relayPort, ipcPort]) {
      const response = await fetch(`http://127.0.0.1:${port}/status`)
      expect(response.status).toBe(200)
      const status = (await response.json()) as Record<string, unknown>
      expect(status.token).toBeUndefined()
      expect(JSON.stringify(status)).not.toContain('secret-token')
    }

    // 已鉴权的 /command status 仍然返回完整快照（含 token），供 CLI 使用
    const authorizedResponse = await fetch(`http://127.0.0.1:${ipcPort}/command`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ command: 'status' }),
    })
    const payload = (await authorizedResponse.json()) as { result?: { token?: string } }
    expect(payload.result?.token).toBe('secret-token')
  })
})
