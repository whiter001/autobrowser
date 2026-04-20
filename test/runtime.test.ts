import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRuntime } from '../src/core/runtime.js'

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
  })
})
