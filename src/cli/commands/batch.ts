import { commandSupportsFrameTarget, commandSupportsTabTarget } from '../../core/command-spec.js'
import { isRecord } from '../client.js'
import { helpRequested, parseOrWriteError } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

interface BatchStepObject {
  command?: unknown
  args?: unknown
  label?: unknown
}

interface BatchStep {
  command: string
  args: Record<string, unknown>
  label: string | null
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

function parseBatchSteps(raw: string): BatchStep[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('batch input must be a JSON array')
  }

  return parsed.map((value, index) => normalizeBatchStep(value, index))
}

function buildBatchFailurePayload(
  payload: { ok?: boolean; error?: { message?: string; code?: string; details?: unknown } },
) {
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
  const steps = parseOrWriteError(() => parseBatchSteps(rawInput))
  if (!steps) {
    return 1
  }

  const dispatchSteps = steps.map((step) => normalizeBatchStepForDispatch(step, context))
  const payload = await context.requestCommand(context.flags.server, 'batch', {
    steps: dispatchSteps,
  })

  if (payload.ok === false) {
    context.writeResult(buildBatchFailurePayload(payload))
    return 1
  }

  context.writeResult(payload)
  return 0
}

export const batchCommandRegistry: CommandRegistry = {
  batch: handleBatch,
}
