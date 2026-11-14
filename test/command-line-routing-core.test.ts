import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

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
      ['--json', 'status'],
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

  test('status prints a readable summary by default and raw JSON with --json', async () => {
    const payload = {
      token: 'live-token',
      relayPort: 57978,
      ipcPort: 57979,
      extensionConnected: false,
    }

    // 默认走摘要：json 默认值仍是 true，但不能因为默认值就把人读格式吞掉。
    const summary = await runCli(['status'], payload)
    expect(summary.exitCode).toBe(0)
    expect(summary.stdout).toContain('autobrowser status')
    expect(summary.stdout).toContain('relay: http://127.0.0.1:57978')
    expect(summary.stdout).toContain('extension: waiting for extension')

    const asJson = await runCli(['--json', 'status'], payload)
    expect(asJson.exitCode).toBe(0)
    expect(JSON.parse(asJson.stdout)).toMatchObject(payload)
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
    const error = cliErrorPayload(result.stdout).error
    expect(error.message).toContain('autobrowser could not reach its local control server')
    expect(error.message).toContain('Recovery status:')
    expect(error.message).toContain('tried to start the local server automatically')
    expect(error.message).toContain('Run `autobrowser connect`')
    expect(error.message).toContain('status unavailable')
  })

  test('sends the persisted token as bearer auth for commands', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-command-token-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(path.join(stateDir, 'token'), JSON.stringify({ token: 'command-token' }))

    const result = await runCli(['click', '#submit'], undefined, { homeDir })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].init.headers?.authorization).toBe('Bearer command-token')
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

        if (body?.command === 'click' && init.headers?.authorization === 'Bearer stale-token') {
          return {
            ok: false,
            async json() {
              return { ok: false, error: { message: 'unauthorized', code: 'UNAUTHORIZED' } }
            },
          }
        }

        if (body?.command === 'click' && init.headers?.authorization === 'Bearer fresh-token') {
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
    expect(result.fetchCalls[2].init.headers?.authorization).toBe('Bearer fresh-token')
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

  test('routes configurable navigation settlement options', async () => {
    const result = await runCli([
      'goto',
      'https://example.com/app#route',
      '--wait-until',
      'networkidle',
      '--settle-timeout',
      '5000',
      '--dom-quiet-ms',
      '250',
    ])
    expect(result.fetchCalls[0].body).toEqual({
      command: 'goto',
      args: {
        url: 'https://example.com/app#route',
        waitUntil: 'networkidle',
        settleTimeoutMs: 5000,
        domQuietMs: 250,
      },
    })
  })

  test('routes the --timeout alias for goto, open and reload while keeping timeoutMs', async () => {
    const goto = await runCli(['goto', 'https://example.com/app', '--timeout', '7000'])
    expect(goto.fetchCalls[0].body).toEqual({
      command: 'goto',
      args: { url: 'https://example.com/app', timeoutMs: 7000 },
    })

    const open = await runCli(['open', 'https://example.com/open', '--timeout', '7100'])
    expect(open.fetchCalls[0].body).toEqual({
      command: 'goto',
      args: { url: 'https://example.com/open', timeoutMs: 7100 },
    })

    const reload = await runCli(['reload', '--timeout', '7200'])
    expect(reload.fetchCalls[0].body).toEqual({
      command: 'reload',
      args: { timeoutMs: 7200 },
    })
  })

  test('rejects mixing --timeout-ms and --timeout before sending navigation requests', async () => {
    for (const args of [
      ['goto', 'https://example.com', '--timeout-ms', '5000', '--timeout', '6000'],
      ['goto', 'https://example.com', '--timeout-ms', '5000', '--timeout-ms', '6000'],
      ['open', 'https://example.com', '--timeout', '5000', '--timeout-ms', '6000'],
      ['reload', '--timeout-ms', '5000', '--timeout', '6000'],
      ['reload', '--timeout', '5000', '--timeout', '6000'],
    ]) {
      const result = await runCli(args)
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      const error = cliErrorPayload(result.stdout).error
      expect(error.code).toBe('CLI_INVALID_ARGUMENT')
      expect(error.message).toContain('duplicate')
    }
  })

  test('routes reload result waits to the extension', async () => {
    const result = await runCli([
      'reload',
      '--wait-until',
      'none',
      '--wait-for',
      'url',
      '#/outNet',
      '--timeout-ms',
      '5000',
    ])

    expect(result.fetchCalls[0].body).toEqual({
      command: 'reload',
      args: { waitUntil: 'none', waitFor: 'url', url: '#/outNet', timeoutMs: 5000 },
    })

    const selector = await runCli(['reload', '--wait-for', 'selector', '#app'])
    expect(selector.fetchCalls[0].body).toEqual({
      command: 'reload',
      args: { waitFor: 'selector', selector: '#app' },
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
              throw Object.assign(
                new Error('Unable to connect. Is the computer able to access the url?'),
                { code: 'ECONNREFUSED' },
              )
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

  test('does not replay a command when the connection drops after the request may have run', async () => {
    let commandCallCount = 0

    const result = await runCli(['fill', '#search', 'hello'], undefined, {
      fetchImpl: async (url) => {
        if (String(url).endsWith('/status')) {
          return {
            ok: true,
            async json() {
              return {
                token: 'live-token',
                relayPort: 48011,
                ipcPort: 57979,
                extensionConnected: true,
              }
            },
          }
        }

        commandCallCount += 1
        // 连接在请求可能已经送达扩展后被重置
        throw new Error('read ECONNRESET')
      },
    })

    expect(result.exitCode).toBe(1)
    // 绝不重放：命令请求只发一次
    expect(commandCallCount).toBe(1)
    expect(result.spawnCalls).toHaveLength(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('COMMAND_EXECUTION_UNKNOWN')
    expect(payload.error.message).toContain('fill')
    expect(payload.error.suggestedAction).toContain('autobrowser command list')
    expect(payload.error.suggestedAction).toContain('autobrowser status')
    expect(payload.error.suggestedAction).toContain('autobrowser snapshot')
  })

  test('reports unknown execution for a reset connection without starting the background server', async () => {
    const result = await runCli(['--raw', 'goto', 'https://example.com'], undefined, {
      spawnDetachedProcess: () => {
        throw new Error('must not spawn')
      },
      fetchImpl: async () => {
        throw new Error('fetch failed')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.spawnCalls).toHaveLength(0)
    expect(result.stderr).toContain('may already have run in the browser')
    expect(result.stderr).toContain('autobrowser snapshot')
    expect(result.stderr).toContain('AI SUGGESTION')
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
          throw Object.assign(
            new Error('Unable to connect. Is the computer able to access the url?'),
            { code: 'ECONNREFUSED' },
          )
        },
      },
    )

    expect(result.exitCode).toBe(1)
    const error = cliErrorPayload(result.stdout).error
    expect(error.message).toContain('autobrowser could not reach its local control server')
    expect(error.message).toContain('Recovery status:')
    expect(error.message).toContain('tried to start the local server automatically')
    expect(error.message).toContain('Run `autobrowser connect`')
    expect(error.message).toContain('extension installed and enabled')
    expect(error.message).toContain('autobrowser status')
    expect(error.message).toContain('Unable to connect. Is the computer able to access the url?')
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
})
