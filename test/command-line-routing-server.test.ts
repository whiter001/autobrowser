import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

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
})
