import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')
const outFile = path.join(distDir, 'autobrowser.js')

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

try {
  // 发布到 npm 后 bin 指向这个产物，npm 生成的是 symlink/shim，真正被解释执行的是
  // 这里注入的 shebang，所以必须是 bun；否则用户装完直接 command not found
  await execFileAsync(
    'bun',
    [
      'build',
      path.join(rootDir, 'src/cli.ts'),
      `--outfile=${outFile}`,
      '--target=bun',
      '--banner=#!/usr/bin/env bun',
    ],
    { cwd: rootDir },
  )
  await chmod(outFile, 0o755)

  // 与扩展的 chrome/build-info.json 对齐：让 `autobrowser version` 能回答"这个 CLI 是
  // 哪次构建"，并在 status 里和扩展的 manifest 版本做错配提示。
  const { version } = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')) as {
    version: string
  }
  let commit: string | null = null
  if (existsSync(path.join(rootDir, '.git'))) {
    try {
      commit =
        execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        }).trim() || null
    } catch {
      // 发布包或无 git 的环境仍然可以构建。
    }
  }
  const buildInfo = { version, buildTime: new Date().toISOString(), commit }
  await writeFile(
    path.join(distDir, 'build-info.json'),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
    'utf8',
  )

  console.log('CLI built successfully to dist/autobrowser.js')
} catch (error) {
  console.error('Build failed:', error)
  process.exit(1)
}
