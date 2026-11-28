import { describe, expect, test } from 'bun:test'
import { createExtensionState } from '../extension/background/state.js'
import { createWorkspaceManager } from '../extension/background/workspaces.js'
import type { TabInput } from '../extension/background/types.js'
import type { WorkspaceGroupApi } from '../extension/background/workspace-groups.js'
import { createMinimalRouter } from './command-router.test.js'

interface FakeTab {
  id: number
  url: string
  title: string
  active: boolean
}

function tabIdFromInput(input: unknown): number {
  if (typeof input === 'number') return input
  const match = /^t(\d+)$/.exec(String(input || ''))
  return match ? Number(match[1]) : 1
}

/**
 * 假浏览器：tabs 是唯一事实，关闭会真的把页面从列表里删掉。
 * 这样 finish 的"关掉 / 保留 / 已不存在 / 关闭失败"四种结果都能用真实状态验证，
 * 而不是只比对返回字符串。
 */
function createFakeBrowser(initial: Array<Partial<FakeTab> & { id: number }> = []) {
  const tabs = new Map<number, FakeTab>()
  const closed: number[] = []
  const closeFailures = new Set<number>()
  let nextId = 1

  function add(tab: Partial<FakeTab> & { id: number }): FakeTab {
    const value: FakeTab = {
      title: `page ${tab.id}`,
      url: `https://t${tab.id}.example`,
      active: false,
      ...tab,
    }
    tabs.set(value.id, value)
    nextId = Math.max(nextId, value.id + 1)
    return value
  }
  for (const tab of initial) add(tab)

  return {
    tabs,
    closed,
    closeFailures,
    add,
    setActive(id: number) {
      for (const tab of tabs.values()) tab.active = tab.id === id
    },
    remove(id: number) {
      tabs.delete(id)
    },
    async listTabs() {
      return Array.from(tabs.values()).map((tab) => ({ ...tab }))
    },
    async getTargetTab(input: TabInput) {
      const tab = tabs.get(tabIdFromInput(input))
      if (!tab) {
        const error = new Error(`No tab with id: ${String(input)}`) as Error & { code?: string }
        error.code = 'STALE_TAB_HANDLE'
        throw error
      }
      return { ...tab } as never
    },
    async createTab(url: string) {
      return add({ id: nextId, url })
    },
    async closeTabs(ids: number[]) {
      for (const id of ids) {
        if (closeFailures.has(id)) throw new Error(`cannot close t${id}`)
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`)
      }
      for (const id of ids) {
        tabs.delete(id)
        closed.push(id)
      }
    },
  }
}

/** 复刻扩展 storage.local 的读写语义 */
function createStorage(seed?: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}))
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

/** 内存版标签组 API；可注入恢复失败，验证展示层故障不会把关错标签 */
function createFakeGroupApi() {
  let nextGroupId = 500
  let regroupFailure: Error | null = null
  const groups = new Map<number, Set<number>>()
  const tabGroups = new Map<number, number>()

  const api: WorkspaceGroupApi = {
    async groupTabs(tabIds, groupId) {
      if (groupId === undefined) {
        groupId = nextGroupId++
        groups.set(groupId, new Set())
      } else {
        if (regroupFailure) throw regroupFailure
        if (!groups.has(groupId)) throw new Error(`No group with id: ${groupId}`)
      }
      for (const tabId of tabIds) {
        groups.get(groupId)!.add(tabId)
        tabGroups.set(tabId, groupId)
      }
      return groupId
    },
    async ungroupTabs(tabIds) {
      for (const tabId of tabIds) {
        const groupId = tabGroups.get(tabId)
        if (groupId !== undefined) groups.get(groupId)?.delete(tabId)
        tabGroups.set(tabId, -1)
      }
    },
    async getGroup(groupId) {
      return groups.has(groupId) ? { id: groupId } : undefined
    },
    async updateGroup() {},
    async tabGroupId(tabId) {
      return tabGroups.get(tabId) ?? -1
    },
  }

  return {
    api,
    seedGroup(tabIds: number[], groupId: number) {
      groups.set(groupId, new Set(tabIds))
      for (const tabId of tabIds) tabGroups.set(tabId, groupId)
    },
    failRegroup(error: Error | null) {
      regroupFailure = error
    },
    groupOf(tabId: number) {
      return tabGroups.get(tabId) ?? -1
    },
  }
}

function createManager(
  browser: ReturnType<typeof createFakeBrowser>,
  options: {
    state?: ReturnType<typeof createExtensionState>
    storage?: ReturnType<typeof createStorage>
    groupApi?: WorkspaceGroupApi | null
  } = {},
) {
  return createWorkspaceManager({
    state: options.state ?? createExtensionState(1),
    getTargetTab: browser.getTargetTab,
    createTab: async (url: string) => (await browser.createTab(url)) as never,
    listTabs: browser.listTabs,
    closeTabs: browser.closeTabs,
    groupApi: options.groupApi ?? null,
    ...options.storage,
  })
}

describe('workspace attachment origin and keep', () => {
  test('only createWorkspaceTab produces origin=created; attach stays attached', async () => {
    const browser = createFakeBrowser([{ id: 1 }])
    const state = createExtensionState(1)
    const manager = createManager(browser, { state })

    const created = await manager.createWorkspaceTab('ai-a', 'https://created.example')
    expect(created.tab).toMatchObject({ id: 2, workspace: 'ai-a', origin: 'created', keep: null })

    const attached = await manager.attach('ai-a', 1)
    expect(attached.tab).toMatchObject({ id: 1, origin: 'attached', keep: null })
    expect(state.workspaces.attachments.get(1)).toMatchObject({
      origin: 'attached',
      keep: null,
    })
  })

  test('re-attaching keeps the existing origin and keep mark', async () => {
    const browser = createFakeBrowser([{ id: 1 }])
    const manager = createManager(browser)

    await manager.attach('ai-a', 1)
    await manager.mark('ai-a', 1, 'deliverable')
    await manager.attach('ai-a', 1)

    await expect(manager.current('ai-a')).resolves.toMatchObject({
      tabs: [{ tabId: 1, origin: 'attached', keep: 'deliverable' }],
    })

    const created = await manager.createWorkspaceTab('ai-a', 'https://kept.example')
    const createdId = (created.tab as { id: number }).id
    await manager.mark('ai-a', createdId, 'handoff')
    await manager.attach('ai-a', createdId)
    await expect(manager.current('ai-a')).resolves.toMatchObject({
      tabs: expect.arrayContaining([
        expect.objectContaining({ tabId: createdId, origin: 'created', keep: 'handoff' }),
      ]),
    })
  })

  test('legacy storage without origin/keep restores conservatively as attached + null', async () => {
    const storage = createStorage({
      'autobrowser.workspaces.v1': {
        workspaces: [
          {
            id: 'ai-old',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastActiveAt: '2026-01-01T00:00:00.000Z',
            targetTabId: 12,
          },
        ],
        attachments: [
          {
            tabId: 12,
            workspaceId: 'ai-old',
            mode: 'owned',
            attachedAt: '2026-01-01T00:00:00.000Z',
            lastActiveAt: '2026-01-01T00:00:00.000Z',
            leaseExpiresAt: '2999-01-01T00:00:00.000Z',
          },
        ],
      },
    })
    const manager = createManager(createFakeBrowser([{ id: 12 }]), { storage })

    // 旧数据没有来源证据：不能被当成 workspace 创建的临时页，也不能有交付标记
    const [decorated] = await manager.decorateTabs([{ id: 12 } as never], true)
    expect(decorated).toMatchObject({
      workspace: 'ai-old',
      attachment: 'owned',
      origin: 'attached',
      keep: null,
      leaseExpiresAt: '2999-01-01T00:00:00.000Z',
    })
    await expect(manager.current('ai-old')).resolves.toMatchObject({
      tabs: [{ tabId: 12, origin: 'attached', keep: null }],
    })
  })

  test('tab list decoration exposes origin/keep and keeps lease only when detailed', async () => {
    const browser = createFakeBrowser([{ id: 1 }, { id: 2 }])
    const manager = createManager(browser)
    await manager.attach('ai-a', 1)
    await manager.mark('ai-a', 1, 'handoff')

    const [concise] = await manager.decorateTabs([{ id: 1 } as never])
    expect(concise).toMatchObject({ origin: 'attached', keep: 'handoff' })
    expect(concise).not.toHaveProperty('leaseExpiresAt')

    const [other] = await manager.decorateTabs([{ id: 2 } as never])
    expect(other).toMatchObject({
      workspace: null,
      attachment: null,
      origin: null,
      keep: null,
      attachable: true,
    })
  })
})

describe('tab mark and unmark', () => {
  test('marks and unmarks an owned tab, returning the updated summary', async () => {
    const browser = createFakeBrowser([{ id: 1 }])
    const manager = createManager(browser)
    await manager.attach('ai-a', 1)

    await expect(manager.mark('ai-a', 't1', 'deliverable')).resolves.toMatchObject({
      marked: true,
      workspace: 'ai-a',
      keep: 'deliverable',
      tab: {
        handle: 't1',
        workspace: 'ai-a',
        attachment: 'owned',
        origin: 'attached',
        keep: 'deliverable',
      },
    })
    await expect(manager.unmark('ai-a', 1)).resolves.toMatchObject({
      unmarked: true,
      workspace: 'ai-a',
      keep: null,
      tab: { handle: 't1', keep: null },
    })
  })

  test('rejects readonly attachments, unowned tabs and foreign workspaces', async () => {
    const browser = createFakeBrowser([{ id: 1 }, { id: 2 }])
    const manager = createManager(browser)
    await manager.attach('ai-a', 1, 'readonly')
    await manager.attach('ai-b', 2)

    await expect(manager.mark('ai-a', 1, 'deliverable')).rejects.toMatchObject({
      code: 'WORKSPACE_READONLY',
    })
    await expect(manager.unmark('ai-a', 1)).rejects.toMatchObject({
      code: 'WORKSPACE_READONLY',
    })
    await expect(manager.mark('ai-a', 2, 'deliverable')).rejects.toMatchObject({
      code: 'TAB_BUSY',
      details: { tabHandle: 't2', workspace: 'ai-b', attachment: 'owned' },
    })
    await expect(manager.mark('ai-a', 3, 'deliverable')).rejects.toMatchObject({
      code: 'TAB_NOT_ATTACHED',
    })

    // 失败不落标记，也提示持有方如何收尾
    const busy = (await manager.mark('ai-a', 2, 'deliverable').catch((error) => error)) as {
      suggestedAction: string
    }
    expect(busy.suggestedAction).toContain('do not force takeover')
    await expect(manager.current('ai-b')).resolves.toMatchObject({
      tabs: [{ tabId: 2, keep: null }],
    })
  })

  test('a marked tab tells other workspaces how the owner can release it', async () => {
    const browser = createFakeBrowser([{ id: 1 }])
    const manager = createManager(browser)
    await manager.attach('ai-a', 1)
    await manager.mark('ai-a', 1, 'handoff')

    const error = (await manager.mark('ai-b', 1, 'deliverable').catch((reason) => reason)) as {
      code: string
      suggestedAction: string
      details: Record<string, unknown>
    }
    expect(error.code).toBe('TAB_BUSY')
    expect(error.details).toMatchObject({ workspace: 'ai-a', keep: 'handoff' })
    expect(error.suggestedAction).toContain('tab unmark t1')
    expect(error.suggestedAction).toContain('workspace finish')
  })
})

describe('workspace finish', () => {
  /** 一整套生命周期：created / borrowed / deliverable / handoff / foreground / missing */
  async function preparedWorkspace() {
    const browser = createFakeBrowser([
      { id: 1, url: 'https://borrowed.example', active: true },
      { id: 2, url: 'https://missing.example' },
    ])
    const manager = createManager(browser)

    const closedLater = await manager.createWorkspaceTab('ai-a', 'https://temp.example')
    const closedId = (closedLater.tab as { id: number }).id
    const deliverable = await manager.createWorkspaceTab('ai-a', 'https://result.example')
    const deliverableId = (deliverable.tab as { id: number }).id
    const handoff = await manager.createWorkspaceTab('ai-a', 'https://handoff.example')
    const handoffId = (handoff.tab as { id: number }).id
    const foreground = await manager.createWorkspaceTab('ai-a', 'https://front.example')
    const foregroundId = (foreground.tab as { id: number }).id

    await manager.attach('ai-a', 1)
    await manager.attach('ai-a', 2)
    await manager.mark('ai-a', deliverableId, 'deliverable')
    await manager.mark('ai-a', handoffId, 'handoff')
    browser.setActive(foregroundId)
    // 用户/浏览器已经把 t2 关掉，扩展状态里还没清理
    browser.remove(2)

    return { browser, manager, closedId, deliverableId, handoffId, foregroundId }
  }

  test('closes only plain created tabs and detaches everything it keeps', async () => {
    const { browser, manager, closedId, deliverableId, handoffId, foregroundId } =
      await preparedWorkspace()

    const result = await manager.finish('ai-a')

    expect(result).toMatchObject({
      success: true,
      workspace: 'ai-a',
      closed: 1,
      closedTabIds: [closedId],
      missingTabIds: [2],
      failedTabs: [],
      remainingTabIds: [],
    })
    expect(result.preserved).toEqual([
      { tabId: 1, handle: 't1', reason: 'borrowed' },
      { tabId: deliverableId, handle: `t${deliverableId}`, reason: 'deliverable' },
      { tabId: handoffId, handle: `t${handoffId}`, reason: 'handoff' },
      { tabId: foregroundId, handle: `t${foregroundId}`, reason: 'foreground' },
    ])
    expect(result.releasedTabIds).toEqual([1, deliverableId, handoffId, foregroundId])

    // 关闭是真删除，保留的页面必须还在
    expect(browser.closed).toEqual([closedId])
    expect(browser.tabs.has(closedId)).toBe(false)
    for (const id of [1, deliverableId, handoffId, foregroundId]) {
      expect(browser.tabs.has(id)).toBe(true)
    }

    // 工作区保留、目标清空、attachment 全部释放
    await expect(manager.current('ai-a')).resolves.toMatchObject({
      workspace: { id: 'ai-a', targetTabId: null },
      tabs: [],
    })
    await expect(manager.decorateTabs([{ id: 1 } as never])).resolves.toMatchObject([
      { workspace: null, attachable: true },
    ])
  })

  test('keeps close failures attached so the caller can retry', async () => {
    const browser = createFakeBrowser()
    const manager = createManager(browser)
    const failing = await manager.createWorkspaceTab('ai-a', 'https://stuck.example')
    const failingId = (failing.tab as { id: number }).id
    browser.closeFailures.add(failingId)

    const result = await manager.finish('ai-a')

    expect(result).toMatchObject({
      success: false,
      closed: 0,
      closedTabIds: [],
      missingTabIds: [],
      remainingTabIds: [failingId],
    })
    expect(result.failedTabs).toEqual([
      { tabId: failingId, handle: `t${failingId}`, error: `cannot close t${failingId}` },
    ])
    // 失败必须保留绑定，不能假装已经收尾
    await expect(manager.current('ai-a')).resolves.toMatchObject({
      workspace: { id: 'ai-a', targetTabId: null },
      tabs: [{ tabId: failingId, origin: 'created', keep: null }],
    })

    browser.closeFailures.delete(failingId)
    await expect(manager.finish('ai-a')).resolves.toMatchObject({
      success: true,
      closed: 1,
      closedTabIds: [failingId],
      remainingTabIds: [],
    })
  })

  test('a failed tab inspection closes nothing and reports failures', async () => {
    const browser = createFakeBrowser()
    const manager = createWorkspaceManager({
      state: createExtensionState(1),
      getTargetTab: browser.getTargetTab,
      createTab: async (url: string) => (await browser.createTab(url)) as never,
      listTabs: async () => {
        throw new Error('tabs.query failed')
      },
      closeTabs: browser.closeTabs,
      groupApi: null,
    })
    const created = await manager.createWorkspaceTab('ai-a', 'https://temp.example')
    const createdId = (created.tab as { id: number }).id

    const result = await manager.finish('ai-a')

    expect(result).toMatchObject({ success: false, closed: 0, remainingTabIds: [createdId] })
    expect(browser.closed).toEqual([])
    expect((result.failedTabs as Array<{ error: string }>)[0].error).toContain('tabs.query failed')
  })

  test('restores the original tab group for kept tabs and ignores display failures', async () => {
    const browser = createFakeBrowser([{ id: 1 }, { id: 2 }])
    const fakeGroups = createFakeGroupApi()
    fakeGroups.seedGroup([1], 7)
    const manager = createManager(browser, { groupApi: fakeGroups.api })
    await manager.attach('ai-a', 1)
    const created = await manager.createWorkspaceTab('ai-a', 'https://temp.example')
    const createdId = (created.tab as { id: number }).id
    await manager.groups(true)
    expect(fakeGroups.groupOf(1)).toBeGreaterThanOrEqual(500)

    const result = await manager.finish('ai-a')
    expect(result.closedTabIds).toEqual([createdId])
    // 借用页恢复进入前的组
    expect(fakeGroups.groupOf(1)).toBe(7)

    // 展示层恢复失败只记 lastError：不能改变关闭/保留的决定
    const second = createFakeBrowser([{ id: 3 }])
    const failingGroups = createFakeGroupApi()
    failingGroups.seedGroup([3], 8)
    const secondManager = createManager(second, { groupApi: failingGroups.api })
    await secondManager.attach('ai-b', 3)
    const temp = await secondManager.createWorkspaceTab('ai-b', 'https://temp2.example')
    const tempId = (temp.tab as { id: number }).id
    await secondManager.groups(true)
    failingGroups.failRegroup(new Error('temporary group failure'))

    const secondResult = await secondManager.finish('ai-b')
    expect(secondResult).toMatchObject({ success: true, closedTabIds: [tempId] })
    expect(second.tabs.has(3)).toBe(true)
    await expect(secondManager.groups()).resolves.toMatchObject({
      lastError: 'temporary group failure',
    })
  })

  test('release still only detaches and never closes pages', async () => {
    const browser = createFakeBrowser([{ id: 1 }])
    const manager = createManager(browser)
    const created = await manager.createWorkspaceTab('ai-a', 'https://temp.example')
    const createdId = (created.tab as { id: number }).id
    await manager.attach('ai-b', 1)

    await expect(manager.release('ai-a')).resolves.toMatchObject({
      released: true,
      workspace: 'ai-a',
      detachedTabs: [createdId],
    })
    expect(browser.closed).toEqual([])
    expect(browser.tabs.has(createdId)).toBe(true)
    // 其他 workspace 的移动不受影响
    await expect(manager.current('ai-b')).resolves.toMatchObject({
      tabs: [{ tabId: 1, origin: 'attached' }],
    })
  })
})

describe('workspace mark/finish through the command router', () => {
  test('tab.mark forwards the keep mode and workspace finish reports preserved tabs', async () => {
    const { router } = createMinimalRouter({
      getTargetTab: async (input) => ({ id: tabIdFromInput(input) }) as never,
      listTabs: async () => [{ id: 1, title: 'kept', url: 'https://kept.example', active: false }],
    })

    await router.handleCommand({ command: 'tab.attach', args: { workspace: 'ai-a', handle: 't1' } })
    const marked = await router.handleCommand({
      command: 'tab.mark',
      args: { workspace: 'ai-a', handle: 't1', mode: 'handoff' },
    })
    expect(marked).toMatchObject({
      marked: true,
      keep: 'handoff',
      tab: { handle: 't1', origin: 'attached', keep: 'handoff' },
    })

    const finished = await router.handleCommand({
      command: 'workspace',
      args: { workspace: 'ai-a', action: 'finish' },
    })
    expect(finished).toMatchObject({
      success: true,
      closed: 0,
      preserved: [{ tabId: 1, handle: 't1', reason: 'handoff' }],
      remainingTabIds: [],
    })
  })

  test('tab mark/unmark require a workspace and a valid mode', async () => {
    const { router } = createMinimalRouter()
    await expect(
      router.handleCommand({ command: 'tab.mark', args: { handle: 't1', mode: 'deliverable' } }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' })
    await expect(
      router.handleCommand({ command: 'tab.mark', args: { workspace: 'ai-a', handle: 't1' } }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND_ARGS' })
    await expect(router.handleCommand({ command: 'tab.unmark', args: {} })).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRED',
    })
  })
})
