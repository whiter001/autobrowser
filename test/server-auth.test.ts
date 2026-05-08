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

describe('server command authentication', () => {
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
})
