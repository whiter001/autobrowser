import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BAT_SHIM_NAME,
  CMD_SHIM_NAME,
  applyCmdShimRename,
  fixWindowsCmdShim,
  looksLikePackageCmdShim,
  planCmdShimRename,
  resolveGlobalBinDir,
} from '../scripts/npm-postinstall.mjs'

// npm 按 bin 字段生成的 .cmd 真实内容（npm 12 的 cmd-shim 产物）。
// 关键在最后一行用 %* 转发参数：PowerShell 调用 .cmd 时会先剥掉参数里的双引号，
// cmd.exe 再把裸露的 & | ^ 当成命令分隔符，URL 查询串和 eval 源码会被拆开。
const NPM_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\bun.exe" (',
  '  SET "_prog=%dp0%\\bun.exe"',
  ') ELSE (',
  '  SET "_prog=bun"',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@whiter001\\autobrowser\\dist\\autobrowser.js" %*',
  '',
].join('\r\n')

const FOREIGN_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\other-package\\cli.js" %*',
  '',
].join('\r\n')

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-postinstall-'))
  tempDirs.push(dir)
  return dir
}

function globalEnv(prefix: string): Record<string, string | undefined> {
  return { npm_config_prefix: prefix, npm_config_global: 'true' }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true })
    }),
  )
})

describe('resolveGlobalBinDir', () => {
  test('returns the npm prefix on Windows', () => {
    expect(resolveGlobalBinDir({ npm_config_prefix: 'D:\\packages\\node\\modules' }, 'win32')).toBe(
      path.resolve('D:\\packages\\node\\modules'),
    )
  })

  test('returns prefix/bin on POSIX platforms', () => {
    expect(resolveGlobalBinDir({ npm_config_prefix: '/usr/local' }, 'linux')).toBe(
      path.resolve('/usr/local/bin'),
    )
    expect(resolveGlobalBinDir({ npm_config_prefix: '/usr/local' }, 'darwin')).toBe(
      path.resolve('/usr/local/bin'),
    )
  })

  test('returns null when npm did not expose a prefix', () => {
    expect(resolveGlobalBinDir({}, 'win32')).toBeNull()
  })

  test('resolves a relative prefix against the process cwd', () => {
    // npm 的 parseField 对 path 类型已经 resolve 过，正常不会传相对路径；
    // 但 postinstall 的 cwd 是包安装目录，万一传入相对路径，不解析就会把 shim
    // 写到包目录而不是全局 bin 目录，这里必须兜底成绝对路径。
    const resolved = resolveGlobalBinDir({ npm_config_prefix: './my-npm' }, 'win32')
    expect(resolved).not.toBeNull()
    expect(path.isAbsolute(resolved!)).toBe(true)
    expect(resolved).toBe(path.resolve('./my-npm'))
  })

  test('resolves a prefix that contains parent-directory segments', () => {
    const resolved = resolveGlobalBinDir({ npm_config_prefix: 'D:\\npm\\..\\npm-global' }, 'win32')
    expect(resolved).toBe(path.resolve('D:\\npm\\..\\npm-global'))
  })

  test('keeps an already-absolute prefix intact', () => {
    expect(resolveGlobalBinDir({ npm_config_prefix: 'D:\\packages\\node\\modules' }, 'win32')).toBe(
      path.resolve('D:\\packages\\node\\modules'),
    )
  })
})

describe('looksLikePackageCmdShim', () => {
  test('accepts the shim npm generates for this package', () => {
    expect(looksLikePackageCmdShim(NPM_CMD_SHIM)).toBe(true)
  })

  test('accepts a shim that uses forward slashes', () => {
    expect(
      looksLikePackageCmdShim('%dp0%/node_modules/@whiter001/autobrowser/dist/autobrowser.js'),
    ).toBe(true)
  })

  test('rejects a shim belonging to another package', () => {
    expect(looksLikePackageCmdShim(FOREIGN_CMD_SHIM)).toBe(false)
  })

  test('rejects empty content', () => {
    expect(looksLikePackageCmdShim('')).toBe(false)
  })

  test('rejects a backup file that only shares the bin path as a prefix', () => {
    expect(
      looksLikePackageCmdShim(
        '%dp0%\\node_modules\\@whiter001\\autobrowser\\dist\\autobrowser.js.backup %*',
      ),
    ).toBe(false)
  })

  test('rejects a bin path that is a prefix of a longer file name', () => {
    expect(looksLikePackageCmdShim('%dp0%\\node_modules\\pkg\\dist\\autobrowser.jsx %*')).toBe(
      false,
    )
  })

  test('accepts a foreign package only when the bin path is genuinely present', () => {
    // 另一个包也可能把自己的可执行文件命名为 dist/autobrowser.js。
    // 路径段边界检查只保证「这是一个完整的 bin 目标路径」，不保证「属于本包」；
    // 真正防止误删其他包 shim 的是 npm bin-links 自己的 shim 冲突检查。
    // 这里至少不能误伤把本包路径当子串、但实际指向别处的 shim。
    expect(looksLikePackageCmdShim('%dp0%\\node_modules\\pkg\\dist\\autobrowser.js %*')).toBe(true)
    expect(looksLikePackageCmdShim('%dp0%\\node_modules\\pkg\\dist\\autobrowser.js.bak %*')).toBe(
      false,
    )
  })

  test('accepts the bin path followed by a quote or end of line', () => {
    expect(looksLikePackageCmdShim('"...\\dist\\autobrowser.js" %*')).toBe(true)
    expect(looksLikePackageCmdShim('...\\dist\\autobrowser.js')).toBe(true)
  })
})

describe('planCmdShimRename', () => {
  test('renames the shim on a Windows global install', () => {
    const plan = planCmdShimRename({
      platform: 'win32',
      env: globalEnv('D:\\npm'),
      cmdContent: NPM_CMD_SHIM,
      cmdExists: true,
    })

    expect(plan).toEqual({
      action: 'rename',
      reason: 'npm-cmd-shim-mangles-args',
      binDir: path.resolve('D:\\npm'),
    })
  })

  test('skips on non-Windows platforms', () => {
    const plan = planCmdShimRename({
      platform: 'linux',
      env: globalEnv('/usr/local'),
      cmdContent: NPM_CMD_SHIM,
      cmdExists: true,
    })

    expect(plan).toEqual({ action: 'skip', reason: 'not-windows' })
  })

  test('skips local installs so the global bin dir is left alone', () => {
    const plan = planCmdShimRename({
      platform: 'win32',
      env: { npm_config_prefix: 'D:\\npm', npm_config_global: 'false' },
      cmdContent: NPM_CMD_SHIM,
      cmdExists: true,
    })

    expect(plan).toEqual({ action: 'skip', reason: 'not-global-install' })
  })

  test('skips when npm did not generate a .cmd shim', () => {
    const plan = planCmdShimRename({
      platform: 'win32',
      env: globalEnv('D:\\npm'),
      cmdContent: '',
      cmdExists: false,
    })

    expect(plan).toEqual({ action: 'skip', reason: 'no-cmd-shim' })
  })

  test('skips a .cmd that belongs to another package', () => {
    const plan = planCmdShimRename({
      platform: 'win32',
      env: globalEnv('D:\\npm'),
      cmdContent: FOREIGN_CMD_SHIM,
      cmdExists: true,
    })

    expect(plan).toEqual({ action: 'skip', reason: 'foreign-cmd-shim' })
  })

  test('skips when npm did not expose a prefix', () => {
    const plan = planCmdShimRename({
      platform: 'win32',
      env: { npm_config_global: 'true' },
      cmdContent: NPM_CMD_SHIM,
      cmdExists: true,
    })

    expect(plan).toEqual({ action: 'skip', reason: 'no-global-prefix' })
  })
})

describe('applyCmdShimRename', () => {
  test('writes the .bat first so a failure keeps the .cmd usable', async () => {
    const dir = await makeTempDir()
    const cmdPath = path.join(dir, CMD_SHIM_NAME)
    const batPath = path.join(dir, BAT_SHIM_NAME)

    await applyCmdShimRename({ cmdPath, batPath, cmdContent: NPM_CMD_SHIM })

    expect(await readFile(batPath, 'utf8')).toBe(NPM_CMD_SHIM)
  })
})

describe('fixWindowsCmdShim', () => {
  test('replaces the npm .cmd shim with a .bat shim', async () => {
    const dir = await makeTempDir()
    const cmdPath = path.join(dir, CMD_SHIM_NAME)
    const batPath = path.join(dir, BAT_SHIM_NAME)
    await writeFile(cmdPath, NPM_CMD_SHIM, 'utf8')

    const result = await fixWindowsCmdShim({
      platform: 'win32',
      env: globalEnv(dir),
      logger: { log: () => {}, error: () => {} },
    })

    expect(result.applied).toBe(true)
    expect(await readFile(batPath, 'utf8')).toBe(NPM_CMD_SHIM)
    await expect(readFile(cmdPath, 'utf8')).rejects.toThrow()
  })

  test('is idempotent and keeps the .bat on a second run', async () => {
    const dir = await makeTempDir()
    const cmdPath = path.join(dir, CMD_SHIM_NAME)
    const batPath = path.join(dir, BAT_SHIM_NAME)
    await writeFile(cmdPath, NPM_CMD_SHIM, 'utf8')

    await fixWindowsCmdShim({
      platform: 'win32',
      env: globalEnv(dir),
      logger: { log: () => {}, error: () => {} },
    })
    const second = await fixWindowsCmdShim({
      platform: 'win32',
      env: globalEnv(dir),
      logger: { log: () => {}, error: () => {} },
    })

    expect(second).toEqual({ applied: false, reason: 'no-cmd-shim' })
    expect(await readFile(batPath, 'utf8')).toBe(NPM_CMD_SHIM)
  })

  test('leaves a .cmd that belongs to another package untouched', async () => {
    const dir = await makeTempDir()
    const cmdPath = path.join(dir, CMD_SHIM_NAME)
    await writeFile(cmdPath, FOREIGN_CMD_SHIM, 'utf8')

    const result = await fixWindowsCmdShim({
      platform: 'win32',
      env: globalEnv(dir),
      logger: { log: () => {}, error: () => {} },
    })

    expect(result).toEqual({ applied: false, reason: 'foreign-cmd-shim' })
    expect(await readFile(cmdPath, 'utf8')).toBe(FOREIGN_CMD_SHIM)
  })

  test('does nothing on non-Windows platforms', async () => {
    const dir = await makeTempDir()
    const cmdPath = path.join(dir, CMD_SHIM_NAME)
    await writeFile(cmdPath, NPM_CMD_SHIM, 'utf8')

    const result = await fixWindowsCmdShim({
      platform: 'linux',
      env: globalEnv(dir),
      logger: { log: () => {}, error: () => {} },
    })

    expect(result).toEqual({ applied: false, reason: 'not-windows' })
    expect(await readFile(cmdPath, 'utf8')).toBe(NPM_CMD_SHIM)
  })

  test('reports a missing .cmd instead of failing', async () => {
    const dir = await makeTempDir()

    const result = await fixWindowsCmdShim({
      platform: 'win32',
      env: globalEnv(dir),
      logger: { log: () => {}, error: () => {} },
    })

    expect(result).toEqual({ applied: false, reason: 'no-cmd-shim' })
  })
})
