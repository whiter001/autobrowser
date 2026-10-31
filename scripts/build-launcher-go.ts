import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type LauncherTarget = { goos: string; goarch: string; name: string }

export type LauncherLdflagOptions = { bunPath?: string; distEntry?: string }

// cmd/go 用 quoted.Split 解析 -ldflags：引号内的内容原样保留、不做反转义，
// 只按同种引号配对。所以路径里的空格要靠引号整体包住，JSON 风格的 \ 转义反而会留下多余反斜杠。
export function quoteGoLdflagField(value: string): string {
  if (!/[\s'"]/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('"')) return `"${value}"`
  throw new Error(`Cannot embed launcher path in Go linker flags: ${value}`)
}

// 发布构建只保留 -s -w；开发链接额外注入当前 Bun 与仓库 dist 的绝对路径。
export function launcherLdflags(options: LauncherLdflagOptions = {}): string {
  const parts = ['-s', '-w']
  if (options.bunPath) {
    parts.push('-X', quoteGoLdflagField(`main.defaultBunPath=${options.bunPath}`))
  }
  if (options.distEntry) {
    parts.push('-X', quoteGoLdflagField(`main.defaultDistEntry=${options.distEntry}`))
  }
  return parts.join(' ')
}

export function launcherTargets(
  args: string[],
  platform: string = process.platform,
  arch: string = process.arch,
): LauncherTarget[] {
  const flags = args.filter((arg) => arg !== '--')
  if (flags.some((arg) => arg !== '--current')) {
    throw new Error('Usage: bun run build:launcher [-- --current]')
  }
  const platforms: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
  const architectures: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }
  const pairs = flags.includes('--current')
    ? [[platforms[platform], architectures[arch]]]
    : [
        ['darwin', 'arm64'],
        ['darwin', 'amd64'],
        ['linux', 'amd64'],
        ['linux', 'arm64'],
        ['windows', 'amd64'],
        ['windows', 'arm64'],
      ]
  return pairs.map(([goos, goarch]) => {
    if (!goos || !goarch) throw new Error(`Unsupported launcher platform: ${platform}/${arch}`)
    return {
      goos,
      goarch,
      name: `autobrowser-${goos}-${goarch === 'amd64' ? 'x64' : goarch}${goos === 'windows' ? '.exe' : ''}`,
    }
  })
}

export type LauncherBuildEnv = { GOOS: string; GOARCH: string; CGO_ENABLED: string }

// 当前宿主的构建目标：显式覆盖外部可能存在的 GOOS/GOARCH 交叉编译设置。
export function currentBuildEnv(
  platform: string = process.platform,
  arch: string = process.arch,
): LauncherBuildEnv {
  const [target] = launcherTargets(['--current'], platform, arch)
  return { GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' }
}

export async function buildLaunchers(args: string[]): Promise<void> {
  const targets = launcherTargets(args)
  try {
    await execFileAsync('go', ['version'])
  } catch {
    throw new Error('Go is required to build native launchers. Install Go and add go to PATH.')
  }
  const outDir = path.join(rootDir, 'launchers')
  await mkdir(outDir, { recursive: true })
  for (const target of targets) {
    const output = path.join(outDir, target.name)
    await execFileAsync(
      'go',
      ['build', '-trimpath', '-ldflags', launcherLdflags(), '-o', output, '.'],
      {
        cwd: path.join(rootDir, 'scripts/launcher-go'),
        env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
      },
    )
    console.log(`Launcher built: ${output}`)
  }
}

if (import.meta.main) {
  try {
    await buildLaunchers(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
