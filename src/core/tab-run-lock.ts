import type { ErrorWithCode } from './runtime-types.js'

interface IdleWaiter {
  resolve: () => void
  timer: ReturnType<typeof setTimeout>
}

function pageScriptActiveError(tabId: number, pending: boolean): ErrorWithCode {
  const error = new Error(
    pending
      ? `a Playwright script is waiting for exclusive access to tab ${tabId}`
      : `a Playwright script is running exclusively on tab ${tabId}`,
  ) as ErrorWithCode
  error.code = 'PAGE_SCRIPT_ACTIVE'
  error.retryable = true
  error.details = { tabId }
  error.suggestedAction =
    'Wait for the Playwright script to finish, target another tab with --tab, or inspect the page before retrying.'
  return error
}

/** run 等待旧命令时也开始挡住新命令，避免等待结束后与新命令发生竞态。 */
export class TabRunLock {
  private activeCommands = new Map<number, number>()
  private activeRuns = new Map<number, string>()
  private pendingRuns = new Map<number, string>()
  private idleWaiters = new Map<number, Set<IdleWaiter>>()

  beginCommand(tabId: number | null): () => void {
    if (tabId === null) return () => {}
    if (this.activeRuns.has(tabId)) throw pageScriptActiveError(tabId, false)
    if (this.pendingRuns.has(tabId)) throw pageScriptActiveError(tabId, true)
    this.activeCommands.set(tabId, (this.activeCommands.get(tabId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.activeCommands.get(tabId) ?? 1) - 1
      if (remaining > 0) {
        this.activeCommands.set(tabId, remaining)
        return
      }
      this.activeCommands.delete(tabId)
      const waiters = this.idleWaiters.get(tabId)
      if (!waiters) return
      this.idleWaiters.delete(tabId)
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.resolve()
      }
    }
  }

  async acquireRun(tabId: number, runId: string, timeoutMs: number): Promise<() => void> {
    if (this.activeRuns.has(tabId)) throw pageScriptActiveError(tabId, false)
    if (this.pendingRuns.has(tabId)) throw pageScriptActiveError(tabId, true)
    this.pendingRuns.set(tabId, runId)
    try {
      if ((this.activeCommands.get(tabId) ?? 0) > 0) {
        await new Promise<void>((resolve, reject) => {
          const waiters = this.idleWaiters.get(tabId) ?? new Set<IdleWaiter>()
          const waiter: IdleWaiter = {
            resolve,
            timer: setTimeout(() => {
              waiters.delete(waiter)
              if (!waiters.size) this.idleWaiters.delete(tabId)
              const error = new Error(
                `timed out waiting for existing commands on tab ${tabId} before running the Playwright script`,
              ) as ErrorWithCode
              error.code = 'COMMAND_TIMEOUT'
              error.retryable = true
              error.details = { tabId, runId }
              reject(error)
            }, timeoutMs),
          }
          waiters.add(waiter)
          this.idleWaiters.set(tabId, waiters)
        })
      }
      this.activeRuns.set(tabId, runId)
    } finally {
      this.pendingRuns.delete(tabId)
    }

    let released = false
    return () => {
      if (released) return
      released = true
      if (this.activeRuns.get(tabId) === runId) this.activeRuns.delete(tabId)
    }
  }
}
