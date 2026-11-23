import { describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as callerIdentity from '../src/cli/caller-identity.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a test port')))
        return
      }

      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function writePersistedState(
  homeDir: string,
  state: { token: string; relayPort: number; ipcPort: number },
): Promise<void> {
  const stateDir = path.join(homeDir, '.autobrowser')
  await mkdir(stateDir, { recursive: true })
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(state))
  await writeFile(path.join(stateDir, 'token'), JSON.stringify({ token: state.token }))
}

describe('cli command routing', () => {
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
    expect(result.spawnCalls[0].args.slice(-2)).toEqual(['server', '--serve'])
    expect(result.spawnCalls[0].args).toContain('--relay-port')
    expect(result.spawnCalls[0].args).toContain('--ipc-port')
    expect(result.stdout).toContain('background')
  })

  test('server serve refuses to start when the ipc port is already in use', async () => {
    const busyServer = createServer()
    await new Promise<void>((resolve, reject) => {
      busyServer.once('error', reject)
      busyServer.listen(0, '127.0.0.1', () => resolve())
    })

    const busyAddress = busyServer.address()
    if (!busyAddress || typeof busyAddress === 'string') {
      throw new Error('failed to allocate busy ipc port')
    }

    const relayPortServer = createServer()
    await new Promise<void>((resolve, reject) => {
      relayPortServer.once('error', reject)
      relayPortServer.listen(0, '127.0.0.1', () => resolve())
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
      expect(cliErrorPayload(result.stdout).error.message).toContain(
        `Server already running on port ${busyAddress.port}`,
      )
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

  test('server stop prefers an explicit ipc port over persisted connection ports', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-stop-explicit-port-'))
    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({ token: 'stop-token', relayPort: 49011, ipcPort: 49012 }),
    )

    const result = await runCli(
      ['--ipc-port', '49112', 'server', 'stop'],
      { ok: true, result: { stopping: true } },
      {
        homeDir,
        fetchImpl: async (url, init = {}) => {
          expect(String(url)).toBe('http://127.0.0.1:49112/shutdown')
          expect(init.headers?.authorization).toBe('Bearer stop-token')
          return Response.json({ ok: true, result: { stopping: true } })
        },
      },
    )

    expect(result.exitCode).toBeUndefined()
    expect(result.fetchCalls).toHaveLength(1)
    expect(String(result.fetchCalls[0].url)).toBe('http://127.0.0.1:49112/shutdown')
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

    const killCalls: { pid: number; signal?: NodeJS.Signals | number }[] = []

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

    const killCalls: { pid: number; signal?: NodeJS.Signals | number }[] = []

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
    expect(cliErrorPayload(result.stdout).error.message).toContain('not an autobrowser server')
  })

  test('status reports the local invocation shell in text, brief and JSON output', async () => {
    const { detectInvocationShell } = callerIdentity
    const detect = spyOn(callerIdentity, 'detectInvocationShell').mockResolvedValue('bash')
    const fetchImpl = async () =>
      Response.json({
        relayPort: 57978,
        ipcPort: 57979,
        extensionConnected: false,
        invocationShell: 'not-the-local-shell',
      })

    try {
      const json = await runCli(['status', '--json'], undefined, { fetchImpl })
      expect(JSON.parse(json.stdout)).toMatchObject({ invocationShell: 'bash' })

      detect.mockResolvedValue('pwsh')
      const text = await runCli(['status'], undefined, { fetchImpl })
      expect(text.stdout).toContain('invocation shell: pwsh\n')
      const brief = await runCli(['status', '--brief'], undefined, { fetchImpl })
      expect(brief.stdout).toContain('invocation shell: pwsh\n')

      detect.mockImplementation(() =>
        detectInvocationShell({ queryProcess: () => Promise.reject(new Error('access denied')) }),
      )
      const unknown = await runCli(['status', '--json'], undefined, { fetchImpl })
      expect(unknown.exitCode).toBe(0)
      expect(JSON.parse(unknown.stdout)).toMatchObject({ invocationShell: 'unknown' })
      expect(detect).toHaveBeenCalledTimes(4)

      await runCli(['status', '--help'])
      await runCli(['version'])
      expect(detect).toHaveBeenCalledTimes(4)
    } finally {
      detect.mockRestore()
    }
  })

  test('status marks a relay it auto-started in the structured result', async () => {
    let spawned = false
    const result = await runCli(['status', '--json'], undefined, {
      // 服务没起来之前必须持续表现为不可达，否则 startBackgroundServer 会误判 already-running。
      fetchImpl: async () => {
        if (!spawned) throw new Error('fetch failed')
        return Response.json({
          token: 'live-token',
          relayPort: 57978,
          ipcPort: 57979,
          extensionConnected: false,
        })
      },
      spawnDetachedProcess: () => {
        spawned = true
        return { pid: 12345, unref() {} }
      },
    })

    expect(result.spawnCalls).toHaveLength(1)
    const status = JSON.parse(result.stdout) as Record<string, unknown>
    expect(status.serverAutoStarted).toBe(true)
    expect(status.relayPort).toBe(57978)
    expect(status.ipcPort).toBe(57979)
  })

  test('status text output says the relay was auto-started by this call', async () => {
    let spawned = false
    const result = await runCli(['status', '--raw'], undefined, {
      fetchImpl: async () => {
        if (!spawned) throw new Error('fetch failed')
        return Response.json({ relayPort: 57978, ipcPort: 57979, extensionConnected: false })
      },
      spawnDetachedProcess: () => {
        spawned = true
        return { pid: 12345, unref() {} }
      },
    })

    expect(result.spawnCalls).toHaveLength(1)
    expect(result.stdout).toContain('server: auto-started by this status command')
  })

  test('status leaves the marker out when the relay was already running', async () => {
    const result = await runCli(['status', '--json'], undefined, {
      fetchImpl: async () =>
        Response.json({ relayPort: 57978, ipcPort: 57979, extensionConnected: false }),
      spawnDetachedProcess: () => {
        throw new Error('status must not start a relay that is already running')
      },
    })

    expect(result.spawnCalls).toHaveLength(0)
    const status = JSON.parse(result.stdout) as Record<string, unknown>
    expect(status.serverAutoStarted).toBeUndefined()
  })

  test('server stop and restart reject extra positional arguments', async () => {
    const stopped = await runCli(['server', 'stop', 'now'])
    expect(stopped.exitCode).toBe(1)
    expect(stopped.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(stopped.stdout).error.message).toContain(
      'unexpected argument for server stop',
    )

    const restarted = await runCli(['server', 'restart', 'now'])
    expect(restarted.exitCode).toBe(1)
    expect(restarted.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(restarted.stdout).error.message).toContain(
      'unexpected argument for server restart',
    )
  })

  test('server restart stops the recorded server, then starts the explicit ports', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-restart-test-'))
    // 持久化端口与显式端口不同，用来证明 flags 覆盖了 state.json。
    await writePersistedState(homeDir, { token: 'restart-token', relayPort: 49031, ipcPort: 49032 })

    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    const events: string[] = []
    let phase: 'running' | 'stopping' = 'running'
    let spawned = false

    const result = await runCli(
      ['--relay-port', String(relayPort), '--ipc-port', String(ipcPort), 'server', 'restart'],
      undefined,
      {
        homeDir,
        fetchImpl: async (url, init = {}) => {
          const target = String(url)
          if (target.endsWith('/status')) {
            events.push('status')
            // 停止之后、新进程起来之前，端口上不该还有服务应答。
            if (phase === 'stopping' && !spawned) throw new Error('fetch failed')
            return Response.json({ relayPort, ipcPort })
          }
          if (target.endsWith('/shutdown')) {
            events.push('shutdown')
            expect(init.method).toBe('POST')
            expect(init.headers?.authorization).toBe('Bearer restart-token')
            phase = 'stopping'
            return Response.json({ ok: true, result: { stopping: true } })
          }
          throw new Error(`unexpected URL: ${target}`)
        },
        spawnDetachedProcess: () => {
          events.push('spawn')
          spawned = true
          return { pid: 4321, unref() {} }
        },
      },
    )

    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('restarted')

    const shutdownIndex = events.indexOf('shutdown')
    const spawnIndex = events.indexOf('spawn')
    expect(shutdownIndex).toBeGreaterThan(-1)
    // 顺序很重要：先确认旧服务收到关闭，再拉起新进程，否则就是两个进程抢同一端口。
    expect(spawnIndex).toBeGreaterThan(shutdownIndex)

    const spawnArgs = result.spawnCalls[0].args
    expect(spawnArgs).toContain('--relay-port')
    expect(spawnArgs).toContain(String(relayPort))
    expect(spawnArgs).toContain('--ipc-port')
    expect(spawnArgs).toContain(String(ipcPort))
    expect(spawnArgs).not.toContain('49031')
    expect(spawnArgs).not.toContain('49032')
    expect(spawnArgs.slice(-2)).toEqual(['server', '--serve'])
  })

  test('server restart reuses the persisted ports when no explicit ports are given', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-restart-persisted-test-'))
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    await writePersistedState(homeDir, { token: 'persisted-token', relayPort, ipcPort })

    const events: string[] = []
    let phase: 'running' | 'stopping' = 'running'
    let spawned = false

    const result = await runCli(['server', 'restart'], undefined, {
      homeDir,
      fetchImpl: async (url, init = {}) => {
        const target = String(url)
        if (target.endsWith('/status')) {
          events.push('status')
          if (phase === 'stopping' && !spawned) throw new Error('fetch failed')
          return Response.json({ relayPort, ipcPort })
        }
        if (target.endsWith('/shutdown')) {
          events.push('shutdown')
          expect(init.method).toBe('POST')
          expect(init.headers?.authorization).toBe('Bearer persisted-token')
          phase = 'stopping'
          return Response.json({ ok: true, result: { stopping: true } })
        }
        throw new Error(`unexpected URL: ${target}`)
      },
      spawnDetachedProcess: () => {
        events.push('spawn')
        spawned = true
        return { pid: 5321, unref() {} }
      },
    })

    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('restarted')

    const shutdownIndex = events.indexOf('shutdown')
    const spawnIndex = events.indexOf('spawn')
    expect(shutdownIndex).toBeGreaterThan(-1)
    expect(spawnIndex).toBeGreaterThan(shutdownIndex)

    // 没有显式端口时，state.json 里的 relay/ipc 就是新进程必须复用的那组。
    const spawnArgs = result.spawnCalls[0].args
    expect(spawnArgs[spawnArgs.indexOf('--relay-port') + 1]).toBe(String(relayPort))
    expect(spawnArgs[spawnArgs.indexOf('--ipc-port') + 1]).toBe(String(ipcPort))
    expect(spawnArgs.slice(-2)).toEqual(['server', '--serve'])
  })

  test('server restart does not auto-start when nothing is running', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-restart-idle-test-'))
    await writePersistedState(homeDir, { token: 'restart-token', relayPort: 49041, ipcPort: 49042 })

    const result = await runCli(['server', 'restart'], undefined, {
      homeDir,
      fetchImpl: async () => {
        throw new Error('fetch failed')
      },
      spawnDetachedProcess: () => {
        throw new Error('restart must not start a fresh relay')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.spawnCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain(
      'No running background server found to restart',
    )
  })

  test('server restart refuses to look successful while the old server still answers', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-restart-stale-test-'))
    await writePersistedState(homeDir, { token: 'restart-token', relayPort: 49051, ipcPort: 49052 })

    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()

    const result = await runCli(
      ['--relay-port', String(relayPort), '--ipc-port', String(ipcPort), 'server', 'restart'],
      undefined,
      {
        homeDir,
        // 关闭请求成功，但服务始终应答：模拟旧进程没退干净，不能对外宣称重启成功。
        fetchImpl: async (url) => {
          const target = String(url)
          if (target.endsWith('/shutdown')) {
            return Response.json({ ok: true, result: { stopping: true } })
          }
          if (target.endsWith('/status')) {
            return Response.json({ relayPort, ipcPort })
          }
          throw new Error(`unexpected URL: ${target}`)
        },
        spawnDetachedProcess: () => {
          throw new Error('restart must not spawn a second relay on the same ports')
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.spawnCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain('still running')
  })
})
