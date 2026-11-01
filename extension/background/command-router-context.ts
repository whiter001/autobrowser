import type { CommandArgs, FrameSelector, SavedStateData, TabInput } from './types.js'

/** 命令参数读取器：全部是纯函数，取值口径跨域统一，改动会让所有域一起漂移 */
export function readStringArg(args: CommandArgs, key: string, fallback = ''): string {
  const value = args[key]
  return typeof value === 'string' ? value : fallback
}

/**
 * 读取可选字符串参数；类型不符按“未提供”处理，不在读取阶段抛错。
 */
export function readOptionalStringArg(args: CommandArgs, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 读取数字参数，非有限数回落到默认值，避免 NaN 流进下游计算。
 */
export function readNumberArg(args: CommandArgs, key: string, fallback = 0): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 读取可选数字参数，非有限数按未提供处理。
 */
export function readOptionalNumberArg(args: CommandArgs, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读取布尔参数，其它类型一律回落到默认值。
 */
export function readBooleanArg(args: CommandArgs, key: string, fallback = false): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 读取字符串数组参数，并过滤掉非字符串项——agent 常把混合类型塞进数组。
 */
export function readStringArrayArg(args: CommandArgs, key: string): string[] {
  const value = args[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/**
 * 读取普通对象参数；数组与 null 都视为未提供。
 */
export function readObjectArg(args: CommandArgs, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 读取 headers 参数，同时兼容 HAR 风格的 [{name,value}] 与普通对象两种写法。
 */
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

/**
 * 读取保存的页面状态快照参数（cookies/localStorage 等恢复用）。
 */
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
