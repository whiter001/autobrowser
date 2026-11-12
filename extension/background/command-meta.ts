import { getOrCreateTabHandle, getPageEpoch, resolveEffectiveFrameSelector } from './targeting.js'
import { commandSupportsTabTarget } from '../../src/core/command-spec.js'
import type {
  CommandArgs,
  CommandMeta,
  ExtensionState,
  FrameSelector,
  TabInput,
  TabWithId,
} from './types.js'

interface CommandMetaDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 读取 tab 目标参数；与路由器的 readTabInputArg 保持同一口径 */
function readTabInputArg(args: CommandArgs, key: string): TabInput {
  const value = args[key]
  return typeof value === 'number' || typeof value === 'string' || value == null ? value : undefined
}

/**
 * 命令元数据构建器：meta 内容、target 兜底说明与结果附加逻辑都收敛在这里，
 * 状态与目标 tab 查询由调用方注入，避免反向依赖路由器。
 */
export function createCommandMetaBuilder({ state, getTargetTab }: CommandMetaDependencies) {
  /** 无页面上下文的命令（status/tab.list/script/batch 等）返回的元数据全为 null */
  function emptyCommandMeta(): CommandMeta {
    return {
      tabHandle: null,
      tabId: null,
      frame: null,
      pageEpoch: null,
      url: null,
      title: null,
    }
  }

  /** 构建命令实际目标 tab 的上下文元数据；取 tab 失败时回退为全 null，永不 throw */
  async function buildCommandMeta(
    command: string,
    args: CommandArgs,
    tabTarget: TabInput,
    frameSelector: FrameSelector,
    options: {
      pinnedTabId: number | null
      targetTabIdBeforeCommand: number | null
      autoAttached?: boolean
    },
  ): Promise<CommandMeta> {
    if (!commandSupportsTabTarget(command)) {
      return emptyCommandMeta()
    }

    // 命令是否显式指定了 tabId/handle；未指定时 getTargetTab 内部可能走了兜底选择
    const explicitTarget =
      readTabInputArg(args, 'tabId') !== undefined || readTabInputArg(args, 'handle') !== undefined
    // getTargetTab 会 rememberTargetTab；固定目标时它发生在命令执行之前，
    // 再读只会看到固定后的值、fallback note 不再出现，故用执行前捕获的旧值
    const preCommandTargetTabId =
      options.pinnedTabId === null ? state.targeting.targetTabId : options.targetTabIdBeforeCommand

    let tab
    try {
      tab = await getTargetTab(tabTarget)
    } catch {
      return emptyCommandMeta()
    }

    if (!tab || typeof tab.id !== 'number') {
      return emptyCommandMeta()
    }

    const handle = getOrCreateTabHandle(state, tab.id)
    const meta: CommandMeta = {
      tabHandle: handle,
      tabId: tab.id,
      frame: resolveEffectiveFrameSelector(state, { id: tab.id }, frameSelector),
      pageEpoch: getPageEpoch(state, tab.id),
      url: tab.url || null,
      title: tab.title || null,
    }

    const openDialog = state.session.dialogs.get(tab.id)
    if (openDialog) {
      meta.dialog = {
        type: openDialog.type,
        message: openDialog.message,
        openedAt: openDialog.openedAt,
      }
    }

    const emulationOverrides = state.session.emulation.get(tab.id)
    if (emulationOverrides && Object.keys(emulationOverrides).length > 0) {
      meta.emulation = { ...emulationOverrides }
    }

    const target: NonNullable<CommandMeta['target']> = {
      tabId: tab.id,
      handle,
      explicit: explicitTarget,
    }
    if (!options.autoAttached && !explicitTarget && preCommandTargetTabId !== tab.id) {
      target.note = 'fell back to last non-active tab'
    }
    meta.target = target

    return meta
  }

  /** 只对对象结果增量附加 meta；原始值/数组保持原样透传 */
  function attachCommandMeta(result: unknown, meta: CommandMeta): unknown {
    if (!isRecord(result)) {
      return result
    }
    // 导航类命令（goto/open）结果体里带新 url，覆盖 buildCommandMeta 从 tabsGet 拿到的旧值
    const effectiveUrl =
      typeof result.observedUrl === 'string'
        ? result.observedUrl
        : typeof result.url === 'string'
          ? result.url
          : null
    const effectiveMeta = effectiveUrl ? { ...meta, url: effectiveUrl } : meta
    // 回落到非活动标签页时，在结果主体（而非仅 meta）给出可见提示，避免 agent 忽略。
    // meta.target.note 保留供程序化判断；targetFallback 是给调用方/人看的显式信号。
    const targetFallback =
      meta.target && !meta.target.explicit && meta.target.note ? meta.target.note : null
    if (targetFallback) {
      return { ...result, targetFallback, meta: effectiveMeta }
    }
    return { ...result, meta: effectiveMeta }
  }

  return { emptyCommandMeta, buildCommandMeta, attachCommandMeta }
}
