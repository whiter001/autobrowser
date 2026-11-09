import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

declare const AUTOBROWSER_DEFAULT_BUN_PATH: string
declare const AUTOBROWSER_DEFAULT_DIST_ENTRY: string

const embeddedBunPath =
  typeof AUTOBROWSER_DEFAULT_BUN_PATH === 'string' ? AUTOBROWSER_DEFAULT_BUN_PATH : ''
const embeddedDistEntry =
  typeof AUTOBROWSER_DEFAULT_DIST_ENTRY === 'string' ? AUTOBROWSER_DEFAULT_DIST_ENTRY : ''

function resolveOverride(envValue: string | undefined, embedded: string): string {
  return envValue || embedded
}

export function resolveBun(override: string): string {
  const name = override || (process.platform === 'win32' ? 'bun.exe' : 'bun')
  const resolved = Bun.which(name)
  if (!resolved) {
    throw new Error(
      `cannot find Bun (${name}): install Bun and add it to PATH, or set AUTOBROWSER_BUN_PATH`,
    )
  }
  return resolved
}

export function distCandidates(executable: string): string[] {
  const dir = path.dirname(executable)
  const packagePath = path.join(
    'node_modules',
    '@whiter001',
    'autobrowser',
    'dist',
    'autobrowser.js',
  )
  return [
    path.join(dir, packagePath),
    path.join(dir, '..', 'lib', packagePath),
    path.join(dir, '..', '@whiter001', 'autobrowser', 'dist', 'autobrowser.js'),
    path.join(dir, '..', 'dist', 'autobrowser.js'),
  ]
}

export function resolveDist(executable: string, override: string): string {
  const candidates = override ? [override] : distCandidates(executable)
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.resolve(candidate)
  }
  throw new Error(
    `cannot find dist/autobrowser.js (checked ${candidates.join(', ')}); reinstall @whiter001/autobrowser or set AUTOBROWSER_DIST_ENTRY`,
  )
}

async function run(): Promise<number> {
  const bun = resolveBun(resolveOverride(process.env.AUTOBROWSER_BUN_PATH, embeddedBunPath))
  const dist = resolveDist(
    process.execPath,
    resolveOverride(process.env.AUTOBROWSER_DIST_ENTRY, embeddedDistEntry),
  )
  const child = spawn(bun, [dist, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  })
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (process.platform !== 'win32') child.kill(signal)
  }
  process.on('SIGINT', forwardSignal)
  process.on('SIGTERM', forwardSignal)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code !== null) return resolve(code)
        const signalNumber = signal ? os.constants.signals[signal] : undefined
        resolve(128 + (signalNumber ?? 1))
      })
    })
  } finally {
    process.removeListener('SIGINT', forwardSignal)
    process.removeListener('SIGTERM', forwardSignal)
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await run()
  } catch (error) {
    console.error('[autobrowser]', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
