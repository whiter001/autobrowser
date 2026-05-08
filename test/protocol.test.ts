import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isValidPort, readJsonFile, writeJsonFile } from '../src/core/protocol.js'

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
})

describe('protocol validation helpers', () => {
  test('validates TCP port ranges', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(Number.NaN)).toBe(false)
  })
})
