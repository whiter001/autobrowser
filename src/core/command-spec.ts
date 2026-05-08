export interface CommandSpec {
  name: string
  supportsTabTarget?: boolean
  supportsFrameTarget?: boolean
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
  'find',
  'focus',
  'get',
  'hover',
  'is',
  'screenshot',
  'scroll',
  'scrollintoview',
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
