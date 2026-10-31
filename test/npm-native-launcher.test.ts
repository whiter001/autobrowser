import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  installNpmLauncher,
  launcherFileName,
  type LauncherInstallOptions,
} from '../scripts/npm-postinstall.mjs'

const dirs: string[] = []
const logger = { log: () => {}, error: () => {} }

async function fixture(platform = 'win32', arch = 'x64') {
  const prefix = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-native-'))
  dirs.push(prefix)
  const packageDir = path.join(prefix, 'package')
  const binDir = platform === 'win32' ? prefix : path.join(prefix, 'bin')
  await mkdir(path.join(packageDir, 'launchers'), { recursive: true })
  await mkdir(binDir, { recursive: true })
  const options: LauncherInstallOptions = {
    platform,
    arch,
    packageDir,
    env: { npm_config_global: 'true', npm_config_prefix: prefix },
    logger,
  }
  return { prefix, packageDir, binDir, options }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('npm native launcher', () => {
  test('maps supported platforms to packaged names', () => {
    expect(launcherFileName('win32', 'arm64')).toBe('autobrowser-windows-arm64.exe')
    expect(launcherFileName('darwin', 'x64')).toBe('autobrowser-darwin-x64')
    expect(launcherFileName('linux', 'arm64')).toBe('autobrowser-linux-arm64')
    expect(launcherFileName('linux', 'ia32')).toBeNull()
    expect(launcherFileName('freebsd', 'x64')).toBeNull()
  })

  test('Windows installs exe, removes every old shim, and can run twice', async () => {
    const { packageDir, binDir, options } = await fixture()
    await writeFile(path.join(packageDir, 'launchers/autobrowser-windows-x64.exe'), 'native')
    const shims = [
      'autobrowser',
      'autobrowser.cmd',
      'autobrowser.bat',
      'autobrowser.ps1',
      'autobrowser.sh',
    ]
    for (const shim of shims) await writeFile(path.join(binDir, shim), 'old shim')
    for (let i = 0; i < 2; i++) {
      expect(await installNpmLauncher(options)).toEqual({
        applied: true,
        reason: 'native-launcher-installed',
      })
    }
    expect(await readFile(path.join(binDir, 'autobrowser.exe'), 'utf8')).toBe('native')
    for (const shim of shims) await expect(stat(path.join(binDir, shim))).rejects.toThrow()
  })

  test('POSIX replaces symlink itself, leaves dist intact, and sets executable bits', async () => {
    const { packageDir, binDir, options } = await fixture('linux', 'arm64')
    await writeFile(path.join(packageDir, 'launchers/autobrowser-linux-arm64'), 'native')
    const dist = path.join(packageDir, 'dist.js')
    await writeFile(dist, 'original JS')
    await symlink(dist, path.join(binDir, 'autobrowser'))
    await writeFile(path.join(binDir, 'autobrowser.sh'), 'old shell wrapper')
    expect((await installNpmLauncher(options)).applied).toBe(true)
    expect(await readFile(path.join(binDir, 'autobrowser'), 'utf8')).toBe('native')
    expect(await readFile(dist, 'utf8')).toBe('original JS')
    if (process.platform !== 'win32') {
      expect((await stat(path.join(binDir, 'autobrowser'))).mode & 0o777).toBe(0o755)
    }
    await expect(stat(path.join(binDir, 'autobrowser.sh'))).rejects.toThrow()
  })

  test('missing binary falls back to the existing Windows shim fix', async () => {
    const { binDir, options } = await fixture()
    await writeFile(path.join(binDir, 'autobrowser.cmd'), 'bun "dist\\autobrowser.js" %*')
    expect(await installNpmLauncher(options)).toEqual({
      applied: true,
      reason: 'npm-cmd-shim-mangles-args',
      nativeReason: 'missing-launcher',
    })
    expect(await readFile(path.join(binDir, 'autobrowser.bat'), 'utf8')).toContain('%*')
  })

  test('unsupported platform and local installs use fallback without installing native', async () => {
    const { binDir, options } = await fixture('win32', 'ia32')
    expect((await installNpmLauncher(options)).nativeReason).toBe('unsupported-platform')
    options.arch = 'x64'
    options.env!.npm_config_global = 'false'
    expect((await installNpmLauncher(options)).nativeReason).toBe('not-global-install')
    await expect(stat(path.join(binDir, 'autobrowser.exe'))).rejects.toThrow()
  })

  test('copy/install failure logs an error and never falls back to renaming cmd', async () => {
    const { packageDir, binDir, options } = await fixture()
    await writeFile(path.join(packageDir, 'launchers/autobrowser-windows-x64.exe'), 'native')
    await writeFile(path.join(binDir, 'autobrowser.cmd'), 'bun "dist\\autobrowser.js" %*')
    await mkdir(path.join(binDir, 'autobrowser.exe'))
    const errors: unknown[][] = []
    options.logger = { error: (...args) => errors.push(args) }
    expect(await installNpmLauncher(options)).toEqual({
      applied: false,
      reason: 'native-install-failed',
    })
    expect(errors.length).toBe(1)
    expect(String(errors[0]?.[0])).toContain('未回退到 shim')
    expect(await readFile(path.join(binDir, 'autobrowser.cmd'), 'utf8')).toContain('%*')
    await expect(stat(path.join(binDir, 'autobrowser.bat'))).rejects.toThrow()
  })
})
