import { describe, expect, test } from 'bun:test'
import { COMMAND_LOADERS } from '../src/cli/commands/index.js'
import { COMMAND_ACTIONS, SET_RESETTABLE_VALUE_TYPES } from '../src/cli/commands/actions.js'
import { HELP_ROOT, type HelpNode } from '../src/cli/help.js'
import { MCP_TOOLS } from '../src/cli/mcp-tools.js'
import { validateCommandArgs } from '../src/core/command-spec.js'
import { runCli } from './command-line-test-utils.js'
import { createCommandHandlers } from '../extension/background/command-handlers.js'
import { COMMAND_CATALOG } from '../src/core/command-catalog.js'
import {
  COMMANDS_REFERENCE_PATH,
  extractCommandListPaths,
  extractCommandListSection,
  readWorkspaceFile,
  uniqueSorted,
} from './command-surface-utils.js'

/**
 * 命令面一致性契约。
 *
 * COMMAND_CATALOG 提供命令与目标能力，command-handlers.ts 提供真实实现注册表；
 * CLI 帮助树告诉 agent 怎么调用，MCP 工具表决定 MCP 客户端能拿到哪些能力。
 *
 * 这里锁的是「跨文件的交叉关系」，任何一处漏改都会让另外几处说谎，而且失败必须发生在
 * 提交之前——否则 agent 读到的帮助和实际能执行的能力就会悄悄对不上。
 */

const ROUTER_COMMANDS = createCommandHandlers({} as never).commands
const REGISTRY_KEYS = Object.keys(COMMAND_LOADERS)

const COMMAND_LIST_PATHS = extractCommandListPaths(
  extractCommandListSection(await readWorkspaceFile(COMMANDS_REFERENCE_PATH)),
)

/**
 * action 表在源码里是 as const 的字面量表，测试只需要「路径 → action 列表」的宽类型，
 * 否则 Object.entries 会把各条目的字面量联合起来，读 defaultAction 之类的字段会报错。
 */
interface ActionEntry {
  actions: readonly string[]
  defaultAction?: string
}

const ACTION_TABLE: Record<string, ActionEntry> = COMMAND_ACTIONS

function topLevelNodes(): HelpNode[] {
  return HELP_ROOT.children ?? []
}

function findTopLevelNode(name: string): HelpNode | undefined {
  return topLevelNodes().find((node) => node.name === name)
}

/** 命令路径能否在帮助树里逐级走到（顶层命令 + 可选子命令）。 */
function resolvesToHelpNode(path: string): boolean {
  let node: HelpNode | undefined = HELP_ROOT
  for (const part of path.split(' ')) {
    const children: HelpNode[] = node?.children ?? []
    node =
      children.find((child) => child.name === part) ??
      children.find((child) => child.aliases?.includes(part))
    if (!node) {
      return false
    }
  }
  return true
}

/** 帮助树里声明的全部别名 -> 所属节点。 */
function aliasOwners(): Map<string, string> {
  const owners = new Map<string, string>()
  for (const node of topLevelNodes()) {
    for (const alias of node.aliases ?? []) {
      owners.set(alias, node.name)
    }
  }
  return owners
}

describe('command surface consistency', () => {
  test('every command the extension router implements is documented in the help tree', () => {
    // 扩展实现了但帮助里没有的命令，agent 就永远不会知道它存在。
    const undocumented = ROUTER_COMMANDS.filter((command) => {
      if (!command.includes('.')) {
        return !findTopLevelNode(command)
      }
      // 带命名空间的命令（tab.list）对应帮助树里的命名空间 + 子命令。
      const [namespace, action] = command.split('.')
      return !findTopLevelNode(namespace)?.children?.some((child) => child.name === action)
    })

    expect(undocumented).toEqual([])
  })

  test('the help tree only documents dispatchable CLI commands', () => {
    // 帮助里写了但 CLI 根本不认识的命令，agent 照着做只会拿到 unknown command。
    const phantom = topLevelNodes()
      .map((node) => node.name)
      .filter((name) => !REGISTRY_KEYS.includes(name))

    expect(phantom).toEqual([])
  })

  test('every CLI command is reachable from the help tree', () => {
    // CLI 注册了但帮助里没写的命令，agent 只能靠猜参数。
    const documented = new Set<string>(topLevelNodes().map((node) => node.name))
    for (const alias of aliasOwners().keys()) {
      documented.add(alias)
    }

    const undocumented = REGISTRY_KEYS.filter((key) => !documented.has(key))

    expect(undocumented).toEqual([])
  })

  test('declared aliases point at commands that actually exist', () => {
    const owners = aliasOwners()

    // 别名必须是 CLI 真实接受的顶层命令，否则帮助里出现了却调不通。
    const dangling = [...owners.keys()].filter((alias) => !REGISTRY_KEYS.includes(alias))
    expect(dangling).toEqual([])

    // 别名不能和真实命令重名，否则顶层分发会有歧义。
    const collisions = [...owners.keys()].filter((alias) => findTopLevelNode(alias))
    expect(collisions).toEqual([])
  })

  test('the catalog matches handlers and every command has a CLI namespace', () => {
    expect(uniqueSorted(ROUTER_COMMANDS)).toEqual(
      uniqueSorted(COMMAND_CATALOG.map((descriptor) => descriptor.name)),
    )
    const unreachable = COMMAND_CATALOG.map((descriptor) => descriptor.name).filter(
      (command) => !REGISTRY_KEYS.includes(command.split('.')[0]!),
    )
    expect(unreachable).toEqual([])
  })

  test('MCP tools only point at commands the extension router implements', () => {
    const routerSet = new Set(ROUTER_COMMANDS)
    const unknown = MCP_TOOLS.filter((tool) => !routerSet.has(tool.command)).map(
      (tool) => `${tool.name} -> ${tool.command}`,
    )

    expect(unknown).toEqual([])
  })

  test('MCP tool names stay unique and follow the MCP naming constraints', () => {
    const names = MCP_TOOLS.map((tool) => tool.name)

    const duplicates = uniqueSorted(names.filter((name, index) => names.indexOf(name) !== index))
    expect(duplicates).toEqual([])

    const invalid = names.filter((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name))
    expect(invalid).toEqual([])

    const undescribed = MCP_TOOLS.filter((tool) => !tool.description.trim()).map(
      (tool) => tool.name,
    )
    expect(undescribed).toEqual([])
  })

  test('every MCP tool command is reachable from the CLI', () => {
    const unreachable = MCP_TOOLS.filter(
      (tool) => !REGISTRY_KEYS.includes(tool.command.split('.')[0]!),
    ).map((tool) => `${tool.name} -> ${tool.command}`)

    expect(unreachable).toEqual([])
  })
})

describe('cli argument parsing matches the command spec', () => {
  // parse.ts 把 CLI 旗标翻译成命令参数，command-spec.ts 再校验同一批参数。
  // 两处各写一遍字段名，一旦漂移，只有真正发请求时才会报错；这里用真实 CLI 调用把两层钉在一起。
  const PARSER_BACKED_COMMANDS = [
    { argv: ['search', 'hello'], command: 'search' },
    { argv: ['wait', '500'], command: 'wait' },
    { argv: ['find', 'text', 'Sign in'], command: 'find' },
    { argv: ['console'], command: 'console' },
    { argv: ['errors'], command: 'errors' },
    { argv: ['snapshot'], command: 'snapshot' },
    { argv: ['network', 'requests'], command: 'network' },
  ]

  for (const { argv, command } of PARSER_BACKED_COMMANDS) {
    test(`${command} 的解析结果能被命令规格接受`, async () => {
      const result = await runCli(argv)

      // 参数没过本地校验时 CLI 根本不会发请求，这里必须能发出去。
      expect(result.fetchCalls).toHaveLength(1)
      const body = result.fetchCalls[0].body
      expect(body?.command).toBe(command)
      expect(() => validateCommandArgs(command, body?.args ?? {})).not.toThrow()
    })
  }
})

describe('agent command reference list only names real commands', () => {
  /**
   * references/commands.md 是 agent 按需读取的命令参考，它的「常用命令」清单比 help 树更容易过期：
   * help 树改了没人会主动同步参考文档，而 agent 读到的是后者。
   *
   * 单向锁：清单里写到的命令必须真实存在（CLI 能分发、帮助树里有条目）；
   * 但不要求清单覆盖全部命令——它本来就是策展子集，漏写不算漂移，写错才算。
   */
  test('commands.md 常用命令清单里的每条命令都真实存在', () => {
    // 段落被改名或解析失灵时这里会掉到 0，防止整组断言变成空转。
    expect(COMMAND_LIST_PATHS.length).toBeGreaterThanOrEqual(50)

    // 命令必须真的能分发，而不是只在文档里出现过。
    const unknownCommands = COMMAND_LIST_PATHS.filter(
      (path) => !REGISTRY_KEYS.includes(path.split(' ')[0]),
    )
    expect(unknownCommands).toEqual([])

    // 带子命令的条目（tab list、network har start）必须在帮助树里有对应层级。
    const undocumented = COMMAND_LIST_PATHS.filter((path) => !resolvesToHelpNode(path))
    expect(undocumented).toEqual([])
  })
})

describe('help tree and command action table agree', () => {
  /**
   * 命令的 action 白名单现在集中在 src/cli/commands/actions.ts 一处，帮助树是另一处独立描述。
   * 两者必须逐命名空间一致：
   * - 帮助树写了 CLI 不接受的 action，agent 照着做只会拿到 unsupported action；
   * - CLI 接受了但帮助树没写的 action，agent 根本不知道它存在。
   */

  /**
   * action 表在源码里是 as const 的字面量表，测试只需要「路径 → action 列表」的宽类型，
   * 否则 Object.entries 会把各条目的字面量联合起来，读 defaultAction 之类的字段会报错。
   */

  /**
   * 帮助树每个节点的子命令，键用点号分隔的命令路径，与 action 表的键同一套写法
   * （'network.har' 对应 network → har）。
   */
  function helpChildrenByPath(): Map<string, string[]> {
    const children = new Map<string, string[]>()
    const walk = (node: HelpNode, prefix: string[]): void => {
      for (const child of node.children ?? []) {
        const path = [...prefix, child.name]
        children.set(
          path.join('.'),
          (child.children ?? []).map((entry) => entry.name),
        )
        walk(child, path)
      }
    }
    walk(HELP_ROOT, [])
    return children
  }

  const HELP_CHILDREN = helpChildrenByPath()

  test('every action the CLI accepts is documented in the help tree', () => {
    const undocumented: string[] = []
    for (const [path, spec] of Object.entries(ACTION_TABLE)) {
      const documented = HELP_CHILDREN.get(path) ?? []
      for (const action of spec.actions) {
        if (!documented.includes(action)) {
          undocumented.push(`${path} ${action}`)
        }
      }
    }

    expect(undocumented).toEqual([])
  })

  test('the help tree does not document actions the CLI would reject', () => {
    const phantom: string[] = []
    for (const [path, children] of HELP_CHILDREN) {
      const spec = ACTION_TABLE[path]
      // 表里没有这个路径，说明该节点不接子命令；帮助树却写了子命令，就是假的。
      const accepted = spec ? [...spec.actions] : []
      for (const child of children) {
        if (!accepted.includes(child)) {
          phantom.push(`${path} ${child}`)
        }
      }
    }

    expect(phantom).toEqual([])
  })

  test('every action path in the table is a real CLI command', () => {
    const unknown: string[] = []
    for (const path of Object.keys(ACTION_TABLE)) {
      const head = path.split('.')[0]!
      if (!REGISTRY_KEYS.includes(head)) {
        unknown.push(path)
      }
    }

    expect(unknown).toEqual([])
  })

  test('the action table is internally consistent', () => {
    const duplicates: string[] = []
    const badDefaults: string[] = []
    for (const [path, spec] of Object.entries(ACTION_TABLE)) {
      if (new Set(spec.actions).size !== spec.actions.length) {
        duplicates.push(path)
      }
      if (spec.defaultAction !== undefined && !spec.actions.includes(spec.defaultAction)) {
        badDefaults.push(path)
      }
    }

    expect(duplicates).toEqual([])
    expect(badDefaults).toEqual([])
  })

  test('the default action is always documented in the help tree', () => {
    const undocumented: string[] = []
    for (const [path, spec] of Object.entries(ACTION_TABLE)) {
      if (spec.defaultAction === undefined) {
        continue
      }
      const documented = HELP_CHILDREN.get(path) ?? []
      if (!documented.includes(spec.defaultAction)) {
        undocumented.push(`${path} ${spec.defaultAction}`)
      }
    }

    expect(undocumented).toEqual([])
  })

  test('behaviour groupings only reference actions the CLI accepts', () => {
    const accepted = ACTION_TABLE.set?.actions ?? []
    const unknown = SET_RESETTABLE_VALUE_TYPES.filter((type) => !accepted.includes(type))

    expect(unknown).toEqual([])
  })
})
