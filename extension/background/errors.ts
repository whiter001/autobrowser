import { errorRetryable } from '../../src/core/tool-error.js'
import type { ErrorWithCode } from './types.js'

export interface SerializedCommandError {
  message: string
  code?: string
  retryable?: boolean
  details?: unknown
  suggestedAction?: string
  ref?: string
  expectedPageEpoch?: number
  currentPageEpoch?: number
}

// Failed commands can retain completed work (for example navigation before a wait).
// Keep details intact for compatibility, and expose its result in both response paths.

/**
 * 把异常转成 {ok:false, error} 形式的命令响应；若错误 details 里带 result
 *（部分成功时留下的结果），一并透出给调用方。
 */
export function serializeCommandFailure(error: unknown): {
  ok: false
  error: SerializedCommandError
  result?: unknown
} {
  const serialized = serializeCommandError(error)
  const details = serialized.details
  return {
    ok: false,
    error: serialized,
    ...(details && typeof details === 'object' && 'result' in details
      ? { result: details.result }
      : {}),
  }
}

// 单命令响应和 batch 步骤共用的错误序列化：
// suggestedAction/ref/pageEpoch 等引导字段对 AI 自愈很关键，两条路径都不能丢

/**
 * 把任意异常收敛成结构化错误（message/code/suggestion/details），
 * 保证扩展侧的机器可读信息在 CLI 端不丢失。
 */
export function serializeCommandError(error: unknown): SerializedCommandError {
  const err = error as ErrorWithCode
  return {
    message: err.message || 'extension command failed',
    code: err.code || 'EXTENSION_COMMAND_ERROR',
    retryable: err.retryable ?? errorRetryable(err.code || 'EXTENSION_COMMAND_ERROR'),
    ...(typeof err.details !== 'undefined' ? { details: err.details } : {}),
    ...(err.suggestedAction ? { suggestedAction: err.suggestedAction } : {}),
    ...(err.ref ? { ref: err.ref } : {}),
    ...(typeof err.expectedPageEpoch === 'number'
      ? { expectedPageEpoch: err.expectedPageEpoch }
      : {}),
    ...(typeof err.currentPageEpoch === 'number' ? { currentPageEpoch: err.currentPageEpoch } : {}),
  }
}
