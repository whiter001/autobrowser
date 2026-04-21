import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRuntime } from '../src/core/runtime.js'

async function waitForStateFile<T>(
  stateFilePath: string,
  predicate: (state: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = JSON.parse(await readFile(stateFilePath, 'utf8')) as T
    if (predicate(state)) {
      return state
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
      }),
    )

    const snapshot = runtime.snapshot()
    expect(snapshot.snapshot.activeTabId).toBe(11)
    expect(snapshot.snapshot.targetTabId).toBe(22)

    const stateFilePath = path.join(homeDir, '.autobrowser', 'state.json')
    const persistedState = await waitForStateFile<{
      snapshot: { activeTabId: number | null; targetTabId: number | null }
    }>(stateFilePath, (state) => state.snapshot?.targetTabId === 22)

    expect(persistedState.snapshot.activeTabId).toBe(11)
    expect(persistedState.snapshot.targetTabId).toBe(22)
  })
})
