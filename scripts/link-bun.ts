import { access, chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const distEntry = path.join(rootDir, 'dist', 'autobrowser.js')

const bunPath = Bun.which('bun')
if (!bunPath) {
  console.error('bun executable not found on PATH')
  process.exit(1)
}

try {
  await access(distEntry)
} catch {
  console.error(`Missing build artifact: ${distEntry}`)
  console.error('Run `bun run build:cli` first.')
  process.exit(1)
}

const bunDir = path.dirname(bunPath)
const isWindows = os.platform() === 'win32'

// 无扩展名的 sh 包装器：Git Bash / WSL 这类 POSIX shell 只会按字面名查找，
// 不会把 autobrowser 补成 autobrowser.cmd，所以 Windows 上也必须放一份
const shWrapper = `#!/usr/bin/env sh
exec ${JSON.stringify(bunPath)} ${JSON.stringify(distEntry)} "$@"
`

const written: string[] = []

if (isWindows) {
  const cmdPath = path.join(bunDir, 'autobrowser.cmd')
  await writeFile(
    cmdPath,
    `@echo off\r\nsetlocal\r\n${JSON.stringify(bunPath)} ${JSON.stringify(distEntry)} %*\r\n`,
    'utf8',
  )
  written.push(cmdPath)
}

const shPath = path.join(bunDir, 'autobrowser')
await writeFile(shPath, shWrapper, 'utf8')
// writeFile 的 mode 只在新建文件时生效，已有文件必须显式 chmod
await chmod(shPath, 0o755)
written.push(shPath)

console.log(`Linked autobrowser ->\n${written.map((p) => `  ${p}`).join('\n')}`)
