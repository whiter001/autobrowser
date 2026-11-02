import { readFile, readdir } from 'node:fs/promises'

/**
 * 命令面一致性测试共用的抽取逻辑。
 *
 * 同一份命令清单散落在六处：扩展路由（command-router.ts 的 switch）、命令规格
 * （command-spec.ts）、CLI 帮助树（help.ts）、CLI 参数解析（parse.ts）、MCP 工具表
 * （mcp-tools.ts），以及 agent 实际加载的 SKILL.md。测试要在这些清单之间做交叉校验，
 * 前提是能稳定地把清单抽出来，所以抽取口径集中放在这里，避免各测试文件各写一套正则、
 * 互相漂移。
 */

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

export async function readWorkspaceFile(relativePath: string): Promise<string> {
  return await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

/** agent 实际加载的那份 skill 文档；它是第六处命令描述面。 */
export const SKILL_MARKDOWN_PATH = '.agents/skills/autobrowser/SKILL.md'

/**
 * 取出 SKILL.md 的「常用命令」段落。
 *
 * agent 读的是这份文件，不是 help 树，所以它和命令面同样会漂移。段落标题一旦被改名，
 * 这里会返回空串，测试靠条目数下限发现，不会静默变成空转断言。
 */
export function extractSkillCommandSection(markdown: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## 常用命令')
  if (start === -1) {
    return ''
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n')
}

/**
 * 从「常用命令」段落里抽出命令路径。
 *
 * 清单条目是「命令 + 参数」混排的，例如 `tab new <url> [--wait-for ...]`、
 * `download <url|--media <index>> [output-path]`；参数从第一个 < [ { 处截断。
 * 以 -- 开头的片段是旗标而不是命令，直接跳过。
 */
export function extractSkillCommandPaths(section: string): string[] {
  const paths: string[] = []
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('- ')) {
      continue
    }
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      const raw = span[1].trim()
      if (!raw || raw.startsWith('-')) {
        continue
      }
      const path = raw.split(/[<[{]/)[0].trim().replace(/\s+/g, ' ')
      if (path) {
        paths.push(path)
      }
    }
  }
  return uniqueSorted(paths)
}

/**
 * 抽出 CLI 源码里 `switch (<command>Action)` 的分支标签。
 *
 * 变量名约定：<命令路径 camelCase> + 'Action'，例如 tracingAction 对应 action 表里的 'tracing'。
 * 命令实现改成 switch 分发后，case 标签就是它的实现面；测试拿它和 action 表双向核对，
 * 表里加了 action 而实现漏了分支（或反过来）都会立刻失败。
 */
export function extractActionSwitchBranches(source: string): Map<string, string[]> {
  const branches = new Map<string, string[]>()
  const pattern = /switch \((\w+Action)\)\s*\{/g

  for (const match of source.matchAll(pattern)) {
    const body = readBlockBody(source, match.index + match[0].length)
    branches.set(
      match[1]!,
      uniqueSorted([...body.matchAll(/case '([^']+)'/g)].map((entry) => entry[1]!)),
    )
  }

  return branches
}

/**
 * 从 switch 的 '{' 之后开始读到配对的 '}'，跳过字符串、模板串和行注释，
 * 避免把模板串里的 ${...} 或注释里的花括号算进嵌套层级。
 */
function readBlockBody(source: string, start: number): string {
  let depth = 1
  let index = start

  while (index < source.length && depth > 0) {
    const char = source[index]!

    if (char === "'" || char === '"' || char === '`') {
      index = skipQuoted(source, index)
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      index = newline === -1 ? source.length : newline
      continue
    }
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
    }
    index += 1
  }

  return source.slice(start, index)
}

function skipQuoted(source: string, start: number): number {
  const quote = source[start]!
  let index = start + 1

  while (index < source.length) {
    const char = source[index]!
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      return index + 1
    }
    index += 1
  }

  return index
}

/** src/cli/commands 下真正承载命令实现的模块；index.ts 只做注册表聚合。 */
export async function readCliCommandSources(): Promise<string[]> {
  const commandsDir = new URL('../src/cli/commands/', import.meta.url)
  const entries = await readdir(commandsDir)
  return await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.ts') && !['index.ts', 'types.ts'].includes(entry))
      .map(async (entry) => await readFile(new URL(entry, commandsDir), 'utf8')),
  )
}

/**
 * 扩展路由真正实现的命令清单。
 *
 * command-router.ts 里只有一个 `switch (command)`，所有 `case '...'` 都是它的分支，
 * 因此全文件匹配 case 标签就等于命令面，不会有误伤。
 */
export function extractRouterCommands(source: string): string[] {
  return uniqueSorted([...source.matchAll(/case '([^']+)'/g)].map((match) => match[1]))
}

/**
 * CLI 会转发给扩展的命令名。
 *
 * 转发点有六种写法，缺一不可：
 * 1. requestAndWrite(context, 'goto', ...)；
 * 2. runActionCommand(context, 'target', ...)——action 命令统一走这个 helper；
 * 3. context.requestCommand(context.flags.server, 'tab.list', ...)——参数可能换行，
 *    所以括号与首个参数之间必须允许空白，否则 'batch'、'tab.close' 这类多行调用会被漏掉；
 * 4. createSingleArgRequestCommand({ command: 'click' })，以及 command: 'open' | 'goto'
 *    这种联合类型写法；
 * 5. createMouseButtonHandler('mouseup')——命令名是工厂入参，requestAndWrite 收的是变量；
 * 6. collect.ts 内部 request(context, 'goto', ...) 这类本地转发 helper。
 *
 * 漏掉任何一种都会让「CLI 能触达的命令」少算几个，测试会误报 router 有命令没人用；
 * 多匹配则会误报 CLI 发了扩展不认识的命令。两种都是响亮的失败，不会静默放过。
 */
export function extractCliForwardedCommands(source: string): string[] {
  const names: string[] = []

  for (const match of source.matchAll(
    /(?:requestAndWrite|runActionCommand)\(\s*context,\s*['"]([^'"]+)['"]/g,
  )) {
    names.push(match[1])
  }

  for (const match of source.matchAll(
    /requestCommand\(\s*context\.flags\.server,\s*['"]([^'"]+)['"]/g,
  )) {
    names.push(match[1])
  }

  // command: 'click' 与 command: 'open' | 'goto' 都要认，捕获整段后再逐个取字面量。
  for (const match of source.matchAll(/command:\s*((?:['"][^'"]*['"]\s*\|\s*)*['"][^'"]*['"])/g)) {
    for (const literal of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      names.push(literal[1])
    }
  }

  for (const match of source.matchAll(/create\w+Handler\(\s*['"]([^'"]+)['"]/g)) {
    names.push(match[1])
  }

  for (const match of source.matchAll(
    /(?:^|[^\w.])request(?:Value)?\(\s*context,\s*['"]([^'"]+)['"]/g,
  )) {
    names.push(match[1])
  }

  return uniqueSorted(names)
}
