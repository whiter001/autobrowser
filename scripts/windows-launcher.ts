import { spawn } from 'node:child_process'

declare const AUTOBROWSER_BUN_PATH: string
declare const AUTOBROWSER_DIST_ENTRY: string

const child = spawn(AUTOBROWSER_BUN_PATH, [AUTOBROWSER_DIST_ENTRY, ...process.argv.slice(2)], {
  stdio: 'inherit',
})

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    resolve(code ?? (signal ? 1 : 0))
  })
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  return 1
})

process.exitCode = exitCode
