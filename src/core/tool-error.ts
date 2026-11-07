import { describeErrorCode } from './error-actions.js'

export interface ToolErrorOptions {
  details?: unknown
  suggestedAction?: string
}

export interface ToolError extends Error {
  code: string
  retryable: boolean
  details?: unknown
  suggestedAction?: string
}

/** 领域错误只选择稳定错误码；是否可重试由中央错误表统一派生。 */
export function createToolError(
  code: string,
  message: string,
  options: ToolErrorOptions = {},
): ToolError {
  const action = describeErrorCode(code)
  return Object.assign(new Error(message), {
    code,
    retryable: action?.retryable ?? false,
    ...(options.details !== undefined ? { details: options.details } : {}),
    ...(options.suggestedAction || action
      ? { suggestedAction: options.suggestedAction || action?.action }
      : {}),
  })
}

export function errorRetryable(code: string | null | undefined): boolean {
  return typeof code === 'string' ? (describeErrorCode(code)?.retryable ?? false) : false
}
