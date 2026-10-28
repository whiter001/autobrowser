import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { DROP_MAX_FILE_BYTES, DROP_MAX_TOTAL_BYTES } from '../../core/command-spec.js'
import { parseFindArgs, parseOptionalNumberArg } from '../parse.js'
import {
  createSingleArgRequestCommand,
  helpRequested,
  parseOrWriteError,
  readAllowedArg,
  readRequiredArg,
  requestAndWrite,
  writeCommandError,
} from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

const KEYBOARD_ACTIONS = ['type', 'inserttext', 'keydown', 'keyup'] as const

const handleClick = createSingleArgRequestCommand({
  helpPath: ['click'],
  command: 'click',
  argName: 'selector',
})

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
    return writeCommandError('missing value for fill')
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

  const findArgs = parseOrWriteError(() => parseFindArgs(rest))
  if (!findArgs) {
    return 1
  }

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

async function handleScroll(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['scroll'])) {
    return 0
  }

  const scrollArgs = parseOrWriteError(() => ({
    deltaX: parseOptionalNumberArg(rest[1], 'scroll deltaX', 0),
    deltaY: parseOptionalNumberArg(rest[2], 'scroll deltaY', 100),
  }))
  if (!scrollArgs) {
    return 1
  }

  await requestAndWrite(context, 'scroll', {
    selector: rest[0] || null,
    ...scrollArgs,
  })
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
    return writeCommandError('missing value for type')
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
  const action = readAllowedArg(rest[0], context, ['keyboard'], KEYBOARD_ACTIONS)
  if (!action) {
    return 0
  }
  if (rest.length < 2) {
    return writeCommandError(`missing text for keyboard ${action}`)
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
      if (!style) return writeCommandError('missing value for --style')
      continue
    }
    if (value.startsWith('--')) return writeCommandError(`unsupported highlight option: ${value}`)
    if (selector) return writeCommandError(`unexpected extra argument for highlight: ${value}`)
    selector = value
  }
  if (!selector && !hide) return writeCommandError('highlight requires a selector or --hide')
  if (hide && style) return writeCommandError('--style cannot be combined with --hide')
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
    if (rest.length !== 2) return writeCommandError(`${command} requires two numeric arguments`)
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
      return writeCommandError(`unexpected extra argument for ${command}: ${rest[1]}`)
    const button = rest[0] || 'left'
    if (!['left', 'right', 'middle', 'back', 'forward'].includes(button))
      return writeCommandError(`unsupported mouse button: ${button}`)
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
  if (!selector) return writeCommandError('missing selector for drop')
  const data: Record<string, string> = {}
  const files: Array<{ name: string; mimeType: string; dataBase64: string }> = []
  let totalBytes = 0
  for (let index = 1; index < rest.length; index += 1) {
    const option = rest[index]!
    const inlinePath = option.startsWith('--path=') ? option.slice('--path='.length) : null
    const inlineData = option.startsWith('--data=') ? option.slice('--data='.length) : null
    if (option === '--path' || inlinePath !== null) {
      const filePath = inlinePath ?? rest[++index]
      if (!filePath) return writeCommandError('missing value for --path')
      const file = await readDropFile(filePath)
      totalBytes += file.size
      if (totalBytes > DROP_MAX_TOTAL_BYTES) return writeCommandError('drop files exceed 64MiB')
      files.push({ name: file.name, mimeType: file.mimeType, dataBase64: file.dataBase64 })
      continue
    }
    if (option === '--data' || inlineData !== null) {
      const item = inlineData ?? rest[++index]
      if (!item) return writeCommandError('missing value for --data')
      const separator = item.indexOf('=')
      if (separator <= 0) return writeCommandError('--data must use mimeType=text format')
      data[item.slice(0, separator)] = item.slice(separator + 1)
      continue
    }
    return writeCommandError(`unsupported drop option: ${option}`)
  }
  if (!Object.keys(data).length && !files.length)
    return writeCommandError('drop requires at least one --path or --data item')
  await requestAndWrite(context, 'drop', { selector, data, files })
  return 0
}

const handleScrollIntoView = createSingleArgRequestCommand({
  helpPath: ['scrollintoview'],
  command: 'scrollintoview',
  argName: 'selector',
})

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
