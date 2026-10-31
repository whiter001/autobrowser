import { access, chmod, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { currentBuildEnv, launcherLdflags } from './build-launcher-go'

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

try {
  await execFileAsync('go', ['version'])
} catch {
  console.error('Go is required to build the native launcher. Install Go and add go to PATH.')
  process.exit(1)
}

const bunDir = path.dirname(bunPath)
const isWindows = os.platform() === 'win32'
const targetPath = path.join(bunDir, isWindows ? 'autobrowser.exe' : 'autobrowser')
// 先写同目录临时文件再 rename，避免覆盖正在运行的入口时留下半个文件。
const tempPath = path.join(bunDir, `.autobrowser-link-${process.pid}${isWindows ? '.exe' : ''}`)

try {
  await execFileAsync(
    'go',
    [
      'build',
      '-trimpath',
      '-ldflags',
      launcherLdflags({ bunPath, distEntry }),
      '-o',
      tempPath,
      '.',
    ],
    {
      cwd: path.join(rootDir, 'scripts', 'launcher-go'),
      // 显式指定宿主目标，避免外部 GOOS/GOARCH 交叉编译设置产出非本机二进制。
      env: { ...process.env, ...currentBuildEnv() },
    },
  )
  await chmod(tempPath, 0o755)
  await rename(tempPath, targetPath)
} finally {
  await rm(tempPath, { force: true })
}

if (isWindows) {
  // 旧的无扩展名 sh 入口和 .cmd 会让调用方继续走 shell 路径，链接时一并清理。
  await rm(path.join(bunDir, 'autobrowser'), { force: true })
  await rm(path.join(bunDir, 'autobrowser.cmd'), { force: true })
}

console.log(`Linked autobrowser ->\n  ${targetPath}`)
