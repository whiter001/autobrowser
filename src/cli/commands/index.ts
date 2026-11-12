import type { CommandHandler, CommandRegistry } from './types.js'

/**
 * 命令实现按需加载。
 *
 * CLI 每次调用都是独立进程，静态引入全部命令组意味着每条命令都要加载 MCP SDK、
 * HAR 录制、下载链路等与本次无关的模块。实测整张注册表约 225ms，其中仅
 * @modelcontextprotocol/sdk 就占约 190ms，而它只服务 `autobrowser mcp` 一个命令。
 * 改成动态 import 后，只有真正执行的那个命令才付出加载成本。
 *
 * 命令名集中在这里声明，它仍是「哪些命令真的能跑」的唯一事实来源：
 * test/command-registry.test.ts 会校验它与各实现模块导出的注册表键完全一致。
 */
export type CommandLoader = () => Promise<CommandHandler>

type GroupLoader = () => Promise<CommandRegistry>

/**
 * 实现组 → 动态 import。同一组的多个命令共享同一次模块加载，
 * 打包器也能对这些字面量 import 做静态分析。
 */
const GROUP_LOADERS: Record<string, GroupLoader> = {
  batch: () => import('./batch.js').then((module) => module.batchCommandRegistry),
  collect: () => import('./collect.js').then((module) => module.collectCommandRegistry),
  diagnostics: () => import('./diagnostics.js').then((module) => module.diagnosticsCommandRegistry),
  elements: () => import('./elements.js').then((module) => module.elementCommandRegistry),
  extension: () => import('./extension.js').then((module) => module.extensionCommandRegistry),
  fillform: () => import('./fillform.js').then((module) => module.fillFormCommandRegistry),
  media: () => import('./media.js').then((module) => module.mediaCommandRegistry),
  page: () => import('./page.js').then((module) => module.pageCommandRegistry),
  server: () => import('./server.js').then((module) => module.serverCommandRegistry),
  skill: () => import('./skill.js').then((module) => module.skillCommandRegistry),
  state: () => import('./state.js').then((module) => module.stateCommandRegistry),
  tabs: () => import('./tabs.js').then((module) => module.tabCommandRegistry),
  version: () => import('./version.js').then((module) => module.versionCommandRegistry),
  webmcp: () => import('./webmcp.js').then((module) => module.webmcpCommandRegistry),
  // mcp 命令独占 @modelcontextprotocol/sdk，必须等到真正执行该命令时才加载
  mcp: () => import('../mcp.js').then((module) => ({ mcp: module.handleMcpCommand })),
}

/** 命令名 → 所属实现组。组内注册表的键就是命令名。 */
const COMMAND_GROUPS: Record<string, string[]> = {
  batch: ['batch'],
  collect: ['collect'],
  diagnostics: ['tracing', 'video', 'actions'],
  elements: [
    'click',
    'dblclick',
    'fill',
    'find',
    'locator',
    'generate-locator',
    'highlight',
    'hover',
    'press',
    'focus',
    'select',
    'check',
    'uncheck',
    'scroll',
    'drag',
    'drop',
    'mousemove',
    'mousedown',
    'mouseup',
    'mousewheel',
    'upload',
    'type',
    'keyboard',
    'scrollintoview',
  ],
  extension: ['extension'],
  fillform: ['fillform'],
  media: ['download', 'media'],
  page: [
    'eval',
    'run',
    'cdp',
    'script',
    'snapshot',
    'search',
    'feed',
    'screenshot',
    'back',
    'forward',
    'reload',
    'close',
    'quit',
    'exit',
    'window',
    'frame',
    'is',
    'get',
    'dialog',
    'downloads',
    'wait',
    'console',
    'errors',
    'pdf',
  ],
  server: [
    'help',
    '--help',
    '-h',
    'server',
    'connect',
    'status',
    'doctor',
    'replay',
    'config',
    'session',
    'attach',
    'detach',
    'close-all',
    'kill-all',
    'delete-data',
  ],
  skill: ['skill'],
  state: ['cookies', 'storage', 'set', 'clipboard', 'state', 'network'],
  tabs: ['tab', 'target', 'command', 'workspace', 'open', 'goto'],
  version: ['version'],
  webmcp: ['webmcp'],
  mcp: ['mcp'],
}

function createCommandLoaders(): Record<string, CommandLoader> {
  const loaders: Record<string, CommandLoader> = {}
  for (const [group, commands] of Object.entries(COMMAND_GROUPS)) {
    const loadGroup = GROUP_LOADERS[group]
    if (!loadGroup) throw new Error(`命令组 ${group} 缺少加载器`)
    for (const command of commands) {
      loaders[command] = async () => {
        const handler = (await loadGroup())[command]
        if (!handler) throw new Error(`命令 "${command}" 未在注册表 ${group} 中实现`)
        return handler
      }
    }
  }
  return loaders
}

/** 命令名 → 实现加载器。键即命令名，供未知命令纠错与分发共用。 */
export const COMMAND_LOADERS: Record<string, CommandLoader> = createCommandLoaders()

/** 供测试校验用的实现组清单，避免命令名声明与实现漂移。 */
export const COMMAND_GROUP_NAMES: string[] = Object.keys(COMMAND_GROUPS)
