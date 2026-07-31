export interface WaitArgs {
  timeout: number
  type?: string
  selector?: string
  url?: string
  text?: string
  ms?: number
  state?: string
  fn?: string
  gone?: boolean
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
  /** 元素级截图目标（selector 或 @eN ref），与 full 互斥 */
  element: string | null
  screenshotDir: string | null
  format: 'png' | 'jpeg'
  quality: number | null
}

export interface NetworkHarStartArgs {
  maxRequests: number | null
  maxBodyBytes: number | null
}

const DEFAULT_HAR_MAX_REQUESTS = 1000
const DEFAULT_HAR_MAX_BODY_BYTES = 256 * 1024

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
      const filterValue = rest[index + 1]
      if (filterValue === undefined) {
        throw new Error('missing value for --filter')
      }

      result.filter = filterValue
      index += 1
      continue
    }

    if (value === '--type') {
      const typeValue = rest[index + 1]
      if (typeValue === undefined) {
        throw new Error('missing value for --type')
      }

      result.type = typeValue
      index += 1
      continue
    }

    if (value === '--method') {
      const methodValue = rest[index + 1]
      if (methodValue === undefined) {
        throw new Error('missing method value')
      }

      result.method = methodValue
      index += 1
      continue
    }

    if (value === '--status') {
      const statusValue = rest[index + 1]
      if (statusValue === undefined) {
        throw new Error('missing status value')
      }

      result.status = statusValue
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`unsupported network option: ${value}`)
    }

    throw new Error(`unexpected extra network argument: ${value}`)
  }

  return result
}

export function parseNetworkHarStartArgs(rest: string[]): NetworkHarStartArgs {
  const result: NetworkHarStartArgs = {
    maxRequests: DEFAULT_HAR_MAX_REQUESTS,
    maxBodyBytes: DEFAULT_HAR_MAX_BODY_BYTES,
  }

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--har-unlimited') {
      result.maxRequests = null
      result.maxBodyBytes = null
      continue
    }

    if (value === '--har-max-requests') {
      result.maxRequests = parseNumberArg(rest[index + 1], 'har max requests', {
        min: 1,
        integer: true,
      })
      index += 1
      continue
    }

    if (value === '--har-max-body-bytes') {
      result.maxBodyBytes = parseNumberArg(rest[index + 1], 'har max body bytes', {
        min: 0,
        integer: true,
      })
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`unsupported network option: ${value}`)
    }

    throw new Error(`unexpected extra network argument: ${value}`)
  }

  return result
}

export interface NetworkRouteArgs {
  url: string
  abort: boolean
  body?: unknown
  status?: number
  contentType?: string
  headers?: Record<string, string>
  removeHeaders?: string[]
}

export function parseNetworkRouteArgs(rest: string[]): NetworkRouteArgs {
  const result: NetworkRouteArgs = {
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

    if (value === '--status') {
      result.status = parseNumberArg(rest[index + 1], 'status', {
        min: 100,
        max: 599,
        integer: true,
      })
      index += 1
      continue
    }

    if (value === '--content-type') {
      const rawContentType = rest[index + 1]
      if (rawContentType === undefined) {
        throw new Error('missing content-type value')
      }

      result.contentType = rawContentType
      index += 1
      continue
    }

    if (value === '--header') {
      const rawHeader = rest[index + 1]
      if (rawHeader === undefined) {
        throw new Error('missing header value')
      }

      // 值里可能带冒号（如 Date 头），只按第一个冒号拆分
      const separator = rawHeader.indexOf(':')
      if (separator <= 0) {
        throw new Error(`invalid header ${JSON.stringify(rawHeader)}: expected "Name: Value"`)
      }

      const headerName = rawHeader.slice(0, separator).trim()
      if (!headerName) {
        throw new Error(`invalid header ${JSON.stringify(rawHeader)}: expected "Name: Value"`)
      }

      result.headers = {
        ...result.headers,
        [headerName]: rawHeader.slice(separator + 1).trim(),
      }
      index += 1
      continue
    }

    if (value === '--remove-headers') {
      const rawRemoveHeaders = rest[index + 1]
      if (rawRemoveHeaders === undefined) {
        throw new Error('missing remove-headers value')
      }

      const names = rawRemoveHeaders
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
      if (names.length === 0) {
        throw new Error(`invalid remove-headers ${JSON.stringify(rawRemoveHeaders)}`)
      }

      result.removeHeaders = [...(result.removeHeaders || []), ...names]
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`unsupported network option: ${value}`)
    }

    if (!result.url) {
      result.url = value
      continue
    }

    throw new Error(`unexpected extra network argument: ${value}`)
  }

  return result
}

export const CONSOLE_LEVELS = ['error', 'warning', 'info', 'debug'] as const
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]

export function parseConsoleArgs(rest: string[]): { level: ConsoleLevel | null } {
  let level: ConsoleLevel | null = null

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--level') {
      const rawLevel = rest[index + 1]
      if (rawLevel === undefined) {
        throw new Error('missing level value')
      }

      if (!CONSOLE_LEVELS.includes(rawLevel as ConsoleLevel)) {
        throw new Error(
          `unsupported console level: ${rawLevel} (expected ${CONSOLE_LEVELS.join('|')})`,
        )
      }

      level = rawLevel as ConsoleLevel
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`unsupported console option: ${value}`)
    }

    throw new Error(`unexpected extra console argument: ${value}`)
  }

  return { level }
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

    if (value === '--gone') {
      waitArgs.gone = true
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
        if (rawLoadState !== 'load' && rawLoadState !== 'networkidle') {
          throw new Error(
            `unsupported --load value: ${rawLoadState} (expected load or networkidle)`,
          )
        }
        waitArgs.type = rawLoadState
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

  // --gone 只适用于文本等待（对齐 Playwright textGone），其它类型给了属于误用
  if (waitArgs.gone && waitArgs.type !== 'text') {
    throw new Error('--gone requires --text <text>')
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
    element: null,
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

    if (value === '--element') {
      const rawElement = rest[index + 1]
      if (rawElement === undefined) {
        throw new Error('missing element value')
      }
      if (screenshotArgs.element) {
        throw new Error('element target specified more than once')
      }
      screenshotArgs.element = rawElement
      index += 1
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

    // @eN 形式的 agent ref 不可能是文件路径，直接识别为元素目标；
    // 其余位置参数按惯例第一个是输出路径、第二个是元素 selector
    if (!value.startsWith('--')) {
      if (value.startsWith('@') && !screenshotArgs.element) {
        screenshotArgs.element = value
        continue
      }

      if (!screenshotArgs.path) {
        screenshotArgs.path = value
        continue
      }

      if (!screenshotArgs.element) {
        screenshotArgs.element = value
        continue
      }

      throw new Error(`unexpected extra argument for screenshot: ${value}`)
    }
  }

  if (screenshotArgs.element && screenshotArgs.full) {
    throw new Error('--element cannot be combined with --full')
  }

  return screenshotArgs
}
