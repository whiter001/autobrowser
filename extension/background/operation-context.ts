export interface OperationContext {
  readonly cancelled: boolean
  readonly signal: AbortSignal
  readonly deadlineAt: string | null
  throwIfCancelled: () => void
}

export function createCancellationError(id: string, reason: string): Error & { code?: string } {
  const error = new Error(`command ${id} cancelled: ${reason}`) as Error & { code?: string }
  error.code = 'COMMAND_CANCELLED'
  return error
}

/** 队列只触发一次取消；具体命令通过 signal 注册真正可中止的底层操作。 */
export function createOperationContext(id: string, deadlineAt: string | null) {
  const controller = new AbortController()
  const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : Number.NaN
  const timer = Number.isFinite(deadlineMs)
    ? setTimeout(() => cancel('deadline elapsed'), Math.max(0, deadlineMs - Date.now()))
    : null

  const context: OperationContext = {
    get cancelled() {
      return controller.signal.aborted
    },
    signal: controller.signal,
    deadlineAt,
    throwIfCancelled() {
      if (!controller.signal.aborted) return
      const reason = controller.signal.reason
      throw reason instanceof Error ? reason : createCancellationError(id, String(reason))
    },
  }

  function cancel(reason: string): void {
    if (!controller.signal.aborted) controller.abort(createCancellationError(id, reason))
  }

  function dispose(): void {
    if (timer) clearTimeout(timer)
  }

  return { context, cancel, dispose }
}

const CDP_DEADLINE_EXCEEDED = 'CDP_DEADLINE_EXCEEDED'

/** 给无法统一中止的 Promise 加逻辑上界；调用方仍需保留底层恢复动作。 */
export function withHardDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const boundedMs = Math.max(1, Math.floor(ms))
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} got no CDP response within ${boundedMs}ms`) as Error & {
        code?: string
      }
      error.code = CDP_DEADLINE_EXCEEDED
      reject(error)
    }, boundedMs)
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export function isDeadlineExceeded(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === CDP_DEADLINE_EXCEEDED
  )
}
