import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EXTENSION_PUBLIC_KEY } from '../src/core/extension.js'
import { createBuildInfo, formatBuildVersionName, writeBuildInfoFile } from './lib/build-info.js'

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

const buildInfo = await createBuildInfo(rootDir)
await writeBuildInfoFile(outputDir, buildInfo)

const manifestPath = path.join(outputDir, 'manifest.json')
const manifest = JSON.parse(
  await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'),
) as Record<string, unknown>
manifest.key = EXTENSION_PUBLIC_KEY
// 数字 version 必须与 package.json 一致（Chrome 的版本比较依赖它），
// commit/buildTime 只能进展示用的 version_name。
manifest.version = buildInfo.version
manifest.version_name = formatBuildVersionName(
  buildInfo.version,
  buildInfo.buildTime,
  buildInfo.commit,
)
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await copyFile(path.join(extensionDir, 'connect.html'), path.join(outputDir, 'connect.html'))
await copyFile(path.join(extensionDir, 'options.html'), path.join(outputDir, 'options.html'))
await copyFile(
  path.join(extensionDir, 'offscreen-recorder.html'),
  path.join(outputDir, 'offscreen-recorder.html'),
)

console.log('Chrome extension built successfully to chrome/')
