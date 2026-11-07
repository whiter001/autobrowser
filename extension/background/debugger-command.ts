import type { CommandExecutionContext } from './command-queue.js'

interface DebuggerCommandDependencies {
  ensureDebuggerAttached: (tabId: number) => Promise<void>
  sendRawDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
}

/** 在发送业务 CDP 前后检查取消；已在途的 CDP 调用由具体命令决定如何恢复。 */
export function createDebuggerCommandSender({
  ensureDebuggerAttached,
  sendRawDebuggerCommand,
}: DebuggerCommandDependencies) {
  async function sendDebuggerCommand<TResult = unknown>(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {},
    context?: CommandExecutionContext,
  ): Promise<TResult> {
    context?.throwIfCancelled()
    await ensureDebuggerAttached(tabId)
    context?.throwIfCancelled()
    return await sendRawDebuggerCommand<TResult>(tabId, method, params)
  }

  return { sendDebuggerCommand }
}
