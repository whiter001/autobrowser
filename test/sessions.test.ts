import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getConfigPath, getTokenPath, readJsonFile, writeJsonFile } from '../src/core/protocol.js'
import {
  createSession,
  deleteSessionData,
  listSessions,
  readSession,
} from '../src/core/sessions.js'

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-sessions-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('named sessions', () => {
  test('isolates home, profile, ports and token files across sessions', async () => {
    await withTempHome(async (home) => {
      const alpha = await createSession(home, 'alpha', { portInUse: async () => false })
      const beta = await createSession(home, 'beta', { portInUse: async () => false })
      expect(alpha.homeDir).not.toBe(beta.homeDir)
      expect(alpha.profileDir).not.toBe(beta.profileDir)
      expect(alpha.relayPort).not.toBe(beta.relayPort)
      expect(alpha.ipcPort).not.toBe(beta.ipcPort)
      expect(
        await readJsonFile<Record<string, unknown> | null>(getConfigPath(alpha.homeDir), null),
      ).toEqual({
        browserArgs: [`--user-data-dir=${alpha.profileDir}`],
      })

      await writeJsonFile(getTokenPath(alpha.homeDir), { token: 'alpha-token' })
      await writeJsonFile(getTokenPath(beta.homeDir), { token: 'beta-token' })
      expect(
        await readJsonFile<Record<string, unknown> | null>(getTokenPath(alpha.homeDir), null),
      ).toEqual({
        token: 'alpha-token',
      })
      expect(
        await readJsonFile<Record<string, unknown> | null>(getTokenPath(beta.homeDir), null),
      ).toEqual({ token: 'beta-token' })
      expect((await listSessions(home)).map((session) => session.name)).toEqual(['alpha', 'beta'])
      expect(await readSession(home, 'alpha')).toEqual(alpha)
    })
  })

  test('rejects duplicate names, invalid names and unavailable explicit ports', async () => {
    await withTempHome(async (home) => {
      await createSession(home, 'alpha', { portInUse: async () => false })
      await expect(createSession(home, 'alpha')).rejects.toMatchObject({ code: 'SESSION_EXISTS' })
      await expect(createSession(home, '../escape')).rejects.toMatchObject({
        code: 'INVALID_SESSION_NAME',
      })
      await expect(
        createSession(home, 'busy', { relayPort: 59000, portInUse: async () => true }),
      ).rejects.toMatchObject({ code: 'SESSION_PORT_UNAVAILABLE' })
    })
  })

  test('skips an explicitly assigned relay port when allocating IPC', async () => {
    await withTempHome(async (home) => {
      const session = await createSession(home, 'custom', {
        relayPort: 58000,
        portInUse: async () => false,
      })
      expect(session.relayPort).toBe(58000)
      expect(session.ipcPort).toBe(58001)
    })
  })

  test('delete-data is idempotent and never targets the default session', async () => {
    await withTempHome(async (home) => {
      await createSession(home, 'alpha', { portInUse: async () => false })
      expect(await deleteSessionData(home, 'alpha')).toEqual({
        name: 'alpha',
        deleted: true,
        alreadyClean: false,
      })
      expect(await deleteSessionData(home, 'alpha')).toEqual({
        name: 'alpha',
        deleted: false,
        alreadyClean: true,
      })
      await expect(deleteSessionData(home, 'default')).rejects.toMatchObject({
        code: 'INVALID_SESSION_NAME',
      })
    })
  })

  test('profile lock failures return recoverable SESSION_DATA_LOCKED', async () => {
    await withTempHome(async (home) => {
      await createSession(home, 'locked', { portInUse: async () => false })
      await expect(
        deleteSessionData(home, 'locked', async () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }),
      ).rejects.toMatchObject({ code: 'SESSION_DATA_LOCKED' })
      expect((await listSessions(home)).map((session) => session.name)).toEqual(['locked'])
    })
  })
})
