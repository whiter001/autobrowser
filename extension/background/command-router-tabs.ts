import { tabsCreate, tabsRemove, tabsUpdate, windowsUpdate } from './chrome.js'
import { getOrCreateTabHandle, rememberTargetTab, toTabSummary } from './targeting.js'
import { paginateList } from './pagination.js'
import {
  readOptionalNumberArg,
  readOptionalStringArg,
  readStringArg,
  type CommandRunScope,
} from './command-router-context.js'
import type { CommandQueue } from './command-queue.js'
import type { ExtensionControlDomain } from './extension-control.js'
import type { ExtensionState, TabInput, TabSummary, TabWithId } from './types.js'

interface TabsCommandDependencies {
  state: ExtensionState
  extensionControl: ExtensionControlDomain
  listTabs: () => Promise<TabSummary[]>
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  /** 命令队列：供 command list/reset 查询与重置 */
  commandQueue: CommandQueue
  /** 取消命令的统一入口（含运行中 eval 的定向中断） */
  cancelTrackedCommand: (id: string) => boolean
  /** 命令串行化队列的 key 解析 */
  resolveCommandQueueKey: (tabTarget: TabInput) => string
}

/** 标签页与控制面命令：tab 生命周期、目标选择、命令队列与扩展自身状态 */
export function createTabsCommandHandler({
  state,
  extensionControl,
  listTabs,
  getTargetTab,
  commandQueue,
  cancelTrackedCommand,
  resolveCommandQueueKey,
}: TabsCommandDependencies) {
  async function selectTab(tabHandle: TabInput) {
    const tab = await getTargetTab(tabHandle)
    const updatedTab = await tabsUpdate(tab.id, {
      active: true,
    })

    rememberTargetTab(state, tab.id)

    if (typeof updatedTab?.windowId === 'number') {
      try {
        await windowsUpdate(updatedTab.windowId, {
          focused: true,
        })
      } catch {
        // Best effort only.
      }
    }

    return {
      selected: true,
      tab: toTabSummary(state, updatedTab || tab),
    }
  }

  async function closeTab(tabHandle: TabInput) {
    const tab = await getTargetTab(tabHandle)
    const handle = getOrCreateTabHandle(state, tab.id)
    await tabsRemove([tab.id])
    return {
      closed: true,
      tab: {
        ...toTabSummary(state, tab),
        handle,
      },
    }
  }

  async function handleTabsCommand(scope: CommandRunScope): Promise<unknown> {
    const { command, args, action, url, explicitTabTarget, queryTargetTabId, pageIdx, pageSize } =
      scope
    switch (command) {
      case 'extension':
        if (action === 'info') return await extensionControl.info()
        if (action === 'reload') return extensionControl.reload()
        if (action === 'reconnect') return extensionControl.reconnect()
        throw new Error(`unsupported extension action: ${action} (expected info|reload|reconnect)`)
      case 'status':
        return {
          connected: true,
          tabs: await listTabs(),
        }
      case 'tab.list': {
        let tabs = await listTabs()
        const filter = readStringArg(args, 'filter').toLowerCase()
        if (args.active === true) tabs = tabs.filter((tab) => tab.active)
        if (args.currentWindow === true) {
          const targetId = queryTargetTabId
          const currentWindowId = tabs.find((tab) => tab.id === targetId)?.windowId
          if (typeof currentWindowId === 'number') {
            tabs = tabs.filter((tab) => tab.windowId === currentWindowId)
          }
        }
        if (filter) {
          tabs = tabs.filter((tab) =>
            `${tab.handle || ''} ${tab.title} ${tab.url}`.toLowerCase().includes(filter),
          )
        }
        const { items, pagination } = paginateList(tabs, pageIdx, pageSize, {
          limit: readOptionalNumberArg(args, 'limit'),
          cursor: readStringArg(args, 'cursor'),
          defaultLimit: 50,
          maxLimit: 200,
          queryKey: {
            filter,
            active: args.active,
            currentWindow: args.currentWindow,
            queryTargetTabId,
          },
          getKey: (tab) => String(tab.handle || tab.id),
        })
        return { tabs: items, total: tabs.length, pagination }
      }
      case 'tab.select':
        return await selectTab(explicitTabTarget)
      case 'tab.new': {
        const tab = await tabsCreate({
          url,
        })

        if (tab && typeof tab.id === 'number') {
          rememberTargetTab(state, tab.id)
        }

        return { tab: toTabSummary(state, tab || {}) }
      }
      case 'tab.close':
        return await closeTab(explicitTabTarget)
      case 'target': {
        if (action === 'show') {
          return { targetTabId: state.targeting.targetTabId }
        }
        if (action === 'clear') {
          rememberTargetTab(state, null)
          return { targetTabId: null }
        }
        if (action === 'active') {
          const tabs = await listTabs()
          const activeTab = tabs.find((tab) => tab.active && typeof tab.id === 'number')
          rememberTargetTab(state, activeTab?.id ?? null)
          return { target: activeTab || null }
        }
        if (action === 'set') {
          return await selectTab(explicitTabTarget)
        }
        throw new Error(`unsupported target action: ${action}`)
      }
      case 'command': {
        if (action === 'list' || action === 'status') {
          const commandId = readOptionalStringArg(args, 'commandId')
          const commands = commandQueue.list()
          const filtered = commandId ? commands.filter((entry) => entry.id === commandId) : commands
          const { items, pagination } = paginateList(filtered, pageIdx, pageSize, {
            limit: readOptionalNumberArg(args, 'limit'),
            cursor: readStringArg(args, 'cursor'),
            queryKey: { commandId },
            getKey: (item) => String(item.id),
          })
          return { commands: items, total: filtered.length, pagination }
        }
        if (action === 'cancel') {
          const commandId = readStringArg(args, 'commandId')
          return { commandId, cancelled: cancelTrackedCommand(commandId) }
        }
        if (action === 'reset') {
          const key =
            readOptionalStringArg(args, 'queueKey') || resolveCommandQueueKey(explicitTabTarget)
          return { queueKey: key, cancelled: commandQueue.reset(key) }
        }
        throw new Error(`unsupported command action: ${action}`)
      }
      default:
        throw new Error(`unsupported command: ${command}`)
    }
  }

  return { handleTabsCommand }
}
