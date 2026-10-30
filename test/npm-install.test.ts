import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BAT_SHIM_NAME, CMD_SHIM_NAME } from '../scripts/npm-postinstall.mjs'

// 真实 npm 安装回归测试（opt-in）：
//   AUTOBROWSER_NPM_INSTALL=1 bun test test/npm-install.test.ts
//
// npm 12 默认阻止 install scripts（allow-scripts 默认不放行），所以这里不假设
// postinstall 一定被 npm 执行，而是分两步验证：
//   1. 真实 npm install -g 之后，全局 bin 目录里确实有 npm 生成的 .cmd（问题现场）；
//   2. 按 npm 的方式（同样的 env 与 cwd）执行 postinstall 之后，.cmd 消失、.bat 就位。
//
// 默认 bun test 走 bun:test 的 skip 机制，不依赖 npm。

const POSTINSTALL_SOURCE = path.resolve(import.meta.dir, '..', 'scripts', 'npm-postinstall.mjs')
const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function runNpm(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn('npm', args, { cwd, shell: process.platform === 'win32' })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (value) => resolve(value ?? -1))
  })
  return { code, stdout, stderr }
}

/** npm 全局可执行文件目录：Windows 在 prefix 下，其他平台在 prefix/bin 下。 */
function globalBinDir(prefix: string): string {
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin')
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true })
    }),
  )
})

describe('npm global install', () => {
  test.skipIf(process.env.AUTOBROWSER_NPM_INSTALL !== '1')(
    'npm generates a .cmd shim and the postinstall replaces it with a .bat shim',
    async () => {
      const workspace = await makeTempDir('autobrowser-npm-')
      const prefix = path.join(workspace, 'prefix')

      await cp(POSTINSTALL_SOURCE, path.join(workspace, 'npm-postinstall.mjs'))
      await writeFile(
        path.join(workspace, 'package.json'),
        `${JSON.stringify(
          {
            name: 'autobrowser-npm-install-probe',
            version: '0.0.0',
            bin: { autobrowser: 'dist/autobrowser.js' },
            scripts: { postinstall: 'node ../npm-postinstall.mjs' },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      await mkdir(path.join(workspace, 'dist'), { recursive: true })
      await writeFile(
        path.join(workspace, 'dist', 'autobrowser.js'),
        '#!/usr/bin/env node\nconsole.log("probe")\n',
        'utf8',
      )

      const install = await runNpm(
        [
          'install',
          '-g',
          '--prefix',
          prefix,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          workspace,
        ],
        workspace,
      )
      expect(install.code).toBe(0)

      const binDir = globalBinDir(prefix)
      const cmdPath = path.join(binDir, CMD_SHIM_NAME)
      const batPath = path.join(binDir, BAT_SHIM_NAME)

      // npm 生成的 .cmd 确实存在，这就是 issue #16 的问题现场。
      const cmdContent = await readFile(cmdPath, 'utf8')
      expect(cmdContent).toContain('autobrowser')
      await expect(readFile(batPath, 'utf8')).rejects.toThrow()

      // 按 npm 的方式执行 postinstall：同样的 env、同样的 cwd。
      const postinstall = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn('node', [path.join(workspace, 'npm-postinstall.mjs')], {
            cwd: workspace,
            env: { ...process.env, npm_config_prefix: prefix, npm_config_global: 'true' },
            shell: process.platform === 'win32',
          })
          let stdout = ''
          let stderr = ''
          child.stdout?.on('data', (chunk) => {
            stdout += String(chunk)
          })
          child.stderr?.on('data', (chunk) => {
            stderr += String(chunk)
          })
          child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
        },
      )
      expect(postinstall.code).toBe(0)

      if (process.platform === 'win32') {
        await expect(readFile(cmdPath, 'utf8')).rejects.toThrow()
        expect(await readFile(batPath, 'utf8')).toBe(cmdContent)
      } else {
        // 非 Windows 上 postinstall 不做任何事，原样保留 npm 生成的启动器。
        expect(await readFile(cmdPath, 'utf8')).toBe(cmdContent)
      }
    },
    120_000,
  )
})
