import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

describe('cli command routing', () => {
  test('replay refuses redacted arguments without dispatching a command', async () => {
    const result = await runCli(['replay'], undefined, {
      fetchImpl: async (url) => {
        if (String(url).endsWith('/status')) {
          return Response.json({
            snapshot: {
              lastCommand: {
                command: 'batch',
                args: {
                  steps: [
                    { command: 'eval', args: { script: '[redacted]' } },
                    { command: 'snapshot', args: {} },
                  ],
                },
              },
            },
          })
        }
        throw new Error('redacted replay must not dispatch')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(1)
    expect(String(result.fetchCalls[0].url)).toBe('http://127.0.0.1:57979/status')
    expect(cliErrorPayload(result.stdout).error.message).toContain('cannot be replayed safely')
  })

  test('named sessions isolate status/config routing and support repeated data cleanup', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-session-cli-'))
    const created = await runCli(['session', 'create', 'alpha'], undefined, { homeDir })
    expect(created.exitCode).toBe(0)
    const record = JSON.parse(created.stdout).result
    expect(record.name).toBe('alpha')

    const statusPayload = {
      relayPort: record.relayPort,
      ipcPort: record.ipcPort,
      extensionConnected: false,
      snapshot: { targetTabId: 42 },
    }
    const status = await runCli(['--session', 'alpha', 'status'], statusPayload, { homeDir })
    expect(status.exitCode).toBe(0)
    expect(String(status.fetchCalls[0].url)).toBe(`http://127.0.0.1:${record.ipcPort}/status`)

    const config = await runCli(['--session', 'alpha', 'config'], undefined, { homeDir })
    const configResult = JSON.parse(config.stdout).result
    expect(configResult.homeDir).toBe(record.homeDir)
    expect(configResult.config.browserArgs).toEqual([`--user-data-dir=${record.profileDir}`])

    const listed = await runCli(['session', 'list'], undefined, { homeDir })
    expect(JSON.parse(listed.stdout).result.sessions[0]).toMatchObject({
      name: 'alpha',
      running: false,
      targetTabId: null,
    })
    const closed = await runCli(['session', 'close-all', 'alpha'], undefined, { homeDir })
    expect(closed.exitCode).toBe(0)
    expect(String(closed.fetchCalls[0].url)).toBe(`http://127.0.0.1:${record.ipcPort}/command`)
    expect(closed.fetchCalls[0].body).toMatchObject({ command: 'close', args: { all: true } })
    const detached = await runCli(['session', 'detach', 'alpha'], undefined, { homeDir })
    expect(JSON.parse(detached.stdout).result).toMatchObject({
      session: 'alpha',
      alreadyStopped: true,
    })

    const killed = await runCli(['kill-all'], undefined, { homeDir })
    expect(JSON.parse(killed.stdout).result.sessions).toEqual([
      { name: 'default', stopped: false, alreadyStopped: true },
      { name: 'alpha', stopped: false, alreadyStopped: true },
    ])

    const deleted = await runCli(['session', 'delete-data', 'alpha'], undefined, { homeDir })
    expect(JSON.parse(deleted.stdout).result).toMatchObject({ deleted: true })
    const repeated = await runCli(['session', 'delete-data', 'alpha'], undefined, { homeDir })
    expect(repeated.exitCode).toBe(0)
    expect(JSON.parse(repeated.stdout).result).toMatchObject({
      deleted: false,
      alreadyClean: true,
    })
  })

  test('session attach starts the background relay with the same session and ports', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-session-attach-'))
    const created = await runCli(['session', 'create', 'alpha'], undefined, { homeDir })
    const record = JSON.parse(created.stdout).result
    let statusCalls = 0
    const attached = await runCli(['session', 'attach', 'alpha'], undefined, {
      homeDir,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/status')) {
          statusCalls += 1
          if (statusCalls === 1) throw new Error('relay not started')
          return Response.json({
            token: 'alpha-token',
            relayPort: record.relayPort,
            ipcPort: record.ipcPort,
            extensionConnected: true,
          })
        }
        return Response.json({ ok: true, result: {} })
      },
      spawnDetachedProcess: () => ({
        pid: 12345,
        unref() {},
        waitForExit: async () => await new Promise(() => {}),
      }),
    })
    expect(attached.exitCode).toBe(0)
    expect(attached.spawnCalls).toHaveLength(1)
    expect(attached.spawnCalls[0].args.slice(1, 3)).toEqual(['--session', 'alpha'])
    expect(attached.spawnCalls[0].args.slice(-2)).toEqual(['server', '--serve'])
    expect(attached.spawnCalls[0].args).toContain(String(record.relayPort))
    expect(attached.spawnCalls[0].args).toContain(String(record.ipcPort))
    // 优先打开扩展的 connect 页；测试里只记录 URL，不会真的打开浏览器
    expect(attached.openCalls).toHaveLength(1)
    expect(attached.openCalls[0]).toContain('connect')
    expect(attached.openCalls[0]).toContain('token=alpha-token')
  })

  test('Firefox status uses the configured WebDriver instead of the Chromium relay', async () => {
    const result = await runCli(
      ['--engine', 'firefox', '--webdriver-url', 'http://driver.test', 'status'],
      undefined,
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url) === 'http://driver.test/session') {
            expect(JSON.parse(String(init.body))).toMatchObject({
              capabilities: { alwaysMatch: { browserName: 'firefox' } },
            })
            return Response.json({ value: { sessionId: 'firefox-session', capabilities: {} } })
          }
          return Response.json({ value: 'about:blank' })
        },
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.spawnCalls).toHaveLength(0)
    expect(
      result.fetchCalls.every((call) => String(call.url).startsWith('http://driver.test')),
    ).toBe(true)
    expect(JSON.parse(result.stdout).result).toMatchObject({
      engine: 'firefox',
      sessionId: 'firefox-session',
      connected: true,
    })

    const invalid = await runCli(['--engine', 'other', 'status'])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(invalid.stdout).error.message).toContain(
      '--engine must be chromium, firefox or webkit',
    )
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
