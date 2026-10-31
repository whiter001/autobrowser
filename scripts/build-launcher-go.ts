import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type LauncherTarget = { goos: string; goarch: string; name: string }

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
    await execFileAsync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', output, '.'], {
      cwd: path.join(rootDir, 'scripts/launcher-go'),
      env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
    })
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
