import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createActionCommand, writeCommandError } from './shared.js'
import type { CommandRegistry } from './types.js'

/**
 * skill sync：把包内的 SKILL.md 同步到 agent 实际加载的 skills 目录。
 *
 * 背景（issue #17）：仓库把 agent 提示词维护在 .agents/skills/autobrowser/SKILL.md，
 * 但 npm 分发和 agent 加载位置（~/.agents/skills/autobrowser/SKILL.md）之间没有同步机制，
 * 两侧靠人工拷贝。安装版一旦落后，agent 会照过期指引调用命令（例如旧的 autobrowser.cmd）。
 */

/** 包内 SKILL.md 的候选位置：源码仓库里在 .agents 下，npm 包里随 .agents 一起发布。 */
function packageSkillCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return [
    // 打包后的 dist：bundle 是 dist/autobrowser.js，dirname 为 dist/，仓库根的 .agents 在其上一级。
    path.resolve(here, '../.agents/skills/autobrowser/SKILL.md'),
    // 兼容源码直跑（bun src/cli.ts）：src/cli/commands -> 仓库根/.agents。
    path.resolve(here, '../../../.agents/skills/autobrowser/SKILL.md'),
  ]
}

/** agent 实际加载的 skills 目录，可用 AUTOBROWSER_SKILL_DIR 覆盖（便于测试）。 */
function agentSkillPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUTOBROWSER_SKILL_DIR) {
    return path.join(env.AUTOBROWSER_SKILL_DIR, 'SKILL.md')
  }
  return path.join(os.homedir(), '.agents', 'skills', 'autobrowser', 'SKILL.md')
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // 继续找下一个候选位置
    }
  }
  return null
}

async function handleSync(): Promise<number | void> {
  const source = await firstExisting(packageSkillCandidates())
  if (!source) {
    return writeCommandError(
      'package SKILL.md not found; if you installed via npm, ensure the package ships .agents/skills/autobrowser/SKILL.md',
    )
  }

  const target = agentSkillPath()
  await mkdir(path.dirname(target), { recursive: true })

  // 内容一致时跳过写入，避免无意义的 mtime 变化。
  const [sourceText, targetText] = await Promise.all([
    readFile(source, 'utf8'),
    readFile(target, 'utf8').catch(() => null),
  ])
  if (targetText !== null && targetText === sourceText) {
    process.stdout.write(`skill already up to date: ${target}\n`)
    return 0
  }

  await copyFile(source, target)
  process.stdout.write(`skill synced: ${source} -> ${target}\n`)
  return 0
}

async function handleStatus(): Promise<number | void> {
  const source = await firstExisting(packageSkillCandidates())
  const target = agentSkillPath()
  const [sourceText, targetText] = await Promise.all([
    source ? readFile(source, 'utf8').catch(() => null) : Promise.resolve(null),
    readFile(target, 'utf8').catch(() => null),
  ])

  const lines = [
    `package skill: ${source ?? '(not found)'}`,
    `installed skill: ${target}${targetText === null ? ' (not installed)' : ''}`,
  ]
  if (sourceText !== null && targetText !== null) {
    lines.push(
      sourceText === targetText ? 'status: in sync' : 'status: out of sync (run skill sync)',
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

export const skillCommandRegistry: CommandRegistry = {
  skill: createActionCommand({
    helpPath: ['skill'],
    allowed: ['sync', 'status'],
    handle: async (_rest, _context, action) => {
      if (action === 'sync') return handleSync()
      return handleStatus()
    },
  }),
}
