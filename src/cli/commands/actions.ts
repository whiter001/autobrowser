/**
 * CLI 命令的 action 白名单（单一事实来源）。
 *
 * 之前同一份白名单散落在各命令模块里：常量数组（COOKIE_ACTIONS、NETWORK_ACTIONS…）、
 * createActionCommand 的内联 allowed、以及手写的 if 链和 includes 判断。加一个 action
 * 很容易只改一处，帮助树和实际行为就对不上，agent 读到的帮助就是错的。
 *
 * 这里统一描述「命令路径 → 该路径下 CLI 接受的 action」：
 * - 键是 CLI 命令路径，点号分隔，与帮助树层级一致（'network.har' 对应 network → har）；
 * - actions 是该路径下被识别的 action / 子命令；
 * - defaultAction 是省略 action 时使用的默认值，缺省表示必须显式指定。
 *
 * 帮助树（src/cli/help.ts）仍然手写 summary 和 usage，但子命令名必须与本表一致，
 * 由 test/command-surface.test.ts 双向校验。
 */

export interface CommandActionSpec {
  /** 该命令路径下 CLI 识别的 action / 子命令 */
  actions: readonly string[]
  /** 省略 action 时使用的默认 action；缺省表示必须显式指定 */
  defaultAction?: string
}

export const COMMAND_ACTIONS = {
  actions: { actions: ['list', 'clear'] },
  cookies: { actions: ['list', 'get', 'set', 'clear', 'delete'] },
  storage: { actions: ['get', 'set', 'clear', 'delete'] },
  set: {
    actions: [
      'viewport',
      'offline',
      'auto-snapshot',
      'headers',
      'geo',
      'media',
      'media-type',
      'reduced-motion',
      'forced-colors',
      'contrast',
      'device',
      'permission',
      'ua',
      'timezone',
      'locale',
    ],
  },
  clipboard: { actions: ['read', 'write'] },
  state: { actions: ['save', 'load'] },
  network: { actions: ['route', 'unroute', 'requests', 'export', 'request', 'har'] },
  'network.har': { actions: ['start', 'stop', 'status', 'recover'] },
  'network.route': { actions: ['list'] },
  window: { actions: ['new'] },
  dialog: { actions: ['accept', 'dismiss', 'status', 'auto'] },
  script: { actions: ['add', 'list', 'remove'] },
  keyboard: { actions: ['type', 'inserttext', 'keydown', 'keyup'] },
  webmcp: { actions: ['list', 'call'] },
  extension: { actions: ['info', 'reload', 'reconnect'] },
  skill: { actions: ['sync', 'status'] },
  tab: { actions: ['list', 'new', 'attach', 'detach', 'select', 'close'] },
  workspace: { actions: ['current', 'list', 'release'], defaultAction: 'current' },
  target: { actions: ['show', 'clear', 'active', 'set'], defaultAction: 'show' },
  command: { actions: ['list', 'status', 'cancel', 'reset'], defaultAction: 'list' },
  session: {
    actions: ['list', 'create', 'attach', 'detach', 'close-all', 'kill-all', 'delete-data'],
    defaultAction: 'list',
  },
  server: { actions: ['stop'] },
  downloads: { actions: ['list', 'clear'], defaultAction: 'list' },
  media: { actions: ['list'] },
  snapshot: { actions: ['export', 'extract'] },
  tracing: { actions: ['start', 'status', 'stop'] },
  video: { actions: ['status', 'start', 'chapter', 'show-actions', 'hide-actions', 'stop'] },
} as const satisfies Record<string, CommandActionSpec>

/**
 * set 下走「可传值、可 --reset」分支的类型。
 *
 * 这是行为分组而不是受理白名单（受理白名单是 COMMAND_ACTIONS.set），但类型名仍要只有一处；
 * test/command-surface.test.ts 会断言这些名字都在白名单里，防止分组里出现不存在的类型。
 */
export const SET_RESETTABLE_VALUE_TYPES = ['reduced-motion', 'forced-colors', 'contrast'] as const

export type CommandActionPath = keyof typeof COMMAND_ACTIONS

/** 命令路径下被接受的 action 列表；类型收窄到字面量，供命令实现直接使用。 */
export function getCommandActions(path: CommandActionPath): readonly string[] {
  return COMMAND_ACTIONS[path].actions
}

/**
 * 判断某个 token 是否是该命令路径接受的 action。
 *
 * 供原来写死 `['a','b'].includes(action)` 的地方改用：白名单只存在于本表一处。
 */
export function isCommandAction(path: CommandActionPath, token: string | undefined): boolean {
  if (token === undefined) {
    return false
  }
  return (COMMAND_ACTIONS[path].actions as readonly string[]).includes(token)
}

/** 某个命令路径的默认 action 类型；有默认值时收窄成字面量，没有则是 undefined。 */
export type CommandDefaultAction<P extends CommandActionPath> =
  (typeof COMMAND_ACTIONS)[P] extends { defaultAction: infer D } ? D : undefined

/**
 * 省略 action 时使用的默认 action；没有默认值时返回 undefined。
 *
 * 返回类型按路径收窄：`getCommandDefaultAction('session')` 是 'list' 而不是 string，
 * 调用方拼出来的默认值因此始终是确定的字符串。
 */
export function getCommandDefaultAction<P extends CommandActionPath>(
  path: P,
): CommandDefaultAction<P> {
  return findCommandDefaultAction(path) as CommandDefaultAction<P>
}

/**
 * 同上，但不做字面量收窄。
 *
 * getCommandDefaultAction 依赖路径是字面量才能收窄；按路径变量查表时（例如统一处理所有
 * action 命令入口的 helper）类型会塌成 undefined，这里单独给一个宽类型版本，
 * 免得调用方自己写断言。
 */
export function findCommandDefaultAction(path: CommandActionPath): string | undefined {
  const spec = COMMAND_ACTIONS[path] as { defaultAction?: string }
  return spec.defaultAction
}
