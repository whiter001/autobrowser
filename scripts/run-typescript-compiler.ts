import path from 'node:path'
import { spawn } from 'node:child_process'

interface CommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

function resolveLocalBinary(name: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  return path.join(process.cwd(), 'node_modules', '.bin', `${name}${suffix}`)
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    })

    let settled = false
    const finish = (result: CommandResult) => {
      if (settled) {
        return
      }
      settled = true
      resolve(result)
    }

    child.once('error', (error) => finish({ code: null, signal: null, error }))
    child.once('exit', (code, signal) => finish({ code, signal }))
  })
}

function formatFailure(result: CommandResult): string {
  if (result.error) {
    return result.error.message
  }

  if (result.signal) {
    return `signal ${result.signal}`
  }

  return `exit code ${result.code ?? 'unknown'}`
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: bun scripts/run-typescript-compiler.ts [tsc args...]')
  process.exit(1)
}

const nativeResult = await runCommand(resolveLocalBinary('tsgo'), args)
if (!nativeResult.error && nativeResult.signal === null && nativeResult.code === 0) {
  process.exit(0)
}

if (process.env.AUTOBROWSER_TSC_FALLBACK === '0') {
  process.exit(nativeResult.code ?? 1)
}

console.warn(`[autobrowser] tsgo failed (${formatFailure(nativeResult)}); falling back to tsc`)

const fallbackResult = await runCommand(resolveLocalBinary('tsc'), args)
if (fallbackResult.error) {
  console.error(`[autobrowser] tsc failed to start: ${fallbackResult.error.message}`)
  process.exit(1)
}

if (fallbackResult.signal) {
  console.error(`[autobrowser] tsc exited via signal ${fallbackResult.signal}`)
  process.exit(1)
}

process.exit(fallbackResult.code ?? 1)
