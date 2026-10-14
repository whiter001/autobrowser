import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRuntime } from '../src/core/runtime.js'
import { shouldTriggerAutoConnect } from '../src/cli/client.js'
import {
  MAX_RESPONSE_BYTES,
  responseByteLength,
  responseChunks,
} from '../src/core/response-transfer.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForStateFile<T>(
  stateFilePath: string,
  predicate: (state: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const state = JSON.parse(await readFile(stateFilePath, 'utf8')) as T
      if (predicate(state)) {
        return state
      }
    } catch {
      // The state file can briefly be mid-write; keep polling until it settles.
    }

    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error(`state file did not update: ${stateFilePath}`)
}

describe('runtime snapshot', () => {
  const tempDirs: string[] = []
  const runtimes: Array<Awaited<ReturnType<typeof createRuntime>>> = []

  async function createTestRuntime(options: Parameters<typeof createRuntime>[0]) {
    const runtime = await createRuntime(options)
    runtimes.push(runtime)
    return runtime
  }

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      runtime.detachExtension()
      await runtime.persist()
    }
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true })
      }),
    )
  })

  test('only assembles pending requests and releases budgets on every lifecycle exit', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)
    const runtime = await createTestRuntime({
      homeDir,
      requestTimeoutMs: 50,
      heartbeatTimeoutMs: 0,
    })
    const sent: Array<{ type: string; id: string }> = []
    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        sent.push(JSON.parse(payload))
        return 1
      },
      close() {},
    } as unknown as Bun.ServerWebSocket<{}>
    runtime.attachExtension(socket)
    const start = (id: string, totalBytes = MAX_RESPONSE_BYTES) =>
      runtime.handleExtensionMessage({ type: 'response.start', id, sequence: 0, totalBytes })
    const begin = async () => {
      const outcome = runtime.dispatchCommand('snapshot').catch((error: unknown) => error)
      await Promise.resolve()
      const id = sent.filter((message) => message.type === 'command').at(-1)!.id
      return { id, outcome }
    }
    for (let index = 0; index < 100; index += 1) start(`unknown-${index}`)
    for (const exit of ['ordinary', 'malformed', 'timeout', 'disconnect', 'replace']) {
      const first = await begin()
      start(first.id)
      const second = await begin()
      start(second.id, 1)
      expect(await second.outcome).toMatchObject({
        code: 'RESPONSE_TOO_LARGE',
        suggestedAction: expect.any(String),
      })
      if (exit === 'ordinary')
        runtime.handleExtensionMessage({
          type: 'response',
          id: first.id,
          ok: true,
          result: 'old extension',
        })
      if (exit === 'malformed')
        runtime.handleExtensionMessage({
          type: 'response.chunk',
          id: first.id,
          sequence: 5,
          byteLength: 1,
          data: 'x',
        })
      if (exit === 'disconnect') runtime.detachExtension()
      if (exit === 'replace') runtime.attachExtension({ ...socket } as Bun.ServerWebSocket<{}>)
      const outcome = await first.outcome
      if (exit === 'ordinary') expect(outcome).toBe('old extension')
      else
        expect(outcome).toMatchObject({
          code:
            exit === 'timeout'
              ? 'COMMAND_TIMEOUT'
              : exit === 'malformed'
                ? 'RESPONSE_TRANSFER_ERROR'
                : 'COMMAND_EXECUTION_UNKNOWN',
        })
      runtime.attachExtension(socket)
      start(first.id)
      runtime.handleExtensionMessage({
        type: 'response.chunk',
        id: first.id,
        sequence: 0,
        data: 'late',
        byteLength: 4,
      })
      const after = await begin()
      start(after.id)
      runtime.handleExtensionMessage({
        type: 'response',
        id: after.id,
        ok: true,
        result: 'released',
      })
      expect(await after.outcome).toBe('released')
    }
  })

  test('assembled responses reuse envelope validation and preserve actionable errors', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)
    const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 200 })
    let currentId = ''
    runtime.attachExtension({
      readyState: WebSocket.OPEN,
      send(payload: string) {
        const message = JSON.parse(payload)
        if (message.type === 'command') currentId = message.id
        return 1
      },
    } as unknown as Bun.ServerWebSocket<{}>)
    for (const invalid of [false, true]) {
      const outcome = runtime.dispatchCommand('snapshot').catch((error: unknown) => error)
      await Promise.resolve()
      const text = JSON.stringify({
        type: 'response',
        id: currentId,
        ok: invalid ? 'not a boolean' : false,
        error: {
          code: 'SYNTHETIC',
          message: 'failure',
          suggestedAction: 'Inspect snapshot before retrying.',
        },
      })
      const totalBytes = responseByteLength(text)
      runtime.handleExtensionMessage({
        type: 'response.start',
        id: currentId,
        sequence: 0,
        totalBytes,
      })
      const chunks = [...responseChunks(text)]
      chunks.forEach((data, sequence) =>
        runtime.handleExtensionMessage({
          type: 'response.chunk',
          id: currentId,
          sequence,
          data,
          byteLength: responseByteLength(data),
        }),
      )
      runtime.handleExtensionMessage({
        type: 'response.end',
        id: currentId,
        sequence: chunks.length,
        totalBytes,
      })
      expect(await outcome).toMatchObject(
        invalid
          ? { code: 'RESPONSE_TRANSFER_ERROR' }
          : { code: 'SYNTHETIC', suggestedAction: 'Inspect snapshot before retrying.' },
      )
    }
  })

  test('records the target tab id from extension state messages', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir })
    runtime.handleExtensionMessage(
      JSON.stringify({
        type: 'state',
        tabs: [
          {
            id: 11,
            title: 'active',
            url: 'https://example.com/active',
            active: true,
            pinned: false,
            status: 'complete',
            windowId: 1,
          },
          {
            id: 22,
            title: 'target',
            url: 'https://example.com/target',
            active: false,
            pinned: false,
            status: 'complete',
            windowId: 1,
          },
        ],
        activeTabId: 11,
        targetTabId: 22,
        pageEpochs: {
          11: 4,
          22: 2,
        },
      }),
    )

    const snapshot = runtime.snapshot()
    expect(snapshot.snapshot.activeTabId).toBe(11)
    expect(snapshot.snapshot.targetTabId).toBe(22)
    expect(snapshot.snapshot.pageEpochs).toEqual({
      11: 4,
      22: 2,
    })

    const stateFilePath = path.join(homeDir, '.autobrowser', 'state.json')
    const persistedState = await waitForStateFile<{
      snapshot: {
        activeTabId: number | null
        targetTabId: number | null
        pageEpochs: Record<number, number>
      }
    }>(stateFilePath, (state) => state.snapshot?.targetTabId === 22)

    expect(persistedState.snapshot.activeTabId).toBe(11)
    expect(persistedState.snapshot.targetTabId).toBe(22)
    expect(persistedState.snapshot.pageEpochs).toEqual({
      11: 4,
      22: 2,
    })
  })

  test('waits for the extension to reconnect before dispatching commands', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 200 })
    const sentMessages: Array<Record<string, unknown>> = []

    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        const message = JSON.parse(payload) as { id?: string }
        sentMessages.push(message)

        if (typeof message.id === 'string') {
          setTimeout(() => {
            runtime.handleExtensionMessage(
              JSON.stringify({
                type: 'response',
                id: message.id,
                ok: true,
                result: { dispatched: true },
              }),
            )
          }, 0)
        }
      },
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    const commandPromise = runtime.dispatchCommand('goto', { url: 'https://example.com' })

    await delay(25)
    expect(sentMessages).toHaveLength(0)

    runtime.attachExtension(socket, {
      extensionId: 'bfccnpkjkbhceghimfjgnkigilidldep',
      userAgent: 'autobrowser-test',
    })

    const result = await commandPromise

    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toMatchObject({
      type: 'command',
      command: 'goto',
      args: {
        url: 'https://example.com',
      },
    })
    expect(result).toEqual({ dispatched: true })
  })

  test('rejects invalid command arguments before waiting for an extension', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 200 })

    await expect(runtime.dispatchCommand('goto', { url: 123 as never })).rejects.toMatchObject({
      code: 'INVALID_COMMAND_ARGS',
    })
  })

  test('records heartbeat acknowledgements from the extension', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir })
    const sentMessages: string[] = []

    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        sentMessages.push(payload)
      },
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(socket, {
      extensionId: 'bfccnpkjkbhceghimfjgnkigilidldep',
      userAgent: 'autobrowser-test',
    })

    runtime.handleExtensionMessage(
      JSON.stringify({
        type: 'heartbeat',
        sentAt: '2026-05-09T12:00:00.000Z',
      }),
    )

    expect(sentMessages).toHaveLength(1)

    const heartbeatAck = JSON.parse(sentMessages[0]) as {
      type?: string
      sentAt?: string | null
      receivedAt?: string
    }

    expect(heartbeatAck.type).toBe('heartbeat')
    expect(heartbeatAck.sentAt).toBe('2026-05-09T12:00:00.000Z')
    expect(typeof heartbeatAck.receivedAt).toBe('string')
    expect(runtime.snapshot().snapshot.extension?.lastHeartbeatAt).not.toBeNull()
  })

  test('redacts sensitive last command arguments before persisting state', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir })

    runtime.setLastCommand('fill', { selector: '#password', value: 'secret-password' })
    expect(runtime.snapshot().snapshot.lastCommand?.args).toEqual({
      selector: '#password',
      value: '[redacted]',
    })

    runtime.setLastCommand('set', {
      type: 'headers',
      headers: [{ name: 'authorization', value: 'Bearer secret' }],
    })
    expect(runtime.snapshot().snapshot.lastCommand?.args).toEqual({
      type: 'headers',
      headers: '[redacted]',
    })

    runtime.setLastCommand('eval', { script: 'document.cookie' })
    expect(runtime.snapshot().snapshot.lastCommand?.args).toEqual({
      script: '[redacted]',
    })

    const stateFilePath = path.join(homeDir, '.autobrowser', 'state.json')
    const persistedState = await waitForStateFile<{
      snapshot: { lastCommand: { args: Record<string, unknown> } | null }
    }>(stateFilePath, (state) => state.snapshot?.lastCommand?.args?.script === '[redacted]')

    expect(persistedState.snapshot.lastCommand?.args).toEqual({
      script: '[redacted]',
    })
  })

  test('redacts nested batches and fillform fields without changing their inputs', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)
    const runtime = await createTestRuntime({ homeDir })
    const args = {
      steps: [
        { id: 'password', command: 'fill', args: { selector: '#password', value: 'fill-secret' } },
        {
          id: 'nested',
          command: 'batch',
          args: {
            steps: [
              { command: 'eval', args: { script: 'eval-secret' } },
              {
                command: 'fillform',
                args: { fields: [{ selector: '#email', value: 'form-secret' }] },
              },
              { command: 'click', args: { selector: '#submit' } },
            ],
          },
        },
      ],
    }
    const original = structuredClone(args)
    const expected = {
      steps: [
        { id: 'password', command: 'fill', args: { selector: '#password', value: '[redacted]' } },
        {
          id: 'nested',
          command: 'batch',
          args: {
            steps: [
              { command: 'eval', args: { script: '[redacted]' } },
              {
                command: 'fillform',
                args: { fields: [{ selector: '#email', value: '[redacted]' }] },
              },
              { command: 'click', args: { selector: '#submit' } },
            ],
          },
        },
      ],
    }
    runtime.setLastCommand('batch', args)
    expect(args).toEqual(original)
    expect(runtime.snapshot().snapshot.lastCommand?.args).toEqual(expected)
    await runtime.persist()
    const statePath = path.join(homeDir, '.autobrowser', 'state.json')
    const persisted = JSON.parse(await readFile(statePath, 'utf8'))
    expect(persisted.snapshot.lastCommand.args).toEqual(expected)

    persisted.snapshot.lastCommand.args = original
    await writeFile(statePath, JSON.stringify(persisted))
    const restored = await createTestRuntime({ homeDir })
    expect(restored.snapshot().snapshot.lastCommand?.args).toEqual(expected)
    expect(JSON.parse(await readFile(statePath, 'utf8')).snapshot.lastCommand.args).toEqual(
      expected,
    )

    runtime.setLastCommand('fillform', { fields: [{ selector: '#name', value: 'direct-secret' }] })
    expect(runtime.snapshot().snapshot.lastCommand?.args).toEqual({
      fields: [{ selector: '#name', value: '[redacted]' }],
    })
    await runtime.persist()
  })

  test('falls back when persisted state JSON is corrupted', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const stateDir = path.join(homeDir, '.autobrowser')
    await writeFile(path.join(stateDir, 'state.json'), '{bad json', 'utf8').catch(async () => {
      await Bun.write(path.join(stateDir, 'state.json'), '{bad json')
    })

    const runtime = await createTestRuntime({ homeDir })

    expect(runtime.snapshot().snapshot).toMatchObject({
      tabs: [],
      activeTabId: null,
      targetTabId: null,
      pageEpochs: {},
      lastCommand: null,
      lastError: null,
    })
  })

  test('cleans up stale crash-left temp files on startup', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const stateDir = path.join(homeDir, '.autobrowser')
    await mkdir(stateDir, { recursive: true })
    const staleTemp = path.join(stateDir, 'state.json.1234.deadbeef.tmp')
    await writeFile(staleTemp, '{')
    const hourAgo = new Date(Date.now() - 3_600_000)
    await utimes(staleTemp, hourAgo, hourAgo)

    await createTestRuntime({ homeDir })

    await expect(access(staleTemp)).rejects.toThrow()
  })

  test('closes the previous socket on re-attach and ignores its late close event', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir })

    let oldSocketClosed = false
    const oldSocket = {
      readyState: WebSocket.OPEN,
      send: () => 1,
      close: () => {
        oldSocketClosed = true
      },
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    const newSocket = {
      readyState: WebSocket.OPEN,
      send: () => 1,
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(oldSocket)
    runtime.attachExtension(newSocket)

    expect(oldSocketClosed).toBe(true)

    // 旧 socket 的 close 事件晚于新连接 attach 到达，不应踢掉新连接
    runtime.detachExtension(oldSocket)
    expect(runtime.runtime.extensionSocket).toBe(newSocket)
    expect(runtime.snapshot().extensionConnected).toBe(true)

    runtime.detachExtension(newSocket)
    expect(runtime.runtime.extensionSocket).toBeNull()
    expect(runtime.snapshot().extensionConnected).toBe(false)
  })

  test('notifies the displaced socket before closing it on re-attach', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir })

    const sentPayloads: string[] = []
    const oldSocket = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => {
        sentPayloads.push(payload)
        return 1
      },
      close: () => {},
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    const newSocket = {
      readyState: WebSocket.OPEN,
      send: () => 1,
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(oldSocket)
    runtime.attachExtension(newSocket)

    expect(sentPayloads).toHaveLength(1)
    const displaced = JSON.parse(sentPayloads[0]) as {
      type?: string
      reason?: string
    }
    expect(displaced.type).toBe('displaced')
    expect(typeof displaced.reason).toBe('string')
    expect(displaced.reason?.length).toBeGreaterThan(0)
  })

  test('rejects pending connection waiters when the extension detaches', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 5_000 })

    const commandPromise = runtime.dispatchCommand('goto', { url: 'https://example.com' })

    runtime.detachExtension()

    // 注意：bun 的 expect(p).rejects 必须在 promise settle 之后调用，
    // 提前调用会拿到 connection 超时错误而非 detach 错误
    await expect(commandPromise).rejects.toMatchObject({
      code: 'EXTENSION_DISCONNECTED',
      message: 'extension disconnected while waiting for connection',
    })
  })

  test('fails fast when the socket is closed between connect check and send', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 5_000 })

    // 模拟已半关闭的 socket：readyState 仍为 OPEN，但 send 返回 0（Bun 不抛异常）
    const socket = {
      readyState: WebSocket.OPEN,
      send: () => 0,
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(socket)

    await expect(
      runtime.dispatchCommand('goto', { url: 'https://example.com' }),
    ).rejects.toMatchObject({
      code: 'EXTENSION_DISCONNECTED',
      message: 'extension disconnected while sending command: goto',
    })
  })

  test('disconnect and replacement report unknown outcomes that CLI will not replay', async () => {
    for (const replace of [false, true]) {
      const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
      tempDirs.push(homeDir)
      const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 100 })
      let sent!: () => void
      const delivered = new Promise<void>((resolve) => {
        sent = resolve
      })
      const socket = {
        readyState: WebSocket.OPEN,
        send: () => {
          sent()
          return -1
        },
        close: () => {},
      } as unknown as Bun.ServerWebSocket<{}>
      runtime.attachExtension(socket)
      const outcome = runtime
        .dispatchCommand('click', { selector: '#submit' })
        .catch((error) => error)
      await delivered
      if (replace)
        runtime.attachExtension({
          readyState: WebSocket.OPEN,
          send: () => 1,
        } as unknown as Bun.ServerWebSocket<{}>)
      else runtime.detachExtension(socket)
      const error = (await outcome) as Error & { code?: string }
      expect(error).toMatchObject({
        code: 'COMMAND_EXECUTION_UNKNOWN',
        details: { commandId: expect.any(String) },
      })
      expect(shouldTriggerAutoConnect({ ok: false, error })).toBe(false)
    }
    expect(
      shouldTriggerAutoConnect({
        ok: false,
        error: { code: 'EXTENSION_DISCONNECTED', message: 'not sent' },
      }),
    ).toBe(true)
  })

  test('keeps backpressured sends pending and delivers the eventual response', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)
    const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 100 })
    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        const message = JSON.parse(payload)
        setTimeout(
          () =>
            runtime.handleExtensionMessage({
              type: 'response',
              id: message.id,
              ok: true,
              result: 'delivered',
            }),
          10,
        )
        return -1
      },
    } as unknown as Bun.ServerWebSocket<{}>
    runtime.attachExtension(socket)
    await expect(runtime.dispatchCommand('snapshot')).resolves.toBe('delivered')
  })

  test('propagates explicit and composite budgets as deadlines without long waits', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)
    const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 100 })
    const budgets: number[] = []
    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string) {
        const message = JSON.parse(payload)
        budgets.push(Date.parse(message.deadlineAt) - Date.parse(message.requestedAt))
        queueMicrotask(() =>
          runtime.handleExtensionMessage({
            type: 'response',
            id: message.id,
            ok: true,
            result: true,
          }),
        )
        return 1
      },
    } as unknown as Bun.ServerWebSocket<{}>
    runtime.attachExtension(socket)
    await runtime.dispatchCommand('eval', { script: '1', timeoutMs: 35_000 })
    await runtime.dispatchCommand('wait', { type: 'time', ms: 40_000 })
    await runtime.dispatchCommand('batch', {
      retries: 1,
      retryDelayMs: 10,
      steps: [{ command: 'eval', args: { script: '1', timeoutMs: 35_000 } }],
    })
    expect(budgets).toEqual([40_000, 45_000, 80_010])
    await expect(
      runtime.dispatchCommand('eval', { script: '1', timeoutMs: 1_800_000 }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
    expect(budgets).toHaveLength(3)
  })

  test('reports the timeout budget and troubleshooting hints on command timeout', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir, requestTimeoutMs: 150 })

    const sent: string[] = []
    const socket = {
      readyState: WebSocket.OPEN,
      send: (message: string) => {
        sent.push(message)
        return 1
      },
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(socket)

    await expect(runtime.dispatchCommand('goto', { url: 'https://example.com' })).rejects.toThrow(
      /command timed out after 150ms: goto/,
    )
    const messages = sent.map((message) => JSON.parse(message))
    const command = messages.find((message) => message.type === 'command')
    expect(command.deadlineAt).toBeString()
    expect(messages).toContainEqual({ type: 'cancel', id: command.id, reason: 'relay timeout' })
  })

  test('detaches the extension when heartbeats stop arriving', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir, heartbeatTimeoutMs: 50 })

    const socket = {
      readyState: WebSocket.OPEN,
      send: () => 1,
      close: () => {
        ;(socket as { readyState: number }).readyState = WebSocket.CLOSED
      },
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(socket)
    expect(runtime.snapshot().extensionConnected).toBe(true)

    await delay(120)

    expect(runtime.runtime.extensionSocket).toBeNull()
    expect(runtime.snapshot().extensionConnected).toBe(false)
  })

  test('keeps the extension attached while heartbeats keep arriving', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({ homeDir, heartbeatTimeoutMs: 60 })

    const socket = {
      readyState: WebSocket.OPEN,
      send: () => 1,
      close: () => {
        ;(socket as { readyState: number }).readyState = WebSocket.CLOSED
      },
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(socket)

    for (let i = 0; i < 5; i += 1) {
      await delay(25)
      runtime.handleExtensionMessage(
        JSON.stringify({
          type: 'heartbeat',
          sentAt: new Date().toISOString(),
        }),
      )
    }

    expect(runtime.snapshot().extensionConnected).toBe(true)

    // 心跳停止后超时触发，连接被断开
    await delay(120)
    expect(runtime.snapshot().extensionConnected).toBe(false)
  })

  test('rejects pending commands when the extension heartbeat times out', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createTestRuntime({
      homeDir,
      requestTimeoutMs: 5_000,
      heartbeatTimeoutMs: 60,
    })

    const socket = {
      readyState: WebSocket.OPEN,
      send: () => 1,
      close: () => {
        ;(socket as { readyState: number }).readyState = WebSocket.CLOSED
      },
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(socket)

    const commandPromise = runtime.dispatchCommand('goto', { url: 'https://example.com' })

    // 已发送命令的副作用未知，不得触发 CLI 的断线重放。
    await expect(commandPromise).rejects.toMatchObject({
      code: 'COMMAND_EXECUTION_UNKNOWN',
      details: { commandId: expect.any(String) },
      suggestedAction: expect.stringContaining('Do not blindly replay'),
    })
  })
})
