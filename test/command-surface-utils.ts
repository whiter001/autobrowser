import { readFile } from 'node:fs/promises'

/** 命令面测试共用的文档读取与排序工具。 */
export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

export async function readWorkspaceFile(relativePath: string): Promise<string> {
  return await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

/** agent 按需读取的 skill 命令参考文档；主 skill 文件只保留指向它的链接。 */
export const COMMANDS_REFERENCE_PATH = '.agents/skills/autobrowser/references/commands.md'

/** 取出 commands.md 的「常用命令」段落。 */
export function extractCommandListSection(markdown: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## 常用命令')
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n')
}

/** 从「常用命令」清单提取命令路径；参数与旗标不属于命令路径。 */
export function extractCommandListPaths(section: string): string[] {
  const paths: string[] = []
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('- ')) continue
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      const raw = span[1].trim()
      if (!raw || raw.startsWith('-')) continue
      const path = raw.split(/[<[{]/)[0].trim().replace(/\s+/g, ' ')
      if (path) paths.push(path)
    }
  }
  return uniqueSorted(paths)
}
