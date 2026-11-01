import { getPageEpoch } from './targeting.js'
import { paginateList } from './pagination.js'
import {
  readNumberArg,
  readOptionalNumberArg,
  readOptionalStringArg,
  readStringArg,
  type CommandRunScope,
} from './command-router-context.js'
import type { ConsoleMessageRecord, ExtensionState, FrameSelector, TabInput } from './types.js'

export interface TracingDomain {
  start: (tabId: TabInput) => Promise<unknown>
  status: (tabId: TabInput) => Promise<unknown>
  stop: (tabId: TabInput) => Promise<unknown>
}

export interface VideoDomain {
  start: (tabId: TabInput, maxDurationMs?: number) => Promise<unknown>
  status: (tabId: TabInput) => Promise<unknown>
  stop: (tabId: TabInput) => Promise<unknown>
  chapter: (
    tabId: TabInput,
    title: string,
    description?: string,
    durationMs?: number,
  ) => Promise<unknown>
  showActions: (
    tabId: TabInput,
    options: { durationMs: number; position: string; highlightStyle?: string },
  ) => Promise<unknown>
  hideActions: (tabId: TabInput) => Promise<unknown>
  handleAction: (
    command: string,
    tabId: number,
    frameSelector: FrameSelector,
    selector: string,
    ok: boolean,
  ) => Promise<void>
}

interface DiagnosticsCommandDependencies {
  state: ExtensionState
  tracing: TracingDomain
  video: VideoDomain
}

type FoldedConsoleMessage = ConsoleMessageRecord & { repeatCount?: number }

/** 连续相同（type+text）的 console 消息折叠成一条，折叠结果带 repeatCount；不改动原始数组 */
function foldConsoleMessages(messages: ConsoleMessageRecord[]): FoldedConsoleMessage[] {
  const folded: FoldedConsoleMessage[] = []
  for (const message of messages) {
    const previous = folded[folded.length - 1]
    if (previous && previous.type === message.type && previous.text === message.text) {
      // 用最后一条的时间戳，计数累加
      folded[folded.length - 1] = { ...message, repeatCount: (previous.repeatCount ?? 1) + 1 }
    } else {
      folded.push({ ...message })
    }
  }
  return folded
}

/** 诊断域命令：动作时间线、追踪/录像录制状态与页面错误、console 查询 */
export function createDiagnosticsCommandHandler({
  state,
  tracing,
  video,
}: DiagnosticsCommandDependencies) {
  async function handleDiagnosticsCommand(scope: CommandRunScope): Promise<unknown> {
    const { command, args, action, tabId, queryTargetTabId, pageIdx, pageSize } = scope
    switch (command) {
      case 'actions': {
        if (action === 'clear') {
          const count = state.session.actionLog.length
          state.session.actionLog = []
          return { cleared: true, count }
        }
        const actions = state.session.actionLog.filter(
          (entry) => queryTargetTabId === null || entry.tabId === queryTargetTabId,
        )
        const { items, pagination } = paginateList(actions, pageIdx, pageSize)
        return { actions: items, pagination }
      }
      case 'tracing':
        if (action === 'start') return await tracing.start(tabId)
        if (action === 'status') return await tracing.status(tabId)
        if (action === 'stop') return await tracing.stop(tabId)
        throw new Error(`unsupported tracing action: ${action}`)
      case 'video':
        if (action === 'start')
          return await video.start(tabId, readOptionalNumberArg(args, 'maxDurationMs'))
        if (action === 'status') return await video.status(tabId)
        if (action === 'stop') return await video.stop(tabId)
        if (action === 'chapter')
          return await video.chapter(
            tabId,
            readStringArg(args, 'title'),
            readOptionalStringArg(args, 'description'),
            readOptionalNumberArg(args, 'durationMs'),
          )
        if (action === 'show-actions')
          return await video.showActions(tabId, {
            durationMs: readNumberArg(args, 'durationMs', 600),
            position: readStringArg(args, 'position', 'top:16px;right:16px;'),
            ...(readOptionalStringArg(args, 'highlightStyle')
              ? { highlightStyle: readOptionalStringArg(args, 'highlightStyle') }
              : {}),
          })
        if (action === 'hide-actions') return await video.hideActions(tabId)
        throw new Error(`unsupported video action: ${action}`)
      case 'console': {
        const targetTabId = queryTargetTabId
        if (action === 'clear') {
          const before = state.session.consoleMessages.length
          state.session.consoleMessages = state.session.consoleMessages.filter(
            (message) => targetTabId !== null && message.tabId !== targetTabId,
          )
          return { cleared: before - state.session.consoleMessages.length }
        }
        const since = readNumberArg(args, 'since', 0)
        const level = readStringArg(args, 'level')
        const maxLevelRank = level ? ['error', 'warning', 'info', 'debug'].indexOf(level) : null
        const currentEpoch = targetTabId === null ? null : getPageEpoch(state, targetTabId)
        const messages = (
          targetTabId === null
            ? state.session.consoleMessages
            : state.session.consoleMessages.filter((message) => message.tabId === targetTabId)
        ).filter((message) => {
          const type = String(message.type || '')
          const levelRank = type === 'error' ? 0 : type === 'warning' ? 1 : type === 'debug' ? 3 : 2
          return (
            message.timestamp >= since &&
            (maxLevelRank === null || levelRank <= maxLevelRank) &&
            (args.allEpochs === true ||
              currentEpoch === null ||
              message.pageEpoch == null ||
              message.pageEpoch === currentEpoch)
          )
        })
        // level 必须在折叠和分页前过滤，total/pagination 才与返回结果一致
        const { items, pagination } = paginateList(foldConsoleMessages(messages), pageIdx, pageSize)
        return { messages: items, pagination }
      }
      case 'errors': {
        const targetTabId = queryTargetTabId
        if (action === 'clear') {
          const before = state.session.pageErrors.length
          state.session.pageErrors = state.session.pageErrors.filter(
            (error) => targetTabId !== null && error.tabId !== targetTabId,
          )
          return { cleared: before - state.session.pageErrors.length }
        }
        const since = readNumberArg(args, 'since', 0)
        const currentEpoch = targetTabId === null ? null : getPageEpoch(state, targetTabId)
        const errors = (
          targetTabId === null
            ? state.session.pageErrors
            : state.session.pageErrors.filter((error) => error.tabId === targetTabId)
        ).filter(
          (error) =>
            error.timestamp >= since &&
            (args.allEpochs === true ||
              currentEpoch === null ||
              error.pageEpoch == null ||
              error.pageEpoch === currentEpoch),
        )
        const { items, pagination } = paginateList(errors, pageIdx, pageSize)
        return { errors: items, pagination }
      }
      default:
        throw new Error(`unsupported command: ${command}`)
    }
  }

  return { handleDiagnosticsCommand }
}
