import { chmod, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
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
  console.log('CLI built successfully to dist/autobrowser.js')
} catch (error) {
  console.error('Build failed:', error)
  process.exit(1)
}
