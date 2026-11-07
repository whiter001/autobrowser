import { readFile } from 'node:fs/promises'

/** 命令面测试共用的文档读取与排序工具。 */
export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

export async function readWorkspaceFile(relativePath: string): Promise<string> {
  return await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

/** agent 实际加载的那份 skill 文档。 */
export const SKILL_MARKDOWN_PATH = '.agents/skills/autobrowser/SKILL.md'

/** 取出 SKILL.md 的「常用命令」段落。 */
export function extractSkillCommandSection(markdown: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## 常用命令')
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n')
}

/** 从「常用命令」清单提取命令路径；参数与旗标不属于命令路径。 */
export function extractSkillCommandPaths(section: string): string[] {
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
