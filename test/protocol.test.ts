import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupStaleTempFiles,
  isPortInUse,
  isValidPort,
  readJsonFile,
  writeJsonFile,
} from '../src/core/protocol.js'

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

  test('removes stale crash-left temp files but keeps fresh ones', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-protocol-test-'))
    tempDirs.push(tempDir)
    const stateDir = path.join(tempDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })

    const staleState = path.join(stateDir, 'state.json.1234.deadbeef.tmp')
    const staleToken = path.join(stateDir, 'token.1234.deadbeef.tmp')
    const fresh = path.join(stateDir, 'config.json.9999.fresh.tmp')
    const unrelated = path.join(stateDir, 'notes.txt')
    await writeFile(staleState, '{')
    await writeFile(staleToken, '{')
    await writeFile(fresh, '{')
    await writeFile(unrelated, 'keep me')

    const hourAgo = new Date(Date.now() - 3_600_000)
    await utimes(staleState, hourAgo, hourAgo)
    await utimes(staleToken, hourAgo, hourAgo)

    await cleanupStaleTempFiles(tempDir)

    await expect(access(staleState)).rejects.toThrow()
    await expect(access(staleToken)).rejects.toThrow()
    // 新鲜（仍在写入中）的临时文件和无关文件不应被删
    // （bun 的 access() 成功时 resolve 为 null，因此这里直接 await，缺文件会抛 ENOENT）
    await access(fresh)
    await access(unrelated)
  })

  test('tolerates a missing state directory during temp cleanup', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-protocol-test-'))
    tempDirs.push(tempDir)

    await expect(cleanupStaleTempFiles(tempDir)).resolves.toBeUndefined()
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
