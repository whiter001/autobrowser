import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { launcherLdflags } from './build-launcher-go'

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type BunLauncherTarget = { name: string; target: string }

type BunLauncherBuildOptions = {
  entrypoint: string
  outfile: string
  target?: string
  bunPath?: string
  distEntry?: string
}

export function bunLauncherTargets(
  args: string[],
  platform: string = process.platform,
  arch: string = process.arch,
): BunLauncherTarget[] {
  const flags = args.filter((arg) => arg !== '--')
  if (flags.some((arg) => arg !== '--current')) {
    throw new Error('Usage: bun run build:launcher [-- --current]')
  }
  const platforms: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported launcher platform: ${platform}/${arch}`)
  }
  const names = flags.includes('--current')
    ? [[platforms[platform], arch]]
    : [
        ['darwin', 'arm64'],
        ['darwin', 'x64'],
        ['linux', 'x64'],
        ['linux', 'arm64'],
        ['windows', 'x64'],
        ['windows', 'arm64'],
      ]
  return names.map(([os, architecture]) => {
    if (!os || !architecture) throw new Error(`Unsupported launcher platform: ${platform}/${arch}`)
    return {
      target: `bun-${os}-${architecture}`,
      name: `autobrowser-${os}-${architecture}${os === 'windows' ? '.exe' : ''}`,
    }
  })
}

export function bunLauncherBuildArgs(options: BunLauncherBuildOptions): string[] {
  const args = [
    'build',
    options.entrypoint,
    '--compile',
    '--aot',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--outfile',
    options.outfile,
  ]
  if (options.target) args.push('--target', options.target)
  if (options.bunPath) {
    args.push('--define', `AUTOBROWSER_DEFAULT_BUN_PATH=${JSON.stringify(options.bunPath)}`)
  }
  if (options.distEntry) {
    args.push('--define', `AUTOBROWSER_DEFAULT_DIST_ENTRY=${JSON.stringify(options.distEntry)}`)
  }
  return args
}

async function buildGoFallback(target: BunLauncherTarget, output: string): Promise<void> {
  const match = /^bun-(darwin|linux|windows)-(x64|arm64)$/.exec(target.target)
  if (!match) throw new Error(`Unsupported Go fallback target: ${target.target}`)
  await execFileAsync(
    'go',
    ['build', '-trimpath', '-ldflags', launcherLdflags(), '-o', output, '.'],
    {
      cwd: path.join(rootDir, 'scripts/launcher-go'),
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: match[1]!,
        GOARCH: match[2] === 'x64' ? 'amd64' : 'arm64',
      },
    },
  )
  console.log(`Go fallback launcher built (Bun AOT cannot cross-compile): ${output}`)
}

async function buildLaunchers(args: string[]): Promise<void> {
  const targets = bunLauncherTargets(args)
  const currentTarget = bunLauncherTargets(['--current'])[0]!
  const needsGo = targets.some((target) => target.target !== currentTarget.target)
  if (needsGo) {
    try {
      await execFileAsync('go', ['version'])
    } catch {
      throw new Error(
        'Bun AOT cannot cross-compile. Install Go for non-host fallback targets, or use --current / build on each target host.',
      )
    }
  }
  const outDir = path.join(rootDir, 'launchers')
  await mkdir(outDir, { recursive: true })
  for (const target of targets) {
    const output = path.join(outDir, target.name)
    if (target.target !== currentTarget.target) {
      await buildGoFallback(target, output)
      continue
    }
    await execFileAsync(
      process.execPath,
      bunLauncherBuildArgs({
        entrypoint: path.join(rootDir, 'scripts', 'launcher-bun.ts'),
        outfile: output,
        target: target.target,
      }),
      { cwd: rootDir },
    )
    console.log(`Bun AOT launcher built: ${output}`)
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
