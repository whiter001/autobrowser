import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { DROP_MAX_FILE_BYTES, DROP_MAX_TOTAL_BYTES } from '../../core/command-spec.js'
import { isRecord } from '../client.js'
import { CLI_ERROR_CODES, CliUsageError } from '../cli-error.js'
import { parseFindArgs, parseNumberArg, parseOptionalNumberArg } from '../parse.js'
import { COMMAND_ACTIONS } from './actions.js'
import {
  createSingleArgRequestCommand,
  helpRequested,
  parseOrThrow,
  readAllowedArg,
  readRequiredArg,
  requestAndWrite,
  throwCommandError,
} from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

/** 显式跟随新标签的开关：默认只报告新标签，不改变当前目标 */
const FOLLOW_NEW_TAB_FLAG = '--follow-new-tab'

export interface ClickArgs {
  selector: string
  followNewTab: boolean
}

/**
 * click 参数解析。
 *
 * --follow-new-tab 只能出现一次：重复出现说明调用方对"是否跟随"有歧义，
 * 报错比 last-wins 更安全。`--` 之后的内容按字面量当作选择器。
 */
export function parseClickArgs(rest: string[]): ClickArgs {
  const separatorIndex = rest.indexOf('--')
  const optionParts = separatorIndex < 0 ? rest : rest.slice(0, separatorIndex)
  const literalParts = separatorIndex < 0 ? [] : rest.slice(separatorIndex + 1)

  let followNewTab = false
  const positional: string[] = []
  for (const part of optionParts) {
    if (part === FOLLOW_NEW_TAB_FLAG) {
      if (followNewTab) {
        throw new CliUsageError(`duplicate click option: ${FOLLOW_NEW_TAB_FLAG}`, {
          details: { path: 'click' },
        })
      }
      followNewTab = true
      continue
    }
    if (part.startsWith('--')) {
      throw new CliUsageError(`unexpected extra argument for click: ${part}`, {
        details: { path: 'click' },
      })
    }
    positional.push(part)
  }

  if (positional.length > 1) {
    throw new CliUsageError(`unexpected extra argument for click: ${positional[1]}`, {
      details: { path: 'click' },
    })
  }

  const selector = [...positional, ...literalParts].join(' ').trim()
  if (!selector) {
    throw new CliUsageError('missing value for click', {
      details: { path: 'click' },
    })
  }

  return { selector, followNewTab }
}

/**
 * 组装跟随后的 meta：目标已经切到新标签，句柄/URL/标题都要换成新标签的。
 */
function buildFollowedMeta(
  clickMeta: unknown,
  followedTab: Record<string, unknown> | null,
  followMeta: unknown,
): Record<string, unknown> {
  const click = isRecord(clickMeta) ? clickMeta : {}
  const base = isRecord(followMeta) ? followMeta : {}
  if (!followedTab) {
    return base
  }

  return {
    ...base,
    tabHandle: followedTab.handle ?? base.tabHandle ?? null,
    tabId: followedTab.id ?? base.tabId ?? null,
    frame: base.frame ?? null,
    pageEpoch: base.pageEpoch ?? null,
    url: followedTab.url ?? base.url ?? click.url ?? null,
    title: followedTab.title ?? base.title ?? click.title ?? null,
    target: isRecord(base.target)
      ? base.target
      : {
          tabId: followedTab.id ?? null,
          handle: followedTab.handle ?? null,
          explicit: true,
        },
  }
}

async function handleClick(rest: string[], context: CommandContext): Promise<number | void> {
  const separatorIndex = rest.indexOf('--')
  const firstToken = separatorIndex === 0 ? rest[1] : rest[0]
  if (helpRequested(firstToken, context, ['click'])) {
    return 0
  }

  const parsed = parseOrThrow(() => parseClickArgs(rest))
  const payload = await context.requestCommand(context.flags.server, 'click', {
    selector: parsed.selector,
    ...(parsed.followNewTab ? { followNewTab: true } : {}),
  })

  if (payload.ok === false || !parsed.followNewTab) {
    context.writeResult(payload)
    return payload.ok === false ? 1 : 0
  }

  const clickResult = isRecord(payload.result) ? payload.result : {}
  const newTabHandle =
    typeof clickResult.newTabHandle === 'string' ? clickResult.newTabHandle.trim() : ''
  if (!newTabHandle) {
    // 没有新标签就没有可跟随的目标：原样返回点击结果
    context.writeResult(payload)
    return 0
  }

  // 复用现有的 tab attach 命令，不在这里另造一套"接管新标签"的逻辑
  let followed = await context.requestCommand(context.flags.server, 'tab.attach', {
    handle: newTabHandle,
  })
  let followMode: 'attach' | 'select' = 'attach'
  if (!followed.ok && followed.error?.code === 'WORKSPACE_REQUIRED') {
    // 无 workspace 模式（--no-workspace / AUTOBROWSER_WORKSPACE=off）没有归属可挂：
    // 改用 tab select 切换当前目标，语义等价，也不复制 attach 的实现。
    followMode = 'select'
    followed = await context.requestCommand(context.flags.server, 'tab.select', {
      handle: newTabHandle,
    })
  }
  const attachResult = isRecord(followed.result) ? followed.result : {}
  const followedTab = isRecord(attachResult.tab) ? attachResult.tab : null

  if (followed.ok === false) {
    // 跟随失败必须显式冒泡：点击本身成功了，但目标没有切到新标签
    context.writeResult({
      ok: false,
      error: followed.error ?? {
        message: `failed to attach new tab ${newTabHandle}`,
      },
      result: {
        ...clickResult,
        followedTab: null,
        followError: followed.error ?? null,
      },
    })
    return 1
  }

  context.writeResult({
    ok: true,
    result: {
      ...clickResult,
      followedTab,
      follow: {
        followed: true,
        mode: followMode,
        workspace: attachResult.workspace ?? null,
        attachment: attachResult.attachment ?? null,
      },
      meta: buildFollowedMeta(clickResult.meta, followedTab, attachResult.meta),
    },
  })
  return 0
}

const handleDoubleClick = createSingleArgRequestCommand({
  helpPath: ['dblclick'],
  command: 'dblclick',
  argName: 'selector',
})

async function handleFill(rest: string[], context: CommandContext): Promise<number | void> {
  const selector = readRequiredArg(rest[0], context, ['fill'])
  if (!selector) {
    return 0
  }
  if (rest.length < 2) {
    return throwCommandError('missing value for fill')
  }
  const value = rest.slice(1).join(' ')

  await requestAndWrite(context, 'fill', {
    selector,
    value,
  })
  return 0
}

async function handleFind(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['find'])) {
    return 0
  }

  const findArgs = parseOrThrow(() => parseFindArgs(rest))

  const payload = await context.requestCommand(context.flags.server, 'find', findArgs)
  context.writeResult(payload)
  return payload.ok === false ? 1 : 0
}

const handleHover = createSingleArgRequestCommand({
  helpPath: ['hover'],
  command: 'hover',
  argName: 'selector',
})

const handlePress = createSingleArgRequestCommand({
  helpPath: ['press'],
  command: 'press',
  argName: 'key',
})

const handleFocus = createSingleArgRequestCommand({
  helpPath: ['focus'],
  command: 'focus',
  argName: 'selector',
})

async function handleSelect(rest: string[], context: CommandContext): Promise<number | void> {
  const selector = readRequiredArg(rest[0], context, ['select'])
  const value = rest[1]
  if (!selector || value === undefined) {
    return context.writeHelp(['select'])
  }

  await requestAndWrite(context, 'select', {
    selector,
    value,
  })
  return 0
}

const handleCheck = createSingleArgRequestCommand({
  helpPath: ['check'],
  command: 'check',
  argName: 'selector',
})

const handleUncheck = createSingleArgRequestCommand({
  helpPath: ['uncheck'],
  command: 'uncheck',
  argName: 'selector',
})

export interface ScrollArgs {
  selector: string | null
  deltaX: number
  deltaY: number
}

// 只认十进制字面量：0x10、Infinity 这类串不能被当成数字，否则会被误判成滚动距离。
const SCROLL_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * scroll 参数解析。
 *
 * 数字开头一律按页面滚动理解，避免 "scroll 0 1800" 把 0 当成 CSS 选择器：
 * - 单个数字是纵向滚动距离（deltaX=0、deltaY=n）；
 * - 两个数字是页面 XY 滚动（先 deltaX 后 deltaY）。
 *
 * 其余按"选择器 + deltaX + deltaY"理解，兼容 scroll '#main' 0 1800 与 scroll '' 0 1800。
 */
export function parseScrollArgs(rest: string[]): ScrollArgs {
  const [first] = rest

  if (first !== undefined && SCROLL_NUMBER_PATTERN.test(first.trim())) {
    if (rest.length > 2) {
      throw new Error(`unexpected extra argument for scroll: ${rest[2]}`)
    }
    if (rest.length === 1) {
      return { selector: null, deltaX: 0, deltaY: parseNumberArg(first, 'scroll deltaY') }
    }
    return {
      selector: null,
      deltaX: parseNumberArg(rest[0]!, 'scroll deltaX'),
      deltaY: parseNumberArg(rest[1]!, 'scroll deltaY'),
    }
  }

  if (rest.length > 3) {
    throw new Error(`unexpected extra argument for scroll: ${rest[3]}`)
  }

  return {
    selector: first || null,
    deltaX: parseOptionalNumberArg(rest[1], 'scroll deltaX', 0),
    deltaY: parseOptionalNumberArg(rest[2], 'scroll deltaY', 100),
  }
}

async function handleScroll(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['scroll'])) {
    return 0
  }

  const scrollArgs = parseOrThrow(() => parseScrollArgs(rest))

  await requestAndWrite(context, 'scroll', scrollArgs)
  return 0
}

async function handleDrag(rest: string[], context: CommandContext): Promise<number | void> {
  const start = readRequiredArg(rest[0], context, ['drag'])
  const end = rest[1]
  if (!start) {
    return 0
  }

  await requestAndWrite(context, 'drag', {
    start,
    end: end || '',
  })
  return 0
}

async function handleUpload(rest: string[], context: CommandContext): Promise<number | void> {
  const selector = readRequiredArg(rest[0], context, ['upload'])
  const files = rest.slice(1)
  if (!selector || files.length === 0) {
    return context.writeHelp(['upload'])
  }

  await requestAndWrite(context, 'upload', {
    selector,
    files,
  })
  return 0
}

async function handleType(rest: string[], context: CommandContext): Promise<number | void> {
  const selector = readRequiredArg(rest[0], context, ['type'])
  if (!selector) {
    return 0
  }

  // -- 后的内容一律是文本，允许输入字面量 --submit
  const separatorIndex = rest.indexOf('--')
  const optionParts = rest.slice(1, separatorIndex < 0 ? undefined : separatorIndex)
  const literalParts = separatorIndex < 0 ? [] : rest.slice(separatorIndex + 1)
  let submit = false
  const valueParts = [
    ...optionParts.filter((part) => {
      if (part === '--submit') {
        submit = true
        return false
      }
      return true
    }),
    ...literalParts,
  ]
  if (valueParts.length === 0) {
    return throwCommandError('missing value for type')
  }
  const value = valueParts.join(' ')

  await requestAndWrite(context, 'type', {
    selector,
    value,
    ...(submit ? { submit: true } : {}),
  })
  return 0
}

async function handleKeyboard(rest: string[], context: CommandContext): Promise<number | void> {
  const action = readAllowedArg(rest[0], context, ['keyboard'], COMMAND_ACTIONS.keyboard.actions)
  if (!action) {
    return 0
  }
  if (rest.length < 2) {
    return throwCommandError(`missing text for keyboard ${action}`)
  }
  const value = rest.slice(1).join(' ')

  await requestAndWrite(context, 'keyboard', {
    action,
    text: value,
  })
  return 0
}

const handleLocator = createSingleArgRequestCommand({
  helpPath: ['locator'],
  command: 'locator',
  argName: 'selector',
})

async function handleHighlight(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['highlight'])) return 0
  let selector: string | undefined
  let style: string | undefined
  let hide = false
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!
    if (value === '--hide') {
      hide = true
      continue
    }
    if (value === '--style') {
      style = rest[++index]
      if (!style) return throwCommandError('missing value for --style')
      continue
    }
    if (value.startsWith('--')) return throwCommandError(`unsupported highlight option: ${value}`)
    if (selector) return throwCommandError(`unexpected extra argument for highlight: ${value}`)
    selector = value
  }
  if (!selector && !hide) return throwCommandError('highlight requires a selector or --hide')
  if (hide && style) return throwCommandError('--style cannot be combined with --hide')
  await requestAndWrite(context, 'highlight', {
    ...(selector ? { selector } : {}),
    ...(style ? { style } : {}),
    ...(hide ? { hide: true } : {}),
  })
  return 0
}

function parseMouseNumber(value: string | undefined, name: string): number {
  if (value === undefined || !Number.isFinite(Number(value)))
    throw new Error(`${name} must be a finite number`)
  return Number(value)
}

function createMouseNumberHandler(command: 'mousemove' | 'mousewheel') {
  return async (rest: string[], context: CommandContext): Promise<number | void> => {
    if (helpRequested(rest[0], context, [command])) return 0
    if (rest.length !== 2) return throwCommandError(`${command} requires two numeric arguments`)
    const first = parseMouseNumber(rest[0], command === 'mousemove' ? 'x' : 'deltaX')
    const second = parseMouseNumber(rest[1], command === 'mousemove' ? 'y' : 'deltaY')
    await requestAndWrite(
      context,
      command,
      command === 'mousemove' ? { x: first, y: second } : { deltaX: first, deltaY: second },
    )
    return 0
  }
}

function createMouseButtonHandler(command: 'mousedown' | 'mouseup') {
  return async (rest: string[], context: CommandContext): Promise<number | void> => {
    if (helpRequested(rest[0], context, [command])) return 0
    if (rest.length > 1)
      return throwCommandError(`unexpected extra argument for ${command}: ${rest[1]}`)
    const button = rest[0] || 'left'
    if (!['left', 'right', 'middle', 'back', 'forward'].includes(button))
      return throwCommandError(`unsupported mouse button: ${button}`)
    await requestAndWrite(context, command, { button })
    return 0
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
}

async function readDropFile(filePath: string) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) throw new Error(`drop path is not a file: ${filePath}`)
  if (fileStat.size > DROP_MAX_FILE_BYTES) throw new Error(`drop file exceeds 32MiB: ${filePath}`)
  const content = await readFile(filePath)
  return {
    name: path.basename(filePath),
    mimeType: MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    dataBase64: content.toString('base64'),
    size: content.byteLength,
  }
}

async function handleDrop(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['drop'])) return 0
  const selector = rest[0]
  if (!selector) return throwCommandError('missing selector for drop')
  const data: Record<string, string> = {}
  const files: Array<{ name: string; mimeType: string; dataBase64: string }> = []
  let totalBytes = 0
  for (let index = 1; index < rest.length; index += 1) {
    const option = rest[index]!
    const inlinePath = option.startsWith('--path=') ? option.slice('--path='.length) : null
    const inlineData = option.startsWith('--data=') ? option.slice('--data='.length) : null
    if (option === '--path' || inlinePath !== null) {
      const filePath = inlinePath ?? rest[++index]
      if (!filePath) return throwCommandError('missing value for --path')
      const file = await readDropFile(filePath)
      totalBytes += file.size
      if (totalBytes > DROP_MAX_TOTAL_BYTES) return throwCommandError('drop files exceed 64MiB')
      files.push({ name: file.name, mimeType: file.mimeType, dataBase64: file.dataBase64 })
      continue
    }
    if (option === '--data' || inlineData !== null) {
      const item = inlineData ?? rest[++index]
      if (!item) return throwCommandError('missing value for --data')
      const separator = item.indexOf('=')
      if (separator <= 0) return throwCommandError('--data must use mimeType=text format')
      data[item.slice(0, separator)] = item.slice(separator + 1)
      continue
    }
    return throwCommandError(`unsupported drop option: ${option}`)
  }
  if (!Object.keys(data).length && !files.length)
    return throwCommandError('drop requires at least one --path or --data item')
  await requestAndWrite(context, 'drop', { selector, data, files })
  return 0
}

const SCROLL_INTO_VIEW_USAGE = 'autobrowser scrollintoview <selector>'

/**
 * 拒绝 Playwright 风格的 text= 引擎选择器。
 *
 * 扩展侧的 scrollintoview 只认 CSS/@eN，text= 会一路走到 Element.matches 才抛原生
 * DOMException，调用方只能看到含糊的 EXTENSION_COMMAND_ERROR。在这里提前拦下，
 * 让错误直接说明该换成什么写法。
 */
function rejectTextEngineSelector(selector: string): void {
  // Playwright 的选择器引擎前缀大小写不敏感，这里按同一语义处理，并容忍前导空白
  if (!/^text=/i.test(selector.trimStart())) {
    return
  }

  throw new CliUsageError(
    `scrollintoview does not support Playwright text= selectors: ${selector}`,
    {
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      details: {
        command: 'scrollintoview',
        selector,
        usage: SCROLL_INTO_VIEW_USAGE,
        supported: 'CSS selector or @eN ref (e.g. "#footer", ".item", "@e12")',
      },
      suggestedAction:
        `Use a CSS selector or @eN ref with '${SCROLL_INTO_VIEW_USAGE}', ` +
        "or locate the element by text with 'autobrowser find text <text> click'.",
    },
  )
}

async function handleScrollIntoView(
  rest: string[],
  context: CommandContext,
): Promise<number | void> {
  // 与 createSingleArgRequestCommand 保持一致：-- 之后的内容才是 selector
  const args = rest[0] === '--' ? rest.slice(1) : rest
  const selector = readRequiredArg(args[0], context, ['scrollintoview'])
  if (!selector) {
    return 0
  }
  rejectTextEngineSelector(selector)
  if (args.length > 1) {
    throw new CliUsageError(`unexpected extra argument for scrollintoview: ${args[1]}`, {
      details: { path: 'scrollintoview' },
    })
  }

  await requestAndWrite(context, 'scrollintoview', { selector })
  return 0
}

export const elementCommandRegistry: CommandRegistry = {
  click: handleClick,
  dblclick: handleDoubleClick,
  fill: handleFill,
  find: handleFind,
  locator: handleLocator,
  'generate-locator': handleLocator,
  highlight: handleHighlight,
  hover: handleHover,
  press: handlePress,
  focus: handleFocus,
  select: handleSelect,
  check: handleCheck,
  uncheck: handleUncheck,
  scroll: handleScroll,
  drag: handleDrag,
  drop: handleDrop,
  mousemove: createMouseNumberHandler('mousemove'),
  mousedown: createMouseButtonHandler('mousedown'),
  mouseup: createMouseButtonHandler('mouseup'),
  mousewheel: createMouseNumberHandler('mousewheel'),
  upload: handleUpload,
  type: handleType,
  keyboard: handleKeyboard,
  scrollintoview: handleScrollIntoView,
}
