import type {
  EvaluateInTabContextOptions,
  ExtensionState,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  TabInput,
  TabWithId,
} from './types.js'

/**
 * page-observe 各功能模块（screenshot/snapshot/find/search/feed/wait）共享的依赖。
 * 由 createPageObserveDomain 统一注入，模块内部不再自行读取全局状态，
 * 便于按职责拆分文件而不改变 CDP 调用路径。
 */
export interface PageObserveDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  resolveElementSelectorForTab: (
    tabId: TabInput,
    selector: string,
  ) => Promise<ResolvedSelectorTarget>
  resolveFrameTarget: (tabId: TabInput, selector: string) => Promise<ResolvedFrameTarget>
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
  ) => Promise<TResult>
}
