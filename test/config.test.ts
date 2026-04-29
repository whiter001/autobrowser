import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConnectLaunchConfig } from '../src/core/config.js'
import { getConfigPath } from '../src/core/protocol.js'

const DEFAULT_EXTENSION_ID = 'bfccnpkjkbhceghimfjgnkigilidldep'
const tempDirs: string[] = []
const originalAutobrowserExtensionId = process.env.AUTOBROWSER_EXTENSION_ID

async function writeConfig(homeDir: string, value: unknown): Promise<void> {
  const configPath = getConfigPath(homeDir)
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readConfig(homeDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(getConfigPath(homeDir), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

afterEach(async () => {
  if (originalAutobrowserExtensionId === undefined) {
    delete process.env.AUTOBROWSER_EXTENSION_ID
  } else {
    process.env.AUTOBROWSER_EXTENSION_ID = originalAutobrowserExtensionId
  }

  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true })
    }),
  )
})

describe('connect launch config', () => {
  test('persists explicit extension and browser launch settings together', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-config-'))
    tempDirs.push(homeDir)

    const result = await resolveConnectLaunchConfig(homeDir, {
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      browserCommand: '  /Applications/Google Chrome  ',
      browserArgs: [' --profile-directory=Profile 1 ', '   '],
    })

    expect(result).toEqual({
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      browserConfig: {
        command: '/Applications/Google Chrome',
        args: ['--profile-directory=Profile 1'],
      },
    })
    expect(await readConfig(homeDir)).toEqual({
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      browserCommand: '/Applications/Google Chrome',
      browserArgs: ['--profile-directory=Profile 1'],
    })
  })

  test('reuses persisted settings when no explicit overrides are provided', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-config-'))
    tempDirs.push(homeDir)

    await writeConfig(homeDir, {
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      browserCommand: 'chrome',
      browserArgs: ['--profile-directory=Profile 1'],
    })

    const result = await resolveConnectLaunchConfig(homeDir)

    expect(result).toEqual({
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      browserConfig: {
        command: 'chrome',
        args: ['--profile-directory=Profile 1'],
      },
    })
    expect(await readConfig(homeDir)).toEqual({
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      browserCommand: 'chrome',
      browserArgs: ['--profile-directory=Profile 1'],
    })
  })

  test('repairs an invalid persisted extension id without dropping browser config', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-config-'))
    tempDirs.push(homeDir)

    await writeConfig(homeDir, {
      extensionId: 'invalid-extension-id',
      browserCommand: 'msedge',
      browserArgs: ['--profile-directory=Profile 1'],
    })

    const result = await resolveConnectLaunchConfig(homeDir)

    expect(result).toEqual({
      extensionId: DEFAULT_EXTENSION_ID,
      browserConfig: {
        command: 'msedge',
        args: ['--profile-directory=Profile 1'],
      },
    })
    expect(await readConfig(homeDir)).toEqual({
      extensionId: DEFAULT_EXTENSION_ID,
      browserCommand: 'msedge',
      browserArgs: ['--profile-directory=Profile 1'],
    })
  })
})
