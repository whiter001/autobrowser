import { parseSearchQueryRegex } from './search.js'

export interface CommandSpec {
  name: string
  supportsTabTarget?: boolean
  supportsFrameTarget?: boolean
}

export interface CommandArgsValidationError extends Error {
  code?: string
  details?: unknown
}

const TAB_TARGET_COMMANDS = [
  'back',
  'check',
  'click',
  'clipboard',
  'close',
  'console',
  'cookies',
  'dblclick',
  'dialog',
  'drag',
  'errors',
  'eval',
  'fill',
  'fillform',
  'feed',
  'find',
  'focus',
  'forward',
  'frame',
  'get',
  'goto',
  'hover',
  'is',
  'keyboard',
  'network',
  'pdf',
  'press',
  'reload',
  'screenshot',
  'scroll',
  'scrollintoview',
  'search',
  'select',
  'set',
  'snapshot',
  'state',
  'storage',
  'type',
  'uncheck',
  'upload',
  'wait',
  'window',
] as const

const FRAME_TARGET_COMMANDS = [
  'check',
  'click',
  'dblclick',
  'drag',
  'eval',
  'fill',
  'fillform',
  'feed',
  'find',
  'focus',
  'get',
  'hover',
  'is',
  'screenshot',
  'scroll',
  'scrollintoview',
  'search',
  'select',
  'snapshot',
  'storage',
  'type',
  'uncheck',
  'upload',
  'wait',
] as const

const FRAME_TARGET_COMMAND_SET = new Set<string>(FRAME_TARGET_COMMANDS)

export const COMMAND_SPECS: CommandSpec[] = TAB_TARGET_COMMANDS.map((name) => ({
  name,
  supportsTabTarget: true,
  ...(FRAME_TARGET_COMMAND_SET.has(name) ? { supportsFrameTarget: true } : {}),
}))

const COMMAND_SPECS_BY_NAME = new Map(COMMAND_SPECS.map((spec) => [spec.name, spec]))

export function getCommandSpec(command: string): CommandSpec | undefined {
  return COMMAND_SPECS_BY_NAME.get(command)
}

export function commandSupportsTabTarget(command: string): boolean {
  return getCommandSpec(command)?.supportsTabTarget === true
}

export function commandSupportsFrameTarget(command: string): boolean {
  return getCommandSpec(command)?.supportsFrameTarget === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function createCommandArgsValidationError(
  command: string,
  reason: string,
  details: Record<string, unknown> = {},
): CommandArgsValidationError {
  const error = new Error(
    `invalid command arguments for ${command}: ${reason}`,
  ) as CommandArgsValidationError
  error.code = 'INVALID_COMMAND_ARGS'
  error.details = {
    command,
    reason,
    ...details,
  }
  return error
}

function requireRecordArgs(command: string, args: unknown): Record<string, unknown> {
  if (!isRecord(args)) {
    throw createCommandArgsValidationError(command, 'args must be an object')
  }

  return args
}

function readStringField(
  args: Record<string, unknown>,
  key: string,
  command: string,
  options: { required: boolean; allowEmpty?: boolean } = { required: true },
): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) {
    if (options.required) {
      throw createCommandArgsValidationError(command, `${key} must be a non-empty string`, {
        field: key,
        value,
      })
    }

    return undefined
  }

  if (typeof value !== 'string') {
    throw createCommandArgsValidationError(command, `${key} must be a string`, {
      field: key,
      value,
    })
  }

  if (!options.allowEmpty && !value.trim()) {
    throw createCommandArgsValidationError(command, `${key} must be a non-empty string`, {
      field: key,
      value,
    })
  }

  return value
}

function readNumberField(
  args: Record<string, unknown>,
  key: string,
  command: string,
  options: { required: boolean } = { required: true },
): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) {
    if (options.required) {
      throw createCommandArgsValidationError(command, `${key} must be a number`, {
        field: key,
        value,
      })
    }

    return undefined
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createCommandArgsValidationError(command, `${key} must be a finite number`, {
      field: key,
      value,
    })
  }

  return value
}

function readOptionalNonNegativeIntegerField(
  args: Record<string, unknown>,
  key: string,
  command: string,
): number | undefined {
  return readOptionalNonNegativeField(args, key, command, { integer: true })
}

function readOptionalNonNegativeNumberField(
  args: Record<string, unknown>,
  key: string,
  command: string,
): number | undefined {
  return readOptionalNonNegativeField(args, key, command)
}

function readOptionalNonNegativeField(
  args: Record<string, unknown>,
  key: string,
  command: string,
  { integer = false }: { integer?: boolean } = {},
): number | undefined {
  const value = readNumberField(args, key, command, { required: false })
  if (value === undefined) {
    return undefined
  }

  const label = integer ? 'non-negative integer' : 'non-negative number'
  if ((integer && !Number.isInteger(value)) || value < 0) {
    throw createCommandArgsValidationError(command, `${key} must be a ${label}`, {
      field: key,
      value,
    })
  }

  return value
}

function readBooleanField(
  args: Record<string, unknown>,
  key: string,
  command: string,
): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'boolean') {
    throw createCommandArgsValidationError(command, `${key} must be a boolean`, {
      field: key,
      value,
    })
  }

  return value
}

function readStringArrayField(
  args: Record<string, unknown>,
  key: string,
  command: string,
  options: { required: boolean; allowEmptyItems?: boolean } = { required: true },
): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) {
    if (options.required) {
      throw createCommandArgsValidationError(command, `${key} must be an array of strings`, {
        field: key,
        value,
      })
    }

    return undefined
  }

  if (!Array.isArray(value)) {
    throw createCommandArgsValidationError(command, `${key} must be an array of strings`, {
      field: key,
      value,
    })
  }

  if (value.some((item) => typeof item !== 'string')) {
    throw createCommandArgsValidationError(command, `${key} must be an array of strings`, {
      field: key,
      value,
    })
  }

  if (!options.allowEmptyItems && value.some((item) => !item.trim())) {
    throw createCommandArgsValidationError(command, `${key} must not contain empty strings`, {
      field: key,
      value,
    })
  }

  if (options.required && value.length === 0) {
    throw createCommandArgsValidationError(command, `${key} must not be empty`, {
      field: key,
      value,
    })
  }

  return value
}

function readTabInputField(
  args: Record<string, unknown>,
  key: string,
  command: string,
): string | number | null | undefined {
  const value = args[key]
  if (value === undefined || value === null) {
    return value
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw createCommandArgsValidationError(command, `${key} must be a string or number`, {
      field: key,
      value,
    })
  }

  return value
}

function readObjectOrArrayField(
  args: Record<string, unknown>,
  key: string,
  command: string,
): unknown {
  const value = args[key]
  if (value === undefined || value === null) {
    return value
  }

  if (!isRecord(value) && !Array.isArray(value)) {
    throw createCommandArgsValidationError(command, `${key} must be an object or array`, {
      field: key,
      value,
    })
  }

  return value
}

// fillform 的 fields 约束：1-50 项，每项必须是非空 selector + 字符串 value。
// value 允许空串（fill 空值语义是清空字段），但字段本身必须存在
function validateFillFormFields(args: Record<string, unknown>, command: string): void {
  const fields = args.fields
  if (!Array.isArray(fields)) {
    throw createCommandArgsValidationError(command, 'fields must be an array', {
      field: 'fields',
      value: fields,
    })
  }

  if (fields.length < 1 || fields.length > 50) {
    throw createCommandArgsValidationError(command, 'fields must contain 1 to 50 items', {
      field: 'fields',
      value: fields,
    })
  }

  fields.forEach((field, index) => {
    if (!isRecord(field)) {
      throw createCommandArgsValidationError(command, `fields[${index}] must be an object`, {
        field: 'fields',
        value: field,
      })
    }

    const selector = field.selector
    if (typeof selector !== 'string' || !selector.trim()) {
      throw createCommandArgsValidationError(
        command,
        `fields[${index}].selector must be a non-empty string`,
        { field: 'selector', value: selector },
      )
    }

    if (typeof field.value !== 'string') {
      throw createCommandArgsValidationError(command, `fields[${index}].value must be a string`, {
        field: 'value',
        value: field.value,
      })
    }
  })
}

function validateBatchWhen(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('when must be an object')
  }

  const stepRef = value.step
  const isStringRef = typeof stepRef === 'string' && stepRef.trim().length > 0
  const isIntegerRef = typeof stepRef === 'number' && Number.isInteger(stepRef) && stepRef >= 1
  if (!isStringRef && !isIntegerRef) {
    throw new Error('when.step must be a step id string or a positive integer')
  }

  if (value.path !== undefined && typeof value.path !== 'string') {
    throw new Error('when.path must be a string')
  }

  const declared = ['equals', 'truthy', 'exists'].filter((key) => key in value)
  if (declared.length !== 1) {
    throw new Error('when must declare exactly one of equals, truthy, or exists')
  }

  if (value.truthy !== undefined && typeof value.truthy !== 'boolean') {
    throw new Error('when.truthy must be a boolean')
  }

  if (value.exists !== undefined && typeof value.exists !== 'boolean') {
    throw new Error('when.exists must be a boolean')
  }
}

function validateBatchStep(value: unknown, index: number): void {
  const stepLabel = `step ${index + 1}`

  try {
    if (typeof value === 'string') {
      if (!value.trim()) {
        throw new Error('command must be a string')
      }

      return
    }

    if (!isRecord(value)) {
      throw new Error('expected a command string or object')
    }

    const command = typeof value.command === 'string' ? value.command.trim() : ''
    if (!command) {
      throw new Error('command must be a non-empty string')
    }

    if (value.args !== undefined && !isRecord(value.args)) {
      throw new Error('args must be an object')
    }

    if (value.label !== undefined && value.label !== null && typeof value.label !== 'string') {
      throw new Error('label must be a string')
    }

    if (value.id !== undefined && value.id !== null) {
      if (typeof value.id !== 'string' || !value.id.trim()) {
        throw new Error('id must be a non-empty string')
      }
    }

    if (
      value.skipRemainingOnFailure !== undefined &&
      typeof value.skipRemainingOnFailure !== 'boolean'
    ) {
      throw new Error('skipRemainingOnFailure must be a boolean')
    }

    if (value.when !== undefined) {
      validateBatchWhen(value.when)
    }

    validateCommandArgs(command, value.args ?? {})
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw createCommandArgsValidationError('batch', `${stepLabel}: ${reason}`, {
      stepIndex: index + 1,
      value,
    })
  }
}

export function validateCommandArgs(command: string, args: unknown): void {
  const normalizedArgs = requireRecordArgs(command, args)

  // 这些字段在多个命令之间共享，先做统一的浅层类型约束，避免把明显错误的值传到扩展侧。
  readTabInputField(normalizedArgs, 'tabId', command)
  readTabInputField(normalizedArgs, 'handle', command)
  readStringField(normalizedArgs, 'frame', command, { required: false })

  switch (command) {
    case 'batch': {
      const steps = normalizedArgs.steps
      if (!Array.isArray(steps)) {
        throw createCommandArgsValidationError(command, 'steps must be an array', {
          field: 'steps',
          value: steps,
        })
      }

      steps.forEach((step, index) => validateBatchStep(step, index))

      const stepIds = new Map<string, number>()
      steps.forEach((step, index) => {
        if (isRecord(step) && typeof step.id === 'string' && step.id.trim()) {
          const id = step.id.trim()
          if (stepIds.has(id)) {
            throw createCommandArgsValidationError(
              command,
              `step ${index + 1}: duplicate step id: ${id}`,
              { stepIndex: index + 1, stepId: id },
            )
          }
          stepIds.set(id, index)
        }
      })

      steps.forEach((step, index) => {
        if (!isRecord(step) || !isRecord(step.when)) {
          return
        }
        const ref = step.when.step
        let referencedIndex: number | null = null
        if (typeof ref === 'number') {
          referencedIndex = ref >= 1 && ref <= steps.length ? ref - 1 : null
        } else if (typeof ref === 'string') {
          referencedIndex = stepIds.get(ref.trim()) ?? null
        }
        if (referencedIndex === null || referencedIndex >= index) {
          throw createCommandArgsValidationError(
            command,
            `step ${index + 1}: when.step must reference an earlier step: ${String(ref)}`,
            { stepIndex: index + 1, whenStep: ref },
          )
        }
      })

      readBooleanField(normalizedArgs, 'continueOnError', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'retries', command)
      readOptionalNonNegativeNumberField(normalizedArgs, 'retryDelayMs', command)
      return
    }
    case 'goto':
    case 'open':
    case 'tab.new':
      readStringField(normalizedArgs, 'url', command, { required: command !== 'tab.new' })
      if (command !== 'tab.new') {
        readOptionalNonNegativeNumberField(normalizedArgs, 'timeoutMs', command)
        readBooleanField(normalizedArgs, 'wait', command)
        readStringField(normalizedArgs, 'waitUntil', command, { required: false })
        readOptionalNonNegativeIntegerField(normalizedArgs, 'settleTimeoutMs', command)
        readOptionalNonNegativeIntegerField(normalizedArgs, 'domQuietMs', command)
      }
      return
    case 'click':
    case 'dblclick':
    case 'hover':
    case 'focus':
    case 'scrollintoview':
    case 'frame':
    case 'check':
    case 'uncheck':
      readStringField(normalizedArgs, 'selector', command)
      if (command === 'click') {
        readOptionalNonNegativeNumberField(normalizedArgs, 'timeoutMs', command)
      }
      return
    case 'scroll':
      readStringField(normalizedArgs, 'selector', command, { required: false })
      readNumberField(normalizedArgs, 'deltaX', command, { required: false })
      readNumberField(normalizedArgs, 'deltaY', command, { required: false })
      return
    case 'fill':
    case 'type':
    case 'select':
      readStringField(normalizedArgs, 'selector', command)
      readStringField(normalizedArgs, 'value', command)
      if (command === 'type') {
        readBooleanField(normalizedArgs, 'submit', command)
      }
      return
    case 'fillform':
      validateFillFormFields(normalizedArgs, command)
      return
    case 'upload':
      readStringField(normalizedArgs, 'selector', command)
      readStringArrayField(normalizedArgs, 'files', command)
      return
    case 'press':
      readStringField(normalizedArgs, 'key', command)
      return
    case 'keyboard':
      readStringField(normalizedArgs, 'action', command)
      readStringField(normalizedArgs, 'text', command)
      return
    case 'drag':
      readStringField(normalizedArgs, 'start', command)
      readStringField(normalizedArgs, 'end', command)
      return
    case 'eval':
      readStringField(normalizedArgs, 'script', command)
      readOptionalNonNegativeNumberField(normalizedArgs, 'timeoutMs', command)
      return
    case 'feed': {
      readStringField(normalizedArgs, 'selector', command, { required: false })
      readOptionalNonNegativeIntegerField(normalizedArgs, 'limit', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'maxScrolls', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'pauseMs', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'stallRounds', command)

      const dedupe = readStringField(normalizedArgs, 'dedupe', command, { required: false })
      if (dedupe !== undefined && !['url', 'text', 'none'].includes(dedupe)) {
        throw createCommandArgsValidationError(command, 'dedupe must be url, text, or none', {
          field: 'dedupe',
          value: dedupe,
        })
      }

      return
    }
    case 'is':
      readStringField(normalizedArgs, 'selector', command)
      readStringField(normalizedArgs, 'state', command)
      return
    case 'find': {
      const strategy = readStringField(normalizedArgs, 'strategy', command)
      if (
        !strategy ||
        !['role', 'text', 'label', 'placeholder', 'alt', 'title', 'test-id', 'exact-name'].includes(
          strategy,
        )
      ) {
        throw createCommandArgsValidationError(
          command,
          'strategy must be role, text, label, placeholder, alt, title, test-id, or exact-name',
          {
            field: 'strategy',
            value: strategy,
          },
        )
      }

      if (strategy === 'role') {
        readStringField(normalizedArgs, 'role', command)
      } else {
        readStringField(normalizedArgs, 'query', command)
      }

      readStringField(normalizedArgs, 'name', command, { required: false })
      readBooleanField(normalizedArgs, 'exact', command)

      const position = readStringField(normalizedArgs, 'position', command, { required: false })
      if (
        position !== undefined &&
        !['first', 'last'].includes(position) &&
        !/^nth=[1-9]\d*$/.test(position)
      ) {
        throw createCommandArgsValidationError(command, 'position must be first, last, or nth=N', {
          field: 'position',
          value: position,
        })
      }

      const candidates = readOptionalNonNegativeIntegerField(normalizedArgs, 'candidates', command)
      if (candidates !== undefined && candidates < 1) {
        throw createCommandArgsValidationError(command, 'candidates must be a positive integer', {
          field: 'candidates',
          value: candidates,
        })
      }

      if (candidates !== undefined && position !== undefined) {
        throw createCommandArgsValidationError(
          command,
          'candidates cannot be combined with position',
          {
            field: 'candidates',
            value: candidates,
          },
        )
      }

      const action = readStringField(normalizedArgs, 'action', command, { required: false })
      if (action === undefined) {
        return
      }

      if (
        !['locate', 'click', 'fill', 'type', 'hover', 'focus', 'check', 'uncheck', 'text'].includes(
          action,
        )
      ) {
        throw createCommandArgsValidationError(command, 'unsupported action', {
          field: 'action',
          value: action,
        })
      }

      if (candidates !== undefined && action !== 'locate') {
        throw createCommandArgsValidationError(
          command,
          'candidates only supports the locate action',
          {
            field: 'action',
            value: action,
          },
        )
      }

      if (action === 'fill' || action === 'type') {
        readStringField(normalizedArgs, 'value', command)
      }

      return
    }
    case 'get':
      {
        const attr = readStringField(normalizedArgs, 'attr', command, { required: false }) || 'text'
        if (!['title', 'url', 'cdp-url'].includes(attr)) {
          readStringField(normalizedArgs, 'selector', command)
        } else {
          readStringField(normalizedArgs, 'selector', command, { required: false })
        }
      }
      return
    case 'wait':
      readStringField(normalizedArgs, 'type', command, { required: false })
      readStringField(normalizedArgs, 'selector', command, { required: false })
      readStringField(normalizedArgs, 'state', command, { required: false })
      readStringField(normalizedArgs, 'url', command, { required: false })
      readStringField(normalizedArgs, 'text', command, { required: false })
      readStringField(normalizedArgs, 'fn', command, { required: false })
      readNumberField(normalizedArgs, 'timeout', command, { required: false })
      readNumberField(normalizedArgs, 'ms', command, { required: false })
      readBooleanField(normalizedArgs, 'gone', command)
      return
    case 'screenshot': {
      const full = readBooleanField(normalizedArgs, 'full', command)
      readBooleanField(normalizedArgs, 'annotate', command)
      readStringField(normalizedArgs, 'format', command, { required: false })
      readNumberField(normalizedArgs, 'quality', command, { required: false })
      const element = readStringField(normalizedArgs, 'element', command, { required: false })
      if (element !== undefined && full === true) {
        throw createCommandArgsValidationError(command, 'element cannot be combined with full', {
          field: 'element',
          value: element,
        })
      }
      return
    }
    case 'snapshot':
      readStringField(normalizedArgs, 'selector', command, { required: false })
      readStringArrayField(normalizedArgs, 'roles', command, { required: false })
      readBooleanField(normalizedArgs, 'changed', command)
      return
    case 'search': {
      const query = readStringField(normalizedArgs, 'query', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'context', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'limit', command)
      try {
        // readStringField 保证 query 非空字符串，这里仅做正则语法校验
        parseSearchQueryRegex(query as string)
      } catch (error) {
        throw createCommandArgsValidationError(
          command,
          error instanceof Error ? error.message : 'invalid search regex',
          { field: 'query', value: query },
        )
      }
      return
    }
    case 'window':
      {
        const action = readStringField(normalizedArgs, 'action', command)
        if (action !== 'new') {
          throw createCommandArgsValidationError(command, 'unsupported action', {
            field: 'action',
            value: action,
          })
        }
      }
      return
    case 'dialog':
      {
        const action = readStringField(normalizedArgs, 'action', command, { required: false })
        if (action && !['status', 'auto'].includes(action)) {
          throw createCommandArgsValidationError(command, 'unsupported action', {
            field: 'action',
            value: action,
          })
        }
      }
      readBooleanField(normalizedArgs, 'accept', command)
      readBooleanField(normalizedArgs, 'enabled', command)
      readStringField(normalizedArgs, 'promptText', command, { required: false, allowEmpty: true })
      return
    case 'downloads':
      readStringField(normalizedArgs, 'action', command, { required: false })
      readOptionalNonNegativeIntegerField(normalizedArgs, 'pageIdx', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'pageSize', command)
      return
    case 'cookies':
      readStringField(normalizedArgs, 'action', command)
      readStringField(normalizedArgs, 'name', command, { required: false })
      readStringField(normalizedArgs, 'value', command, { required: false })
      readStringField(normalizedArgs, 'domain', command, { required: false })
      readStringField(normalizedArgs, 'path', command, { required: false })
      return
    case 'storage':
      readStringField(normalizedArgs, 'action', command)
      readStringField(normalizedArgs, 'key', command, { required: false })
      readStringField(normalizedArgs, 'value', command, { required: false })
      readBooleanField(normalizedArgs, 'session', command)
      readObjectOrArrayField(normalizedArgs, 'data', command)
      return
    case 'set': {
      const type = readStringField(normalizedArgs, 'type', command)
      if (type === 'viewport') {
        readNumberField(normalizedArgs, 'width', command)
        readNumberField(normalizedArgs, 'height', command)
        readNumberField(normalizedArgs, 'deviceScaleFactor', command, { required: false })
        readBooleanField(normalizedArgs, 'mobile', command)
      } else if (type === 'offline') {
        readBooleanField(normalizedArgs, 'enabled', command)
      } else if (type === 'headers') {
        readObjectOrArrayField(normalizedArgs, 'headers', command)
      } else if (type === 'geo') {
        readNumberField(normalizedArgs, 'latitude', command)
        readNumberField(normalizedArgs, 'longitude', command)
        readNumberField(normalizedArgs, 'accuracy', command, { required: false })
      } else if (type === 'media') {
        readStringField(normalizedArgs, 'media', command, { required: false })
      } else if (type === 'permission') {
        readStringField(normalizedArgs, 'name', command)
        readBooleanField(normalizedArgs, 'reset', command)
      } else if (type === 'ua' || type === 'timezone' || type === 'locale') {
        // 空字符串表示恢复默认值，因此允许空串
        readStringField(normalizedArgs, 'value', command, { required: false, allowEmpty: true })
      }
      return
    }
    case 'network': {
      const action = readStringField(normalizedArgs, 'action', command)
      if (action === 'route') {
        const subaction = readStringField(normalizedArgs, 'subaction', command, { required: false })
        if (subaction === 'list') {
          return
        }
        readStringField(normalizedArgs, 'url', command)
        readBooleanField(normalizedArgs, 'abort', command)
        const status = readNumberField(normalizedArgs, 'status', command, { required: false })
        if (status !== undefined && (status < 100 || status > 599 || !Number.isInteger(status))) {
          throw createCommandArgsValidationError(command, 'status must be an integer 100-599', {
            field: 'status',
            value: status,
          })
        }
        readStringField(normalizedArgs, 'contentType', command, { required: false })
        readObjectOrArrayField(normalizedArgs, 'headers', command)
        readStringArrayField(normalizedArgs, 'removeHeaders', command, { required: false })
      } else if (action === 'unroute') {
        readStringField(normalizedArgs, 'url', command)
      } else if (action === 'request') {
        readStringField(normalizedArgs, 'requestId', command)
      } else if (action === 'har') {
        const subaction = readStringField(normalizedArgs, 'subaction', command)
        if (subaction === 'start') {
          readNumberField(normalizedArgs, 'maxRequests', command, { required: false })
          readNumberField(normalizedArgs, 'maxBodyBytes', command, { required: false })
        }
      } else if (action === 'requests') {
        readStringField(normalizedArgs, 'filter', command, { required: false })
        readStringField(normalizedArgs, 'type', command, { required: false })
        readStringField(normalizedArgs, 'method', command, { required: false })
        readStringField(normalizedArgs, 'status', command, { required: false })
        readStringField(normalizedArgs, 'resourceType', command, { required: false })
        readOptionalNonNegativeIntegerField(normalizedArgs, 'pageIdx', command)
        readOptionalNonNegativeIntegerField(normalizedArgs, 'pageSize', command)
        readBooleanField(normalizedArgs, 'allTabs', command)
        readBooleanField(normalizedArgs, 'allEpochs', command)
        readBooleanField(normalizedArgs, 'includeDetails', command)
      }
      return
    }
    case 'clipboard':
      readStringField(normalizedArgs, 'action', command)
      readStringField(normalizedArgs, 'text', command, { required: false })
      return
    case 'script': {
      const action = readStringField(normalizedArgs, 'action', command)
      if (action === 'add') {
        readStringField(normalizedArgs, 'source', command)
      } else if (action === 'remove') {
        readStringField(normalizedArgs, 'id', command, { required: false })
        readBooleanField(normalizedArgs, 'all', command)
      } else if (action !== 'list') {
        throw createCommandArgsValidationError(command, 'unsupported action', {
          field: 'action',
          value: action,
        })
      }
      return
    }
    case 'state':
      readStringField(normalizedArgs, 'action', command)
      readStringField(normalizedArgs, 'name', command, { required: false })
      readObjectOrArrayField(normalizedArgs, 'data', command)
      return
    case 'close':
      readBooleanField(normalizedArgs, 'all', command)
      return
    case 'tab.select':
    case 'tab.close':
      readTabInputField(normalizedArgs, 'handle', command)
      return
    case 'tab.list':
      readStringField(normalizedArgs, 'filter', command, { required: false })
      readBooleanField(normalizedArgs, 'active', command)
      readBooleanField(normalizedArgs, 'currentWindow', command)
    case 'status':
    case 'console':
    case 'errors':
      readOptionalNonNegativeIntegerField(normalizedArgs, 'pageIdx', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'pageSize', command)
      readOptionalNonNegativeIntegerField(normalizedArgs, 'since', command)
      readBooleanField(normalizedArgs, 'allEpochs', command)
      readStringField(normalizedArgs, 'action', command, { required: false })
      return
    case 'target':
      readStringField(normalizedArgs, 'action', command)
      readTabInputField(normalizedArgs, 'handle', command)
      return
    case 'command':
      readStringField(normalizedArgs, 'action', command)
      readStringField(normalizedArgs, 'commandId', command, { required: false })
      readStringField(normalizedArgs, 'queueKey', command, { required: false })
      readTabInputField(normalizedArgs, 'handle', command)
      return
    case 'pdf':
    case 'back':
    case 'forward':
    case 'reload':
      readOptionalNonNegativeNumberField(normalizedArgs, 'timeoutMs', command)
      readStringField(normalizedArgs, 'waitUntil', command, { required: false })
      return
    default:
      return
  }
}
