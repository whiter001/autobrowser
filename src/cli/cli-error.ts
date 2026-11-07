import { describeErrorCode } from '../core/error-actions.js'
import { errorRetryable } from '../core/tool-error.js'

/**
 * CLI 解析期错误契约。
 *
 * 运行期错误由 relay 返回 {ok:false,error:{code,...}}，解析期错误此前是裸文本，
 * agent 按"stdout 永远是 JSON"解析时会在最需要它的时候崩掉。这里给解析期错误补齐
 * 同一套结构：错误码 + 默认 suggestedAction，输出位置也跟运行期一致（stdout）。
 */
export const CLI_ERROR_CODES = {
  /** 命令行用法错误：缺参、多参、取值非法、未知选项 */
  INVALID_ARGUMENT: 'CLI_INVALID_ARGUMENT',
  /** 顶层命令名不存在 */
  UNKNOWN_COMMAND: 'CLI_UNKNOWN_COMMAND',
  /** 其它 CLI 层失败（连不上服务、产物缺失等），不是用法问题 */
  FAILED: 'CLI_ERROR',
} as const

export interface CliUsageErrorInit {
  code?: string
  details?: unknown
  suggestedAction?: string
}

/** 解析期错误：带错误码与修复建议，最终由 CLI 统一出口按 JSON 契约输出。 */
export class CliUsageError extends Error {
  readonly code: string
  readonly details: unknown
  readonly suggestedAction: string | undefined

  constructor(message: string, init: CliUsageErrorInit = {}) {
    super(message)
    this.name = 'CliUsageError'
    this.code = init.code ?? CLI_ERROR_CODES.INVALID_ARGUMENT
    this.details = init.details
    this.suggestedAction = init.suggestedAction
  }
}

// 用法类错误的措辞高度一致（missing/invalid/unsupported/...），没有显式错误码时按措辞兜底分类；
// 匹配不上的一律算 CLI_ERROR，避免把连接失败之类的运行期问题误标成"参数写错了"。
const USAGE_MESSAGE_PATTERN =
  /^(missing|invalid|unsupported|unexpected|duplicate|--)|\brequires\b|\bmust be\b|cannot be combined/i

const FALLBACK_ACTION =
  "Inspect 'status', 'command list' and the current page state before retrying, and keep using autobrowser rather than switching to another automation framework."

export function resolveCliErrorCode(error: unknown): string {
  if (error instanceof CliUsageError) {
    return error.code
  }

  const explicitCode = (error as { code?: unknown } | null | undefined)?.code
  if (typeof explicitCode === 'string' && explicitCode) {
    return explicitCode
  }

  const message = error instanceof Error ? error.message : String(error)
  return USAGE_MESSAGE_PATTERN.test(message)
    ? CLI_ERROR_CODES.INVALID_ARGUMENT
    : CLI_ERROR_CODES.FAILED
}

/** 把任意异常收敛成带错误码的解析期错误，保留原始 message 与 details。 */
export function toCliError(error: unknown, code?: string): CliUsageError {
  if (error instanceof CliUsageError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  const source = error as { details?: unknown; detail?: unknown } | null | undefined
  const details =
    source?.details !== undefined
      ? source.details
      : source?.detail !== undefined
        ? { detail: source.detail }
        : undefined
  return new CliUsageError(message, {
    code: code ?? resolveCliErrorCode(error),
    details,
  })
}

export interface CliErrorPayload {
  ok: false
  error: {
    message: string
    code: string
    retryable: boolean
    details?: unknown
    suggestedAction: string
  }
}

function mergeDetails(details: unknown, command?: string): unknown {
  if (!command) {
    return details
  }

  if (details && typeof details === 'object' && !Array.isArray(details)) {
    return { ...(details as Record<string, unknown>), command }
  }

  return { command }
}

function readHelpPath(details: unknown): string | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return undefined
  }

  const record = details as Record<string, unknown>
  const path = record.path ?? record.command
  return typeof path === 'string' && path ? path : undefined
}

function resolveSuggestedAction(error: CliUsageError, code: string, details: unknown): string {
  if (error.suggestedAction) {
    return error.suggestedAction
  }

  if (code === CLI_ERROR_CODES.INVALID_ARGUMENT) {
    const helpPath = readHelpPath(details)
    if (helpPath) {
      return `Run 'autobrowser help ${helpPath}' to see the accepted arguments, then run the command again with a corrected value.`
    }
    return "Run 'autobrowser help' to see the supported commands and global flags, then run the command again with a corrected value."
  }

  return describeErrorCode(code)?.action ?? FALLBACK_ACTION
}

/**
 * 把解析期错误组装成与运行期一致的响应体。
 * details 里带上命令名，agent 才能知道是哪个命令的参数出了问题。
 */
export function buildCliErrorPayload(
  error: unknown,
  options: { command?: string } = {},
): CliErrorPayload {
  const normalized = toCliError(error)
  const details = mergeDetails(normalized.details, options.command)

  return {
    ok: false,
    error: {
      message: normalized.message,
      code: normalized.code,
      retryable: errorRetryable(normalized.code),
      ...(details === undefined ? {} : { details }),
      suggestedAction: resolveSuggestedAction(normalized, normalized.code, details),
    },
  }
}

/**
 * CLI 统一错误出口。
 *
 * JSON 模式下错误写 stdout（和运行期失败同一位置，stdout 始终是合法 JSON）；
 * 文本模式下写 stderr，并附上 suggestedAction。
 */
export function writeCliError(
  error: unknown,
  options: { json: boolean; command?: string },
): number {
  const payload = buildCliErrorPayload(error, options)

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 1
  }

  process.stderr.write(
    `${payload.error.message}\n\n[AI SUGGESTION]: ${payload.error.suggestedAction}\n`,
  )
  return 1
}
