import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { collectSkillAssets } from '../src/cli/commands/skill.js'

// skill sync/status 的真实 CLI 测试：用 AUTOBROWSER_SKILL_DIR 把目标目录隔离到临时目录，
// 避免读写真实的 ~/.agents/skills。
const CLI = path.resolve(import.meta.dir, '..', 'dist', 'autobrowser.js')
const PACKAGE_SKILL_DIR = path.resolve(import.meta.dir, '..', '.agents', 'skills', 'autobrowser')
const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-skill-'))
  tempDirs.push(dir)
  return dir
}

/** 递归列出目录下的文件（相对路径），用于计算声明范围内的资产清单。 */
async function listFilesRecursive(dir: string, prefix: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = `${prefix}/${entry.name}`
    if (entry.isFile()) {
      files.push(rel)
      continue
    }
    if (entry.isDirectory())
      files.push(...(await listFilesRecursive(path.join(dir, entry.name), rel)))
  }
  return files.sort()
}

/** 包内 skill 目录声明范围内的全部资产（SKILL.md + references/ + examples/）。 */
async function packagedAssets(): Promise<string[]> {
  const assets = ['SKILL.md']
  for (const sub of ['references', 'examples']) {
    assets.push(...(await listFilesRecursive(path.join(PACKAGE_SKILL_DIR, sub), sub)))
  }
  return assets.sort()
}

async function runSkill(
  args: string[],
  skillDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn('bun', [CLI, ...args], {
    // 每次 sync 都会起子进程；关闭默认 auto workspace，避免真实进程树解析拖慢测试
    env: { ...process.env, AUTOBROWSER_SKILL_DIR: skillDir, AUTOBROWSER_WORKSPACE: 'off' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (c) => {
    stdout += String(c)
  })
  child.stderr?.on('data', (c) => {
    stderr += String(c)
  })
  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (v) => resolve(v ?? -1))
  })
  return { code, stdout, stderr }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('skill sync/status', () => {
  test('status reports out of sync when the installed copy differs', async () => {
    const dir = await makeTempDir()
    await writeFile(path.join(dir, 'SKILL.md'), '# old version\n', 'utf8')

    const result = await runSkill(['skill', 'status'], dir)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('out of sync')
  })

  test('sync copies the packaged SKILL.md into the skill dir and is idempotent', async () => {
    const dir = await makeTempDir()
    await writeFile(path.join(dir, 'SKILL.md'), '# old version\n', 'utf8')

    const first = await runSkill(['skill', 'sync'], dir)
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('skill synced')

    // 同步后与包内版本一致
    const synced = await readFile(path.join(dir, 'SKILL.md'), 'utf8')
    const packaged = await readFile(path.join(PACKAGE_SKILL_DIR, 'SKILL.md'), 'utf8')
    expect(synced).toBe(packaged)

    // 第二次执行为 no-op
    const second = await runSkill(['skill', 'sync'], dir)
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('already up to date')

    // 同步后 status 报告 in sync
    const status = await runSkill(['skill', 'status'], dir)
    expect(status.stdout).toContain('in sync')
  })

  test('status reports not installed when the target does not exist', async () => {
    const dir = await makeTempDir()

    const result = await runSkill(['skill', 'status'], dir)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('not installed')
  })

  test('sync installs references/ and examples/ assets, and a second sync is a full no-op', async () => {
    const dir = await makeTempDir()
    const assets = await packagedAssets()
    // 包内必须真的带 references/ 与 examples/，否则这条断言没有意义
    expect(assets.some((a) => a.startsWith('references/'))).toBe(true)
    expect(assets.some((a) => a.startsWith('examples/'))).toBe(true)

    const first = await runSkill(['skill', 'sync'], dir)
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('skill synced')
    expect(first.stdout).toContain(`updated ${assets.length} of ${assets.length} assets`)

    // 声明范围内的每个资产都被复制且内容一致
    for (const rel of assets) {
      const target = path.join(dir, ...rel.split('/'))
      const installed = await readFile(target)
      const packaged = await readFile(path.join(PACKAGE_SKILL_DIR, ...rel.split('/')))
      expect(installed.equals(packaged)).toBe(true)
    }

    // 第二次 sync 不再写入任何文件（mtime 不变）
    const before = await Promise.all(
      assets.map(async (rel) => (await stat(path.join(dir, ...rel.split('/')))).mtimeMs),
    )
    const second = await runSkill(['skill', 'sync'], dir)
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('already up to date')
    const after = await Promise.all(
      assets.map(async (rel) => (await stat(path.join(dir, ...rel.split('/')))).mtimeMs),
    )
    expect(after).toEqual(before)

    // 同步后 status 报告 in sync
    const status = await runSkill(['skill', 'status'], dir)
    expect(status.stdout).toContain('in sync')
  })

  test('status flags a modified installed asset and sync restores it', async () => {
    const dir = await makeTempDir()
    await runSkill(['skill', 'sync'], dir)

    // 改坏安装目录里的 references 资产
    const target = path.join(dir, 'references', 'commands.md')
    await writeFile(target, '# tampered\n', 'utf8')

    const status = await runSkill(['skill', 'status'], dir)
    expect(status.stdout).toContain('out of sync')
    expect(status.stdout).toContain('references/commands.md')

    // 再 sync 恢复
    const resync = await runSkill(['skill', 'sync'], dir)
    expect(resync.stdout).toContain('skill synced')
    expect(resync.stdout).toContain('updated 1 of ')

    const restored = await readFile(target, 'utf8')
    const packaged = await readFile(
      path.join(PACKAGE_SKILL_DIR, 'references', 'commands.md'),
      'utf8',
    )
    expect(restored).toBe(packaged)

    const after = await runSkill(['skill', 'status'], dir)
    expect(after.stdout).toContain('in sync')
  })

  test('sync keeps extra files that are outside the declared asset scope', async () => {
    const dir = await makeTempDir()
    await runSkill(['skill', 'sync'], dir)

    const extra = path.join(dir, 'my-notes.md')
    await writeFile(extra, '# keep me\n', 'utf8')

    const resync = await runSkill(['skill', 'sync'], dir)
    expect(resync.code).toBe(0)
    expect(resync.stdout).toContain('already up to date')

    const kept = await readFile(extra, 'utf8')
    expect(kept).toBe('# keep me\n')
  })
})

/**
 * 创建符号链接；没有权限的环境（Windows 非开发者模式）返回 false，调用方据此跳过用例。
 */
async function trySymlink(
  target: string,
  link: string,
  type: 'file' | 'dir' = 'file',
): Promise<boolean> {
  try {
    await symlink(target, link, type)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'UNKNOWN') {
      return false
    }
    throw error
  }
}

describe('skill sync symlink safety', () => {
  test('sync refuses a symlinked SKILL.md and never writes through it', async () => {
    const dir = await makeTempDir()
    const outsideDir = await makeTempDir()
    const outsideFile = path.join(outsideDir, 'outside.md')
    await writeFile(outsideFile, '# external\n', 'utf8')
    const linked = await trySymlink(outsideFile, path.join(dir, 'SKILL.md'), 'file')
    if (!linked) return

    const sync = await runSkill(['skill', 'sync'], dir)
    expect(sync.code).not.toBe(0)
    expect(`${sync.stdout}${sync.stderr}`).toContain('symbolic link')

    // 链接指向的外部文件内容不变
    expect(await readFile(outsideFile, 'utf8')).toBe('# external\n')

    const status = await runSkill(['skill', 'status'], dir)
    expect(status.stdout).toContain('out of sync')
    expect(status.stdout).toContain('symbolic link')
  })

  test('sync refuses a symlinked parent directory and never writes through it', async () => {
    const dir = await makeTempDir()
    const outsideDir = await makeTempDir()
    const outsideRefs = path.join(outsideDir, 'references')
    await mkdir(outsideRefs, { recursive: true })
    await writeFile(path.join(outsideRefs, 'commands.md'), '# external\n', 'utf8')
    const linked = await trySymlink(outsideRefs, path.join(dir, 'references'), 'dir')
    if (!linked) return

    const sync = await runSkill(['skill', 'sync'], dir)
    expect(sync.code).not.toBe(0)
    expect(`${sync.stdout}${sync.stderr}`).toContain('symbolic link')

    // 外部目录既没被改写，也没多出同步资产
    expect(await readFile(path.join(outsideRefs, 'commands.md'), 'utf8')).toBe('# external\n')
    expect((await readdir(outsideRefs)).sort()).toEqual(['commands.md'])

    const status = await runSkill(['skill', 'status'], dir)
    expect(status.stdout).toContain('out of sync')
    expect(status.stdout).toContain('references/commands.md')
  })

  test('status reports out of sync for a symlinked asset instead of reading through it', async () => {
    const dir = await makeTempDir()
    const outsideDir = await makeTempDir()
    const outsideFile = path.join(outsideDir, 'outside.md')
    await writeFile(outsideFile, '# external\n', 'utf8')
    await runSkill(['skill', 'sync'], dir)

    // 把已安装的 references/commands.md 换成指向外部文件的链接
    const target = path.join(dir, 'references', 'commands.md')
    await rm(target)
    const linked = await trySymlink(outsideFile, target, 'file')
    if (!linked) return

    const status = await runSkill(['skill', 'status'], dir)
    expect(status.stdout).toContain('out of sync')
    expect(status.stdout).toContain('references/commands.md')
    expect(status.stdout).not.toContain('in sync')
  })
})

describe('skill asset enumeration', () => {
  test('collectSkillAssets rejects when references/ is missing', async () => {
    const dir = await makeTempDir()
    await writeFile(path.join(dir, 'SKILL.md'), '# x\n', 'utf8')

    await expect(collectSkillAssets(dir)).rejects.toThrow(/failed to read package skill directory/)
  })

  test('collectSkillAssets treats a missing examples/ as an empty directory', async () => {
    const dir = await makeTempDir()
    await writeFile(path.join(dir, 'SKILL.md'), '# x\n', 'utf8')
    await mkdir(path.join(dir, 'references'), { recursive: true })
    await writeFile(path.join(dir, 'references', 'commands.md'), '# x\n', 'utf8')

    const assets = await collectSkillAssets(dir)
    expect(assets.map((asset) => asset.relPath)).toEqual(['SKILL.md', 'references/commands.md'])
  })

  test('collectSkillAssets rejects a non-directory references/ instead of reporting it as empty', async () => {
    const dir = await makeTempDir()
    await writeFile(path.join(dir, 'SKILL.md'), '# x\n', 'utf8')
    // references 是普通文件：readdir 会抛 ENOTDIR，与权限不足同样属于"读不到"，不能被当成空目录
    await writeFile(path.join(dir, 'references'), '# not a directory\n', 'utf8')

    await expect(collectSkillAssets(dir)).rejects.toThrow(/failed to read package skill directory/)
  })
})
