import {
  DEFAULT_WORKSPACE_LEASE_MS,
  createWorkspaceState,
  isWorkspaceReadonlyCommand,
  normalizeWorkspaceId,
  type WorkspaceAttachment,
  type WorkspaceAttachmentMode,
  type WorkspaceRecord,
} from '../../src/core/workspaces.js'
import { createToolError } from '../../src/core/tool-error.js'
import { storageLocalGet, storageLocalSet, tabsCreate, tabsQuery } from './chrome.js'
import { resolveTabInput } from './targeting.js'
import type { CommandArgs, ExtensionState, TabInput, TabSummary, TabWithId } from './types.js'

const WORKSPACE_STORAGE_KEY = 'autobrowser.workspaces.v1'

/** 自动认领只需要 id/active/url；chrome.tabs.Tab 与 TabSummary 都满足 */
interface AutoAttachTab {
  id?: number | null
  active?: boolean
  url?: string
}

interface WorkspaceManagerDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  createTab?: (url: string) => Promise<chrome.tabs.Tab | undefined>
  listTabs?: () => Promise<AutoAttachTab[]>
  storageGet?: (keys: string | string[] | null) => Promise<Record<string, unknown>>
  storageSet?: (items: Record<string, unknown>) => Promise<void>
  now?: () => number
  leaseMs?: number
}

/** 浏览器自身页面无法被 debugger 附加，自动认领时必须跳过；about:blank 仍可调试 */
const UNDEBUGGABLE_URL_PROTOCOLS = new Set([
  'chrome:',
  'edge:',
  'devtools:',
  'chrome-extension:',
  'edge-extension:',
])

function isAutoAttachableUrl(url: string | undefined): boolean {
  const protocol = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url || '')?.[1]
  return !protocol || !UNDEBUGGABLE_URL_PROTOCOLS.has(`${protocol.toLowerCase()}:`)
}

function autoAttachmentKey(workspaceId: string, tabId: number): string {
  return `${workspaceId}\u0000${tabId}`
}

interface StoredWorkspaces {
  workspaces?: WorkspaceRecord[]
  attachments?: WorkspaceAttachment[]
}

function workspaceError(
  code: string,
  message: string,
  suggestedAction: string,
  details?: Record<string, unknown>,
) {
  return createToolError(code, message, { suggestedAction, details })
}

/** Workspace 归属在扩展事件循环内原子变更；存储只承担恢复，不参与并发协商。 */
export function createWorkspaceManager({
  state,
  getTargetTab,
  createTab = async (url) => await tabsCreate({ url }),
  listTabs = async () => await tabsQuery({}),
  storageGet = storageLocalGet,
  storageSet = storageLocalSet,
  now = Date.now,
  leaseMs = DEFAULT_WORKSPACE_LEASE_MS,
}: WorkspaceManagerDependencies) {
  state.workspaces ??= createWorkspaceState()
  let loadPromise: Promise<void> | null = null
  /** 自动认领只标记一次：由 command-router 在首次 resolve 后消费 */
  const autoAttachments = new Set<string>()

  async function persist(): Promise<void> {
    const stored: StoredWorkspaces = {
      workspaces: Array.from(state.workspaces.workspaces.values()),
      attachments: Array.from(state.workspaces.attachments.values()),
    }
    await storageSet({ [WORKSPACE_STORAGE_KEY]: stored }).catch(() => {})
  }

  async function ensureLoaded(): Promise<void> {
    if (!loadPromise) {
      loadPromise = (async () => {
        const stored = await storageGet([WORKSPACE_STORAGE_KEY])
        const value = stored[WORKSPACE_STORAGE_KEY] as StoredWorkspaces | undefined
        if (!value || typeof value !== 'object') return
        for (const workspace of value.workspaces || []) {
          if (
            workspace &&
            typeof workspace.id === 'string' &&
            typeof workspace.createdAt === 'string' &&
            typeof workspace.lastActiveAt === 'string'
          ) {
            state.workspaces.workspaces.set(workspace.id, {
              ...workspace,
              targetTabId: typeof workspace.targetTabId === 'number' ? workspace.targetTabId : null,
            })
          }
        }
        for (const attachment of value.attachments || []) {
          if (
            attachment &&
            typeof attachment.tabId === 'number' &&
            typeof attachment.workspaceId === 'string' &&
            state.workspaces.workspaces.has(attachment.workspaceId)
          ) {
            state.workspaces.attachments.set(attachment.tabId, attachment)
          }
        }
      })().catch(() => {})
    }
    await loadPromise
  }

  async function pruneExpired(): Promise<boolean> {
    const timestamp = now()
    let changed = false
    for (const [tabId, attachment] of state.workspaces.attachments) {
      if (Date.parse(attachment.leaseExpiresAt) > timestamp) continue
      state.workspaces.attachments.delete(tabId)
      const workspace = state.workspaces.workspaces.get(attachment.workspaceId)
      if (workspace?.targetTabId === tabId) workspace.targetTabId = null
      changed = true
    }
    if (changed) await persist()
    return changed
  }

  async function ensureWorkspace(id: string): Promise<WorkspaceRecord> {
    await ensureLoaded()
    const workspaceId = normalizeWorkspaceId(id)
    let workspace = state.workspaces.workspaces.get(workspaceId)
    if (!workspace) {
      const timestamp = new Date(now()).toISOString()
      workspace = {
        id: workspaceId,
        createdAt: timestamp,
        lastActiveAt: timestamp,
        targetTabId: null,
      }
      state.workspaces.workspaces.set(workspaceId, workspace)
      await persist()
    }
    return workspace
  }

  async function touch(workspace: WorkspaceRecord, tabId?: number): Promise<void> {
    const timestamp = now()
    workspace.lastActiveAt = new Date(timestamp).toISOString()
    if (tabId !== undefined) {
      const attachment = state.workspaces.attachments.get(tabId)
      if (attachment?.workspaceId === workspace.id) {
        attachment.lastActiveAt = new Date(timestamp).toISOString()
        attachment.leaseExpiresAt = new Date(timestamp + leaseMs).toISOString()
      }
    }
    await persist()
  }

  function busyError(attachment: WorkspaceAttachment, tabId: number) {
    return workspaceError(
      'TAB_BUSY',
      `tab t${tabId} is attached to workspace ${attachment.workspaceId}`,
      "Choose an unattached tab from 'tab list', use 'tab detach' from the owning workspace, or retry after its lease expires.",
      {
        tabHandle: `t${tabId}`,
        workspace: attachment.workspaceId,
        attachment: attachment.mode,
        leaseExpiresAt: attachment.leaseExpiresAt,
      },
    )
  }

  async function attach(
    workspaceId: string,
    tabInput: TabInput,
    mode: WorkspaceAttachmentMode = 'owned',
  ): Promise<Record<string, unknown>> {
    const workspace = await ensureWorkspace(workspaceId)
    const tab = await getTargetTab(tabInput)
    await pruneExpired()
    const existing = state.workspaces.attachments.get(tab.id)
    if (existing && existing.workspaceId !== workspace.id) throw busyError(existing, tab.id)

    const timestamp = new Date(now()).toISOString()
    const attachment: WorkspaceAttachment = {
      tabId: tab.id,
      workspaceId: workspace.id,
      mode,
      attachedAt: existing?.attachedAt || timestamp,
      lastActiveAt: timestamp,
      leaseExpiresAt: new Date(now() + leaseMs).toISOString(),
    }
    state.workspaces.attachments.set(tab.id, attachment)
    workspace.targetTabId = tab.id
    await touch(workspace, tab.id)
    const [decorated] = await decorateTabs([toWorkspaceTabSummary(state, tab)])
    return { attached: true, workspace: workspace.id, attachment: mode, tab: decorated }
  }

  async function detach(
    workspaceId: string,
    tabInput?: TabInput,
  ): Promise<Record<string, unknown>> {
    const workspace = await ensureWorkspace(workspaceId)
    await pruneExpired()
    const tabId =
      resolveTabInput(state, tabInput) ??
      (tabInput == null || String(tabInput).trim() === '' ? workspace.targetTabId : null)
    if (typeof tabId !== 'number') {
      throw workspaceError(
        'WORKSPACE_TARGET_REQUIRED',
        `workspace ${workspace.id} has no target tab to detach`,
        "Run 'tab list', then 'tab attach <tN>' to attach an existing tab or 'tab new [url]' to create one.",
        { workspace: workspace.id },
      )
    }
    const attachment = state.workspaces.attachments.get(tabId)
    if (attachment && attachment.workspaceId !== workspace.id) throw busyError(attachment, tabId)
    state.workspaces.attachments.delete(tabId)
    if (workspace.targetTabId === tabId) {
      workspace.targetTabId =
        Array.from(state.workspaces.attachments.values()).find(
          (candidate) => candidate.workspaceId === workspace.id,
        )?.tabId ?? null
    }
    await touch(workspace)
    return { detached: true, workspace: workspace.id, tabId }
  }

  /**
   * 自动认领：active 未绑定 tab 优先，其余按 tabId 升序。
   * 候选之间用 attach 逐个原子尝试，TAB_BUSY 只说明被别的 workspace 抢先，继续换下一个。
   */
  async function autoAttachTab(workspaceId: string): Promise<number | null> {
    const tabs = await listTabs()
    const candidates = tabs
      .filter(
        (tab): tab is AutoAttachTab & { id: number } =>
          typeof tab.id === 'number' &&
          isAutoAttachableUrl(tab.url) &&
          !state.workspaces.attachments.has(tab.id),
      )
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || a.id - b.id)

    for (const candidate of candidates) {
      try {
        await attach(workspaceId, candidate.id)
        autoAttachments.add(autoAttachmentKey(normalizeWorkspaceId(workspaceId), candidate.id))
        return candidate.id
      } catch (error) {
        if ((error as { code?: unknown }).code === 'TAB_BUSY') continue
        throw error
      }
    }
    return null
  }

  /** 消费自动认领标记；同一 (workspace, tab) 只会返回一次 true */
  function consumeAutoAttachment(workspaceId: string, tabId: number): boolean {
    return autoAttachments.delete(autoAttachmentKey(normalizeWorkspaceId(workspaceId), tabId))
  }

  async function resolveCommandTab(
    workspaceId: string,
    command: string,
    args: CommandArgs,
    tabInput?: TabInput,
  ): Promise<number> {
    const workspace = await ensureWorkspace(workspaceId)
    await pruneExpired()
    const explicit = tabInput != null && String(tabInput).trim() !== ''
    let tabId = resolveTabInput(state, tabInput) ?? (explicit ? null : workspace.targetTabId)
    if (typeof tabId !== 'number' && !explicit) {
      // 没有默认目标时自动认领已有标签；显式 tab 仍走 TAB_NOT_ATTACHED，不能借自动认领绕过归属
      if (args.autoAttach !== false) tabId = (await autoAttachTab(workspace.id)) ?? null
      if (typeof tabId !== 'number') {
        throw workspaceError(
          'WORKSPACE_TARGET_REQUIRED',
          args.autoAttach === false
            ? `workspace ${workspace.id} has no target tab`
            : `workspace ${workspace.id} has no target tab and no existing tab is available to auto-attach`,
          args.autoAttach === false
            ? "Run 'tab list', then 'tab attach <tN>' to reuse an existing tab or 'tab new [url]' to create one."
            : "Open a page or run 'tab new [url]', or attach one explicitly with 'tab list' and 'tab attach <tN>'.",
          { workspace: workspace.id },
        )
      }
    }
    if (typeof tabId !== 'number') {
      throw workspaceError(
        explicit ? 'TAB_NOT_ATTACHED' : 'WORKSPACE_TARGET_REQUIRED',
        explicit
          ? `tab ${String(tabInput)} is not attached to workspace ${workspace.id}`
          : `workspace ${workspace.id} has no target tab`,
        "Run 'tab list', then 'tab attach <tN>' to reuse an existing tab or 'tab new [url]' to create one.",
        { workspace: workspace.id },
      )
    }

    const attachment = state.workspaces.attachments.get(tabId)
    if (!attachment) {
      throw workspaceError(
        'TAB_NOT_ATTACHED',
        `tab t${tabId} is not attached to workspace ${workspace.id}`,
        "Run 'tab attach <tN>' from this workspace before operating the tab.",
        { workspace: workspace.id, tabHandle: `t${tabId}` },
      )
    }
    if (attachment.workspaceId !== workspace.id) throw busyError(attachment, tabId)
    if (attachment.mode === 'readonly' && !isWorkspaceReadonlyCommand(command, args)) {
      throw workspaceError(
        'WORKSPACE_READONLY',
        `tab t${tabId} is read-only in workspace ${workspace.id}; ${command} is not allowed`,
        "Use a read-only observation command, or reattach the tab with 'tab attach <tN>' without --readonly.",
        { workspace: workspace.id, tabHandle: `t${tabId}`, attachment: attachment.mode },
      )
    }

    try {
      await getTargetTab(tabId)
    } catch (error) {
      state.workspaces.attachments.delete(tabId)
      if (workspace.targetTabId === tabId) workspace.targetTabId = null
      await persist()
      throw error
    }
    workspace.targetTabId = tabId
    await touch(workspace, tabId)
    return tabId
  }

  function startCommandLease(
    workspaceId: string,
    command: string,
    args: CommandArgs,
    tabId: number,
  ): () => void {
    const timer = setInterval(
      () => {
        void resolveCommandTab(workspaceId, command, args, tabId).catch(() => {})
      },
      Math.max(1000, Math.floor(leaseMs / 3)),
    )
    return () => clearInterval(timer)
  }

  async function createWorkspaceTab(
    workspaceId: string,
    url: string,
  ): Promise<Record<string, unknown>> {
    const tab = await createTab(url)
    if (!tab || typeof tab.id !== 'number') throw new Error('failed to create a tab with an id')
    const attached = await attach(workspaceId, tab.id)
    return { tab: (attached.tab as Record<string, unknown>) || toWorkspaceTabSummary(state, tab) }
  }

  async function decorateTabs(tabs: TabSummary[], detailed = false): Promise<TabSummary[]> {
    await ensureLoaded()
    await pruneExpired()
    return tabs.map((tab) => {
      const attachment =
        typeof tab.id === 'number' ? state.workspaces.attachments.get(tab.id) : null
      return {
        ...tab,
        workspace: attachment?.workspaceId ?? null,
        attachment: attachment?.mode ?? null,
        attachable: !attachment,
        ...(detailed && attachment
          ? { lastActiveAt: attachment.lastActiveAt, leaseExpiresAt: attachment.leaseExpiresAt }
          : {}),
      }
    })
  }

  async function current(workspaceId: string): Promise<Record<string, unknown>> {
    const workspace = await ensureWorkspace(workspaceId)
    await pruneExpired()
    const tabs = Array.from(state.workspaces.attachments.values()).filter(
      (attachment) => attachment.workspaceId === workspace.id,
    )
    await touch(workspace)
    for (const attachment of tabs) await touch(workspace, attachment.tabId)
    return { workspace, tabs }
  }

  async function list(): Promise<Record<string, unknown>> {
    await ensureLoaded()
    await pruneExpired()
    return {
      workspaces: Array.from(state.workspaces.workspaces.values()).map((workspace) => ({
        ...workspace,
        tabIds: Array.from(state.workspaces.attachments.values())
          .filter((attachment) => attachment.workspaceId === workspace.id)
          .map((attachment) => attachment.tabId),
      })),
    }
  }

  async function clearTarget(workspaceId: string): Promise<Record<string, unknown>> {
    const workspace = await ensureWorkspace(workspaceId)
    workspace.targetTabId = null
    await touch(workspace)
    return { workspace: workspace.id, targetTabId: null }
  }

  async function release(workspaceId: string): Promise<Record<string, unknown>> {
    await ensureLoaded()
    const id = normalizeWorkspaceId(workspaceId)
    const attachments = Array.from(state.workspaces.attachments.values()).filter(
      (attachment) => attachment.workspaceId === id,
    )
    for (const attachment of attachments) state.workspaces.attachments.delete(attachment.tabId)
    state.workspaces.workspaces.delete(id)
    await persist()
    return { released: true, workspace: id, detachedTabs: attachments.map((item) => item.tabId) }
  }

  return {
    attach,
    clearTarget,
    consumeAutoAttachment,
    createWorkspaceTab,
    current,
    decorateTabs,
    detach,
    list,
    release,
    resolveCommandTab,
    startCommandLease,
  }
}

function toWorkspaceTabSummary(_state: ExtensionState, tab: chrome.tabs.Tab): TabSummary {
  return {
    id: typeof tab.id === 'number' ? tab.id : null,
    handle: typeof tab.id === 'number' ? `t${tab.id}` : null,
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    status: tab.status || '',
    windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
  }
}
