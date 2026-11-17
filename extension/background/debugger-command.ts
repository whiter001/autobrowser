import type { CommandExecutionContext } from './command-queue.js'
import { isDeadlineExceeded, withHardDeadline } from './operation-context.js'

interface DebuggerCommandDependencies {
  ensureDebuggerAttached: (tabId: number) => Promise<void>
  sendRawDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
  /** 测试可缩短硬截止；Runtime.evaluate 由页面评估器按脚本预算单独控制 */
  timeoutMs?: number
  /** 超时后丢弃卡死的调试会话；不重放原命令，下次使用时再 attach */
  recoverDebugger?: (tabId: number) => Promise<void>
}

/** 在发送业务 CDP 前后检查取消；已在途的 CDP 调用由具体命令决定如何恢复。 */
export function createDebuggerCommandSender({
  ensureDebuggerAttached,
  sendRawDebuggerCommand,
  timeoutMs = 25_000,
  recoverDebugger,
}: DebuggerCommandDependencies) {
  async function sendDebuggerCommand<TResult = unknown>(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {},
    context?: CommandExecutionContext,
    timeoutOverrideMs?: number,
  ): Promise<TResult> {
    const operation = async () => {
      context?.throwIfCancelled()
      await ensureDebuggerAttached(tabId)
      context?.throwIfCancelled()
      return await sendRawDebuggerCommand<TResult>(tabId, method, params)
    }
    if (method === 'Runtime.evaluate') return await operation()
    // 输入事件通常应立即返回；单独收紧到 5s，给释放/诊断和 relay 回执留下预算。
    const budgetMs = method.startsWith('Input.')
      ? Math.min(timeoutOverrideMs ?? timeoutMs, 5000)
      : (timeoutOverrideMs ?? timeoutMs)
    try {
      return await withHardDeadline(operation(), budgetMs, `${method} CDP command`)
    } catch (error) {
      if (isDeadlineExceeded(error) && recoverDebugger) {
        // 旧 attach 可能让后续所有 CDP 都无回执；只清理会话，是否重试由调用方核实页面后决定。
        await withHardDeadline(
          recoverDebugger(tabId),
          5000,
          `detach debugger for tab ${tabId}`,
        ).catch(() => {})
      }
      throw error
    }
  }

  return { sendDebuggerCommand }
}
