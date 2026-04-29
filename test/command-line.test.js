import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildSystemOpenCommand, main, parseWindowsNetstatListeningPid } from '../src/cli.js'

const originalFetch = globalThis.fetch
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
const originalStderrWrite = process.stderr.write.bind(process.stderr)
const originalAutobrowserHome = process.env.AUTOBROWSER_HOME

function interceptStream(chunks) {
  return (chunk, encoding, callback) => {
    chunks.push(String(chunk))
    if (typeof encoding === 'function') {
      encoding()
    }
    if (typeof callback === 'function') {
      callback()
    }
    return true
  }
}

async function runCli(argv, payload = { ok: true, result: { ok: true } }, options = {}) {
  const fetchCalls = []
  const spawnCalls = []
  const stdout = []
  const stderr = []
  const openCalls = []
  const browserCalls = []
  const previousAutobrowserHome = process.env.AUTOBROWSER_HOME
  const homeDir =
    options.homeDir || (await mkdtemp(path.join(os.tmpdir(), 'autobrowser-home-run-')))

  process.env.AUTOBROWSER_HOME = homeDir

  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : null,
    })

    if (options.fetchImpl) {
      return options.fetchImpl(url, init)
    }

    return {
      ok: true,
      async json() {
        return payload
      },
      async text() {
        return `${JSON.stringify(payload)}\n`
      },
    }
  }

  process.stdout.write = interceptStream(stdout)
  process.stderr.write = interceptStream(stderr)

  try {
    const exitCode = await main(argv, {
      openUrl: options.openUrl
        ? async (url, browserConfig) => {
            openCalls.push(url)
            browserCalls.push(browserConfig)
            await options.openUrl(url, browserConfig)
          }
        : undefined,
      spawnDetachedProcess: options.spawnDetachedProcess
        ? (command, args) => {
            const child = options.spawnDetachedProcess(command, args)
            spawnCalls.push({ command, args })
            return child
          }
        : undefined,
      findProcessIdByPort: options.findProcessIdByPort,
      killProcess: options.killProcess,
    })

    return {
      exitCode,
      fetchCalls,
      spawnCalls,
      openCalls,
      browserCalls,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    }
  } finally {
    globalThis.fetch = originalFetch
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite

    if (previousAutobrowserHome === undefined) {
      delete process.env.AUTOBROWSER_HOME
    } else {
      process.env.AUTOBROWSER_HOME = previousAutobrowserHome
    }
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  process.stdout.write = originalStdoutWrite
  process.stderr.write = originalStderrWrite
  if (originalAutobrowserHome === undefined) {
    delete process.env.AUTOBROWSER_HOME
  } else {
    process.env.AUTOBROWSER_HOME = originalAutobrowserHome
  }
})

describe('cli helpers', () => {
  test('uses rundll32 on windows for system url opens', () => {
    expect(
      buildSystemOpenCommand(
        'win32',
        'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=a&relayPort=1&ipcPort=2',
      ),
    ).toEqual({
      command: 'rundll32',
      args: [
        'url.dll,FileProtocolHandler',
        'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=a&relayPort=1&ipcPort=2',
      ],
    })
  })

  test('parses the exact listening pid from netstat output', () => {
    const stdout = [
      '  TCP    0.0.0.0:57978    0.0.0.0:0     LISTENING       12345',
      '  TCP    0.0.0.0:579780   0.0.0.0:0     LISTENING       54321',
    ].join('\n')

    expect(parseWindowsNetstatListeningPid(stdout, 57978)).toBe(12345)
  })
})

describe('cli command routing', () => {
  test('allows title reads without a selector', async () => {
    const result = await runCli(['get', 'title'], {
      ok: true,
      result: 'Example title',
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'get',
      args: { attr: 'title' },
    })
    expect(result.stdout).toContain('Example title')
  })

  test('returns the local cdp websocket url without requiring a selector', async () => {
    const result = await runCli(['get', 'cdp-url'], {
      token: 'test-token',
      relayPort: 48001,
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(String(result.fetchCalls[0].url)).toBe('http://127.0.0.1:57979/status')
    expect(result.stdout).toContain('ws://127.0.0.1:48001/ws?token=test-token')
  })

  test('returns a non-zero code when status lookup fails', async () => {
    const result = await runCli(
      ['status'],
      { ok: true, result: { ok: true } },
      {
        fetchImpl: async () => {
          throw new Error('status unavailable')
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.stderr).toContain('status unavailable')
  })

  test('routes tab selection by stable handle to the extension', async () => {
    const result = await runCli(['tab', 'select', 't2'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'tab.select',
      args: {
        handle: 't2',
      },
    })
  })

  test('routes shorthand tab selection by handle to the extension', async () => {
    const result = await runCli(['tab', 't3'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'tab.select',
      args: {
        handle: 't3',
      },
    })
  })

  test('routes tab close by stable handle to the extension', async () => {
    const result = await runCli(['tab', 'close', 't4'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'tab.close',
      args: {
        handle: 't4',
      },
    })
  })

  test('open falls back to a new tab when goto hits a restricted page', async () => {
    const result = await runCli(
      ['open', 'https://www.baidu.com'],
      { ok: true, result: { ok: true } },
      {
        fetchImpl: async (url, init = {}) => {
          const body = init.body ? JSON.parse(init.body) : null

          if (body?.command === 'goto') {
            return {
              ok: true,
              async json() {
                return {
                  ok: false,
                  error: {
                    message: 'Cannot access chrome:// and edge:// URLs',
                  },
                }
              },
              async text() {
                return `${JSON.stringify({
                  ok: false,
                  error: {
                    message: 'Cannot access chrome:// and edge:// URLs',
                  },
                })}\n`
              },
            }
          }

          if (body?.command === 'tab.new') {
            expect(body.args).toEqual({ url: 'https://www.baidu.com' })
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  result: {
                    tab: {
                      id: 123,
                      url: 'https://www.baidu.com',
                      active: true,
                    },
                  },
                }
              },
              async text() {
                return `${JSON.stringify({
                  ok: true,
                  result: {
                    tab: {
                      id: 123,
                      url: 'https://www.baidu.com',
                      active: true,
                    },
                  },
                })}\n`
              },
            }
          }

          throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(2)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'goto',
      args: {
        url: 'https://www.baidu.com',
      },
    })
    expect(result.fetchCalls[1].body).toEqual({
      command: 'tab.new',
      args: {
        url: 'https://www.baidu.com',
      },
    })
    expect(result.stdout).toContain('https://www.baidu.com')
  })

  test('auto-connect opens the extension page before dispatching a command when disconnected', async () => {
    const result = await runCli(
      ['--auto-connect', 'open', 'https://example.com'],
      { ok: true, result: { ok: true } },
      {
        openUrl: async () => {},
        fetchImpl: async (url, init = {}) => {
          const body = init.body ? JSON.parse(init.body) : null

          if (String(url).endsWith('/status')) {
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  token: 'live-token',
                  relayPort: 48011,
                  ipcPort: 48012,
                  extensionConnected: false,
                }
              },
              async text() {
                return `${JSON.stringify({
                  ok: true,
                  token: 'live-token',
                  relayPort: 48011,
                  ipcPort: 48012,
                  extensionConnected: false,
                })}\n`
              },
            }
          }

          if (body?.command === 'goto') {
            expect(body.args).toEqual({
              url: 'https://example.com',
            })
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  result: {
                    navigated: true,
                  },
                }
              },
              async text() {
                return `${JSON.stringify({
                  ok: true,
                  result: {
                    navigated: true,
                  },
                })}\n`
              },
            }
          }

          throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(2)
    expect(String(result.fetchCalls[0].url)).toBe('http://127.0.0.1:57979/status')
    expect(result.fetchCalls[1].body).toEqual({
      command: 'goto',
      args: {
        url: 'https://example.com',
      },
    })
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=live-token&relayPort=48011&ipcPort=48012',
    ])
  })

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
    expect(result.fetchCalls).toHaveLength(1)
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

  test('server starts the detached background process and waits for status', async () => {
    let callCount = 0
    const result = await runCli(
      ['server'],
      {
        ok: true,
        result: { token: 'live-token', relayPort: 57978, ipcPort: 57979 },
      },
      {
        fetchImpl: async () => {
          callCount += 1
          if (callCount === 1) {
            throw new Error('server not ready yet')
          }

          return {
            ok: true,
            async json() {
              return { token: 'live-token', relayPort: 57978, ipcPort: 57979 }
            },
          }
        },
        spawnDetachedProcess: (command, args) => ({
          pid: 12345,
          unref() {},
        }),
      },
    )

    expect(result.exitCode).toBeUndefined()
    expect(result.spawnCalls).toHaveLength(1)
    expect(result.spawnCalls[0].command).toBe('bun')
    expect(result.spawnCalls[0].args[1]).toBe('server')
    expect(result.spawnCalls[0].args).toContain('--serve')
    expect(result.spawnCalls[0].args).toContain('--relay-port')
    expect(result.spawnCalls[0].args).toContain('--ipc-port')
    expect(result.stdout).toContain('background')
  })

  test('server ignores unrelated ipc responses before deciding it is already running', async () => {
    let callCount = 0
    const result = await runCli(
      ['server'],
      {
        ok: true,
        result: { token: 'live-token', relayPort: 57978, ipcPort: 57979 },
      },
      {
        fetchImpl: async () => {
          callCount += 1

          if (callCount === 1) {
            return {
              ok: true,
              async json() {
                return { random: true }
              },
            }
          }

          return {
            ok: true,
            async json() {
              return { token: 'live-token', relayPort: 57978, ipcPort: 57979 }
            },
          }
        },
        spawnDetachedProcess: () => ({
          pid: 12345,
          unref() {},
        }),
      },
    )

    expect(result.exitCode).toBeUndefined()
    expect(result.spawnCalls).toHaveLength(1)
    expect(result.stdout).toContain('background')
  })

  test('server stop asks the background server to shut down', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-stop-test-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        token: 'stop-token',
        relayPort: 49011,
        ipcPort: 49012,
      }),
    )
    await writeFile(path.join(stateDir, 'token'), JSON.stringify({ token: 'stop-token' }))

    const result = await runCli(
      ['server', 'stop'],
      { ok: true, result: { stopping: true } },
      {
        homeDir,
        fetchImpl: async (url, init = {}) => {
          expect(String(url)).toBe('http://127.0.0.1:49012/shutdown')
          expect(init.method).toBe('POST')
          expect(JSON.parse(init.body)).toEqual({ token: 'stop-token' })
          return {
            ok: true,
            async text() {
              return JSON.stringify({ ok: true, result: { stopping: true } })
            },
            async json() {
              return { ok: true, result: { stopping: true } }
            },
          }
        },
      },
    )

    expect(result.exitCode).toBeUndefined()
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.stdout).toContain('stopped')
  })

  test('server stop tolerates a non-json shutdown response body', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-stop-text-test-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        token: 'stop-token',
        relayPort: 49011,
        ipcPort: 49012,
      }),
    )
    await writeFile(path.join(stateDir, 'token'), JSON.stringify({ token: 'stop-token' }))

    const result = await runCli(
      ['server', 'stop'],
      { ok: true, result: { stopping: true } },
      {
        homeDir,
        fetchImpl: async (url, init = {}) => {
          expect(String(url)).toBe('http://127.0.0.1:49012/shutdown')
          expect(init.method).toBe('POST')
          expect(JSON.parse(init.body)).toEqual({ token: 'stop-token' })
          return {
            ok: true,
            async text() {
              return 'shutting down'
            },
          }
        },
      },
    )

    expect(result.exitCode).toBeUndefined()
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.stdout).toContain('stopped')
  })

  test('server stop falls back to terminating the listening process when shutdown is missing', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-stop-fallback-test-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        token: 'stop-token',
        relayPort: 49011,
        ipcPort: 49012,
      }),
    )
    await writeFile(path.join(stateDir, 'token'), JSON.stringify({ token: 'stop-token' }))

    const killCalls = []

    const result = await runCli(
      ['server', 'stop'],
      { ok: true, result: { stopping: true } },
      {
        homeDir,
        findProcessIdByPort: async (port) => {
          expect(port).toBe(49012)
          return 12345
        },
        killProcess: (pid, signal) => {
          killCalls.push({ pid, signal })
          return true
        },
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/shutdown')) {
            expect(init.method).toBe('POST')
            expect(JSON.parse(init.body)).toEqual({ token: 'stop-token' })
          } else if (String(url).endsWith('/status')) {
            expect(init.method).toBeUndefined()
          } else {
            throw new Error(`unexpected URL: ${String(url)}`)
          }

          return {
            ok: false,
            status: 404,
            statusText: 'Not Found',
            async text() {
              return 'not found'
            },
          }
        },
      },
    )

    expect(result.exitCode).toBeUndefined()
    expect(result.fetchCalls).toHaveLength(2)
    expect(killCalls).toEqual([{ pid: 12345, signal: 'SIGTERM' }])
    expect(result.stdout).toContain('stopped')
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

  test('routes computed styles requests to the extension', async () => {
    const result = await runCli(['get', 'styles', '#panel'], {
      ok: true,
      result: {
        found: true,
        value: {
          display: 'block',
          width: '320px',
        },
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'get',
      args: {
        selector: '#panel',
        attr: 'styles',
      },
    })
    expect(result.stdout).toContain('display')
    expect(result.stdout).toContain('width')
  })

  test('prints boolean state checks as primitive output', async () => {
    const result = await runCli(['is', 'visible', '#submit'], {
      ok: true,
      result: {
        found: true,
        state: 'visible',
        value: true,
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'is',
      args: {
        selector: '#submit',
        state: 'visible',
      },
    })
    expect(result.stdout.trim()).toBe('true')
  })

  test('routes selector waits to the extension with visible state by default', async () => {
    const result = await runCli(['wait', '#spinner'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'selector',
        selector: '#spinner',
      },
    })
  })

  test('routes hidden selector waits to the extension', async () => {
    const result = await runCli(['wait', '#spinner', '--state', 'hidden'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'hidden',
        type: 'selector',
        selector: '#spinner',
      },
    })
  })

  test('routes text waits to the extension', async () => {
    const result = await runCli(['wait', '--text', 'Welcome'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'text',
        text: 'Welcome',
      },
    })
  })

  test('routes glob url waits to the extension', async () => {
    const result = await runCli(['wait', '--url', '**/dash'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'url',
        url: '**/dash',
      },
    })
  })

  test('routes load and fn waits to the extension', async () => {
    const loadResult = await runCli(['wait', '--load', 'networkidle'])

    expect(loadResult.exitCode).toBe(0)
    expect(loadResult.fetchCalls).toHaveLength(1)
    expect(loadResult.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'networkidle',
      },
    })

    const fnResult = await runCli(['wait', '--fn', 'window.ready === true'])

    expect(fnResult.exitCode).toBe(0)
    expect(fnResult.fetchCalls).toHaveLength(1)
    expect(fnResult.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'fn',
        fn: 'window.ready === true',
      },
    })
  })

  test('still requires a selector for selector-based get commands', async () => {
    const result = await runCli(['get', 'text'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('missing selector')
  })

  test('passes full prompt text to dialog commands', async () => {
    const result = await runCli(['dialog', 'accept', 'hello', 'world'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dialog',
      args: {
        accept: true,
        promptText: 'hello world',
      },
    })
  })

  test('routes dialog dismiss commands to the extension', async () => {
    const result = await runCli(['dialog', 'dismiss'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dialog',
      args: {
        accept: false,
        promptText: '',
      },
    })
  })

  test('routes dialog status commands to the extension', async () => {
    const result = await runCli(['dialog', 'status'], {
      ok: true,
      result: {
        open: false,
        type: null,
        message: null,
        defaultPrompt: null,
        url: null,
        openedAt: null,
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dialog',
      args: {
        action: 'status',
      },
    })
    expect(result.stdout).toContain('open')
    expect(result.stdout).toContain('false')
  })

  test('routes screenshot options to the extension and writes the output file', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-test-'))
    const outputPath = path.join(outputDir, 'shot.jpeg')
    const screenshotBytes = Buffer.from('screenshot-bytes')

    const result = await runCli(
      [
        'screenshot',
        outputPath,
        '--full',
        '--annotate',
        '--screenshot-format',
        'jpeg',
        '--screenshot-quality',
        '80',
      ],
      {
        ok: true,
        result: {
          data: screenshotBytes.toString('base64'),
          mimeType: 'image/jpeg',
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: true,
        annotate: true,
        format: 'jpeg',
        quality: 80,
      },
    })
    expect(result.stdout.trim()).toBe(outputPath)
    expect((await readFile(outputPath)).toString()).toBe('screenshot-bytes')
  })

  test('adds global tab and frame overrides to screenshot commands', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-frame-test-'))
    const outputPath = path.join(outputDir, 'shot.png')
    const screenshotBytes = Buffer.from('frame-screenshot-bytes')

    const result = await runCli(['screenshot', '--tab', 't2', '--frame', '@f4', outputPath], {
      ok: true,
      result: {
        data: screenshotBytes.toString('base64'),
        mimeType: 'image/png',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: false,
        annotate: false,
        format: 'png',
        tabId: 't2',
        frame: '@f4',
      },
    })
    expect((await readFile(outputPath)).toString()).toBe('frame-screenshot-bytes')
  })

  test('saves screenshots into the configured screenshot dir when no path is provided', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-dir-test-'))
    const screenshotBytes = Buffer.from('temp-screenshot')

    const result = await runCli(
      ['screenshot', '--screenshot-dir', outputDir, '--screenshot-format', 'jpeg'],
      {
        ok: true,
        result: {
          data: screenshotBytes.toString('base64'),
          mimeType: 'image/jpeg',
        },
      },
    )

    const savedPath = result.stdout.trim()
    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: false,
        annotate: false,
        format: 'jpeg',
      },
    })
    expect(savedPath.startsWith(outputDir)).toBe(true)
    expect(savedPath.endsWith('.jpeg')).toBe(true)
    expect((await readFile(savedPath)).toString()).toBe('temp-screenshot')
  })

  test('saves screenshots to a temporary directory when no path is provided', async () => {
    const screenshotBytes = Buffer.from('auto-temp-screenshot')

    const result = await runCli(['screenshot'], {
      ok: true,
      result: {
        data: screenshotBytes.toString('base64'),
        mimeType: 'image/png',
      },
    })

    const savedPath = result.stdout.trim()
    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: false,
        annotate: false,
        format: 'png',
      },
    })
    expect(path.dirname(savedPath).startsWith(os.tmpdir())).toBe(true)
    expect(savedPath.includes('autobrowser-screenshot-')).toBe(true)
    expect((await readFile(savedPath)).toString()).toBe('auto-temp-screenshot')
  })

  test('routes double clicks to the extension', async () => {
    const result = await runCli(['dblclick', '#submit'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'dblclick',
      args: {
        selector: '#submit',
      },
    })
  })

  test('returns a non-zero exit code when the extension reports a failed command', async () => {
    const result = await runCli(['click', '#submit'], {
      ok: false,
      error: {
        message: 'click failed',
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'click',
      args: {
        selector: '#submit',
      },
    })
    expect(result.stderr).toContain('click failed')
  })

  test('routes type commands to the extension', async () => {
    const result = await runCli(['type', '#editor', 'hello world'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'type',
      args: {
        selector: '#editor',
        value: 'hello world',
      },
    })
  })

  test('routes semantic role finds to the extension', async () => {
    const result = await runCli(['find', 'role', 'button', 'click', '--name', 'Submit'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'role',
        role: 'button',
        name: 'Submit',
        exact: false,
        action: 'click',
      },
    })
  })

  test('routes semantic text finds with exact matching to the extension', async () => {
    const result = await runCli(['find', 'text', 'Sign in', 'text', '--exact'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'text',
        query: 'Sign in',
        exact: true,
        action: 'text',
      },
    })
  })

  test('routes semantic label fills to the extension', async () => {
    const result = await runCli(['find', 'label', 'Email', 'fill', 'test@example.com'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'label',
        query: 'Email',
        exact: false,
        action: 'fill',
        value: 'test@example.com',
      },
    })
  })

  test('adds global tab and frame overrides to selector commands', async () => {
    const result = await runCli(['click', '--tab', 't2', '--frame', '@f1', '@e3'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'click',
      args: {
        selector: '@e3',
        tabId: 't2',
        frame: '@f1',
      },
    })
  })

  test('adds global tab and frame overrides to semantic find commands', async () => {
    const result = await runCli([
      'find',
      'role',
      'button',
      'click',
      '--name',
      'Submit',
      '--tab',
      't3',
      '--frame',
      '@f2',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'role',
        role: 'button',
        name: 'Submit',
        exact: false,
        action: 'click',
        tabId: 't3',
        frame: '@f2',
      },
    })
  })

  test('adds global tab overrides without leaking frame overrides to frame selection', async () => {
    const result = await runCli(['frame', '--tab', 't4', '@f3'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'frame',
      args: {
        selector: '@f3',
        tabId: 't4',
      },
    })
  })

  test('adds global tab and frame overrides to upload commands', async () => {
    const result = await runCli([
      'upload',
      '--tab',
      't5',
      '--frame',
      '@f6',
      '#avatar',
      'avatar.png',
      'avatar@2x.png',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'upload',
      args: {
        selector: '#avatar',
        files: ['avatar.png', 'avatar@2x.png'],
        tabId: 't5',
        frame: '@f6',
      },
    })
  })

  test('adds global tab and frame overrides to storage commands', async () => {
    const result = await runCli([
      'storage',
      'set',
      '--tab',
      't6',
      '--frame',
      '@f7',
      'draft',
      'ready',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'storage',
      args: {
        action: 'set',
        key: 'draft',
        value: 'ready',
        tabId: 't6',
        frame: '@f7',
      },
    })
  })

  test('routes keyboard typing commands to the extension', async () => {
    const result = await runCli(['keyboard', 'type', 'abc'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'keyboard',
      args: {
        action: 'type',
        text: 'abc',
      },
    })
  })

  test('routes scroll into view commands to the extension', async () => {
    const result = await runCli(['scrollintoview', '#footer'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'scrollintoview',
      args: {
        selector: '#footer',
      },
    })
  })

  test('routes stable frame refs to the extension', async () => {
    const result = await runCli(['frame', '@f1'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'frame',
      args: {
        selector: '@f1',
      },
    })
  })

  test('routes close all commands to the extension', async () => {
    const result = await runCli(['close', 'all'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'close',
      args: {
        all: true,
      },
    })
  })

  test('routes requests to the configured ipc port', async () => {
    const result = await runCli(['--ipc-port', '5001', 'status'], {
      ok: true,
      ready: true,
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].url).toBe('http://127.0.0.1:5001/status')
  })

  test('routes network abort commands to the extension', async () => {
    const result = await runCli(['network', 'route', 'https://api.example.com', '--abort'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'route',
        url: 'https://api.example.com',
        abort: true,
      },
    })
  })

  test('routes network request filters to the extension', async () => {
    const result = await runCli([
      'network',
      'requests',
      '--filter',
      'api',
      '--type',
      'xhr,fetch',
      '--method',
      'POST',
      '--status',
      '2xx',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'requests',
        filter: 'api',
        type: 'xhr,fetch',
        method: 'POST',
        status: '2xx',
      },
    })
  })

  test('writes HAR output when stopping a recording', async () => {
    const payload = {
      ok: true,
      result: {
        har: {
          log: {
            version: '1.2',
            creator: { name: 'autobrowser', version: '0.1.0' },
            entries: [],
          },
        },
      },
    }
    const result = await runCli(['network', 'har', 'stop'], payload)

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)

    const outputPath = result.stdout.trim()
    expect(outputPath.length).toBeGreaterThan(0)

    const harContent = await readFile(outputPath, 'utf8')
    expect(harContent).toContain('"version": "1.2"')
    expect(harContent).toContain('"creator"')
  })

  test('reconstructs HAR output when stop only returns metadata', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-har-rebuild-test-'))
    const outputPath = path.join(outputDir, 'network.har')
    const startedAt = '2026-04-20T15:00:00.000Z'
    const stoppedAt = '2026-04-20T15:00:05.000Z'
    const requestSummary = {
      id: '1275677941:abc',
      requestId: 'abc',
      tabId: 1275677941,
      url: 'https://example.com/',
      method: 'GET',
      resourceType: 'Document',
      status: 200,
      statusText: 'OK',
      startedAt,
      durationMs: 12,
    }
    const requestDetail = {
      request: requestSummary,
      summary: {
        id: requestSummary.id,
        requestId: requestSummary.requestId,
        tabId: requestSummary.tabId,
        url: requestSummary.url,
        method: requestSummary.method,
        resourceType: requestSummary.resourceType,
        status: requestSummary.status,
        statusText: requestSummary.statusText,
        startedAt: requestSummary.startedAt,
        durationMs: requestSummary.durationMs,
      },
      harEntry: {
        startedDateTime: startedAt,
        time: 12,
        request: {
          method: 'GET',
          url: 'https://example.com/',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: {
            size: 19,
            mimeType: 'text/html',
            text: 'hello from response',
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: 19,
        },
        cache: {},
        timings: {
          send: 0,
          wait: 12,
          receive: 0,
        },
        pageref: 'tab-1275677941',
      },
    }

    const result = await runCli(
      ['network', 'har', 'stop', outputPath],
      { ok: true, result: { recording: false, startedAt, stoppedAt, requestCount: 1 } },
      {
        fetchImpl: async (url, init = {}) => {
          const body = init.body ? JSON.parse(init.body) : null

          if (body?.command !== 'network') {
            throw new Error(`unexpected command: ${JSON.stringify(body)}`)
          }

          if (body.args.action === 'har' && body.args.subaction === 'stop') {
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  result: { recording: false, startedAt, stoppedAt, requestCount: 1 },
                }
              },
            }
          }

          if (body.args.action === 'requests') {
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  result: {
                    total: 1,
                    requests: [requestSummary],
                  },
                }
              },
            }
          }

          if (body.args.action === 'request') {
            expect(body.args.requestId).toBe('abc')
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  result: requestDetail,
                }
              },
            }
          }

          throw new Error(`unexpected URL or body: ${String(url)} ${JSON.stringify(body)}`)
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(3)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'har',
        subaction: 'stop',
      },
    })
    expect(result.fetchCalls[1].body).toEqual({
      command: 'network',
      args: {
        action: 'requests',
      },
    })
    expect(result.fetchCalls[2].body).toEqual({
      command: 'network',
      args: {
        action: 'request',
        requestId: 'abc',
      },
    })

    const harContent = JSON.parse(await readFile(outputPath, 'utf8'))
    expect(harContent.log.entries).toHaveLength(1)
    expect(harContent.log.entries[0].response.content.text).toBe('hello from response')
  })

  test('saves state under the requested name', async () => {
    const result = await runCli(['state', 'save', 'checkout'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'state',
      args: {
        action: 'save',
        name: 'checkout',
      },
    })
  })

  test('loads state by saved name when input is not json', async () => {
    const result = await runCli(['state', 'load', 'checkout'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'state',
      args: {
        action: 'load',
        name: 'checkout',
      },
    })
  })

  test('loads state from inline json when provided', async () => {
    const result = await runCli(['state', 'load', '{"name":"checkout","storage":{"step":"2"}}'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'state',
      args: {
        action: 'load',
        data: {
          name: 'checkout',
          storage: {
            step: '2',
          },
        },
      },
    })
  })
})
