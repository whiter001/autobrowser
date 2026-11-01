import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserProfileLockError } from '../src/cli/browser-launch.js'
import { runCli } from './command-line-test-utils.js'

describe('cli command routing', () => {
  test('connect opens the extension page when the server reports a token', async () => {
    const result = await runCli(
      ['connect'],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        openUrl: async () => {},
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(String(result.fetchCalls[0].url)).toBe('http://127.0.0.1:57979/status')
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=live-token&relayPort=48011&ipcPort=48012',
    ])
    expect(result.browserCalls).toEqual([null])
  })

  test('connect honors an explicit extension id override', async () => {
    const result = await runCli(
      ['connect', '--extension-id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        openUrl: async () => {},
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.openCalls).toEqual([
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/connect.html?token=live-token&relayPort=48011&ipcPort=48012',
    ])
  })

  test('connect persists the extension id for later runs', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-config-test-'))

    const firstResult = await runCli(
      ['connect', '--extension-id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        homeDir,
        openUrl: async () => {},
      },
    )

    expect(firstResult.exitCode).toBe(0)
    const configPath = path.join(homeDir, '.autobrowser', 'config.json')
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })

    const secondResult = await runCli(
      ['connect'],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        homeDir,
        openUrl: async () => {},
      },
    )

    expect(secondResult.exitCode).toBe(0)
    expect(secondResult.openCalls).toEqual([
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/connect.html?token=live-token&relayPort=48011&ipcPort=48012',
    ])
  })

  test('connect persists the browser command for later runs', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-browser-config-'))
    const browserCommand = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const browserArg = '--profile-directory=Profile 1'

    const firstResult = await runCli(
      ['connect', '--browser-command', browserCommand, '--browser-arg', browserArg],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        homeDir,
        openUrl: async () => {},
      },
    )

    expect(firstResult.exitCode).toBe(0)
    expect(firstResult.browserCalls).toEqual([
      {
        command: browserCommand,
        args: [browserArg],
      },
    ])
    const configPath = path.join(homeDir, '.autobrowser', 'config.json')
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      extensionId: 'bfccnpkjkbhceghimfjgnkigilidldep',
      browserCommand,
      browserArgs: [browserArg],
    })

    const secondResult = await runCli(
      ['connect'],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        homeDir,
        openUrl: async () => {},
      },
    )

    expect(secondResult.exitCode).toBe(0)
    expect(secondResult.browserCalls).toEqual([
      {
        command: browserCommand,
        args: [browserArg],
      },
    ])
  })

  test('allows browser args that look like CLI flags', async () => {
    const browserArg = '--profile-directory=Profile 1'

    const result = await runCli(
      ['connect', '--browser-command', 'chrome', '--browser-arg', browserArg],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        openUrl: async () => {},
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.browserCalls).toEqual([
      {
        command: 'chrome',
        args: [browserArg],
      },
    ])
  })

  test('reports an actionable error when the browser profile is already in use', async () => {
    const result = await runCli(
      ['connect', '--browser-command', 'chrome'],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        openUrl: async () => {
          throw new BrowserProfileLockError()
        },
      },
    )

    expect(result.exitCode).toBe(1)
    // 不应回退到 relay 页：浏览器根本没起来，回退没有意义
    expect(result.openCalls).toHaveLength(1)
    expect(result.openCalls[0]).toContain('connect.html')
    expect(result.stderr).toContain('--user-data-dir')
    expect(result.stderr).toContain('already in use')
  })

  test('opens the plain relay connect page when the server reports no token', async () => {
    const result = await runCli(
      ['connect'],
      { ok: true, relayPort: 48011, ipcPort: 48012 },
      { openUrl: async () => {} },
    )

    expect(result.exitCode).toBe(0)
    // 没有 token 可带，页面会渲染脱敏版本
    expect(result.openCalls).toEqual(['http://127.0.0.1:48011/connect'])
  })

  test('falls back to the relay connect page with the token when the extension page cannot open', async () => {
    let attempts = 0
    const result = await runCli(
      ['connect'],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        openUrl: async () => {
          attempts += 1
          if (attempts === 1) {
            throw new Error('browser launch failed')
          }
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.openCalls).toHaveLength(2)
    expect(result.openCalls[0]).toContain('connect.html')
    // 回退页必须带 token：否则拿到的是脱敏版本，用户反而看不到凭证
    expect(result.openCalls[1]).toBe('http://127.0.0.1:48011/connect?token=live-token')
  })

  test('connect repairs an invalid persisted extension id', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-invalid-config-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      path.join(stateDir, 'config.json'),
      JSON.stringify({
        extensionId: 'invalid-extension-id',
      }),
    )

    const result = await runCli(
      ['connect'],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        homeDir,
        openUrl: async () => {},
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=live-token&relayPort=48011&ipcPort=48012',
    ])
    expect(JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'))).toEqual({
      extensionId: 'bfccnpkjkbhceghimfjgnkigilidldep',
    })
  })

  test('connect starts the detached background process when the local server is unavailable', async () => {
    let callCount = 0

    const result = await runCli(
      ['connect'],
      { ok: true, result: { ok: true } },
      {
        fetchImpl: async () => {
          callCount += 1

          if (callCount < 3) {
            throw new Error('status unavailable')
          }

          return {
            ok: true,
            async json() {
              return { token: 'live-token', relayPort: 57978, ipcPort: 57979 }
            },
          }
        },
        openUrl: async () => {},
        spawnDetachedProcess: () => ({
          pid: 12345,
          unref() {},
        }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(3)
    expect(result.spawnCalls).toHaveLength(1)
    expect(result.spawnCalls[0].command).toBe('bun')
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=live-token&relayPort=57978&ipcPort=57979',
    ])
    expect(result.stdout).toContain('autobrowser server started in background')
  })

  test('connect falls back to persisted token and ports when a remote server is unavailable', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-home-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        token: 'saved-token',
        relayPort: 49001,
        ipcPort: 49002,
      }),
    )
    await writeFile(path.join(stateDir, 'token'), JSON.stringify({ token: 'saved-token' }))

    const result = await runCli(
      ['connect', '--server', 'http://remote.example:57979'],
      { ok: true, result: { ok: true } },
      {
        homeDir,
        fetchImpl: async () => {
          throw new Error('status unavailable')
        },
        openUrl: async () => {},
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(result.spawnCalls).toHaveLength(0)
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=saved-token&relayPort=49001&ipcPort=49002',
    ])
  })

  test('connect returns a non-zero code when the local server cannot be started', async () => {
    const result = await runCli(
      ['connect'],
      { ok: true, result: { ok: true } },
      {
        fetchImpl: async () => {
          throw new Error('status unavailable')
        },
        openUrl: async () => {},
        spawnDetachedProcess: () => ({
          pid: 12345,
          unref() {},
          async waitForExit() {
            return { code: 1, signal: null }
          },
        }),
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.spawnCalls).toHaveLength(1)
    expect(result.openCalls).toEqual([])
    expect(result.stderr).toContain('Background server exited before becoming ready')
  })

  test('connect keeps working when config persistence is unavailable', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-readonly-home-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await chmod(stateDir, 0o500)

    const result = await runCli(
      [
        'connect',
        '--browser-command',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
      { ok: true, token: 'live-token', relayPort: 48011, ipcPort: 48012 },
      {
        homeDir,
        openUrl: async () => {},
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.browserCalls).toEqual([
      {
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [],
      },
    ])
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=live-token&relayPort=48011&ipcPort=48012',
    ])
  })
})
