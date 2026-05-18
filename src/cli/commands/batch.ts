import { commandSupportsFrameTarget, commandSupportsTabTarget } from '../../core/command-spec.js'
import { isRecord } from '../client.js'
import { helpRequested, parseOrWriteError } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

interface BatchStepObject {
  command?: unknown
  args?: unknown
  label?: unknown
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

  return {
    command,
    args: (record.args as Record<string, unknown>) || {},
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : null,
  }
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
    if (typeof value.retryDelayMs !== 'number' || !Number.isFinite(value.retryDelayMs) || value.retryDelayMs < 0) {
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
  const payload = await context.requestCommand(context.flags.server, 'batch',
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
