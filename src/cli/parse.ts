export interface WaitArgs {
  timeout: number
  type?: string
  selector?: string
  url?: string
  text?: string
  ms?: number
  state?: string
  fn?: string
}

export interface FindArgs {
  strategy: 'role' | 'text' | 'label'
  role?: string
  query?: string
  name?: string
  exact: boolean
  action?: string
  value?: string
}

export interface ScreenshotArgs {
  path: string | null
  full: boolean
  annotate: boolean
  screenshotDir: string | null
  format: 'png' | 'jpeg'
  quality: number | null
}

export interface NumberArgOptions {
  min?: number
  max?: number
  integer?: boolean
}

function validateNumberValue(
  numberValue: number,
  rawValue: unknown,
  label: string,
  options: NumberArgOptions,
): number {
  if (!Number.isFinite(numberValue)) {
    throw new Error(`invalid ${label} ${JSON.stringify(rawValue)}: expected a finite number`)
  }

  if (options.integer === true && !Number.isInteger(numberValue)) {
    throw new Error(`invalid ${label} ${JSON.stringify(rawValue)}: expected an integer`)
  }

  if (options.min !== undefined && numberValue < options.min) {
    throw new Error(`invalid ${label} ${JSON.stringify(rawValue)}: expected >= ${options.min}`)
  }

  if (options.max !== undefined && numberValue > options.max) {
    throw new Error(`invalid ${label} ${JSON.stringify(rawValue)}: expected <= ${options.max}`)
  }

  return numberValue
}

export function parseNumberArg(
  value: string | undefined,
  label: string,
  options: NumberArgOptions = {},
): number {
  if (value === undefined) {
    throw new Error(`missing ${label} value`)
  }

  if (value.trim() === '') {
    throw new Error(`invalid ${label} ${JSON.stringify(value)}: expected a finite number`)
  }

  const numberValue = Number(value)
  return validateNumberValue(numberValue, value, label, options)
}

export function parseOptionalNumberArg(
  value: string | undefined,
  label: string,
  fallback: number,
  options: NumberArgOptions = {},
): number {
  return value === undefined
    ? validateNumberValue(fallback, fallback, label, options)
    : parseNumberArg(value, label, options)
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`invalid JSON: ${value}`)
  }
}

export function parseNetworkRequestsArgs(rest: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--filter') {
      result.filter = rest[index + 1] || ''
      index += 1
      continue
    }

    if (value === '--type') {
      result.type = rest[index + 1] || ''
      index += 1
      continue
    }

    if (value === '--method') {
      result.method = rest[index + 1] || ''
      index += 1
      continue
    }

    if (value === '--status') {
      result.status = rest[index + 1] || ''
      index += 1
      continue
    }
  }

  return result
}

export function parseNetworkRouteArgs(rest: string[]): {
  url: string
  abort: boolean
  body?: unknown
} {
  const result: { url: string; abort: boolean; body?: unknown } = {
    url: '',
    abort: false,
  }

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--abort') {
      result.abort = true
      continue
    }

    if (value === '--body') {
      const rawBody = rest[index + 1]
      if (rawBody === undefined) {
        throw new Error('missing body value')
      }

      result.body = parseJsonValue(rawBody)
      index += 1
      continue
    }

    if (!value.startsWith('--') && !result.url) {
      result.url = value
    }
  }

  return result
}

export function parseWaitArgs(rest: string[]): WaitArgs {
  const waitArgs: WaitArgs = {
    timeout: 30000,
    state: 'visible',
  }

  const positionals: string[] = []

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--timeout') {
      const rawTimeout = rest[index + 1]
      waitArgs.timeout = parseNumberArg(rawTimeout, 'timeout', { min: 1, integer: true })
      index += 1
      continue
    }

    if (value === '--state') {
      const rawState = rest[index + 1]
      if (rawState === undefined) {
        throw new Error('missing state value')
      }
      waitArgs.state = rawState
      index += 1
      continue
    }

    if (value === '--text') {
      const rawText = rest[index + 1]
      if (rawText === undefined) {
        throw new Error('missing text value')
      }
      waitArgs.type = 'text'
      waitArgs.text = rawText
      index += 1
      continue
    }

    if (value === '--url') {
      const rawUrl = rest[index + 1]
      if (rawUrl === undefined) {
        throw new Error('missing url value')
      }
      waitArgs.type = 'url'
      waitArgs.url = rawUrl
      index += 1
      continue
    }

    if (value === '--fn') {
      const rawFn = rest[index + 1]
      if (rawFn === undefined) {
        throw new Error('missing fn value')
      }
      waitArgs.type = 'fn'
      waitArgs.fn = rawFn
      index += 1
      continue
    }

    if (value === '--load') {
      const rawLoadState = rest[index + 1]
      if (rawLoadState && !rawLoadState.startsWith('--')) {
        waitArgs.type = rawLoadState === 'networkidle' ? 'networkidle' : 'load'
        index += 1
      } else {
        waitArgs.type = 'networkidle'
      }
      continue
    }

    if (value === '--ms') {
      const rawMs = rest[index + 1]
      waitArgs.type = 'time'
      waitArgs.ms = parseNumberArg(rawMs, 'ms', { min: 0, integer: true })
      index += 1
      continue
    }

    if (!value.startsWith('--')) {
      positionals.push(value)
    }
  }

  if (!waitArgs.type && positionals.length > 0) {
    const [first, second] = positionals

    if (first === 'selector') {
      waitArgs.type = 'selector'
      waitArgs.selector = second || ''
    } else if (first === 'url') {
      waitArgs.type = 'url'
      waitArgs.url = second || ''
    } else if (first === 'text') {
      waitArgs.type = 'text'
      waitArgs.text = second || ''
    } else if (first === 'time' || first === 'ms') {
      waitArgs.type = 'time'
      waitArgs.ms = parseNumberArg(second, 'wait time', { min: 0, integer: true })
    } else if (first === 'load') {
      waitArgs.type = second === 'networkidle' ? 'networkidle' : 'load'
    } else if (first === 'networkidle') {
      waitArgs.type = 'networkidle'
    } else if (!isNaN(Number(first)) && positionals.length === 1) {
      waitArgs.type = 'time'
      waitArgs.ms = parseNumberArg(first, 'wait time', { min: 0, integer: true })
    } else {
      waitArgs.type = 'selector'
      waitArgs.selector = first
    }
  }

  if (!waitArgs.type) {
    waitArgs.type = 'networkidle'
  }

  if (waitArgs.type === 'selector' && !waitArgs.selector && positionals.length > 0) {
    waitArgs.selector = positionals[0]
  }

  if (waitArgs.type === 'url' && !waitArgs.url && positionals.length > 0) {
    waitArgs.url = positionals[0]
  }

  if (waitArgs.type === 'text' && !waitArgs.text && positionals.length > 0) {
    waitArgs.text = positionals[0]
  }

  return waitArgs
}

const FIND_ACTIONS = new Set([
  'locate',
  'click',
  'fill',
  'type',
  'hover',
  'focus',
  'check',
  'uncheck',
  'text',
])

export function parseFindArgs(rest: string[]): FindArgs {
  const strategy = String(rest[0] || '').trim()
  const queryOrRole = rest[1]

  if (!['role', 'text', 'label'].includes(strategy)) {
    throw new Error(`unsupported find strategy: ${strategy || '(empty)'}`)
  }

  if (!queryOrRole) {
    throw new Error(`missing ${strategy} value`)
  }

  const findArgs: FindArgs = {
    strategy: strategy as FindArgs['strategy'],
    exact: false,
  }

  if (strategy === 'role') {
    findArgs.role = queryOrRole
  } else {
    findArgs.query = queryOrRole
  }

  const positionals: string[] = []

  for (let index = 2; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--name') {
      const rawName = rest[index + 1]
      if (rawName === undefined) {
        throw new Error('missing name value')
      }
      findArgs.name = rawName
      index += 1
      continue
    }

    if (value === '--exact') {
      findArgs.exact = true
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`unsupported find option: ${value}`)
    }

    positionals.push(value)
  }

  if (positionals.length === 0) {
    return findArgs
  }

  const action = positionals[0]
  if (!FIND_ACTIONS.has(action)) {
    throw new Error(`unsupported find action: ${action}`)
  }

  findArgs.action = action

  if (['fill', 'type'].includes(action)) {
    const actionValue = positionals.slice(1).join(' ')
    if (!actionValue) {
      throw new Error(`missing value for find ${action}`)
    }
    findArgs.value = actionValue
    return findArgs
  }

  if (positionals.length > 1) {
    throw new Error(`unexpected extra arguments for find ${action}`)
  }

  return findArgs
}

export function parseScreenshotArgs(rest: string[]): ScreenshotArgs {
  const screenshotArgs: ScreenshotArgs = {
    path: null,
    full: false,
    annotate: false,
    screenshotDir: null,
    format: 'png',
    quality: null,
  }

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--full') {
      screenshotArgs.full = true
      continue
    }

    if (value === '--annotate') {
      screenshotArgs.annotate = true
      continue
    }

    if (value === '--screenshot-dir') {
      const rawDir = rest[index + 1]
      if (rawDir === undefined) {
        throw new Error('missing screenshot dir value')
      }
      screenshotArgs.screenshotDir = rawDir
      index += 1
      continue
    }

    if (value === '--screenshot-format') {
      const rawFormat = rest[index + 1]
      if (rawFormat === undefined) {
        throw new Error('missing screenshot format value')
      }
      if (rawFormat !== 'png' && rawFormat !== 'jpeg') {
        throw new Error(`unsupported screenshot format: ${rawFormat}`)
      }
      screenshotArgs.format = rawFormat
      index += 1
      continue
    }

    if (value === '--screenshot-quality') {
      const rawQuality = rest[index + 1]
      screenshotArgs.quality = parseNumberArg(rawQuality, 'screenshot quality', {
        min: 0,
        max: 100,
        integer: true,
      })
      index += 1
      continue
    }

    if (!value.startsWith('--') && !screenshotArgs.path) {
      screenshotArgs.path = value
    }
  }

  return screenshotArgs
}
