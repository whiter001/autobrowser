import { access, chmod, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const execFileAsync = promisify(execFile)
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
// Windows 上另提供原生 exe，避免批处理 %* 二次展开脚本参数
const shWrapper = `#!/usr/bin/env sh
exec ${JSON.stringify(bunPath)} ${JSON.stringify(distEntry)} "$@"
`

const written: string[] = []

if (isWindows) {
  const executablePath = path.join(bunDir, 'autobrowser.exe')
  await execFileAsync(
    bunPath,
    [
      'build',
      path.join(rootDir, 'scripts', 'windows-launcher.ts'),
      '--compile',
      `--outfile=${executablePath}`,
      '--define',
      `AUTOBROWSER_BUN_PATH=${JSON.stringify(bunPath.replaceAll('\\', '/'))}`,
      '--define',
      `AUTOBROWSER_DIST_ENTRY=${JSON.stringify(distEntry.replaceAll('\\', '/'))}`,
    ],
    { cwd: rootDir },
  )
  // 旧批处理会把 %VARIABLE% 当环境变量展开，不能继续留在 PATH 中误导调用方。
  await rm(path.join(bunDir, 'autobrowser.cmd'), { force: true })
  written.push(executablePath)
}

const shPath = path.join(bunDir, 'autobrowser')
await writeFile(shPath, shWrapper, 'utf8')
// writeFile 的 mode 只在新建文件时生效，已有文件必须显式 chmod
await chmod(shPath, 0o755)
written.push(shPath)

console.log(`Linked autobrowser ->\n${written.map((p) => `  ${p}`).join('\n')}`)
