import { serializeCommandFailure, type SerializedCommandError } from './errors.js'
import type { CommandExecutionContext } from './command-queue.js'
import type { CommandArgs, ErrorWithCode } from './types.js'

/** batch 步骤的条件：引用前置步骤的结果，再按 path/谓词匹配 */
interface BatchStepCondition {
  step: string | number
  path?: string
  equals?: unknown
  truthy?: boolean
  exists?: boolean
}

interface BatchCommandStep {
  command: string
  args: CommandArgs
  label: string | null
  id?: string | null
  when?: BatchStepCondition | null
  skipRemainingOnFailure?: boolean
}

interface BatchCommandStepResult {
  index: number
  command: string
  args: CommandArgs
  label: string | null
  id?: string
  skipped?: true
  reason?: string
  response?: { ok: true; result: unknown } | { ok: false; error: SerializedCommandError }
}

interface BatchCommandOptions {
  continueOnError: boolean
  retries: number
  retryDelayMs: number
}

interface BatchCommandSummary {
  total: number
  completed: number
  succeeded: number
  failed: number
  skippedCount: number
  retried: number
  continueOnError: boolean
  retries: number
  retryDelayMs: number
  terminated?: true
}

/** batch 步骤复用的命令执行入口；由路由器注入同一个 executeCommand，保持单一入口 */
type BatchCommandExecutor = (
  command: string,
  args?: CommandArgs,
  options?: {
    skipQueue?: boolean
    request?: { id?: string; deadlineAt?: string }
    context?: CommandExecutionContext
  },
) => Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readBooleanArg(args: CommandArgs, key: string, fallback = false): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

function readNumberArg(args: CommandArgs, key: string, fallback = 0): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * batch 命令处理器：步骤的规范化、条件求值、重试与汇总都收敛在这里，
 * 命令执行入口由调用方注入，避免反向依赖路由器。
 */
export function createBatchCommandHandler(executeCommand: BatchCommandExecutor) {
  function normalizeBatchStepCondition(value: unknown, index: number): BatchStepCondition {
    if (!isRecord(value)) {
      throw new Error(`invalid batch step ${index + 1}: when must be an object`)
    }

    const stepRef = value.step
    const isStringRef = typeof stepRef === 'string' && stepRef.trim().length > 0
    const isIntegerRef = typeof stepRef === 'number' && Number.isInteger(stepRef) && stepRef >= 1
    if (!isStringRef && !isIntegerRef) {
      throw new Error(
        `invalid batch step ${index + 1}: when.step must be a step id string or a positive integer`,
      )
    }

    if (value.path !== undefined && typeof value.path !== 'string') {
      throw new Error(`invalid batch step ${index + 1}: when.path must be a string`)
    }

    const declared = ['equals', 'truthy', 'exists'].filter((key) => key in value)
    if (declared.length !== 1) {
      throw new Error(
        `invalid batch step ${index + 1}: when must declare exactly one of equals, truthy, or exists`,
      )
    }

    if (value.truthy !== undefined && typeof value.truthy !== 'boolean') {
      throw new Error(`invalid batch step ${index + 1}: when.truthy must be a boolean`)
    }
    if (value.exists !== undefined && typeof value.exists !== 'boolean') {
      throw new Error(`invalid batch step ${index + 1}: when.exists must be a boolean`)
    }

    const condition: BatchStepCondition = { step: stepRef as string | number }
    if (value.path !== undefined) {
      condition.path = value.path
    }
    if (value.equals !== undefined) {
      condition.equals = value.equals
    }
    if (value.truthy !== undefined) {
      condition.truthy = value.truthy
    }
    if (value.exists !== undefined) {
      condition.exists = value.exists
    }
    return condition
  }

  function normalizeBatchCommandStep(value: unknown, index: number): BatchCommandStep {
    if (typeof value === 'string') {
      const command = value.trim()
      if (!command) {
        throw new Error(`invalid batch step ${index + 1}: empty command string`)
      }

      return {
        command,
        args: {},
        label: null,
      }
    }

    if (!isRecord(value)) {
      throw new Error(`invalid batch step ${index + 1}: expected a command string or object`)
    }

    const command = typeof value.command === 'string' ? value.command.trim() : ''
    if (!command) {
      throw new Error(`invalid batch step ${index + 1}: missing command`)
    }

    const args = value.args === undefined ? {} : value.args
    if (!isRecord(args)) {
      throw new Error(`invalid batch step ${index + 1}: args must be an object`)
    }

    const step: BatchCommandStep = {
      command,
      args,
      label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : null,
    }

    if (value.id !== undefined && value.id !== null) {
      if (typeof value.id !== 'string' || !value.id.trim()) {
        throw new Error(`invalid batch step ${index + 1}: id must be a non-empty string`)
      }
      step.id = value.id.trim()
    }

    if (value.skipRemainingOnFailure !== undefined && value.skipRemainingOnFailure !== null) {
      if (typeof value.skipRemainingOnFailure !== 'boolean') {
        throw new Error(`invalid batch step ${index + 1}: skipRemainingOnFailure must be a boolean`)
      }
      step.skipRemainingOnFailure = value.skipRemainingOnFailure
    }

    if (value.when !== undefined && value.when !== null) {
      step.when = normalizeBatchStepCondition(value.when, index)
    }

    return step
  }

  function readBatchCommandSteps(args: CommandArgs): BatchCommandStep[] {
    const rawSteps = args.steps
    if (!Array.isArray(rawSteps)) {
      throw new Error('batch steps must be a JSON array')
    }

    return rawSteps.map((value, index) => normalizeBatchCommandStep(value, index))
  }

  function readBatchCommandOptions(args: CommandArgs): BatchCommandOptions {
    return {
      continueOnError: readBooleanArg(args, 'continueOnError', false),
      retries: Math.max(0, Math.floor(readNumberArg(args, 'retries', 0))),
      retryDelayMs: Math.max(0, Math.floor(readNumberArg(args, 'retryDelayMs', 0))),
    }
  }

  async function waitForRetryDelay(ms: number): Promise<void> {
    if (ms <= 0) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  function createBatchStepResponse(result: unknown): { ok: true; result: unknown } {
    return {
      ok: true,
      result,
    }
  }

  function createBatchStepFailureResponse(error: unknown): {
    ok: false
    error: SerializedCommandError
  } {
    return serializeCommandFailure(error)
  }

  function createBatchSummary(
    total: number,
    completed: number,
    succeeded: number,
    failed: number,
    skippedCount: number,
    retried: number,
    options: BatchCommandOptions,
    terminated = false,
  ): BatchCommandSummary {
    return {
      total,
      completed,
      succeeded,
      failed,
      skippedCount,
      retried,
      continueOnError: options.continueOnError,
      retries: options.retries,
      retryDelayMs: options.retryDelayMs,
      ...(terminated ? { terminated: true as const } : {}),
    }
  }

  async function executeBatchStep(
    step: BatchCommandStep,
    index: number,
    options: BatchCommandOptions,
    context?: CommandExecutionContext,
  ): Promise<{
    result: BatchCommandStepResult
    failed: boolean
    retryCount: number
  }> {
    let attempt = 0
    let lastError: unknown = null
    let retryCount = 0
    // 防御性截断：确保 retries 是有限非负整数，避免 Infinity/NaN 导致无限循环
    const maxRetries = Number.isFinite(options.retries)
      ? Math.max(0, Math.floor(options.retries))
      : 0

    while (attempt <= maxRetries) {
      context?.throwIfCancelled()
      try {
        // batch 已在自身队列槽内执行，嵌套步骤共享取消状态，不能重新创建上下文。
        const result = await executeCommand(step.command, step.args, { skipQueue: true, context })
        context?.throwIfCancelled()
        return {
          result: {
            index: index + 1,
            command: step.command,
            args: step.args,
            label: step.label,
            ...(step.id ? { id: step.id } : {}),
            response: createBatchStepResponse(result),
          },
          failed: false,
          retryCount,
        }
      } catch (error) {
        context?.throwIfCancelled()
        lastError = error
        if (attempt >= maxRetries) {
          break
        }

        retryCount += 1
        await waitForRetryDelay(options.retryDelayMs)
        context?.throwIfCancelled()
      }

      attempt += 1
    }

    return {
      result: {
        index: index + 1,
        command: step.command,
        args: step.args,
        label: step.label,
        ...(step.id ? { id: step.id } : {}),
        response: createBatchStepFailureResponse(lastError),
      },
      failed: true,
      retryCount,
    }
  }

  function batchValuesEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
      return true
    }
    if (typeof a !== typeof b) {
      return false
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((item, i) => batchValuesEqual(item, b[i]))
    }
    if (isRecord(a) && isRecord(b)) {
      const aKeys = Object.keys(a)
      const bKeys = Object.keys(b)
      return (
        aKeys.length === bKeys.length &&
        aKeys.every(
          (key) => Object.prototype.hasOwnProperty.call(b, key) && batchValuesEqual(a[key], b[key]),
        )
      )
    }
    return false
  }

  function getBatchStepResultValue(
    container: unknown,
    path: string | undefined,
  ): { exists: boolean; value: unknown } {
    if (!path) {
      return { exists: true, value: container }
    }

    let current: unknown = container
    for (const part of path.split('.')) {
      if (current === null || current === undefined) {
        return { exists: false, value: undefined }
      }
      if (Array.isArray(current)) {
        if (!/^(0|[1-9]\d*)$/.test(part)) {
          return { exists: false, value: undefined }
        }
        const arrayIndex = Number(part)
        if (arrayIndex >= current.length) {
          return { exists: false, value: undefined }
        }
        current = current[arrayIndex]
        continue
      }
      if (typeof current === 'object') {
        const record = current as Record<string, unknown>
        if (!Object.prototype.hasOwnProperty.call(record, part)) {
          return { exists: false, value: undefined }
        }
        current = record[part]
        continue
      }
      return { exists: false, value: undefined }
    }

    return { exists: true, value: current }
  }

  function resolveBatchStepIndex(ref: string | number, steps: BatchCommandStep[]): number | null {
    if (typeof ref === 'number') {
      return ref >= 1 && ref <= steps.length ? ref - 1 : null
    }
    const matchedIndex = steps.findIndex((step) => step.id === ref)
    return matchedIndex === -1 ? null : matchedIndex
  }

  /** 求值 when 条件：被引用的前置 step 必须已成功执行且未跳过，再按 path/谓词匹配其结果 */
  function evaluateBatchStepCondition(
    condition: BatchStepCondition,
    steps: BatchCommandStep[],
    results: BatchCommandStepResult[],
    currentIndex: number,
  ): boolean {
    const referencedIndex = resolveBatchStepIndex(condition.step, steps)
    if (
      referencedIndex === null ||
      referencedIndex >= currentIndex ||
      referencedIndex >= results.length
    ) {
      return false
    }

    const referencedResult = results[referencedIndex]
    if (referencedResult.skipped || referencedResult.response?.ok !== true) {
      return false
    }

    const { exists, value } = getBatchStepResultValue(
      referencedResult.response.result,
      condition.path,
    )

    if (condition.exists !== undefined) {
      return condition.exists === exists
    }
    if (condition.truthy !== undefined) {
      return condition.truthy ? Boolean(value) : !value
    }
    if (condition.equals !== undefined) {
      return exists && batchValuesEqual(condition.equals, value)
    }
    return false
  }

  function validateBatchWhenReferences(steps: BatchCommandStep[]): void {
    for (const [index, step] of steps.entries()) {
      if (!step.when) {
        continue
      }
      const referencedIndex = resolveBatchStepIndex(step.when.step, steps)
      if (referencedIndex === null || referencedIndex >= index) {
        throw new Error(
          `invalid batch step ${index + 1}: when.step must reference an earlier step (got ${JSON.stringify(step.when.step)})`,
        )
      }
    }
  }

  function createSkippedBatchStepResult(
    step: BatchCommandStep,
    index: number,
    reason: string,
  ): BatchCommandStepResult {
    return {
      index: index + 1,
      command: step.command,
      args: step.args,
      label: step.label,
      ...(step.id ? { id: step.id } : {}),
      skipped: true,
      reason,
    }
  }

  async function handleBatchCommand(
    args: CommandArgs,
    context?: CommandExecutionContext,
  ): Promise<{ steps: BatchCommandStepResult[]; summary: BatchCommandSummary }> {
    const steps = readBatchCommandSteps(args)
    const options = readBatchCommandOptions(args)
    validateBatchWhenReferences(steps)
    const results: BatchCommandStepResult[] = []
    let succeeded = 0
    let failed = 0
    let retried = 0
    let skippedCount = 0
    let terminated = false
    let terminatedAtIndex: number | null = null

    for (const [index, step] of steps.entries()) {
      context?.throwIfCancelled()
      if (terminated) {
        skippedCount += 1
        results.push(
          createSkippedBatchStepResult(
            step,
            index,
            `terminated: step ${terminatedAtIndex} failed with skipRemainingOnFailure`,
          ),
        )
        continue
      }

      if (step.when) {
        const conditionMet = evaluateBatchStepCondition(step.when, steps, results, index)
        if (!conditionMet) {
          skippedCount += 1
          results.push(
            createSkippedBatchStepResult(
              step,
              index,
              `skipped: when condition not met (references step ${String(step.when.step)})`,
            ),
          )
          continue
        }
      }

      const stepExecution = await executeBatchStep(step, index, options, context)
      results.push(stepExecution.result)

      if (stepExecution.failed) {
        failed += 1
        retried += stepExecution.retryCount

        // skipRemainingOnFailure 只在 continueOnError 下生效：失败时不继续执行后续步骤，而是显式终止。
        if (step.skipRemainingOnFailure === true && options.continueOnError) {
          terminated = true
          terminatedAtIndex = index + 1
          continue
        }

        if (!options.continueOnError) {
          const summary = createBatchSummary(
            steps.length,
            results.length - skippedCount,
            succeeded,
            failed,
            skippedCount,
            retried,
            options,
          )
          const batchError = new Error(
            `batch step ${index + 1} failed: ${step.command}`,
          ) as ErrorWithCode
          batchError.code = 'BATCH_STEP_FAILED'
          batchError.details = {
            steps: results,
            failedStep: stepExecution.result,
            summary,
          }
          throw batchError
        }

        continue
      }

      succeeded += 1
      retried += stepExecution.retryCount
    }

    return {
      steps: results,
      summary: createBatchSummary(
        steps.length,
        results.length - skippedCount,
        succeeded,
        failed,
        skippedCount,
        retried,
        options,
        terminated,
      ),
    }
  }

  return { handleBatchCommand }
}
