import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  BrowserProfileLockError,
  buildSystemOpenCommand,
  detectBrowserProfileLock,
  main,
  parseWindowsNetstatListeningPid,
} from '../src/cli.js'
import {
  parseConsoleArgs,
  parseNetworkHarStartArgs,
  parseNetworkRequestsArgs,
  parseNetworkRouteArgs,
  parseScreenshotArgs,
  parseSearchArgs,
  parseWaitArgs,
} from '../src/cli/parse.js'

const originalFetch = globalThis.fetch
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
const originalStderrWrite = process.stderr.write.bind(process.stderr)
let cliRunQueue = Promise.resolve()

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
  const run = cliRunQueue.then(async () => {
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
  })

  // 这些 CLI 测试会临时替换全局 fetch/stdout/stderr；串行化能避免全量并发执行时互相踩状态。
  cliRunQueue = run.catch(() => {})
  return await run
}

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

  test('detects browser profile lock signatures in stderr', () => {
    expect(detectBrowserProfileLock('Opening in existing browser session.\n')).toBe(true)
    expect(detectBrowserProfileLock('ERROR: profile is already in use')).toBe(true)
    expect(detectBrowserProfileLock('user data directory is already in use')).toBe(true)
    expect(detectBrowserProfileLock('')).toBe(false)
    expect(detectBrowserProfileLock('DevTools listening on ws://127.0.0.1:9222')).toBe(false)
  })

  test('parses the exact listening pid from netstat output', () => {
    const stdout = [
      '  TCP    0.0.0.0:57978    0.0.0.0:0     LISTENING       12345',
      '  TCP    0.0.0.0:579780   0.0.0.0:0     LISTENING       54321',
    ].join('\n')

    expect(parseWindowsNetstatListeningPid(stdout, 57978)).toBe(12345)
  })

  test('parses wait time aliases as milliseconds', () => {
    expect(parseWaitArgs(['time', '3'])).toMatchObject({
      type: 'time',
      ms: 3,
      timeout: 30000,
    })

    expect(parseWaitArgs(['3'])).toMatchObject({
      type: 'time',
      ms: 3,
      timeout: 30000,
    })
  })

  test('rejects invalid wait durations', () => {
    expect(() => parseWaitArgs(['--timeout', 'soon'])).toThrow('invalid timeout')
    expect(() => parseWaitArgs(['--ms', ''])).toThrow('invalid ms')
    expect(() => parseWaitArgs(['time'])).toThrow('missing wait time value')
  })

  test('parses --gone as a text-gone wait modifier', () => {
    expect(parseWaitArgs(['--text', 'Loading', '--gone'])).toMatchObject({
      type: 'text',
      text: 'Loading',
      gone: true,
    })
  })

  test('rejects --gone without a text wait', () => {
    expect(() => parseWaitArgs(['#spinner', '--gone'])).toThrow('--gone requires --text')
  })

  test('parses screenshot element targets from flags and positionals', () => {
    expect(parseScreenshotArgs(['--element', '#card'])).toMatchObject({
      element: '#card',
      path: null,
    })
    expect(parseScreenshotArgs(['@e3#p1'])).toMatchObject({
      element: '@e3#p1',
      path: null,
    })
    expect(parseScreenshotArgs(['out.png', '#card'])).toMatchObject({
      path: 'out.png',
      element: '#card',
    })
  })

  test('rejects screenshot element targets combined with --full', () => {
    expect(() => parseScreenshotArgs(['--element', '#card', '--full'])).toThrow(
      'cannot be combined',
    )
  })

  test('documents wait durations as milliseconds in help output', async () => {
    const result = await runCli(['help', 'wait'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stdout).toContain('time <ms>')
    expect(result.stdout).toContain('fixed duration in milliseconds')
    expect(result.stdout).toContain('--ms <ms> wait a fixed duration in milliseconds')
  })

  test('documents root server ports in help output', async () => {
    const result = await runCli(['help'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stdout).toContain('--relay-port <port>')
    expect(result.stdout).toContain('--ipc-port <port>')
    expect(result.stdout).toContain('--tab <tN|id>')
    expect(result.stdout).toContain('--frame <@fN|selector>')
    expect(result.stdout).toContain('--extension-id <id>')
    expect(result.stdout).toContain('--browser-command <command>')
    expect(result.stdout).toContain('--browser-arg <arg>')
  })

  test('documents tab, find, and get help output', async () => {
    const tabHelp = await runCli(['help', 'tab'])
    expect(tabHelp.exitCode).toBe(0)
    expect(tabHelp.stdout).toContain('autobrowser tab new [url]')
    expect(tabHelp.stdout).toContain('autobrowser tab close [tN]')

    const findHelp = await runCli(['help', 'find'])
    expect(findHelp.exitCode).toBe(0)
    expect(findHelp.stdout).toContain(
      'autobrowser find <role|text|label|placeholder|alt|title|test-id|exact-name> <query> [locate|click|fill|type|hover|focus|check|uncheck|text] [value]',
    )
    expect(findHelp.stdout).toContain('--name <name>')
    expect(findHelp.stdout).toContain('--exact')
    expect(findHelp.stdout).toContain('--position <first|last|nth=N>')
    expect(findHelp.stdout).toContain('--candidates <n>')

    const getHelp = await runCli(['help', 'get'])
    expect(getHelp.exitCode).toBe(0)
    expect(getHelp.stdout).toContain('autobrowser get <attribute> [selector]')
    expect(getHelp.stdout).toContain(
      'title, url, and cdp-url read the current page and ignore selector',
    )
    expect(getHelp.stdout).toContain('other attribute names are passed through to the page element')
  })

  test('documents search help output', async () => {
    const result = await runCli(['help', 'search'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'autobrowser search <query|/regex/flags> [--context <n>] [--limit <n>]',
    )
    expect(result.stdout).toContain('--context <n>')
    expect(result.stdout).toContain('--limit <n>')
  })

  test('documents configurable HAR limits in help output', async () => {
    const result = await runCli(['help', 'network', 'har', 'start'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--har-max-requests <n>')
    expect(result.stdout).toContain('--har-max-body-bytes <n>')
    expect(result.stdout).toContain('--har-unlimited')
  })

  test('parses HAR capture limits for network har start', () => {
    expect(parseNetworkHarStartArgs(['--har-unlimited'])).toEqual({
      maxRequests: null,
      maxBodyBytes: null,
    })

    expect(
      parseNetworkHarStartArgs(['--har-max-requests', '5000', '--har-max-body-bytes', '1048576']),
    ).toEqual({
      maxRequests: 5000,
      maxBodyBytes: 1048576,
    })
  })

  test('parses search arguments with defaults', () => {
    expect(parseSearchArgs(['Sign in'])).toEqual({ query: 'Sign in', context: 3, limit: 20 })
    expect(parseSearchArgs(['/foo/i', '--context', '5', '--limit', '2'])).toEqual({
      query: '/foo/i',
      context: 5,
      limit: 2,
    })
    expect(() => parseSearchArgs([])).toThrow('missing search query')
    expect(() => parseSearchArgs(['x', '--bogus'])).toThrow('unsupported search option: --bogus')
    expect(() => parseSearchArgs(['x', 'extra'])).toThrow('unexpected extra search argument: extra')
  })

  test('rejects unsupported network request filter flags', () => {
    // '--filtter' 是故意拼错的 flag，用于验证未知选项会被拒绝
    expect(() => parseNetworkRequestsArgs(['--filtter', 'api'])).toThrow(
      'unsupported network option: --filtter',
    )
  })

  test('rejects unknown global flags before the command name', async () => {
    // '--selecor' 是故意拼错的 flag；放在命令名前必须直接报错而不是被当成命令/位置参数
    const result = await runCli(['--selecor', '#submit', 'click'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('unsupported global option: --selecor')
    expect(result.stderr).toContain('--tab')
    expect(result.stderr).toContain('--ipc-port')
  })

  test('rejects unsupported network har start flags', () => {
    expect(() => parseNetworkHarStartArgs(['--har-max-request', '10'])).toThrow(
      'unsupported network option: --har-max-request',
    )
    expect(() => parseNetworkHarStartArgs(['extra'])).toThrow(
      'unexpected extra network argument: extra',
    )
  })

  test('rejects unsupported network har start flags before dispatching commands', async () => {
    const result = await runCli(['network', 'har', 'start', '--har-max-request', '10'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('unsupported network option: --har-max-request')
  })

  test('rejects unsupported network route arguments', () => {
    expect(() => parseNetworkRouteArgs(['**/api/*', '--bogus'])).toThrow(
      'unsupported network option: --bogus',
    )
    expect(() => parseNetworkRouteArgs(['**/api/*', '**/other/*'])).toThrow(
      'unexpected extra network argument: **/other/*',
    )
  })

  test('rejects unsupported wait --load values', () => {
    expect(parseWaitArgs(['--load'])).toMatchObject({ type: 'networkidle' })
    expect(parseWaitArgs(['--load', 'load'])).toMatchObject({ type: 'load' })
    expect(parseWaitArgs(['--load', 'networkidle'])).toMatchObject({ type: 'networkidle' })
    expect(() => parseWaitArgs(['--load', 'interactive'])).toThrow(
      'unsupported --load value: interactive',
    )
  })

  test('rejects missing global flag values before dispatching commands', async () => {
    const result = await runCli(['click', '--tab'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('missing value for --tab')
  })

  test('rejects invalid global port values before dispatching commands', async () => {
    for (const portValue of ['not-a-port', '0', '65536']) {
      const result = await runCli(['--ipc-port', portValue, 'status'])

      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(result.stderr).toContain('invalid --ipc-port')
    }
  })

  test('rejects invalid numeric command values before dispatching commands', async () => {
    const cases = [
      { argv: ['wait', '--ms', 'soon'], message: 'invalid ms' },
      {
        argv: ['screenshot', '--screenshot-quality', '101'],
        message: 'invalid screenshot quality',
      },
      { argv: ['set', 'viewport', 'wide'], message: 'invalid viewport width' },
      { argv: ['set', 'geo', '91', '0'], message: 'invalid latitude' },
      { argv: ['scroll', '#main', 'left'], message: 'invalid scroll deltaX' },
    ]

    for (const testCase of cases) {
      const result = await runCli(testCase.argv)

      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(result.stderr).toContain(testCase.message)
    }
  })

  test('rejects unsupported network request flags before dispatching commands', async () => {
    const result = await runCli(['network', 'requests', '--filtter', 'api'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('unsupported network option: --filtter')
  })

  test('routes HAR start limits to the extension', async () => {
    const result = await runCli(['network', 'har', 'start', '--har-unlimited'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'har',
        subaction: 'start',
        maxRequests: null,
        maxBodyBytes: null,
      },
    })
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
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: 'Example title',
    })
  })

  test('returns the local cdp websocket url without requiring a selector', async () => {
    const result = await runCli(['get', 'cdp-url'], {
      token: 'test-token',
      relayPort: 48001,
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(String(result.fetchCalls[0].url)).toBe('http://127.0.0.1:57979/status')
    expect(JSON.parse(result.stdout)).toBe('ws://127.0.0.1:48001/ws?token=test-token')
  })

  test('returns raw text when --raw is set', async () => {
    const result = await runCli(['--raw', 'get', 'cdp-url'], {
      token: 'test-token',
      relayPort: 48001,
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(String(result.fetchCalls[0].url)).toBe('http://127.0.0.1:57979/status')
    expect(result.stdout.trim()).toBe('ws://127.0.0.1:48001/ws?token=test-token')
  })

  test('status starts the local server when the control server is unreachable', async () => {
    let statusCallCount = 0

    const result = await runCli(
      ['status'],
      { ok: true, result: { ok: true } },
      {
        spawnDetachedProcess: () => ({
          pid: 12345,
          unref() {},
        }),
        fetchImpl: async () => {
          statusCallCount += 1

          if (statusCallCount < 3) {
            throw new Error('status unavailable')
          }

          return {
            ok: true,
            async json() {
              return {
                token: 'live-token',
                relayPort: 57978,
                ipcPort: 57979,
                extensionConnected: false,
              }
            },
          }
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.spawnCalls).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      token: 'live-token',
      relayPort: 57978,
      ipcPort: 57979,
      extensionConnected: false,
    })
  })

  test('returns a non-zero code when status lookup fails', async () => {
    const result = await runCli(
      ['status'],
      { ok: true, result: { ok: true } },
      {
        spawnDetachedProcess: () => ({
          pid: 12345,
          unref() {},
          async waitForExit() {
            return { code: 1, signal: null }
          },
        }),
        fetchImpl: async () => {
          throw new Error('status unavailable')
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('autobrowser could not reach its local control server')
    expect(result.stderr).toContain('Recovery status:')
    expect(result.stderr).toContain('tried to start the local server automatically')
    expect(result.stderr).toContain('Run `autobrowser connect`')
    expect(result.stderr).toContain('status unavailable')
  })

  test('sends the persisted token as bearer auth for commands', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-command-token-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(path.join(stateDir, 'token'), JSON.stringify({ token: 'command-token' }))

    const result = await runCli(['click', '#submit'], undefined, { homeDir })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].init.headers.authorization).toBe('Bearer command-token')
  })

  test('refreshes command auth after an unauthorized response', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-stale-token-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(path.join(stateDir, 'token'), JSON.stringify({ token: 'stale-token' }))

    const result = await runCli(['click', '#submit'], undefined, {
      homeDir,
      fetchImpl: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null
        if (String(url).endsWith('/status')) {
          return {
            ok: true,
            async json() {
              return { token: 'fresh-token', relayPort: 57978, ipcPort: 57979 }
            },
          }
        }

        if (body?.command === 'click' && init.headers.authorization === 'Bearer stale-token') {
          return {
            ok: false,
            async json() {
              return { ok: false, error: { message: 'unauthorized', code: 'UNAUTHORIZED' } }
            },
          }
        }

        if (body?.command === 'click' && init.headers.authorization === 'Bearer fresh-token') {
          return {
            ok: true,
            async json() {
              return { ok: true, result: { clicked: true } }
            },
          }
        }

        throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.map((call) => String(call.url))).toEqual([
      'http://127.0.0.1:57979/command',
      'http://127.0.0.1:57979/status',
      'http://127.0.0.1:57979/command',
    ])
    expect(result.fetchCalls[2].init.headers.authorization).toBe('Bearer fresh-token')
    expect(JSON.parse(await readFile(path.join(stateDir, 'token'), 'utf8'))).toEqual({
      token: 'fresh-token',
    })
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

  test('open starts the local server and opens the connect page when the control server is unreachable', async () => {
    let statusCallCount = 0

    const result = await runCli(
      ['open', 'https://example.com'],
      { ok: true, result: { ok: true } },
      {
        openUrl: async () => {},
        spawnDetachedProcess: () => ({
          pid: 12345,
          unref() {},
        }),
        fetchImpl: async (url, init = {}) => {
          const body = init.body ? JSON.parse(init.body) : null

          if (body?.command === 'goto') {
            if (!init.headers?.authorization) {
              throw new Error('Unable to connect. Is the computer able to access the url?')
            }

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

          if (String(url).endsWith('/status')) {
            statusCallCount += 1

            if (statusCallCount < 3) {
              throw new Error('status unavailable')
            }

            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  token: 'live-token',
                  relayPort: 57978,
                  ipcPort: 57979,
                  extensionConnected: false,
                }
              },
              async text() {
                return `${JSON.stringify({
                  ok: true,
                  token: 'live-token',
                  relayPort: 57978,
                  ipcPort: 57979,
                  extensionConnected: false,
                })}\n`
              },
            }
          }

          throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.spawnCalls).toHaveLength(1)
    expect(result.fetchCalls.map((call) => String(call.url))).toContain(
      'http://127.0.0.1:57979/status',
    )
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=live-token&relayPort=57978&ipcPort=57979',
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        navigated: true,
      },
    })
  })

  test('open auto-connects after a disconnected response without requiring --auto-connect', async () => {
    let commandCallCount = 0

    const result = await runCli(
      ['open', 'https://example.com'],
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
            }
          }

          if (body?.command === 'goto') {
            commandCallCount += 1

            if (commandCallCount === 1) {
              return {
                ok: true,
                async json() {
                  return {
                    ok: false,
                    error: {
                      message: 'no extension is connected',
                      code: 'EXTENSION_DISCONNECTED',
                    },
                  }
                },
              }
            }

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
            }
          }

          throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=live-token&relayPort=48011&ipcPort=48012',
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        navigated: true,
      },
    })
  })

  test('open explains how to connect autobrowser when recovery still fails', async () => {
    const result = await runCli(
      ['open', 'https://bun.com/bun-unsafe-audit'],
      { ok: true, result: { ok: true } },
      {
        spawnDetachedProcess: () => ({
          pid: 12345,
          unref() {},
          async waitForExit() {
            return { code: 1, signal: null }
          },
        }),
        fetchImpl: async () => {
          throw new Error('Unable to connect. Is the computer able to access the url?')
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('autobrowser could not reach its local control server')
    expect(result.stderr).toContain('Recovery status:')
    expect(result.stderr).toContain('tried to start the local server automatically')
    expect(result.stderr).toContain('Run `autobrowser connect`')
    expect(result.stderr).toContain('extension installed and enabled')
    expect(result.stderr).toContain('autobrowser status')
    expect(result.stderr).toContain('Unable to connect. Is the computer able to access the url?')
  })

  test('open reports that the connect page was already opened automatically when retry still needs a connection', async () => {
    let commandCallCount = 0

    const result = await runCli(
      ['open', 'https://example.com'],
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
            }
          }

          if (body?.command === 'goto') {
            commandCallCount += 1
            return {
              ok: true,
              async json() {
                return {
                  ok: false,
                  error: {
                    message: `no extension is connected (${commandCallCount})`,
                    code: 'EXTENSION_DISCONNECTED',
                  },
                }
              },
            }
          }

          throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.openCalls).toEqual([
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=live-token&relayPort=48011&ipcPort=48012',
    ])
    expect(result.stdout).toContain('Recovery status:')
    expect(result.stdout).toContain('opened the connect page automatically')
    expect(result.stdout).toContain(
      'Complete the connect page that autobrowser opened automatically',
    )
    expect(result.stdout).toContain('Wait for `autobrowser status` to show `extension: connected`')
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

  test('auto-connect retries after an initial connect page launch failure', async () => {
    let commandCallCount = 0
    let openCallCount = 0

    const result = await runCli(
      ['--auto-connect', 'open', 'https://example.com'],
      { ok: true, result: { navigated: true } },
      {
        openUrl: async () => {
          openCallCount += 1
          if (openCallCount === 1) {
            throw new Error('failed to open connect page')
          }
        },
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
            }
          }

          if (body?.command === 'goto') {
            commandCallCount += 1
            if (commandCallCount === 1) {
              return {
                ok: true,
                async json() {
                  return {
                    ok: false,
                    error: {
                      message: 'no extension is connected',
                      code: 'EXTENSION_DISCONNECTED',
                    },
                  }
                },
              }
            }

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
            }
          }

          throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.openCalls).toHaveLength(2)
    expect(result.fetchCalls).toHaveLength(4)
    expect(result.fetchCalls.map((call) => String(call.url))).toEqual([
      'http://127.0.0.1:57979/status',
      'http://127.0.0.1:57979/command',
      'http://127.0.0.1:57979/status',
      'http://127.0.0.1:57979/command',
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        navigated: true,
      },
    })
  })

  test('batch runs commands in sequence from file input', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-batch-'))
    const batchFile = path.join(homeDir, 'batch.json')
    await writeFile(
      batchFile,
      JSON.stringify(
        [
          { command: 'snapshot' },
          {
            command: 'goto',
            args: {
              url: 'https://example.com',
            },
          },
        ],
        null,
        2,
      ),
    )

    const result = await runCli(['batch', '--file', batchFile], undefined, {
      homeDir,
      fetchImpl: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null

        if (body?.command === 'batch') {
          return {
            ok: true,
            async json() {
              return {
                ok: true,
                result: {
                  steps: [
                    {
                      index: 1,
                      command: 'snapshot',
                      args: {},
                      label: null,
                      response: {
                        ok: true,
                        result: { snapshotId: 's1' },
                      },
                    },
                    {
                      index: 2,
                      command: 'goto',
                      args: {
                        url: 'https://example.com',
                      },
                      label: null,
                      response: {
                        ok: true,
                        result: { navigated: true },
                      },
                    },
                  ],
                },
              }
            },
          }
        }

        throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body.command).toBe('batch')
    expect(result.fetchCalls[0].body.args.steps).toEqual([
      { command: 'snapshot', args: {}, label: null },
      {
        command: 'goto',
        args: {
          url: 'https://example.com',
        },
        label: null,
      },
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        steps: [
          {
            index: 1,
            command: 'snapshot',
            args: {},
            label: null,
            response: {
              ok: true,
              result: { snapshotId: 's1' },
            },
          },
          {
            index: 2,
            command: 'goto',
            args: {
              url: 'https://example.com',
            },
            label: null,
            response: {
              ok: true,
              result: { navigated: true },
            },
          },
        ],
      },
    })
  })

  test('batch rejects array args before sending requests', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-batch-args-'))
    const batchFile = path.join(homeDir, 'batch.json')
    await writeFile(
      batchFile,
      JSON.stringify([
        {
          command: 'goto',
          args: [],
        },
      ]),
    )

    const result = await runCli(['batch', '--file', batchFile], undefined, {
      homeDir,
      fetchImpl: async () => {
        throw new Error('batch should fail before making requests')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('invalid batch step 1: args must be an object')
  })

  test('batch rejects invalid nested command argument types before sending requests', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-batch-schema-'))
    const batchFile = path.join(homeDir, 'batch.json')
    await writeFile(
      batchFile,
      JSON.stringify([
        {
          command: 'goto',
          args: {
            url: 123,
          },
        },
      ]),
    )

    const result = await runCli(['batch', '--file', batchFile], undefined, {
      homeDir,
      fetchImpl: async () => {
        throw new Error('batch should fail before making requests')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
  })

  test('batch stops on the first failed step and returns structured failure', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-batch-fail-'))
    const batchFile = path.join(homeDir, 'batch.json')
    await writeFile(
      batchFile,
      JSON.stringify(
        [
          { command: 'snapshot' },
          {
            command: 'goto',
            args: {
              url: 'chrome://settings',
            },
          },
        ],
        null,
        2,
      ),
    )

    const result = await runCli(['batch', '--file', batchFile], undefined, {
      homeDir,
      fetchImpl: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null

        if (body?.command === 'batch') {
          return {
            ok: true,
            async json() {
              return {
                ok: false,
                error: {
                  message: 'batch step 2 failed: goto',
                  code: 'BATCH_STEP_FAILED',
                  details: {
                    steps: [
                      {
                        index: 1,
                        command: 'snapshot',
                        args: {},
                        label: null,
                        response: {
                          ok: true,
                          result: { snapshotId: 's1' },
                        },
                      },
                      {
                        index: 2,
                        command: 'goto',
                        args: {
                          url: 'chrome://settings',
                        },
                        label: null,
                        response: {
                          ok: false,
                          error: {
                            message: 'cannot access chrome:// and edge:// urls',
                            code: 'EXTENSION_COMMAND_ERROR',
                          },
                        },
                      },
                    ],
                    failedStep: {
                      index: 2,
                      command: 'goto',
                      args: {
                        url: 'chrome://settings',
                      },
                      label: null,
                      response: {
                        ok: false,
                        error: {
                          message: 'cannot access chrome:// and edge:// urls',
                          code: 'EXTENSION_COMMAND_ERROR',
                        },
                      },
                    },
                  },
                },
              }
            },
          }
        }

        throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body.command).toBe('batch')
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'BATCH_STEP_FAILED',
      },
      result: {
        steps: [
          {
            index: 1,
            command: 'snapshot',
            response: {
              ok: true,
            },
          },
          {
            index: 2,
            command: 'goto',
            response: {
              ok: false,
              error: {
                message: 'cannot access chrome:// and edge:// urls',
              },
            },
          },
        ],
      },
    })
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
        spawnDetachedProcess: () => ({
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

  test('server serve refuses to start when the ipc port is already in use', async () => {
    const busyServer = createServer()
    await new Promise((resolve, reject) => {
      busyServer.once('error', reject)
      busyServer.listen(0, '127.0.0.1', resolve)
    })

    const busyAddress = busyServer.address()
    if (!busyAddress || typeof busyAddress === 'string') {
      throw new Error('failed to allocate busy ipc port')
    }

    const relayPortServer = createServer()
    await new Promise((resolve, reject) => {
      relayPortServer.once('error', reject)
      relayPortServer.listen(0, '127.0.0.1', resolve)
    })

    const relayAddress = relayPortServer.address()
    if (!relayAddress || typeof relayAddress === 'string') {
      throw new Error('failed to allocate relay port')
    }

    await new Promise((resolve, reject) => {
      relayPortServer.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(undefined)
      })
    })

    try {
      const result = await runCli(
        [
          'server',
          '--serve',
          '--relay-port',
          String(relayAddress.port),
          '--ipc-port',
          String(busyAddress.port),
        ],
        { ok: true, result: { ok: true } },
      )

      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(result.spawnCalls).toHaveLength(0)
      expect(result.stdout).not.toContain('autobrowser server started')
      expect(result.stderr).toContain(`Server already running on port ${busyAddress.port}`)
    } finally {
      await new Promise((resolve, reject) => {
        busyServer.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve(undefined)
        })
      })
    }
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
          expect(init.headers?.authorization).toBe('Bearer stop-token')
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
          expect(init.headers?.authorization).toBe('Bearer stop-token')
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
            expect(init.headers?.authorization).toBe('Bearer stop-token')
            return {
              ok: false,
              status: 404,
              statusText: 'Not Found',
              async text() {
                return 'not found'
              },
            }
          }

          if (String(url).endsWith('/status')) {
            expect(init.method).toBeUndefined()
            return {
              ok: true,
              async json() {
                return { relayPort: 49011, ipcPort: 49012 }
              },
            }
          }

          throw new Error(`unexpected URL: ${String(url)}`)
        },
      },
    )

    expect(result.exitCode).toBeUndefined()
    expect(result.fetchCalls).toHaveLength(2)
    expect(killCalls).toEqual([{ pid: 12345, signal: 'SIGTERM' }])
    expect(result.stdout).toContain('stopped')
  })

  test('server stop refuses to kill a foreign process occupying the port', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-stop-foreign-test-'))
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
        findProcessIdByPort: async () => 12345,
        killProcess: (pid, signal) => {
          killCalls.push({ pid, signal })
          return true
        },
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/shutdown')) {
            expect(init.method).toBe('POST')
            return {
              ok: false,
              status: 404,
              statusText: 'Not Found',
              async text() {
                return 'not found'
              },
            }
          }

          if (String(url).endsWith('/status')) {
            // 响应不是 autobrowser 形态（缺 relayPort/ipcPort），说明端口被无关进程占用
            return {
              ok: true,
              async json() {
                return { service: 'something-else' }
              },
            }
          }

          throw new Error(`unexpected URL: ${String(url)}`)
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(killCalls).toEqual([])
    expect(result.stderr).toContain('not an autobrowser server')
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

    const isCall = result.fetchCalls.find((call) => call.body?.command === 'is')

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(isCall?.body).toEqual({
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
    const waitCall = result.fetchCalls.find((call) => call.body?.command === 'wait')

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(waitCall?.body).toEqual({
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
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
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
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'screenshot',
      args: {
        full: true,
        annotate: true,
        format: 'jpeg',
        quality: 80,
      },
    })
    expect(JSON.parse(result.stdout)).toMatchObject({
      path: outputPath,
      mimeType: 'image/jpeg',
      format: 'jpeg',
      full: true,
      annotate: true,
    })
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

    const savedPath = JSON.parse(result.stdout).path
    const screenshotCall = result.fetchCalls.find((call) => call.body?.command === 'screenshot')
    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(screenshotCall?.body).toEqual({
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

    const savedPath = JSON.parse(result.stdout).path
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
    const doubleClickCall = result.fetchCalls.find((call) => call.body?.command === 'dblclick')

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(doubleClickCall?.body).toEqual({
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
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        message: 'click failed',
      },
    })
    expect(result.stderr).toBe('')
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

  test('routes type --submit to the extension', async () => {
    const result = await runCli(['type', '#q', 'hello', '--submit'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'type',
      args: {
        selector: '#q',
        value: 'hello',
        submit: true,
      },
    })
  })

  test('routes element screenshots to the extension', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-element-test-'))
    const outputPath = path.join(outputDir, 'shot.png')
    const screenshotBytes = Buffer.from('element-screenshot')

    const result = await runCli(['screenshot', outputPath, '--element', '#card'], {
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
        element: '#card',
      },
    })
    expect((await readFile(outputPath)).toString()).toBe('element-screenshot')
  })

  test('rejects element screenshots combined with --full before calling the extension', async () => {
    const result = await runCli(['screenshot', '--element', '#card', '--full'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('cannot be combined')
  })

  test('routes text-gone waits to the extension', async () => {
    const result = await runCli(['wait', '--text', 'Loading', '--gone'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'wait',
      args: {
        timeout: 30000,
        state: 'visible',
        type: 'text',
        text: 'Loading',
        gone: true,
      },
    })
  })

  test('routes snapshot subtree targets to the extension', async () => {
    const result = await runCli(['snapshot', '--target', '#panel'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'snapshot',
      args: {
        selector: '#panel',
      },
    })
  })

  test('routes snapshot role filters and changed mode to the extension', async () => {
    const result = await runCli(['snapshot', '--role', 'button,link', '--changed'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'snapshot',
      args: {
        roles: ['button', 'link'],
        changed: true,
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
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
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

  test('routes find candidates mode to the extension', async () => {
    const result = await runCli(['find', 'text', 'Save', '--candidates', '3'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'text',
        query: 'Save',
        exact: false,
        candidates: 3,
      },
    })
  })

  test('routes find position selection to the extension', async () => {
    const result = await runCli(['find', 'role', 'button', '--position', 'last'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'find',
      args: {
        strategy: 'role',
        role: 'button',
        exact: false,
        position: 'last',
      },
    })
  })

  test('rejects find candidates combined with position', async () => {
    const result = await runCli(['find', 'text', 'Save', '--candidates', '3', '--position', 'last'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--candidates cannot be combined with --position')
  })

  test('rejects find candidates with a non-locate action', async () => {
    const result = await runCli(['find', 'text', 'Save', '--candidates', '3', 'click'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--candidates only supports the locate action')
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

  test('routes search queries to the extension', async () => {
    const result = await runCli(['search', 'Sign in'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'search',
      args: {
        query: 'Sign in',
        context: 3,
        limit: 20,
      },
    })
  })

  test('routes search regex queries with context and limit options', async () => {
    const result = await runCli(['search', '/foo/i', '--context', '5', '--limit', '2'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'search',
      args: {
        query: '/foo/i',
        context: 5,
        limit: 2,
      },
    })
  })

  test('adds global tab and frame overrides to search commands', async () => {
    const result = await runCli(['search', '--tab', 't2', '--frame', '@f1', 'Sign in'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'search',
      args: {
        query: 'Sign in',
        context: 3,
        limit: 20,
        tabId: 't2',
        frame: '@f1',
      },
    })
  })

  test('rejects invalid search invocations', async () => {
    const missingQuery = await runCli(['search'])
    expect(missingQuery.exitCode).toBe(1)
    expect(missingQuery.stderr).toContain('missing search query')
    expect(missingQuery.fetchCalls).toHaveLength(0)

    const badRegex = await runCli(['search', '/foo[/'])
    expect(badRegex.exitCode).toBe(1)
    expect(badRegex.stderr).toContain('invalid search regex')
    expect(badRegex.fetchCalls).toHaveLength(0)

    const badOption = await runCli(['search', 'x', '--bogus'])
    expect(badOption.exitCode).toBe(1)
    expect(badOption.stderr).toContain('unsupported search option: --bogus')
    expect(badOption.fetchCalls).toHaveLength(0)

    const extraArg = await runCli(['search', 'x', 'extra'])
    expect(extraArg.exitCode).toBe(1)
    expect(extraArg.stderr).toContain('unexpected extra search argument: extra')
    expect(extraArg.fetchCalls).toHaveLength(0)
  })

  test('adds global tab overrides without leaking frame overrides to frame selection', async () => {
    const result = await runCli(['frame', '--tab', 't4', '@f3'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.some((call) => call.body?.command === 'frame')).toBe(true)
    expect(result.fetchCalls.find((call) => call.body?.command === 'frame')?.body).toEqual({
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
            entries: [
              {
                startedDateTime: '2026-04-20T15:00:00.000Z',
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
            ],
          },
        },
      },
    }
    const result = await runCli(['network', 'har', 'stop'], payload)

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)

    const outputPath = JSON.parse(result.stdout).result
    expect(outputPath.length).toBeGreaterThan(0)

    const harContent = await readFile(outputPath, 'utf8')
    expect(harContent).toContain('"version": "1.2"')
    expect(harContent).toContain('"creator"')
    expect(harContent).toContain('"https://example.com/"')
    expect(harContent).toContain('"entries": [')
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
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(3)
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
    const stateLoadCall = result.fetchCalls.find((call) => call.body?.command === 'state')

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)
    expect(stateLoadCall?.body).toEqual({
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

describe('cli network route and console argument parsing', () => {
  test('parses network route mock options', () => {
    expect(
      parseNetworkRouteArgs([
        '**/api/*',
        '--status',
        '404',
        '--content-type',
        'text/plain',
        '--header',
        'X-Mock: yes',
        '--header',
        'X-Other: a:b',
        '--remove-headers',
        'Authorization, X-Debug',
      ]),
    ).toEqual({
      url: '**/api/*',
      abort: false,
      status: 404,
      contentType: 'text/plain',
      headers: { 'X-Mock': 'yes', 'X-Other': 'a:b' },
      removeHeaders: ['Authorization', 'X-Debug'],
    })
  })

  test('rejects invalid network route options', () => {
    expect(() => parseNetworkRouteArgs(['**/api/*', '--status'])).toThrow('missing status value')
    expect(() => parseNetworkRouteArgs(['**/api/*', '--status', '99'])).toThrow('expected >= 100')
    expect(() => parseNetworkRouteArgs(['**/api/*', '--header', 'NoColon'])).toThrow(
      'expected "Name: Value"',
    )
    expect(() => parseNetworkRouteArgs(['**/api/*', '--remove-headers'])).toThrow(
      'missing remove-headers value',
    )
  })

  test('parses console level with strict validation', () => {
    expect(parseConsoleArgs([])).toEqual({ level: null })
    expect(parseConsoleArgs(['--level', 'warning'])).toEqual({ level: 'warning' })
    expect(() => parseConsoleArgs(['--level', 'verbose'])).toThrow('unsupported console level')
    expect(() => parseConsoleArgs(['--bogus'])).toThrow('unsupported console option')
    expect(() => parseConsoleArgs(['extra'])).toThrow('unexpected extra console argument')
  })
})

describe('cli network/session command forwarding', () => {
  test('routes network route list to the extension', async () => {
    const result = await runCli(['network', 'route', 'list'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: { action: 'route', subaction: 'list' },
    })
  })

  test('forwards network route mock options to the extension', async () => {
    const result = await runCli([
      'network',
      'route',
      '**/api/*',
      '--status',
      '503',
      '--header',
      'X-Mock: yes',
      '--remove-headers',
      'authorization,x-debug',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'route',
        url: '**/api/*',
        abort: false,
        status: 503,
        headers: { 'X-Mock': 'yes' },
        removeHeaders: ['authorization', 'x-debug'],
      },
    })
  })

  test('forwards cookies get filters and delete to the extension', async () => {
    const filtered = await runCli(['cookies', 'get', '--domain', 'example.com', '--path', '/'])
    expect(filtered.fetchCalls[0].body).toEqual({
      command: 'cookies',
      args: { action: 'get', domain: 'example.com', path: '/' },
    })

    const deleted = await runCli(['cookies', 'delete', 'sid'])
    expect(deleted.fetchCalls[0].body).toEqual({
      command: 'cookies',
      args: { action: 'delete', name: 'sid' },
    })
  })

  test('forwards storage session flag and delete to the extension', async () => {
    const deleted = await runCli(['storage', 'delete', '--session', 'draft'])
    expect(deleted.fetchCalls[0].body).toEqual({
      command: 'storage',
      args: { action: 'delete', key: 'draft', session: true },
    })

    const listed = await runCli(['storage', 'get', '--session'])
    expect(listed.fetchCalls[0].body).toEqual({
      command: 'storage',
      args: { action: 'get', session: true },
    })
  })

  test('forwards set permission/ua/timezone/locale to the extension', async () => {
    const granted = await runCli(['set', 'permission', 'geolocation'])
    expect(granted.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'permission', name: 'geolocation' },
    })

    const resetPermission = await runCli(['set', 'permission', 'geolocation', '--reset'])
    expect(resetPermission.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'permission', name: 'geolocation', reset: true },
    })

    const ua = await runCli(['set', 'ua', 'My Agent 1.0'])
    expect(ua.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'ua', value: 'My Agent 1.0' },
    })

    const resetUa = await runCli(['set', 'ua', '--reset'])
    expect(resetUa.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'ua', value: '' },
    })

    const timezone = await runCli(['set', 'timezone', 'Asia/Shanghai'])
    expect(timezone.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'timezone', value: 'Asia/Shanghai' },
    })

    const locale = await runCli(['set', 'locale', 'zh-CN'])
    expect(locale.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'locale', value: 'zh-CN' },
    })
  })

  test('filters console messages by level on the CLI side', async () => {
    const payload = {
      ok: true,
      result: {
        messages: [
          { type: 'error', text: 'e', timestamp: 1 },
          { type: 'warning', text: 'w', timestamp: 2 },
          { type: 'log', text: 'l', timestamp: 3 },
          { type: 'debug', text: 'd', timestamp: 4 },
        ],
      },
    }

    const filtered = await runCli(['console', '--level', 'warning'], payload)
    expect(filtered.exitCode).toBe(0)
    const filteredOutput = JSON.parse(filtered.stdout)
    // warning 级别包含更严重的 error，排除 log/debug
    expect(filteredOutput.result.messages.map((message) => message.type)).toEqual([
      'error',
      'warning',
    ])

    const unfiltered = await runCli(['console'], payload)
    const unfilteredOutput = JSON.parse(unfiltered.stdout)
    expect(unfilteredOutput.result.messages).toHaveLength(4)
  })
})

describe('cli script command forwarding', () => {
  test('documents script help output', async () => {
    const scriptHelp = await runCli(['help', 'script'])
    expect(scriptHelp.exitCode).toBe(0)
    expect(scriptHelp.stdout).toContain('autobrowser script <add|list|remove>')
    expect(scriptHelp.stdout).toContain(
      'autobrowser script add [--stdin|--file <path>|--base64] <source>',
    )
    expect(scriptHelp.stdout).toContain('autobrowser script remove <id|--all>')
  })

  test('forwards script add with a positional source', async () => {
    const result = await runCli(['script', 'add', 'window.__injected = true'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'add', source: 'window.__injected = true' },
    })
  })

  test('forwards script add reading the source from --file and --base64', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-script-'))
    const scriptPath = path.join(tempDir, 'init.js')
    await writeFile(scriptPath, 'window.__fromFile = 1\n', 'utf8')

    const fromFile = await runCli(['script', 'add', '--file', scriptPath])
    expect(fromFile.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'add', source: 'window.__fromFile = 1' },
    })

    const fromBase64 = await runCli([
      'script',
      'add',
      '--base64',
      Buffer.from('window.__b64 = 2', 'utf8').toString('base64'),
    ])
    expect(fromBase64.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'add', source: 'window.__b64 = 2' },
    })
  })

  test('forwards script list and remove to the extension', async () => {
    const listed = await runCli(['script', 'list'])
    expect(listed.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'list' },
    })

    const removed = await runCli(['script', 'remove', 'script_abc'])
    expect(removed.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'remove', id: 'script_abc' },
    })

    const removedAll = await runCli(['script', 'remove', '--all'])
    expect(removedAll.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'remove', all: true },
    })
  })
})
