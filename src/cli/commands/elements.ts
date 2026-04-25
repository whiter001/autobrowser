import { parseFindArgs } from '../parse.js'
import {
  createSingleArgRequestCommand,
  helpRequested,
  parseOrWriteError,
  readAllowedArg,
  readRequiredArg,
  requestAndWrite,
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
  const value = rest.slice(1).join(' ')
  if (!selector) {
    return 0
  }

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

  await requestAndWrite(context, 'scroll', {
    selector: rest[0] || null,
    deltaX: Number(rest[1] || 0),
    deltaY: Number(rest[2] || 100),
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
  const value = rest.slice(1).join(' ')
  if (!selector) {
    return 0
  }

  await requestAndWrite(context, 'type', {
    selector,
    value,
  })
  return 0
}

async function handleKeyboard(rest: string[], context: CommandContext): Promise<number | void> {
  const action = readAllowedArg(rest[0], context, ['keyboard'], KEYBOARD_ACTIONS)
  const value = rest.slice(1).join(' ')
  if (!action) {
    return 0
  }

  await requestAndWrite(context, 'keyboard', {
    action,
    text: value,
  })
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
  hover: handleHover,
  press: handlePress,
  focus: handleFocus,
  select: handleSelect,
  check: handleCheck,
  uncheck: handleUncheck,
  scroll: handleScroll,
  drag: handleDrag,
  upload: handleUpload,
  type: handleType,
  keyboard: handleKeyboard,
  scrollintoview: handleScrollIntoView,
}
