import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { launcherTargets } from '../scripts/build-launcher-go'

const target = launcherTargets(['--current'])[0]!
const launcher = path.resolve(import.meta.dir, '../launchers', target.name)

test.skipIf(!existsSync(launcher))(
  'native launcher preserves argv, stdin, cwd, env, and exit code',
  async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-go-'))
    try {
      const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin')
      const packageDir = path.join(
        prefix,
        process.platform === 'win32' ? '' : 'lib',
        'node_modules/@whiter001/autobrowser',
      )
      const dist = path.join(packageDir, 'dist/autobrowser.js')
      await mkdir(path.dirname(dist), { recursive: true })
      await mkdir(binDir, { recursive: true })
      const entry = path.join(
        binDir,
        process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser',
      )
      await copyFile(launcher, entry)
      await writeFile(
        dist,
        `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env.LAUNCHER_TEST, stdin: await Bun.stdin.text() })); process.exit(23)`,
      )
      const args = ['eval', 'return "a&b|c^d<e>%PATH%"', '', 'two words', 'line\nline']
      const result = spawnSync(entry, args, {
        cwd: prefix,
        input: 'stdin text\n',
        encoding: 'utf8',
        env: {
          ...process.env,
          AUTOBROWSER_BUN_PATH: process.execPath,
          AUTOBROWSER_DIST_ENTRY: '',
          LAUNCHER_TEST: 'inherited',
        },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(23)
      expect(result.stderr).toBe('')
      const output = JSON.parse(result.stdout)
      expect(output.args).toEqual(args)
      expect(output.env).toBe('inherited')
      expect(output.stdin).toBe('stdin text\n')
      expect(await Bun.file(path.join(output.cwd, path.relative(prefix, dist))).text()).toContain(
        'process.exit(23)',
      )
    } finally {
      await rm(prefix, { recursive: true, force: true })
    }
  },
)
