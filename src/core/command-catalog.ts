export interface CommandDescriptor {
  name: string
  supportsTabTarget?: boolean
  supportsFrameTarget?: boolean
}

const TAB_TARGET_COMMANDS = [
  'actions',
  'back',
  'check',
  'click',
  'clipboard',
  'close',
  'cdp',
  'console',
  'cookies',
  'dblclick',
  'dialog',
  'download',
  'drag',
  'drop',
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
  'highlight',
  'hover',
  'is',
  'keyboard',
  'locator',
  'media',
  'mousemove',
  'mousedown',
  'mouseup',
  'mousewheel',
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
  'tracing',
  'type',
  'uncheck',
  'video',
  'upload',
  'wait',
  'webmcp',
  'window',
] as const

const FRAME_TARGET_COMMANDS = [
  'check',
  'click',
  'dblclick',
  'drag',
  'drop',
  'eval',
  'fill',
  'fillform',
  'feed',
  'find',
  'focus',
  'get',
  'highlight',
  'hover',
  'is',
  'locator',
  'media',
  'goto',
  'reload',
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
  'webmcp',
] as const

const CONTROL_COMMANDS = [
  'batch',
  'command',
  'downloads',
  'extension',
  'open',
  'script',
  'status',
  'tab.close',
  'tab.list',
  'tab.new',
  'tab.select',
  'target',
] as const

const FRAME_TARGET_COMMAND_SET = new Set<string>(FRAME_TARGET_COMMANDS)

/** CLI、relay 与扩展共享的命令目录；各接口仍可保留自己的语法和说明文案。 */
export const COMMAND_CATALOG: CommandDescriptor[] = [
  ...CONTROL_COMMANDS,
  ...TAB_TARGET_COMMANDS,
].map((name) => ({
  name,
  ...(TAB_TARGET_COMMANDS.includes(name as (typeof TAB_TARGET_COMMANDS)[number])
    ? { supportsTabTarget: true }
    : {}),
  ...(FRAME_TARGET_COMMAND_SET.has(name) ? { supportsFrameTarget: true } : {}),
}))

const COMMAND_CATALOG_BY_NAME = new Map(COMMAND_CATALOG.map((spec) => [spec.name, spec]))

export function getCommandDescriptor(command: string): CommandDescriptor | undefined {
  return COMMAND_CATALOG_BY_NAME.get(command)
}

export function commandSupportsTabTarget(command: string): boolean {
  return getCommandDescriptor(command)?.supportsTabTarget === true
}

export function commandSupportsFrameTarget(command: string): boolean {
  return getCommandDescriptor(command)?.supportsFrameTarget === true
}
