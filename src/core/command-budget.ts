export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const MAX_REQUEST_TIMEOUT_MS = 30 * 60_000
export const COMMAND_TRANSPORT_ALLOWANCE_MS = 5_000
export const MAX_BATCH_DEPTH = 16
const MAX_BATCH_NODES = 10_000
const MAX_BATCH_RETRIES = 1_000

function invalidBudget(command: string, reason: string): never {
  throw Object.assign(new Error(`invalid command arguments for ${command}: ${reason}`), {
    code: 'INVALID_COMMAND_ARGS',
    details: { command, reason, maxRequestTimeoutMs: MAX_REQUEST_TIMEOUT_MS },
  })
}

/** 浏览器与 relay 共用；先限制递归规模，再计算最坏情况下的重试预算，绝不静默截断。 */
export function getCommandRequestBudgetMs(
  command: string,
  args: Record<string, unknown> = {},
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  let nodes = 0
  function bounded(value: number, name: string): number {
    if (!Number.isFinite(value)) invalidBudget(command, `${name} must be a finite number`)
    if (value < 0) invalidBudget(command, `${name} must be a non-negative number`)
    if (value > MAX_REQUEST_TIMEOUT_MS) {
      invalidBudget(command, `${name} must not exceed ${MAX_REQUEST_TIMEOUT_MS}ms`)
    }
    return value
  }
  bounded(defaultTimeoutMs, 'default request budget')
  if (defaultTimeoutMs <= 0) invalidBudget(command, 'default request budget must be positive')

  function visit(name: string, input: Record<string, unknown>, depth: number): number {
    if (++nodes > MAX_BATCH_NODES || depth > MAX_BATCH_DEPTH) {
      invalidBudget(
        command,
        `batch exceeds ${MAX_BATCH_DEPTH} nesting levels or ${MAX_BATCH_NODES} commands`,
      )
    }
    const duration = (key: string): number | undefined => {
      const value = input[key]
      if (value === undefined || value === null) return undefined
      if (typeof value !== 'number') invalidBudget(name, `${key} must be a finite number`)
      return bounded(value, key)
    }
    if (name === 'batch') {
      const retries = input.retries ?? 0
      if (
        typeof retries !== 'number' ||
        !Number.isInteger(retries) ||
        retries < 0 ||
        retries > MAX_BATCH_RETRIES
      ) {
        invalidBudget(
          name,
          `retries must be a non-negative integer no greater than ${MAX_BATCH_RETRIES}`,
        )
      }
      const delay = duration('retryDelayMs') ?? 0
      const steps = input.steps
      if (!Array.isArray(steps)) return defaultTimeoutMs
      if (steps.length > MAX_BATCH_NODES) invalidBudget(name, 'too many batch steps')
      let total = 0
      for (const step of steps) {
        const record = step && typeof step === 'object' ? (step as Record<string, unknown>) : {}
        const childName =
          typeof step === 'string' ? step.trim() : String(record.command ?? '').trim()
        const childArgs =
          record.args && typeof record.args === 'object' && !Array.isArray(record.args)
            ? (record.args as Record<string, unknown>)
            : {}
        const budget = visit(childName, childArgs, depth + 1)
        total = bounded(total + budget * (retries + 1) + delay * retries, 'batch request budget')
      }
      return Math.max(defaultTimeoutMs, total)
    }

    let explicit: number | undefined
    if (['eval', 'goto', 'open', 'click', 'reload'].includes(name)) {
      explicit = duration('timeoutMs')
      if (name === 'goto' || name === 'open') {
        duration('settleTimeoutMs')
        duration('domQuietMs')
      }
      // reload 的附加等待在导航后运行，两段都必须纳入预算。
      if (name === 'reload' && input.waitFor) {
        explicit = (explicit ?? defaultTimeoutMs) * 2
      }
    } else if (name === 'wait') {
      const timeout = duration('timeout')
      const ms = duration('ms')
      explicit = ms !== undefined && ms > 0 ? ms : timeout
    }
    return explicit === undefined
      ? defaultTimeoutMs
      : bounded(
          Math.max(defaultTimeoutMs, explicit + COMMAND_TRANSPORT_ALLOWANCE_MS),
          'request budget',
        )
  }
  return visit(command, args, 0)
}
