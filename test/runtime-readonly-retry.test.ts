import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRuntime } from '../src/core/runtime.js'

function openSocket(send: (message: Record<string, unknown>) => void) {
  return {
    readyState: WebSocket.OPEN,
    send(payload: string) {
      send(JSON.parse(payload) as Record<string, unknown>)
      return 1
    },
    close() {},
  } as unknown as Bun.ServerWebSocket<{}>
}

describe('runtime read-only reconnect retry', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createRuntime>>> = []
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      runtime.detachExtension()
      await runtime.persist()
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function createTestRuntime() {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-retry-test-'))
    tempDirs.push(homeDir)
    const runtime = await createRuntime({
      homeDir,
      requestTimeoutMs: 500,
      heartbeatTimeoutMs: 0,
    })
    runtimes.push(runtime)
    return runtime
  }

  test('retries snapshot once on a new connection and records disconnect diagnostics', async () => {
    const runtime = await createTestRuntime()
    const firstCommands: Array<Record<string, unknown>> = []
    const first = openSocket((message) => {
      if (message.type === 'command') firstCommands.push(message)
    })
    runtime.attachExtension(first, { extensionId: 'extension-one' })

    const outcome = runtime.dispatchCommand('snapshot')
    await Promise.resolve()
    runtime.detachExtension(first, {
      reason: 'socket-closed',
      closeCode: 1006,
      closeReason: 'abnormal closure',
    })

    const secondCommands: Array<Record<string, unknown>> = []
    const second = openSocket((message) => {
      if (message.type !== 'command') return
      secondCommands.push(message)
      queueMicrotask(() => {
        runtime.handleExtensionMessage({
          type: 'response',
          id: message.id,
          ok: true,
          result: { elements: [] },
        })
      })
    })
    runtime.attachExtension(second, { extensionId: 'extension-two' })

    await expect(outcome).resolves.toEqual({ elements: [] })
    expect(firstCommands).toHaveLength(1)
    expect(secondCommands).toHaveLength(1)
    expect(secondCommands[0]?.id).not.toBe(firstCommands[0]?.id)
    expect(runtime.snapshot().snapshot).toMatchObject({
      connectionGeneration: 2,
      extension: { connectionGeneration: 2 },
      lastDisconnect: {
        reason: 'socket-closed',
        closeCode: 1006,
        closeReason: 'abnormal closure',
        connectionGeneration: 1,
      },
    })
  })

  test('does not replay a click after its execution result becomes unknown', async () => {
    const runtime = await createTestRuntime()
    const first = openSocket(() => {})
    runtime.attachExtension(first)

    const outcome = runtime.dispatchCommand('click', { selector: '#submit' })
    await Promise.resolve()
    runtime.detachExtension(first)
    await expect(outcome).rejects.toMatchObject({
      code: 'COMMAND_EXECUTION_UNKNOWN',
      details: {
        commandId: expect.any(String),
        lastDisconnect: { reason: 'disconnected', connectionGeneration: 1 },
      },
    })

    const retryCommands: Array<Record<string, unknown>> = []
    runtime.attachExtension(openSocket((message) => retryCommands.push(message)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(retryCommands.filter((message) => message.type === 'command')).toHaveLength(0)
  })

  test('does not retry a read on an extension instance that replaced the sender', async () => {
    const runtime = await createTestRuntime()
    const first = openSocket(() => {})
    runtime.attachExtension(first, { extensionId: 'extension-one' })

    const outcome = runtime.dispatchCommand('snapshot')
    await Promise.resolve()
    const replacementCommands: Array<Record<string, unknown>> = []
    runtime.attachExtension(
      openSocket((message) => replacementCommands.push(message)),
      {
        extensionId: 'extension-two',
      },
    )

    await expect(outcome).rejects.toMatchObject({
      code: 'COMMAND_EXECUTION_UNKNOWN',
      details: { lastDisconnect: { reason: 'replaced' } },
    })
    expect(replacementCommands.filter((message) => message.type === 'command')).toHaveLength(0)
  })
})
