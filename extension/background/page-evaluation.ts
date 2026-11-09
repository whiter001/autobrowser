import type { CommandExecutionContext } from './command-queue.js'
import type {
  ErrorWithCode,
  EvaluateInTabContextOptions,
  FrameExecutionContext,
  FrameSelector,
  TabInput,
  TabWithId,
} from './types.js'

// 页面脚本挂起时先于 server 30s 命令超时把 evaluate 掐掉，避免长等
const DEFAULT_EVALUATE_TIMEOUT_MS = 25_000

interface PageEvaluationDependencies {
  getFrameExecutionContext: (
    tabId: TabInput,
    frameSelector: FrameSelector,
  ) => Promise<FrameExecutionContext>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
  clearWorldContext: (key: string) => void
}

function isStaleWorldContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cannot find context/i.test(message)
}

// CDP 超时中断 evaluate 的报错文案不统一（同步挂起是 "Execution was terminated"，
// 部分版本是 "Script execution timed out"），两种都要识别
function isEvaluationTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed\s*out|execution was terminated|execution terminated/i.test(message)
}

function createEvaluationTimeoutError(timeoutMs: number): ErrorWithCode {
  const error = new Error(`page evaluation timed out after ${timeoutMs}ms`) as ErrorWithCode
  error.code = 'EVALUATION_TIMEOUT'
  error.suggestedAction =
    'Keep the original task goal, split complex eval into smaller steps, and pass complex source with --file or --stdin. Increase --timeout-ms only after confirming this is a long-running page task.'
  return error
}

function createPageEvaluationExceptionError(description: string): ErrorWithCode {
  const error = new Error(`page evaluation failed: ${description}`) as ErrorWithCode
  error.code = 'PAGE_EVALUATION_EXCEPTION'
  const invalidCssSelector =
    /failed to execute ['"](?:querySelector|querySelectorAll|matches|closest)['"]/i.test(
      description,
    ) && /not a valid selector/i.test(description)
  error.suggestedAction = invalidCssSelector
    ? 'The script was parsed and ran, but the page rejected a CSS selector. Quote CSS attribute values (for example, a[href*="/status/"]); use eval --file <path> or eval --stdin for complex source to keep shell, JavaScript, and CSS quoting separate.'
    : 'Check the original script, pass complex or multiline source with eval --file <path> or eval --stdin to avoid shell escaping issues, diagnose page state with snapshot, console, or status, then retry around the original task goal.'
  return error
}

export function unwrapEvaluationResult<TValue = unknown>(result: unknown): TValue | null {
  if (!result) return null

  const evaluationResult = result as {
    type?: string
    value?: unknown
    description?: string | null
  }
  if (Object.prototype.hasOwnProperty.call(evaluationResult, 'value')) {
    return evaluationResult.value as TValue
  }
  if (evaluationResult.type === 'undefined') return null
  return (evaluationResult.description || null) as TValue | null
}

/** 页面求值与 isolated world 失效重试；只重试尚未成功执行的缓存上下文失效请求。 */
export function createPageEvaluation({
  getFrameExecutionContext,
  sendDebuggerCommand,
  clearWorldContext,
}: PageEvaluationDependencies) {
  async function evaluateInTabContext<TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options: EvaluateInTabContextOptions = {},
  ): Promise<{
    tab: TabWithId
    response: { result: unknown }
    value: TValue | null
  }> {
    const {
      frameSelector,
      commandContext,
      timeoutMs = DEFAULT_EVALUATE_TIMEOUT_MS,
      ...runtimeOptions
    } = options
    commandContext?.throwIfCancelled()
    const context = await getFrameExecutionContext(tabId, frameSelector)
    commandContext?.throwIfCancelled()
    let { tab, executionContextId } = context

    const evaluate = (contextId: number | null) =>
      sendDebuggerCommand<{
        result: unknown
        exceptionDetails?: {
          text?: string
          exception?: { description?: string }
        }
      }>(
        tab.id,
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: Math.max(1, Math.floor(timeoutMs)),
          ...(contextId ? { contextId } : {}),
          ...runtimeOptions,
        },
        commandContext,
      )

    let response: Awaited<ReturnType<typeof evaluate>>
    const evaluationStartedAt = Date.now()
    try {
      response = await evaluate(executionContextId)
    } catch (error) {
      commandContext?.throwIfCancelled()
      const message = error instanceof Error ? error.message : String(error)
      // 部分 Chromium 在 Runtime.evaluate 到期时返回 Internal error，而不是超时文本；
      // 只有确实耗尽本次预算才映射，避免把普通的内部错误误报为超时。
      const internalErrorAtDeadline =
        /internal error/i.test(message) &&
        Date.now() - evaluationStartedAt >= Math.max(1, Math.floor(timeoutMs)) - 100
      if (isEvaluationTimeoutError(error) || internalErrorAtDeadline) {
        throw createEvaluationTimeoutError(timeoutMs)
      }
      if (!context.worldFromCache || !context.worldCacheKey || !isStaleWorldContextError(error)) {
        throw error
      }
      clearWorldContext(context.worldCacheKey)
      const retryContext = await getFrameExecutionContext(tabId, frameSelector)
      commandContext?.throwIfCancelled()
      tab = retryContext.tab
      executionContextId = retryContext.executionContextId
      response = await evaluate(executionContextId)
    }
    // 页面内表达式抛异常时 CDP 不返回 value，必须把真实异常原因抛给调用方，
    // 否则 description 字符串会被当成正常结果继续传递
    if (response.exceptionDetails) {
      const details = response.exceptionDetails
      const description = details.exception?.description || details.text || 'unknown error'
      if (isEvaluationTimeoutError(description)) throw createEvaluationTimeoutError(timeoutMs)
      throw createPageEvaluationExceptionError(description)
    }
    return {
      tab,
      response,
      value: unwrapEvaluationResult<TValue>(response.result),
    }
  }

  return { evaluateInTabContext }
}
