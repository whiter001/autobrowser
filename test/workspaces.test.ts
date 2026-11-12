import { describe, expect, test } from 'bun:test'
import { createExtensionState } from '../extension/background/state.js'
import { createWorkspaceManager } from '../extension/background/workspaces.js'
import type { TabInput } from '../extension/background/types.js'
import { createMinimalRouter } from './command-router.test.js'

function tabIdFromInput(input: unknown): number {
  if (typeof input === 'number') return input
  const match = /^t(\d+)$/.exec(String(input || ''))
  return match ? Number(match[1]) : 1
}

function routerWithTabs() {
  return createMinimalRouter({
    getTargetTab: async (input) => ({ id: tabIdFromInput(input) }),
    listTabs: async () => [
      { id: 1, handle: 't1', title: 'A', url: 'https://a.example', active: false },
      { id: 2, handle: 't2', title: 'B', url: 'https://b.example', active: false },
    ],
  })
}

describe('workspace target isolation', () => {
  test('requires an explicit attach when no tab can be auto-attached', async () => {
    const { router, snapshotCalls } = createMinimalRouter({
      getTargetTab: async (input) => ({ id: tabIdFromInput(input) }),
      listTabs: async () => [],
    })

    await expect(
      router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a' } }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_TARGET_REQUIRED' })
    expect(snapshotCalls).toHaveLength(0)
  })

  test('two callers reuse different existing tabs without repeating --tab', async () => {
    const { router, snapshotCalls, clickCalls, navigateCalls } = routerWithTabs()
    await router.handleCommand({
      command: 'tab.attach',
      args: { workspace: 'ai-a', handle: 't1' },
    })
    await router.handleCommand({
      command: 'tab.attach',
      args: { workspace: 'ai-b', handle: 't2' },
    })

    const [a, b] = await Promise.all([
      router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a' } }),
      router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-b' } }),
    ])

    expect(snapshotCalls.map((call) => call.tabId)).toEqual([1, 2])
    expect(a).toMatchObject({ meta: { tabId: 1, workspace: 'ai-a' } })
    expect(b).toMatchObject({ meta: { tabId: 2, workspace: 'ai-b' } })

    await Promise.all([
      router.handleCommand({ command: 'click', args: { workspace: 'ai-a', selector: '#a' } }),
      router.handleCommand({ command: 'click', args: { workspace: 'ai-b', selector: '#b' } }),
    ])
    await Promise.all([
      router.handleCommand({
        command: 'goto',
        args: { workspace: 'ai-a', url: 'https://a.example/next' },
      }),
      router.handleCommand({
        command: 'goto',
        args: { workspace: 'ai-b', url: 'https://b.example/next' },
      }),
    ])
    expect(clickCalls.map((call) => call.tabId)).toEqual([1, 2])
    expect(navigateCalls.map((call) => call.tabId)).toEqual([1, 2])
  })

  test('open without a target creates and attaches a new workspace tab', async () => {
    const { router, navigateCalls } = createMinimalRouter({
      getTargetTab: async (input) => ({ id: tabIdFromInput(input) }),
      createTab: async (url) => ({ id: 9, url }),
    })

    const result = await router.handleCommand({
      command: 'open',
      args: { workspace: 'ai-a', url: 'https://new.example' },
    })

    expect(result).toMatchObject({ navigated: true, url: 'https://new.example' })
    expect(navigateCalls).toEqual([{ tabId: 9, url: 'https://new.example' }])
    await router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a' } })
  })

  test('atomic attachment prevents another workspace from taking the same tab', async () => {
    const { router } = routerWithTabs()
    const results = await Promise.allSettled([
      router.handleCommand({ command: 'tab.attach', args: { workspace: 'ai-a', handle: 't1' } }),
      router.handleCommand({ command: 'tab.attach', args: { workspace: 'ai-b', handle: 't1' } }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({
      code: 'TAB_BUSY',
      details: { tabHandle: 't1', attachment: 'owned' },
    })
  })

  test('readonly attachments allow snapshots but reject writes and eval', async () => {
    const { router, snapshotCalls, clickCalls, evalCalls } = routerWithTabs()
    await router.handleCommand({
      command: 'tab.attach',
      args: { workspace: 'ai-a', handle: 't1', readonly: true },
    })

    await router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a' } })
    await expect(
      router.handleCommand({ command: 'click', args: { workspace: 'ai-a', selector: '#save' } }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_READONLY' })
    await expect(
      router.handleCommand({ command: 'eval', args: { workspace: 'ai-a', script: '1' } }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_READONLY' })
    expect(snapshotCalls).toHaveLength(1)
    expect(clickCalls).toHaveLength(0)
    expect(evalCalls).toHaveLength(0)
  })

  test('batch steps inherit the workspace and cannot bypass ownership with an explicit tab', async () => {
    const { router, snapshotCalls } = routerWithTabs()
    await router.handleCommand({
      command: 'tab.attach',
      args: { workspace: 'ai-a', handle: 't1' },
    })

    const result = await router.handleCommand({
      command: 'batch',
      args: {
        workspace: 'ai-a',
        steps: [
          { command: 'snapshot', args: {} },
          { command: 'snapshot', args: {} },
        ],
      },
    })
    expect(result).toMatchObject({ summary: { succeeded: 2 } })
    expect(snapshotCalls.map((call) => call.tabId)).toEqual([1, 1])

    await expect(
      router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-b', tabId: 1 } }),
    ).rejects.toMatchObject({ code: 'TAB_BUSY' })
  })

  test('batch steps cannot override the outer workspace', async () => {
    const { router, snapshotCalls } = routerWithTabs()
    await router.handleCommand({
      command: 'tab.attach',
      args: { workspace: 'ai-a', handle: 't1' },
    })

    const result = await router.handleCommand({
      command: 'batch',
      args: {
        workspace: 'ai-a',
        steps: [{ command: 'snapshot', args: { workspace: 'ai-b' } }],
      },
    })

    expect(result).toMatchObject({ summary: { succeeded: 1 } })
    expect(snapshotCalls).toHaveLength(1)
    expect(snapshotCalls[0].tabId).toBe(1)
  })

  test('tab list exposes ownership and attachability', async () => {
    const { router } = routerWithTabs()
    await router.handleCommand({
      command: 'tab.attach',
      args: { workspace: 'ai-a', handle: 't1', readonly: true },
    })

    const result = await router.handleCommand({ command: 'tab.list', args: {} })
    expect(result).toMatchObject({
      tabs: [
        { handle: 't1', workspace: 'ai-a', attachment: 'readonly', attachable: false },
        { handle: 't2', workspace: null, attachment: null, attachable: true },
      ],
    })
  })
})

describe('workspace lease lifecycle', () => {
  test('expiry releases ownership without closing or reloading the page', async () => {
    let timestamp = 1_000
    const state = createExtensionState(1)
    const targetCalls: TabInput[] = []
    const manager = createWorkspaceManager({
      state,
      getTargetTab: async (input) => {
        targetCalls.push(input)
        return { id: tabIdFromInput(input) } as never
      },
      now: () => timestamp,
      leaseMs: 100,
      listTabs: async () => [],
    })
    await manager.attach('ai-a', 1)

    timestamp += 101
    await expect(manager.resolveCommandTab('ai-a', 'snapshot', {})).rejects.toMatchObject({
      code: 'WORKSPACE_TARGET_REQUIRED',
    })
    const attached = await manager.attach('ai-b', 1)
    expect(attached).toMatchObject({ workspace: 'ai-b', attached: true })
    expect(targetCalls).toEqual([1, 1])
  })

  test('release detaches pages and forgets only the released workspace', async () => {
    const state = createExtensionState(1)
    const manager = createWorkspaceManager({
      state,
      getTargetTab: async (input) => ({ id: tabIdFromInput(input) }) as never,
    })
    await manager.attach('ai-a', 1)
    await manager.attach('ai-b', 2)

    await expect(manager.release('ai-a')).resolves.toMatchObject({
      released: true,
      workspace: 'ai-a',
      detachedTabs: [1],
    })
    expect(state.workspaces.workspaces.has('ai-a')).toBe(false)
    expect(state.workspaces.attachments.has(1)).toBe(false)
    expect(state.workspaces.attachments.get(2)?.workspaceId).toBe('ai-b')
  })

  test('restores workspace targets and attachments from extension storage', async () => {
    const storage = new Map<string, unknown>()
    const dependencies = {
      storageGet: async (keys: string | string[] | null) => {
        const selected = Array.isArray(keys) ? keys : [keys]
        return Object.fromEntries(
          selected
            .filter((key): key is string => typeof key === 'string' && storage.has(key))
            .map((key) => [key, storage.get(key)]),
        )
      },
      storageSet: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) storage.set(key, value)
      },
    }
    const getTargetTab = async (input: TabInput) => ({ id: tabIdFromInput(input) }) as never
    const first = createWorkspaceManager({
      state: createExtensionState(1),
      getTargetTab,
      ...dependencies,
    })
    await first.attach('ai-a', 1, 'readonly')

    const restored = createWorkspaceManager({
      state: createExtensionState(1),
      getTargetTab,
      ...dependencies,
    })
    await expect(restored.resolveCommandTab('ai-a', 'snapshot', {})).resolves.toBe(1)
    await expect(
      restored.resolveCommandTab('ai-a', 'click', { selector: '#save' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_READONLY' })

    const afterBrowserRestart = createWorkspaceManager({
      state: createExtensionState(1),
      getTargetTab: async () => {
        throw Object.assign(new Error('tab no longer exists'), { code: 'STALE_TAB_HANDLE' })
      },
      ...dependencies,
    })
    await expect(
      afterBrowserRestart.resolveCommandTab('ai-a', 'snapshot', {}),
    ).rejects.toMatchObject({ code: 'STALE_TAB_HANDLE' })
    await expect(afterBrowserRestart.current('ai-a')).resolves.toMatchObject({
      workspace: { targetTabId: null },
      tabs: [],
    })
  })
})
