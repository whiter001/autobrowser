import { copyFile, lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI_ERROR_CODES, CliUsageError } from '../cli-error.js'
import { COMMAND_ACTIONS } from './actions.js'
import { createActionCommand, throwCommandError } from './shared.js'
import type { CommandRegistry } from './types.js'

/**
 * skill sync：把包内 skill 目录的资产同步到 agent 实际加载的 skills 目录。
 *
 * 背景（issue #17）：仓库把 agent 提示词维护在 .agents/skills/autobrowser/SKILL.md，
 * 但 npm 分发和 agent 加载位置（~/.agents/skills/autobrowser/SKILL.md）之间没有同步机制，
 * 两侧靠人工拷贝。安装版一旦落后，agent 会照过期指引调用命令（例如旧的 autobrowser.cmd）。
 *
 * 同步范围是声明式的：SKILL.md + references/ 下所有文件 + examples/ 下所有文件。
 * 范围之外的目标目录文件一律保留（不删除），范围之内的内容一致就跳过写入，第二次 sync 完全 no-op。
 *
 * 安全约束：目标路径逐级检查，任意一级是符号链接就拒绝同步（copyFile 会跟随链接写穿到技能目录之外）。
 * 目标根本身（AUTOBROWSER_SKILL_DIR）由用户显式配置，允许是符号链接。
 */

/** 声明要同步的子目录：references/ 与 examples/。 */
const ASSET_SUBDIRS = ['references', 'examples'] as const

/** 允许整个目录缺失时按空目录处理的子目录；references/ 缺失说明包不完整，必须报错。 */
const MISSING_ALLOWED_SUBDIRS = new Set<string>(['examples'])

/** 一个待同步资产：sourcePath 在包内 skill 目录，relPath 是相对 skill 目录的 POSIX 路径。 */
export interface SkillAsset {
  relPath: string
  sourcePath: string
}

/** 目标文件的检查结果：符号链接单独成一类，不能按普通文件读，否则会读到目录外的内容。 */
type TargetState = 'missing' | 'symlink' | 'file'

/** 包内 skill 目录的候选位置：源码仓库里在 .agents 下，npm 包里随 .agents 一起发布。 */
function packageSkillDirCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return [
    // 打包后的 dist：bundle 是 dist/autobrowser.js，dirname 为 dist/，仓库根的 .agents 在其上一级。
    path.resolve(here, '../.agents/skills/autobrowser'),
    // 兼容源码直跑（bun src/cli.ts）：src/cli/commands -> 仓库根/.agents。
    path.resolve(here, '../../../.agents/skills/autobrowser'),
  ]
}

/** agent 实际加载的 skills 目录，可用 AUTOBROWSER_SKILL_DIR 覆盖（便于测试）。 */
function agentSkillDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUTOBROWSER_SKILL_DIR) {
    return env.AUTOBROWSER_SKILL_DIR
  }
  return path.join(os.homedir(), '.agents', 'skills', 'autobrowser')
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorErrno(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN'
}

/** 找到第一个含 SKILL.md 的候选目录：只有 SKILL.md 的目录不算可用的包内 skill。 */
async function firstExistingDir(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (!info.isDirectory()) continue
      const skillMd = await stat(path.join(candidate, 'SKILL.md'))
      if (skillMd.isFile()) return candidate
    } catch (error) {
      if (isNotFoundError(error)) continue
      throw error
    }
  }
  return null
}

/**
 * 读取目录内容。
 * 只有明确允许缺失的目录（examples/）在 ENOENT 时按空目录处理，其余错误（EACCES、IO 错误等）
 * 必须上抛：把读不到当成"没有文件"会让 sync/status 把损坏的包报成同步成功。
 */
async function readDirEntries(dir: string, allowMissing: boolean): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (allowMissing && isNotFoundError(error)) return []
    throw new CliUsageError(
      `failed to read package skill directory ${dir}: ${errorMessage(error)}`,
      {
        code: CLI_ERROR_CODES.FAILED,
        details: { path: dir, errno: errorErrno(error) },
        suggestedAction:
          'Reinstall the autobrowser package so .agents/skills/autobrowser ships a readable references/ directory.',
      },
    )
  }
}

/** 递归列出目录下的文件（相对路径，POSIX 分隔符），跳过点文件和非普通文件。 */
async function listFilesRecursive(
  dir: string,
  prefix: string,
  allowMissing = false,
): Promise<string[]> {
  const entries = await readDirEntries(dir, allowMissing)
  const files: string[] = []
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const entry of sorted) {
    // 点文件通常是编辑器/系统垃圾（.DS_Store），同步过去只会制造无意义差异
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    const rel = `${prefix}/${entry.name}`
    if (entry.isFile()) {
      files.push(rel)
      continue
    }
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full, rel)))
      continue
    }
    // 符号链接按真实类型判断，避免把目录链接无限展开
    try {
      const info = await stat(full)
      if (info.isFile()) files.push(rel)
    } catch (error) {
      // 只有悬空链接可以忽略，权限和 I/O 错误必须上抛。
      if (!isNotFoundError(error)) throw error
    }
  }
  return files
}

/** 收集声明范围内的全部资产，顺序固定（SKILL.md 在前，其余按目录与文件名排序）。 */
export async function collectSkillAssets(skillDir: string): Promise<SkillAsset[]> {
  const assets: SkillAsset[] = [
    { relPath: 'SKILL.md', sourcePath: path.join(skillDir, 'SKILL.md') },
  ]
  for (const sub of ASSET_SUBDIRS) {
    const relPaths = await listFilesRecursive(
      path.join(skillDir, sub),
      sub,
      MISSING_ALLOWED_SUBDIRS.has(sub),
    )
    for (const relPath of relPaths) {
      assets.push({ relPath, sourcePath: path.join(skillDir, ...relPath.split('/')) })
    }
  }
  return assets
}

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

/** 目标文件路径：relPath 是 POSIX 相对路径，转成平台路径。 */
function targetPathOf(skillDir: string, relPath: string): string {
  return path.join(skillDir, ...relPath.split('/'))
}

/** 目标路径出现符号链接时的拒绝信息：跟随链接会把内容写到技能目录之外。 */
function symlinkRefusal(targetPath: string, relPath: string): CliUsageError {
  return new CliUsageError(
    `refusing to sync: target path is a symbolic link: ${targetPath} (asset ${relPath})`,
    {
      code: CLI_ERROR_CODES.FAILED,
      details: { asset: relPath, targetPath },
      suggestedAction:
        'Remove the symbolic link (or replace it with a real file/directory) inside the skill directory, or point AUTOBROWSER_SKILL_DIR at a directory without links, then run skill sync again.',
    },
  )
}

/** 目标路径的某一级不是目录时的拒绝信息（例如 references 是个普通文件）。 */
function notADirectoryRefusal(targetPath: string, relPath: string): CliUsageError {
  return new CliUsageError(
    `refusing to sync: target path component is not a directory: ${targetPath} (asset ${relPath})`,
    {
      code: CLI_ERROR_CODES.FAILED,
      details: { asset: relPath, targetPath },
      suggestedAction:
        'Remove the conflicting file inside the skill directory, or point AUTOBROWSER_SKILL_DIR at a clean directory, then run skill sync again.',
    },
  )
}

/** lstat 失败时把 I/O 错误转成带上下文的 CLI 错误。 */
function inspectFailure(targetPath: string, error: unknown): CliUsageError {
  return new CliUsageError(`failed to inspect target path ${targetPath}: ${errorMessage(error)}`, {
    code: CLI_ERROR_CODES.FAILED,
    details: { targetPath, errno: errorErrno(error) },
    suggestedAction: 'Check the permissions of the skill directory, then run skill sync again.',
  })
}

/**
 * 逐级 lstat 目标路径，返回第一个符号链接组件（没有则 null）。
 * lstat 不跟随最后一级，但会跟随中间目录，所以必须自顶向下逐级检查：
 * 一旦发现上级是链接就立刻停住，绝不进入链接指向的目录。
 * 目标根本身是用户显式配置的（AUTOBROWSER_SKILL_DIR），因此不检查根目录这一级。
 */
async function findSymlinkComponent(targetDir: string, relPath: string): Promise<string | null> {
  let current = targetDir
  for (const part of relPath.split('/')) {
    current = path.join(current, part)
    const info = await lstat(current).catch((error: unknown) => {
      if (isNotFoundError(error)) return null
      throw inspectFailure(current, error)
    })
    // 该级不存在时更深的层级也不存在，路径本身是安全的
    if (!info) return null
    if (info.isSymbolicLink()) return current
  }
  return null
}

/**
 * 逐级确认目标父目录安全，并创建缺失的中间层。
 * 先检查后创建：mkdir 之前每一级都已确认不是符号链接，创建后再复核一次，
 * 避免"先建出来再穿透"到目录外。
 */
async function ensureTargetParent(targetDir: string, relPath: string): Promise<string> {
  const parts = relPath.split('/')
  let current = targetDir
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i])
    const info = await lstat(current).catch((error: unknown) => {
      if (isNotFoundError(error)) return null
      throw inspectFailure(current, error)
    })
    if (info) {
      if (info.isSymbolicLink()) throw symlinkRefusal(current, relPath)
      if (!info.isDirectory()) throw notADirectoryRefusal(current, relPath)
      continue
    }
    // 父级已确认是真实目录，逐级创建缺失的中间层
    await mkdir(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
    })
    const created = await lstat(current)
    if (created.isSymbolicLink()) throw symlinkRefusal(current, relPath)
    if (!created.isDirectory()) throw notADirectoryRefusal(current, relPath)
  }
  return targetPathOf(targetDir, relPath)
}

/** 检查目标资产状态：符号链接单独识别，不跟随读取目录外的内容。 */
async function inspectTarget(targetDir: string, relPath: string): Promise<TargetState> {
  const link = await findSymlinkComponent(targetDir, relPath)
  if (link) return 'symlink'
  const data = await readIfExists(targetPathOf(targetDir, relPath))
  return data === null ? 'missing' : 'file'
}

/** 写入单个资产：内容一致则跳过写入，返回是否真的写了。 */
async function writeAsset(targetDir: string, asset: SkillAsset): Promise<boolean> {
  const target = await ensureTargetParent(targetDir, asset.relPath)
  const info = await lstat(target).catch((error: unknown) => {
    if (isNotFoundError(error)) return null
    throw inspectFailure(target, error)
  })
  if (info?.isSymbolicLink()) throw symlinkRefusal(target, asset.relPath)

  const [source, existing] = await Promise.all([readFile(asset.sourcePath), readIfExists(target)])
  if (existing !== null && existing.equals(source)) return false
  await copyFile(asset.sourcePath, target)
  return true
}

async function handleSync(): Promise<number | void> {
  const sourceDir = await firstExistingDir(packageSkillDirCandidates())
  if (!sourceDir) {
    return throwCommandError(
      'package SKILL.md not found; if you installed via npm, ensure the package ships .agents/skills/autobrowser/SKILL.md',
    )
  }

  const assets = await collectSkillAssets(sourceDir)
  const targetDir = agentSkillDir()
  await mkdir(targetDir, { recursive: true })

  // 预检：任一资产的目标路径含符号链接就整体拒绝，避免写了一半才发现穿透到目录外
  for (const asset of assets) {
    const link = await findSymlinkComponent(targetDir, asset.relPath)
    if (link) throw symlinkRefusal(link, asset.relPath)
  }

  // 内容一致时跳过写入，避免无意义的 mtime 变化；目标目录里的其它文件不动。
  let updated = 0
  for (const asset of assets) {
    if (await writeAsset(targetDir, asset)) updated += 1
  }

  if (updated === 0) {
    process.stdout.write(
      `skill already up to date: ${path.join(targetDir, 'SKILL.md')} (${assets.length} assets)\n`,
    )
    return 0
  }
  process.stdout.write(
    `skill synced: ${path.join(sourceDir, 'SKILL.md')} -> ${path.join(targetDir, 'SKILL.md')} (updated ${updated} of ${assets.length} assets)\n`,
  )
  return 0
}

async function handleStatus(): Promise<number | void> {
  const sourceDir = await firstExistingDir(packageSkillDirCandidates())
  const targetDir = agentSkillDir()
  const targetSkillPath = path.join(targetDir, 'SKILL.md')
  const lines = [`package skill: ${sourceDir ? path.join(sourceDir, 'SKILL.md') : '(not found)'}`]

  const skillMdState = await inspectTarget(targetDir, 'SKILL.md')
  const marker =
    skillMdState === 'missing'
      ? ' (not installed)'
      : skillMdState === 'symlink'
        ? ' (unsafe: symbolic link)'
        : ''
  lines.push(`installed skill: ${targetSkillPath}${marker}`)

  if (!sourceDir) {
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  }

  const assets = await collectSkillAssets(sourceDir)
  const mismatched: string[] = []
  for (const asset of assets) {
    const state = await inspectTarget(targetDir, asset.relPath)
    if (state === 'symlink') {
      mismatched.push(`${asset.relPath} (symbolic link)`)
      continue
    }
    if (state === 'missing') {
      mismatched.push(`${asset.relPath} (missing)`)
      continue
    }
    const [source, existing] = await Promise.all([
      readFile(asset.sourcePath),
      readIfExists(targetPathOf(targetDir, asset.relPath)),
    ])
    if (existing === null || !existing.equals(source)) {
      mismatched.push(`${asset.relPath} (differs)`)
    }
  }

  if (mismatched.length === 0) {
    lines.push(`status: in sync (${assets.length} assets)`)
  } else {
    lines.push('status: out of sync (run skill sync)')
    lines.push(`out of sync assets: ${mismatched.join(', ')}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

export const skillCommandRegistry: CommandRegistry = {
  skill: createActionCommand({
    helpPath: ['skill'],
    allowed: COMMAND_ACTIONS.skill.actions,
    handle: async (_rest, _context, action) => {
      if (action === 'sync') return handleSync()
      return handleStatus()
    },
  }),
}
