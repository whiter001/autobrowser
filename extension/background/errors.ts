import type { ErrorWithCode } from './types.js'

export interface SerializedCommandError {
  message: string
  code?: string
  details?: unknown
  suggestedAction?: string
  ref?: string
  expectedPageEpoch?: number
  currentPageEpoch?: number
}

// 单命令响应和 batch 步骤共用的错误序列化：
// suggestedAction/ref/pageEpoch 等引导字段对 AI 自愈很关键，两条路径都不能丢
export function serializeCommandError(error: unknown): SerializedCommandError {
  const err = error as ErrorWithCode
  return {
    message: err.message || 'extension command failed',
    code: err.code || 'EXTENSION_COMMAND_ERROR',
    ...(typeof err.details !== 'undefined' ? { details: err.details } : {}),
    ...(err.suggestedAction ? { suggestedAction: err.suggestedAction } : {}),
    ...(err.ref ? { ref: err.ref } : {}),
    ...(typeof err.expectedPageEpoch === 'number'
      ? { expectedPageEpoch: err.expectedPageEpoch }
      : {}),
    ...(typeof err.currentPageEpoch === 'number' ? { currentPageEpoch: err.currentPageEpoch } : {}),
  }
}
