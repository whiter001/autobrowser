import { buildDeepDomTraversalHelpersSource } from './deep-dom.js'
import type { CommandExecutionContext } from './command-queue.js'
import type {
  EvaluateInTabContextOptions,
  ExtensionState,
  FrameExecutionContext,
  FrameSelector,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  TabInput,
  TabWithId,
} from './types.js'

export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementActionResult extends Record<string, unknown> {
  found: boolean
  reason?: string
}

export interface FillFormField {
  selector: string
  value: string
}

export interface PageInputDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  resolveElementSelectorForTab: (
    tabId: TabInput,
    selector: string,
  ) => Promise<ResolvedSelectorTarget>
  resolveFrameTarget: (tabId: TabInput, selector: string) => Promise<ResolvedFrameTarget>
  getFrameExecutionContext: (
    tabId: TabInput,
    frameSelector: FrameSelector,
  ) => Promise<FrameExecutionContext>
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<{
    tab: TabWithId
    response: { result: unknown }
    value: TValue | null
  }>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
}

// 页面表达式前统一注入的深 DOM 遍历 helper 源码
export const PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE = buildDeepDomTraversalHelpersSource()

// 各子域命令（导航 / eval / 元素 / 键鼠）共享的上下文：
// 依赖、页面求值入口和等待工具都从这里注入，子模块之间只通过参数互相依赖，不互相 import
export interface PageInputContext {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  resolveElementSelectorForTab: (
    tabId: TabInput,
    selector: string,
  ) => Promise<ResolvedSelectorTarget>
  resolveFrameTarget: (tabId: TabInput, selector: string) => Promise<ResolvedFrameTarget>
  getFrameExecutionContext: (
    tabId: TabInput,
    frameSelector: FrameSelector,
  ) => Promise<FrameExecutionContext>
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<{
    tab: TabWithId
    response: { result: unknown }
    value: TValue | null
  }>
  evaluateInTabContextBase: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<{
    tab: TabWithId
    response: { result: unknown }
    value: TValue | null
  }>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
  sleep: (ms: number) => Promise<void>
}

export function createPageInputContext({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  getFrameExecutionContext,
  evaluateInTabContext: evaluateInTabContextBase,
  sendDebuggerCommand,
}: PageInputDependencies): PageInputContext {
  // 页面表达式默认带上深 DOM 遍历 helper；只有 readyState 这类极短表达式走 base
  const evaluateInTabContext = <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => {
    return evaluateInTabContextBase<TValue>(
      tabId,
      `${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}\n${expression}`,
      options,
    )
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  return {
    state,
    getTargetTab,
    resolveElementSelectorForTab,
    resolveFrameTarget,
    getFrameExecutionContext,
    evaluateInTabContext,
    evaluateInTabContextBase,
    sendDebuggerCommand,
    sleep,
  }
}
