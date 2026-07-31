import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRuntime } from '../src/core/runtime.js'

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

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true })
      }),
    )
  })

  test('records the target tab id from extension state messages', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createRuntime({ homeDir })
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

    const runtime = await createRuntime({ homeDir, requestTimeoutMs: 200 })
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

    const runtime = await createRuntime({ homeDir, requestTimeoutMs: 200 })

    await expect(runtime.dispatchCommand('goto', { url: 123 as never })).rejects.toMatchObject({
      code: 'INVALID_COMMAND_ARGS',
    })
  })

  test('records heartbeat acknowledgements from the extension', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createRuntime({ homeDir })
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

    const runtime = await createRuntime({ homeDir })

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

  test('falls back when persisted state JSON is corrupted', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const stateDir = path.join(homeDir, '.autobrowser')
    await writeFile(path.join(stateDir, 'state.json'), '{bad json', 'utf8').catch(async () => {
      await Bun.write(path.join(stateDir, 'state.json'), '{bad json')
    })

    const runtime = await createRuntime({ homeDir })

    expect(runtime.snapshot().snapshot).toMatchObject({
      tabs: [],
      activeTabId: null,
      targetTabId: null,
      pageEpochs: {},
      lastCommand: null,
      lastError: null,
    })
  })

  test('closes the previous socket on re-attach and ignores its late close event', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createRuntime({ homeDir })

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

  test('rejects pending connection waiters when the extension detaches', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createRuntime({ homeDir, requestTimeoutMs: 5_000 })

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

    const runtime = await createRuntime({ homeDir, requestTimeoutMs: 5_000 })

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

  test('reports the timeout budget and troubleshooting hints on command timeout', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-runtime-test-'))
    tempDirs.push(homeDir)

    const runtime = await createRuntime({ homeDir, requestTimeoutMs: 150 })

    const socket = {
      readyState: WebSocket.OPEN,
      send: () => 1,
    } as unknown as Bun.ServerWebSocket<{ extensionId?: string | null; userAgent?: string | null }>

    runtime.attachExtension(socket)

    await expect(runtime.dispatchCommand('goto', { url: 'https://example.com' })).rejects.toThrow(
      /command timed out after 150ms: goto/,
    )
  })
})
