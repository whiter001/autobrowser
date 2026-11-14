import { describe, expect, test } from 'bun:test'
import { createExtensionState } from '../extension/background/state.js'
import type { WorkspaceGroupApi } from '../extension/background/workspace-groups.js'
import { createWorkspaceManager } from '../extension/background/workspaces.js'
import type { TabInput } from '../extension/background/types.js'

function tabIdFromInput(input: unknown): number {
  if (typeof input === 'number') return input
  const match = /^t(\d+)$/.exec(String(input || ''))
  return match ? Number(match[1]) : 1
}

/** 内存版标签组 API，行为对齐 Chromium：组不存在时 group/update 抛错 */
function createFakeGroupApi() {
  let nextGroupId = 100
  let groupFailure: Error | null = null
  let regroupFailure: Error | null = null
  const groups = new Map<number, Set<number>>()
  const tabGroups = new Map<number, number>()
  const closedTabs = new Set<number>()
  const calls = {
    group: [] as Array<{ tabIds: number[]; groupId?: number }>,
    ungroup: [] as number[][],
    get: [] as number[],
    update: [] as Array<{ groupId: number; title?: string; color?: string }>,
  }

  const api: WorkspaceGroupApi = {
    async groupTabs(tabIds, groupId) {
      calls.group.push({ tabIds: [...tabIds], ...(groupId === undefined ? {} : { groupId }) })
      if (groupId === undefined) {
        if (groupFailure) throw groupFailure
      } else if (regroupFailure) {
        // 模拟恢复原组时的暂时性故障（不是“组不存在”）
        throw regroupFailure
      }
      let target = groupId
      if (target === undefined) {
        target = nextGroupId++
        groups.set(target, new Set())
      } else if (!groups.has(target)) {
        throw new Error(`No group with id: ${target}`)
      }
      const members = groups.get(target)!
      for (const tabId of tabIds) {
        members.add(tabId)
        tabGroups.set(tabId, target)
      }
      return target
    },
    async ungroupTabs(tabIds) {
      calls.ungroup.push([...tabIds])
      for (const tabId of tabIds) {
        const groupId = tabGroups.get(tabId)
        if (groupId !== undefined) groups.get(groupId)?.delete(tabId)
        tabGroups.set(tabId, -1)
      }
    },
    async getGroup(groupId) {
      calls.get.push(groupId)
      return groups.has(groupId) ? { id: groupId } : undefined
    },
    async updateGroup(groupId, update) {
      calls.update.push({ groupId, ...update })
      if (!groups.has(groupId)) throw new Error(`No group with id: ${groupId}`)
    },
    async tabGroupId(tabId) {
      if (closedTabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`)
      return tabGroups.get(tabId) ?? -1
    },
  }

  return {
    api,
    calls,
    seedGroup(tabIds: number[], groupId: number) {
      groups.set(groupId, new Set(tabIds))
      for (const tabId of tabIds) tabGroups.set(tabId, groupId)
    },
    moveTab(tabId: number, groupId: number) {
      if (!groups.has(groupId)) groups.set(groupId, new Set())
      groups.get(groupId)!.add(tabId)
      tabGroups.set(tabId, groupId)
    },
    dropGroup(groupId: number) {
      groups.delete(groupId)
    },
    closeTab(tabId: number) {
      closedTabs.add(tabId)
      const groupId = tabGroups.get(tabId)
      if (groupId !== undefined) groups.get(groupId)?.delete(tabId)
      tabGroups.delete(tabId)
    },
    failGrouping(error: Error | null) {
      groupFailure = error
    },
    failRegroup(error: Error | null) {
      regroupFailure = error
    },
    groupOf(tabId: number) {
      return tabGroups.get(tabId) ?? -1
    },
  }
}

/** 复刻扩展 storage.local 的读写语义 */
function createStorage() {
  const data = new Map<string, unknown>()
  return {
    data,
    storageGet: async (keys: string | string[] | null) => {
      const selected = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(
        selected
          .filter((key): key is string => typeof key === 'string' && data.has(key))
          .map((key) => [key, data.get(key)]),
      )
    },
    storageSet: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value)
    },
  }
}

function createManager(
  groupApi: WorkspaceGroupApi | null,
  options: {
    state?: ReturnType<typeof createExtensionState>
    storage?: ReturnType<typeof createStorage>
    now?: () => number
    leaseMs?: number
  } = {},
) {
  return createWorkspaceManager({
    state: options.state ?? createExtensionState(1),
    getTargetTab: async (input: TabInput) => ({ id: tabIdFromInput(input) }) as never,
    listTabs: async () => [],
    groupApi,
    ...(options.now ? { now: options.now } : {}),
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    ...options.storage,
  })
}

function groupOf(
  status: Record<string, unknown>,
  workspaceId: string,
): { groupId: number; tabIds: number[]; title: string; color: string } | undefined {
  return (status.groups as Array<Record<string, unknown>>).find(
    (group) => group.workspaceId === workspaceId,
  ) as never
}

describe('workspace tab groups display layer', () => {
  test('stays disabled by default and never touches the tabGroups API', async () => {
    const fake = createFakeGroupApi()
    const manager = createManager(fake.api)

    await manager.attach('ai-a', 1)
    await manager.attach('ai-a', 2)

    expect(fake.calls.group).toHaveLength(0)
    expect(await manager.groups()).toMatchObject({ enabled: false, available: true, groups: [] })
  })

  test('groups existing and new attachments per workspace and reuses the same group', async () => {
    const fake = createFakeGroupApi()
    const manager = createManager(fake.api)
    await manager.attach('ai-a', 1)
    await manager.attach('ai-a', 2)
    await manager.attach('ai-b', 3)

    const enabled = await manager.groups(true)
    expect(enabled).toMatchObject({ enabled: true, available: true })
    // 每个 workspace 只新建一次组
    expect(fake.calls.group.filter((call) => call.groupId === undefined)).toHaveLength(2)
    expect(groupOf(enabled, 'ai-a')).toMatchObject({ tabIds: [1, 2] })
    expect(groupOf(enabled, 'ai-b')).toMatchObject({ tabIds: [3] })
    expect(groupOf(enabled, 'ai-a')!.groupId).not.toBe(groupOf(enabled, 'ai-b')!.groupId)
    expect(groupOf(enabled, 'ai-a')!.title.length).toBeGreaterThan(0)
    expect(groupOf(enabled, 'ai-a')!.color.length).toBeGreaterThan(0)

    const attached = await manager.attach('ai-a', 4)
    expect(attached).toMatchObject({ attached: true, workspace: 'ai-a' })
    expect(fake.calls.group.at(-1)).toMatchObject({
      tabIds: [4],
      groupId: groupOf(enabled, 'ai-a')!.groupId,
    })
    expect(groupOf(await manager.groups(), 'ai-a')).toMatchObject({ tabIds: [1, 2, 4] })
  })

  test('detach, release and off restore the original groups; missing originals ungroup', async () => {
    const fake = createFakeGroupApi()
    fake.seedGroup([1], 7)
    fake.seedGroup([2], 8)
    fake.seedGroup([5], 9)
    const manager = createManager(fake.api)
    await manager.attach('ai-a', 1)
    await manager.attach('ai-b', 2)
    await manager.attach('ai-c', 5)
    await manager.groups(true)
    expect(fake.groupOf(1)).toBeGreaterThanOrEqual(100)
    expect(fake.groupOf(2)).toBeGreaterThanOrEqual(100)
    expect(fake.groupOf(5)).toBeGreaterThanOrEqual(100)

    // 原组 9 被浏览器回收后，只能退化为 ungroup
    fake.dropGroup(9)

    await manager.detach('ai-a', 1)
    expect(fake.groupOf(1)).toBe(7)

    await manager.release('ai-b')
    expect(fake.groupOf(2)).toBe(8)

    await manager.detach('ai-c', 5)
    expect(fake.groupOf(5)).toBe(-1)

    // 关闭展示层只恢复标签，不改变归属
    await manager.groups(false)
    expect((await manager.groups()).groups).toEqual([])
  })

  test('off restores managed tabs and clears group caches without changing attachments', async () => {
    const fake = createFakeGroupApi()
    fake.seedGroup([1], 7)
    const manager = createManager(fake.api)
    await manager.attach('ai-a', 1)
    await manager.groups(true)
    expect(fake.groupOf(1)).toBeGreaterThanOrEqual(100)

    const status = await manager.groups(false)
    expect(status).toMatchObject({ enabled: false, groups: [] })
    expect(fake.groupOf(1)).toBe(7)
    // 归属事实不受影响
    expect(await manager.current('ai-a')).toMatchObject({ workspace: { id: 'ai-a' } })
  })

  test('leaves tabs alone when the user already moved them to another group', async () => {
    const fake = createFakeGroupApi()
    fake.seedGroup([1], 7)
    const manager = createManager(fake.api)
    await manager.attach('ai-a', 1)
    await manager.groups(true)

    fake.moveTab(1, 55)
    await manager.detach('ai-a', 1)

    expect(fake.groupOf(1)).toBe(55)
    expect(fake.calls.group.some((call) => call.tabIds.includes(1) && call.groupId === 7)).toBe(
      false,
    )
  })

  test('keeps the managed group when restoring the original fails transiently', async () => {
    const fake = createFakeGroupApi()
    fake.seedGroup([1], 7)
    const manager = createManager(fake.api)
    await manager.attach('ai-a', 1)
    const enabled = await manager.groups(true)
    const managedGroupId = groupOf(enabled, 'ai-a')!.groupId
    expect(fake.groupOf(1)).toBe(managedGroupId)

    // 非“组不存在”的故障：只记 lastError，不能把 tab 甩出管理组
    fake.failRegroup(new Error('temporary failure'))
    await manager.detach('ai-a', 1)

    expect(fake.calls.ungroup).toHaveLength(0)
    expect(fake.groupOf(1)).toBe(managedGroupId)
    expect((await manager.groups()).lastError).toBe('temporary failure')
  })

  test('treats a closed tab as normal lifecycle instead of a group failure', async () => {
    const fake = createFakeGroupApi()
    const state = createExtensionState(1)
    const manager = createManager(fake.api, { state })
    await manager.attach('ai-a', 1)
    await manager.attach('ai-b', 2)
    await manager.attach('ai-c', 3)
    await manager.groups(true)

    // 真实浏览器里 close 之后 tabGroupId 会抛 "No tab with id"
    fake.closeTab(1)
    await manager.detach('ai-a', 1)
    expect(state.workspaces.attachments.has(1)).toBe(false)
    expect((await manager.groups()).lastError).toBeUndefined()

    fake.closeTab(2)
    await manager.release('ai-b')
    expect(state.workspaces.attachments.has(2)).toBe(false)
    expect(state.workspaces.workspaces.has('ai-b')).toBe(false)
    expect((await manager.groups()).lastError).toBeUndefined()

    fake.closeTab(3)
    const off = await manager.groups(false)
    expect(off.lastError).toBeUndefined()
    // off 只关展示层，不改变归属：attachment 仍保留
    expect(state.workspaces.attachments.has(3)).toBe(true)
  })

  test('expired leases restore the original group without changing ownership semantics', async () => {
    const fake = createFakeGroupApi()
    fake.seedGroup([1], 7)
    let clock = 1_000_000
    const state = createExtensionState(1)
    const manager = createManager(fake.api, { state, now: () => clock, leaseMs: 1000 })
    await manager.attach('ai-a', 1)
    await manager.groups(true)
    expect(fake.groupOf(1)).toBeGreaterThanOrEqual(100)

    clock += 1000
    // current() 内部会触发过期清理
    const current = await manager.current('ai-a')

    // 展示层恢复，归属记录已释放
    expect(fake.groupOf(1)).toBe(7)
    expect(state.workspaces.attachments.size).toBe(0)
    expect(current).toMatchObject({ workspace: { id: 'ai-a', targetTabId: null }, tabs: [] })
    expect(groupOf(await manager.groups(), 'ai-a')).toMatchObject({ tabIds: [] })

    // 过期只是释放：tab 重新空闲，可被别的 workspace 认领
    await expect(manager.attach('ai-b', 1)).resolves.toMatchObject({ workspace: 'ai-b' })
  })

  test('grouping failures keep ownership and surface lastError', async () => {
    const fake = createFakeGroupApi()
    fake.failGrouping(new Error('cannot group tabs'))
    const state = createExtensionState(1)
    const manager = createManager(fake.api, { state })

    await expect(manager.attach('ai-a', 1)).resolves.toMatchObject({
      attached: true,
      workspace: 'ai-a',
    })
    expect(state.workspaces.attachments.get(1)?.workspaceId).toBe('ai-a')
    expect(await manager.groups()).toMatchObject({
      enabled: false,
      available: true,
    })

    const enabled = await manager.groups(true)
    expect(enabled).toMatchObject({ enabled: true, lastError: 'cannot group tabs' })
    // 归属仍然可用
    await expect(manager.resolveCommandTab('ai-a', 'snapshot', {})).resolves.toBe(1)
  })

  test('restores group caches from storage and rebuilds a stale group on next sync', async () => {
    const storage = createStorage()
    const fake = createFakeGroupApi()
    fake.seedGroup([1], 7)
    const first = createManager(fake.api, { storage })
    await first.groups(true)
    // 开启后普通 attach 的 touch 落盘必须带上 enabled 与 group 映射
    await first.attach('ai-a', 1)
    const originalGroupId = groupOf(await first.groups(), 'ai-a')!.groupId

    const restored = createManager(fake.api, { storage, state: createExtensionState(1) })
    const restoredStatus = await restored.groups()
    expect(restoredStatus.enabled).toBe(true)
    expect(groupOf(restoredStatus, 'ai-a')).toMatchObject({
      groupId: originalGroupId,
      tabIds: [1],
    })

    // 扩展重载后旧组已不存在：下一次同步创建新组
    fake.dropGroup(originalGroupId)
    await restored.attach('ai-a', 2)
    const resynced = await restored.groups()
    const rebuiltGroupId = groupOf(resynced, 'ai-a')!.groupId
    expect(rebuiltGroupId).not.toBe(originalGroupId)
    expect(groupOf(resynced, 'ai-a')!.tabIds).toEqual([1, 2])
    // 新组必须真的收拢该 workspace 的全部 attachments，而不是只改状态
    expect(fake.groupOf(1)).toBe(rebuiltGroupId)
    expect(fake.groupOf(2)).toBe(rebuiltGroupId)

    // 重建时逐 tab 记录原组，不得覆盖已有的 originalGroups：tab 1 仍回到 7
    await restored.detach('ai-a', 1)
    expect(fake.groupOf(1)).toBe(7)
  })

  test('concurrent attaches to one workspace create a single group', async () => {
    const fake = createFakeGroupApi()
    const manager = createManager(fake.api)
    await manager.groups(true)

    await Promise.all([manager.attach('ai-a', 1), manager.attach('ai-a', 2)])

    expect(fake.calls.group.filter((call) => call.groupId === undefined)).toHaveLength(1)
    const status = await manager.groups()
    expect(groupOf(status, 'ai-a')!.tabIds.sort()).toEqual([1, 2])
  })

  test('reports unavailable capability instead of faking success', async () => {
    const storage = createStorage()
    storage.data.set('autobrowser.workspaces.v1', {
      workspaces: [],
      attachments: [],
      groups: { enabled: true, workspaceGroups: {}, originalGroups: {} },
    })
    const manager = createManager(null, { storage })
    const unavailable = createManager(null, { storage, state: createExtensionState(1) })

    // 旧存储里 enabled=true，但当前浏览器没有 API：不能伪装成已开启
    expect(await unavailable.groups()).toMatchObject({
      enabled: false,
      available: false,
    })
    await expect(unavailable.groups(true)).rejects.toMatchObject({
      code: 'BROWSER_CAPABILITY_UNSUPPORTED',
    })
    // attach 不受展示层能力影响
    await expect(manager.attach('ai-a', 1)).resolves.toMatchObject({ attached: true })
  })
})
