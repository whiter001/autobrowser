import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildCliConfigStatus } from '../src/cli/commands/server.js'

describe('server config status', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true })
      }),
    )
  })

  test('reads persisted cli config and exposes related paths', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-config-test-'))
    tempDirs.push(homeDir)

    const configDir = path.join(homeDir, '.autobrowser')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify(
        {
          extensionId: 'bfccnpkjkbhceghimfjgnkigilidldep',
          browserCommand: 'chrome',
          browserArgs: ['--new-window'],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )

    const status = await buildCliConfigStatus(homeDir)

    expect(status.homeDir).toBe(homeDir)
    expect(status.paths).toMatchObject({
      config: path.join(homeDir, '.autobrowser', 'config.json'),
      state: path.join(homeDir, '.autobrowser', 'state.json'),
      token: path.join(homeDir, '.autobrowser', 'token'),
    })
    expect(status.config).toMatchObject({
      extensionId: 'bfccnpkjkbhceghimfjgnkigilidldep',
      browserCommand: 'chrome',
      browserArgs: ['--new-window'],
    })
  })
})
