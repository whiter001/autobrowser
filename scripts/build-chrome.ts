import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EXTENSION_PUBLIC_KEY } from '../src/core/extension.js'

const rootDir = process.cwd()
const extensionDir = path.join(rootDir, 'extension')
const outputDir = path.join(rootDir, 'chrome')

await rm(outputDir, { recursive: true, force: true })

const build = await Bun.build({
  entrypoints: [
    path.join(extensionDir, 'background.ts'),
    path.join(extensionDir, 'connect.ts'),
    path.join(extensionDir, 'options.ts'),
    path.join(extensionDir, 'offscreen-recorder.ts'),
  ],
  outdir: outputDir,
  target: 'browser',
})

if (!build.success) {
  console.error(build.logs)
  process.exit(1)
}

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
    // 发布包或无 git 的环境仍然可以构建扩展。
  }
}
const buildInfo = { version, buildTime: new Date().toISOString(), commit }
await writeFile(
  path.join(outputDir, 'build-info.json'),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
  'utf8',
)

const manifestPath = path.join(outputDir, 'manifest.json')
const manifest = JSON.parse(
  await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'),
) as Record<string, unknown>
manifest.key = EXTENSION_PUBLIC_KEY
manifest.version = version
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await copyFile(path.join(extensionDir, 'connect.html'), path.join(outputDir, 'connect.html'))
await copyFile(path.join(extensionDir, 'options.html'), path.join(outputDir, 'options.html'))
await copyFile(
  path.join(extensionDir, 'offscreen-recorder.html'),
  path.join(outputDir, 'offscreen-recorder.html'),
)

console.log('Chrome extension built successfully to chrome/')
