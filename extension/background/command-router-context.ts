import type { CommandArgs, FrameSelector, SavedStateData, TabInput } from './types.js'

/** 命令参数读取器：全部是纯函数，取值口径跨域统一，改动会让所有域一起漂移 */
export function readStringArg(args: CommandArgs, key: string, fallback = ''): string {
  const value = args[key]
  return typeof value === 'string' ? value : fallback
}

export function readOptionalStringArg(args: CommandArgs, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

export function readNumberArg(args: CommandArgs, key: string, fallback = 0): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function readOptionalNumberArg(args: CommandArgs, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readBooleanArg(args: CommandArgs, key: string, fallback = false): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

export function readStringArrayArg(args: CommandArgs, key: string): string[] {
  const value = args[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function readObjectArg(args: CommandArgs, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function readHeadersArg(
  args: CommandArgs,
  key: string,
): Array<{ name?: string; value?: unknown }> | Record<string, unknown> | undefined {
  const value = args[key]
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is { name?: string; value?: unknown } =>
        Boolean(item) && typeof item === 'object',
    )
  }

  return readObjectArg(args, key)
}

export function readSavedStateArg(args: CommandArgs, key: string): SavedStateData | undefined {
  const value = args[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as SavedStateData)
    : undefined
}

/**
 * 单次命令执行的共享上下文：把命令级只读参数一次性算好后交给各域 handler，
 * 这样拆出去的域不再反向依赖路由器，也不会各自重复读参数导致口径漂移。
 */
export interface CommandRunScope {
  /** 命令名 */
  command: string
  /** 原始参数 */
  args: CommandArgs
  /** 命令的二级动作 */
  action: string
  /** network 等命令的三级子动作 */
  subaction: string
  /** 导航/请求地址 */
  url: string
  /** 网络请求 id */
  requestId: string
  /** 固定后的目标 tab */
  tabId: TabInput
  /** 命令显式指定的 tab 目标（tabId/handle） */
  explicitTabTarget: TabInput
  /** 页面命令使用的 frame */
  frameSelector: FrameSelector
  /** 数据查询口径的目标 tab（与页面操作目标相互独立） */
  queryTargetTabId: number | null
  /** 分页页码 */
  pageIdx: number
  /** 分页大小 */
  pageSize: number
}
