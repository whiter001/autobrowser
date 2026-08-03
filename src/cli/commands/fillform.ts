import { isRecord } from '../client.js'
import { helpRequested, parseOrWriteError } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

interface FillFormField {
  selector: string
  value: string
}

function normalizeFillFormField(value: unknown, index: number): FillFormField {
  if (!isRecord(value)) {
    throw new Error(
      `invalid fillform field ${index + 1}: expected an object with selector and value`,
    )
  }

  if (typeof value.selector !== 'string' || !value.selector.trim()) {
    throw new Error(`invalid fillform field ${index + 1}: selector must be a non-empty string`)
  }

  if (typeof value.value !== 'string') {
    throw new Error(`invalid fillform field ${index + 1}: value must be a string`)
  }

  return { selector: value.selector, value: value.value }
}

// 输入与 batch 一致：JSON 数组（field 列表）或 JSON 对象（{ fields: [...] }）
function parseFillFormInput(raw: string): FillFormField[] {
  const parsed = JSON.parse(raw) as unknown
  if (Array.isArray(parsed)) {
    return parsed.map((value, index) => normalizeFillFormField(value, index))
  }

  if (isRecord(parsed) && Array.isArray(parsed.fields)) {
    return (parsed.fields as unknown[]).map((value, index) => normalizeFillFormField(value, index))
  }

  throw new Error(
    'fillform input must be a JSON array of {selector, value} or an object with a fields array',
  )
}

/**
 * fillform 批量填表：一次填多个字段，单个字段失败不中断，
 * 结果带 {results, succeeded, failed} 统计（语义同 batch 的 continueOnError）。
 * 输入为位置参数 JSON / --stdin / --file / --base64，与 batch 同一条解析管线。
 */
async function handleFillForm(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['fillform'])) {
    return 0
  }

  const rawInput = await context.resolveEvalScript(rest)
  const fields = parseOrWriteError(() => parseFillFormInput(rawInput))
  if (!fields) {
    return 1
  }

  const payload = await context.requestCommand(context.flags.server, 'fillform', { fields })
  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

export const fillFormCommandRegistry: CommandRegistry = {
  fillform: handleFillForm,
}
