import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// skill sync/status 的真实 CLI 测试：用 AUTOBROWSER_SKILL_DIR 把目标目录隔离到临时目录，
// 避免读写真实的 ~/.agents/skills。
const CLI = path.resolve(import.meta.dir, '..', 'dist', 'autobrowser.js')
const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-skill-'))
  tempDirs.push(dir)
  return dir
}

async function runSkill(
  args: string[],
  skillDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn('bun', [CLI, ...args], {
    env: { ...process.env, AUTOBROWSER_SKILL_DIR: skillDir },
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
    const packaged = await readFile(
      path.resolve(import.meta.dir, '..', '.agents', 'skills', 'autobrowser', 'SKILL.md'),
      'utf8',
    )
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
})
