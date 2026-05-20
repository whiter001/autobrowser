import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { isPortInUse, isValidPort, readJsonFile, writeJsonFile } from '../src/core/protocol.js'

describe('protocol file helpers', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true })
      }),
    )
  })

  test('writes readable JSON with private file permissions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-protocol-test-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, '.autobrowser', 'token')

    await writeJsonFile(filePath, { token: 'secret' })

    await expect(readJsonFile(filePath)).resolves.toEqual({ token: 'secret' })
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    }
  })

  test('returns the fallback when JSON content is corrupted', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-protocol-test-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, '.autobrowser', 'state.json')

    await Bun.write(filePath, '{bad json')

    await expect(readJsonFile(filePath, { ok: false })).resolves.toEqual({ ok: false })
  })
})

describe('protocol validation helpers', () => {
  test('validates TCP port ranges', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(Number.NaN)).toBe(false)
  })

  test('detects listening TCP ports even when they do not expose /status', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404
      response.end('not autobrowser')
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('failed to allocate test port')
      }

      await expect(isPortInUse(address.port)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    }
  })
})
