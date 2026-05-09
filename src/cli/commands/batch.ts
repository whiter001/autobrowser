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

interface BatchStepResult {
  index: number
  command: string
  args: Record<string, unknown>
  label: string | null
  response: unknown
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
  results: BatchStepResult[],
  failedStep: BatchStepResult,
  reason: string,
) {
  return {
    ok: false,
    result: {
      steps: results,
    },
    error: {
      code: 'BATCH_STEP_FAILED',
      message: reason,
      details: {
        stepIndex: failedStep.index,
        command: failedStep.command,
        label: failedStep.label,
        args: failedStep.args,
        response: failedStep.response,
      },
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

  const results: BatchStepResult[] = []
  for (const [index, step] of steps.entries()) {
    let response: Awaited<ReturnType<CommandContext['requestCommand']>> | null = null
    try {
      response = await context.requestCommand(context.flags.server, step.command, step.args)
    } catch (error) {
      const stepResult: BatchStepResult = {
        index: index + 1,
        command: step.command,
        args: step.args,
        label: step.label,
        response: {
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: 'BATCH_STEP_ERROR',
          },
        },
      }
      results.push(stepResult)

      context.writeResult(
        buildBatchFailurePayload(
          results,
          stepResult,
          `batch step ${index + 1} errored: ${step.command}`,
        ),
      )
    }

    if (response === null) {
      return 1
    }

    const stepResult: BatchStepResult = {
      index: index + 1,
      command: step.command,
      args: step.args,
      label: step.label,
      response,
    }
    results.push(stepResult)

    if (response.ok === false) {
      context.writeResult(
        buildBatchFailurePayload(
          results,
          stepResult,
          `batch step ${index + 1} failed: ${step.command}`,
        ),
      )
    }
  }

  context.writeResult({
    ok: true,
    result: {
      steps: results,
    },
  })
  return 0
}

export const batchCommandRegistry: CommandRegistry = {
  batch: handleBatch,
}
