import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

try {
  await execFileAsync(
    'bun',
    ['build', path.join(rootDir, 'src/cli.ts'), '--outfile=dist/autobrowser.js', '--target=bun'],
    { cwd: rootDir },
  )
  console.log('CLI built successfully to dist/autobrowser.js')
} catch (error) {
  console.error('Build failed:', error)
  process.exit(1)
}
