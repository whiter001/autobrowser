import { createToolError } from '../../src/core/tool-error.js'
import { tabGroupsGet, tabGroupsUpdate, tabsGet, tabsGroup, tabsUngroup } from './chrome.js'

/**
 * Chromium 标签组展示层。
 *
 * workspace attachment 始终是唯一归属事实；这里的 groupId 只是可失效的缓存，
 * 用来让同一 workspace 的标签在浏览器 UI 上聚在一起。任何分组失败都只记录
 * lastError，不影响 attach/detach/release 以及页面命令。
 */

export interface WorkspaceGroupApi {
  /** 省略 groupId 时新建组并返回组 id */
  groupTabs(tabIds: number[], groupId?: number): Promise<number>
  ungroupTabs(tabIds: number[]): Promise<void>
  /** 组已不存在时返回 undefined；其它错误照常抛出，避免把暂时性故障误判成需要重建 */
  getGroup(groupId: number): Promise<{ id: number } | undefined>
  updateGroup(groupId: number, update: { title: string; color: string }): Promise<void>
  /** 返回 tab 当前所在组 id，未分组时为 -1 */
  tabGroupId(tabId: number): Promise<number>
}

export interface StoredWorkspaceGroups {
  enabled?: boolean
  workspaceGroups?: Record<string, number>
  originalGroups?: Record<string, number | null>
}

export interface WorkspaceGroupAttachment {
  tabId: number
  workspaceId: string
}

export interface WorkspaceGroupsDependencies {
  api: WorkspaceGroupApi | null
  listAttachments: () => WorkspaceGroupAttachment[]
  persist: () => Promise<void>
}

export interface WorkspaceGroupsController {
  restore: (stored: unknown) => void
  serialize: () => StoredWorkspaceGroups
  status: () => Record<string, unknown>
  setEnabled: (enabled: boolean) => Promise<Record<string, unknown>>
  syncTab: (tabId: number, workspaceId: string) => Promise<void>
  restoreTab: (tabId: number, workspaceId: string) => Promise<void>
  releaseWorkspace: (workspaceId: string, tabIds: number[]) => Promise<void>
  forgetTab: (tabId: number) => void
}

const GROUP_COLORS = [
  'blue',
  'cyan',
  'green',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
  'grey',
] as const

const MISSING_GROUP = /no (?:tab )?group|group\b.*(?:does not exist|not found|invalid)/i
const MISSING_TAB = /no tab with id|invalid tab id|tab not found/i

/** 组标题只做确定性截断，避免把长 workspace id 原样塞进 UI */
export function workspaceGroupTitle(workspaceId: string): string {
  const normalized = workspaceId.replace(/\s+/g, ' ').trim() || 'workspace'
  return normalized.length <= 20 ? normalized : `${normalized.slice(0, 19)}…`
}

/** 同一个 workspace 永远得到同一个颜色，便于用户建立稳定印象 */
export function workspaceGroupColor(workspaceId: string): string {
  let hash = 0
  for (const char of workspaceId) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length]
}

function isMissingGroupError(error: unknown): boolean {
  return error instanceof Error && MISSING_GROUP.test(error.message)
}

/** tab 在恢复前被关闭属于正常生命周期，不应记成展示层故障 */
function isMissingTabError(error: unknown): boolean {
  return error instanceof Error && MISSING_TAB.test(error.message)
}

/**
 * chrome API 适配器；缺少 tabGroups 能力时返回 null，由上层报告 available=false。
 */
export function createChromeWorkspaceGroupApi(): WorkspaceGroupApi | null {
  if (typeof chrome === 'undefined') return null
  if (
    typeof chrome.tabs?.group !== 'function' ||
    typeof chrome.tabs?.ungroup !== 'function' ||
    typeof chrome.tabGroups?.get !== 'function' ||
    typeof chrome.tabGroups?.update !== 'function'
  ) {
    return null
  }
  return {
    groupTabs: async (tabIds, groupId) => await tabsGroup(tabIds, groupId),
    ungroupTabs: async (tabIds) => await tabsUngroup(tabIds),
    getGroup: async (groupId) => {
      try {
        const group = await tabGroupsGet(groupId)
        return group ? { id: group.id } : undefined
      } catch (error) {
        if (isMissingGroupError(error)) return undefined
        throw error
      }
    },
    updateGroup: async (groupId, update) => {
      await tabGroupsUpdate(groupId, {
        title: update.title,
        color: update.color as chrome.tabGroups.UpdateProperties['color'],
      })
    },
    tabGroupId: async (tabId) => {
      const tab = await tabsGet(tabId)
      return typeof tab.groupId === 'number' ? tab.groupId : -1
    },
  }
}

export function createWorkspaceGroupsController({
  api,
  listAttachments,
  persist,
}: WorkspaceGroupsDependencies): WorkspaceGroupsController {
  const available = api !== null
  let enabled = false
  let lastError: string | null = null
  /** workspaceId -> 管理组 id；可失效，组没了下次同步重建 */
  const groupIds = new Map<string, number>()
  /** tabId -> 进入管理组前所在组；null 表示原本未分组 */
  const originalGroups = new Map<number, number | null>()
  /** 每个 workspace 一条串行队列，避免并发 attach 重复建组 */
  const queues = new Map<string, Promise<void>>()

  function rememberError(error: unknown): void {
    lastError = error instanceof Error ? error.message : String(error)
  }

  async function safePersist(): Promise<void> {
    await persist().catch(() => {})
  }

  /** 同一 workspace 的分组任务严格串行；返回的 Promise 永远 resolve */
  function enqueue(workspaceId: string, task: () => Promise<void>): Promise<void> {
    const previous = queues.get(workspaceId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const guard = run.then(
      () => undefined,
      () => undefined,
    )
    queues.set(workspaceId, guard)
    void guard.then(() => {
      if (queues.get(workspaceId) === guard) queues.delete(workspaceId)
    })
    return guard
  }

  function belongsTo(tabId: number, workspaceId: string): boolean {
    return listAttachments().some(
      (attachment) => attachment.tabId === tabId && attachment.workspaceId === workspaceId,
    )
  }

  async function syncTabUnsafe(tabId: number, workspaceId: string): Promise<void> {
    if (!enabled || !api) return
    // 排队期间归属可能已经变化，以执行时的 attachments 为准
    if (!belongsTo(tabId, workspaceId)) return

    let groupId = groupIds.get(workspaceId)
    if (typeof groupId === 'number') {
      const existing = await api.getGroup(groupId)
      if (!existing) {
        groupId = undefined
        groupIds.delete(workspaceId)
      }
    }

    const currentGroupId = await api.tabGroupId(tabId)
    if (typeof groupId === 'number' && currentGroupId === groupId) {
      // 已在唯一组里，只补齐标题与颜色
      await api.updateGroup(groupId, {
        title: workspaceGroupTitle(workspaceId),
        color: workspaceGroupColor(workspaceId),
      })
      return
    }

    if (!originalGroups.has(tabId)) {
      originalGroups.set(tabId, currentGroupId >= 0 ? currentGroupId : null)
    }

    if (typeof groupId === 'number') {
      await api.groupTabs([tabId], groupId)
    } else {
      // 新建组（含 stale 组重建）时一次性收拢该 workspace 的全部 attachments，
      // 否则重建后其它 tab 会留在旧布局里，与 groups() 报出的 tabIds 不一致
      const pending = listAttachments().filter(
        (attachment) => attachment.workspaceId === workspaceId,
      )
      const tabIds = Array.from(new Set([tabId, ...pending.map((item) => item.tabId)]))
      for (const id of tabIds) {
        if (originalGroups.has(id)) continue
        const group = id === tabId ? currentGroupId : await api.tabGroupId(id)
        originalGroups.set(id, group >= 0 ? group : null)
      }
      groupId = await api.groupTabs(tabIds)
      groupIds.set(workspaceId, groupId)
    }
    await api.updateGroup(groupId, {
      title: workspaceGroupTitle(workspaceId),
      color: workspaceGroupColor(workspaceId),
    })
  }

  function syncTab(tabId: number, workspaceId: string): Promise<void> {
    return enqueue(workspaceId, async () => {
      try {
        await syncTabUnsafe(tabId, workspaceId)
      } catch (error) {
        rememberError(error)
      }
    })
  }

  async function restoreTabUnsafe(tabId: number, workspaceId: string): Promise<void> {
    const hasOriginal = originalGroups.has(tabId)
    const original = originalGroups.get(tabId) ?? null
    originalGroups.delete(tabId)
    if (!api || !hasOriginal) return

    const managedGroupId = groupIds.get(workspaceId)
    if (typeof managedGroupId !== 'number') return

    const currentGroupId = await api.tabGroupId(tabId)
    // 用户已经手动把 tab 移到别组（或管理组已被浏览器回收）时不做任何改动
    if (currentGroupId !== managedGroupId) return

    if (typeof original === 'number' && original >= 0) {
      try {
        await api.groupTabs([tabId], original)
        return
      } catch (error) {
        // 只有原组确实消失才能退化为 ungroup；其它错误照常抛出，
        // 由 restoreTab 记入 lastError，不继续改变标签组
        if (!isMissingGroupError(error)) throw error
      }
    }
    await api.ungroupTabs([tabId])
  }

  function restoreTab(tabId: number, workspaceId: string): Promise<void> {
    return enqueue(workspaceId, async () => {
      try {
        await restoreTabUnsafe(tabId, workspaceId)
      } catch (error) {
        // tab 已关闭时恢复动作本就无从谈起，静默跳过；其它错误仍需暴露
        if (isMissingTabError(error)) return
        rememberError(error)
      }
    })
  }

  function status(): Record<string, unknown> {
    const attachments = listAttachments()
    const groups = Array.from(groupIds.entries())
      .map(([workspaceId, groupId]) => ({
        workspaceId,
        groupId,
        tabIds: attachments
          .filter((attachment) => attachment.workspaceId === workspaceId)
          .map((attachment) => attachment.tabId),
        title: workspaceGroupTitle(workspaceId),
        color: workspaceGroupColor(workspaceId),
      }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
    return {
      enabled,
      available,
      groups,
      ...(lastError ? { lastError } : {}),
    }
  }

  function restore(stored: unknown): void {
    if (!stored || typeof stored !== 'object') return
    const value = stored as StoredWorkspaceGroups
    if (value.enabled === true) {
      if (api) {
        enabled = true
      } else {
        // 能力缺失时不能伪装成已开启，交给调用方看到 available=false + lastError
        lastError = 'tabGroups API is not available'
      }
    }
    if (value.workspaceGroups && typeof value.workspaceGroups === 'object') {
      for (const [workspaceId, groupId] of Object.entries(value.workspaceGroups)) {
        if (typeof groupId === 'number' && Number.isFinite(groupId)) {
          groupIds.set(workspaceId, groupId)
        }
      }
    }
    if (value.originalGroups && typeof value.originalGroups === 'object') {
      for (const [key, groupId] of Object.entries(value.originalGroups)) {
        const tabId = Number(key)
        if (!Number.isFinite(tabId)) continue
        if (groupId === null || (typeof groupId === 'number' && Number.isFinite(groupId))) {
          originalGroups.set(tabId, groupId)
        }
      }
    }
  }

  function serialize(): StoredWorkspaceGroups {
    return {
      enabled,
      workspaceGroups: Object.fromEntries(groupIds),
      originalGroups: Object.fromEntries(originalGroups),
    }
  }

  async function setEnabled(next: boolean): Promise<Record<string, unknown>> {
    if (next) {
      if (!api) {
        throw createToolError(
          'BROWSER_CAPABILITY_UNSUPPORTED',
          'tab groups are not available in this browser',
          {
            suggestedAction:
              'Use a Chromium browser that supports the tabGroups API, or keep tab group display disabled.',
          },
        )
      }
      if (!enabled) {
        enabled = true
        lastError = null
        await safePersist()
      }
      // 为已有 attachments 建组；逐 tab 入队，同一 workspace 复用同一个组
      await Promise.all(
        listAttachments().map((attachment) => syncTab(attachment.tabId, attachment.workspaceId)),
      )
      await safePersist()
      return status()
    }

    enabled = false
    const attachments = listAttachments()
    const workspaceOfTab = new Map(
      attachments.map((attachment) => [attachment.tabId, attachment.workspaceId] as const),
    )
    await Promise.all(
      Array.from(originalGroups.keys()).map((tabId) => {
        const workspaceId = workspaceOfTab.get(tabId)
        // 已 detach 的 tab 原先就恢复过；残留记录直接丢弃
        return workspaceId === undefined ? Promise.resolve() : restoreTab(tabId, workspaceId)
      }),
    )
    groupIds.clear()
    originalGroups.clear()
    await safePersist()
    return status()
  }

  async function releaseWorkspace(workspaceId: string, tabIds: number[]): Promise<void> {
    await Promise.all(tabIds.map((tabId) => restoreTab(tabId, workspaceId)))
    groupIds.delete(workspaceId)
  }

  function forgetTab(tabId: number): void {
    originalGroups.delete(tabId)
  }

  return {
    restore,
    serialize,
    status,
    setEnabled,
    syncTab,
    restoreTab,
    releaseWorkspace,
    forgetTab,
  }
}
