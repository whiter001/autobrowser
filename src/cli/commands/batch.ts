import { commandSupportsFrameTarget, commandSupportsTabTarget } from '../../core/command-spec.js'
import { isRecord } from '../client.js'
import { helpRequested, parseOrWriteError } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

interface BatchStepWhen {
  step: string | number
  path?: string
  equals?: unknown
  truthy?: boolean
  exists?: boolean
}

interface BatchStepObject {
  command?: unknown
  args?: unknown
  label?: unknown
  id?: unknown
  when?: unknown
  skipRemainingOnFailure?: unknown
}

interface BatchInputObject {
  steps?: unknown
  continueOnError?: unknown
  retries?: unknown
  retryDelayMs?: unknown
}

interface BatchStep {
  command: string
  args: Record<string, unknown>
  label: string | null
  id?: string
  when?: BatchStepWhen
  skipRemainingOnFailure?: boolean
}

interface BatchOptions {
  continueOnError: boolean
  retries: number
  retryDelayMs: number
}

interface BatchInput {
  steps: BatchStep[]
  options: BatchOptions
}

function normalizeBatchStepForDispatch(step: BatchStep, context: CommandContext): BatchStep {
  const args: Record<string, unknown> = { ...step.args }

  if (commandSupportsTabTarget(step.command) && args.tabId === undefined && context.flags.tab) {
    args.tabId = context.flags.tab
  }

  if (commandSupportsFrameTarget(step.command) && args.frame === undefined && context.flags.frame) {
    args.frame = context.flags.frame
  }

  return {
    ...step,
    args,
  }
}

function normalizeBatchWhen(value: unknown, index: number): BatchStepWhen {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid batch step ${index + 1}: when must be an object`)
  }

  const record = value as BatchStepWhen
  const stepRef = record.step
  const isStringRef = typeof stepRef === 'string' && stepRef.trim().length > 0
  const isIntegerRef = typeof stepRef === 'number' && Number.isInteger(stepRef) && stepRef >= 1
  if (!isStringRef && !isIntegerRef) {
    throw new Error(
      `invalid batch step ${index + 1}: when.step must be a step id string or a positive integer`,
    )
  }

  if (record.path !== undefined && typeof record.path !== 'string') {
    throw new Error(`invalid batch step ${index + 1}: when.path must be a string`)
  }

  const declared = ['equals', 'truthy', 'exists'].filter((key) => key in (value as object))
  if (declared.length !== 1) {
    throw new Error(
      `invalid batch step ${index + 1}: when must declare exactly one of equals, truthy, or exists`,
    )
  }

  if (record.truthy !== undefined && typeof record.truthy !== 'boolean') {
    throw new Error(`invalid batch step ${index + 1}: when.truthy must be a boolean`)
  }

  if (record.exists !== undefined && typeof record.exists !== 'boolean') {
    throw new Error(`invalid batch step ${index + 1}: when.exists must be a boolean`)
  }

  const when: BatchStepWhen = { step: stepRef as string | number }
  if (record.path !== undefined) {
    when.path = record.path
  }
  if (record.equals !== undefined) {
    when.equals = record.equals
  }
  if (record.truthy !== undefined) {
    when.truthy = record.truthy
  }
  if (record.exists !== undefined) {
    when.exists = record.exists
  }
  return when
}

function normalizeBatchStep(value: unknown, index: number): BatchStep {
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

  if (!value || typeof value !== 'object') {
    throw new Error(`invalid batch step ${index + 1}: expected a command string or object`)
  }

  const record = value as BatchStepObject
  const command = typeof record.command === 'string' ? record.command.trim() : ''
  if (!command) {
    throw new Error(`invalid batch step ${index + 1}: missing command`)
  }

  if (
    record.args !== undefined &&
    (Array.isArray(record.args) || typeof record.args !== 'object' || record.args === null)
  ) {
    throw new Error(`invalid batch step ${index + 1}: args must be an object`)
  }

  const step: BatchStep = {
    command,
    args: (record.args as Record<string, unknown>) || {},
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : null,
  }

  if (record.id !== undefined && record.id !== null) {
    if (typeof record.id !== 'string' || !record.id.trim()) {
      throw new Error(`invalid batch step ${index + 1}: id must be a non-empty string`)
    }
    step.id = record.id.trim()
  }

  if (record.skipRemainingOnFailure !== undefined && record.skipRemainingOnFailure !== null) {
    if (typeof record.skipRemainingOnFailure !== 'boolean') {
      throw new Error(`invalid batch step ${index + 1}: skipRemainingOnFailure must be a boolean`)
    }
    step.skipRemainingOnFailure = record.skipRemainingOnFailure
  }

  if (record.when !== undefined && record.when !== null) {
    step.when = normalizeBatchWhen(record.when, index)
  }

  return step
}

function readBatchOptions(value: BatchInputObject): BatchOptions {
  if (value.continueOnError !== undefined && typeof value.continueOnError !== 'boolean') {
    throw new Error('batch input continueOnError must be a boolean')
  }

  if (value.retries !== undefined) {
    if (
      typeof value.retries !== 'number' ||
      !Number.isFinite(value.retries) ||
      !Number.isInteger(value.retries) ||
      value.retries < 0
    ) {
      throw new Error('batch input retries must be a non-negative integer')
    }
  }

  if (value.retryDelayMs !== undefined) {
    if (
      typeof value.retryDelayMs !== 'number' ||
      !Number.isFinite(value.retryDelayMs) ||
      value.retryDelayMs < 0
    ) {
      throw new Error('batch input retryDelayMs must be a non-negative number')
    }
  }

  return {
    continueOnError: value.continueOnError === true,
    retries: value.retries === undefined ? 0 : Math.floor(value.retries),
    retryDelayMs: value.retryDelayMs === undefined ? 0 : Math.floor(value.retryDelayMs),
  }
}

function parseBatchInput(raw: string): BatchInput {
  const parsed = JSON.parse(raw) as unknown
  if (Array.isArray(parsed)) {
    return {
      steps: parsed.map((value, index) => normalizeBatchStep(value, index)),
      options: {
        continueOnError: false,
        retries: 0,
        retryDelayMs: 0,
      },
    }
  }

  if (!isRecord(parsed)) {
    throw new Error('batch input must be a JSON array or object')
  }

  const stepsValue = parsed.steps
  if (!Array.isArray(stepsValue)) {
    throw new Error('batch input.steps must be a JSON array')
  }

  return {
    steps: stepsValue.map((value, index) => normalizeBatchStep(value, index)),
    options: readBatchOptions(parsed),
  }
}

function buildBatchRequestArgs(input: BatchInput): Record<string, unknown> {
  const args: Record<string, unknown> = {
    steps: input.steps,
  }

  if (input.options.continueOnError) {
    args.continueOnError = true
  }

  if (input.options.retries > 0) {
    args.retries = input.options.retries
  }

  if (input.options.retryDelayMs > 0) {
    args.retryDelayMs = input.options.retryDelayMs
  }

  return args
}

function buildBatchFailurePayload(payload: {
  ok?: boolean
  error?: { message?: string; code?: string; details?: unknown }
}) {
  const details = isRecord(payload.error?.details) ? payload.error.details : null
  const steps = Array.isArray(details?.steps) ? details.steps.filter(isRecord) : []

  return {
    ok: false,
    result: {
      steps,
    },
    error: {
      code: payload.error?.code || 'BATCH_STEP_FAILED',
      message: payload.error?.message || 'batch step failed',
      ...(typeof payload.error?.details !== 'undefined' ? { details: payload.error.details } : {}),
    },
  }
}

/**
 * batch 输入为 JSON 数组（步骤列表）或 JSON 对象（steps + 选项）。
 * 每个步骤可以是命令字符串，或 { command, args, label, id?, when?, skipRemainingOnFailure? }：
 * - `id`：步骤标识，供后续步骤的 `when` 引用（无 id 时用 1 起的序号引用）。
 * - `when`：声明式条件，形如 { step, path?, equals? | truthy? | exists? }。求值失败则跳过该步，
 *   结果带 skipped:true 与 reason。引用的前置步骤必须已成功执行。
 * - `skipRemainingOnFailure`：仅在 continueOnError:true 下生效——该步失败后不再继续执行
 *   剩余步骤，而是标记 skipped 并返回（summary.terminated:true），与 continueOnError 的"继续"语义区分。
 */
async function handleBatch(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['batch'])) {
    return 0
  }

  const rawInput = await context.resolveEvalScript(rest)
  const input = parseOrWriteError(() => parseBatchInput(rawInput))
  if (!input) {
    return 1
  }

  const dispatchSteps = input.steps.map((step) => normalizeBatchStepForDispatch(step, context))
  const payload = await context.requestCommand(
    context.flags.server,
    'batch',
    buildBatchRequestArgs({
      steps: dispatchSteps,
      options: input.options,
    }),
  )

  if (payload.ok === false) {
    if (payload.error?.code === 'INVALID_COMMAND_ARGS') {
      context.writeResult(payload)
      return 1
    }

    context.writeResult(buildBatchFailurePayload(payload))
    return 1
  }

  context.writeResult(payload)
  return 0
}

export const batchCommandRegistry: CommandRegistry = {
  batch: handleBatch,
}
