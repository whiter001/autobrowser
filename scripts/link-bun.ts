import { access, chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const targetPath = path.join(bunDir, 'autobrowser')
const wrapper = `#!/usr/bin/env sh
exec ${JSON.stringify(bunPath)} ${JSON.stringify(distEntry)} "$@"
`

await writeFile(targetPath, wrapper, 'utf8')
await chmod(targetPath, 0o755)

console.log(`Linked autobrowser -> ${targetPath}`)
