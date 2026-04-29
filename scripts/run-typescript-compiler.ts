import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export interface CommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

export interface ParsedCompilerArgs {
  forwardedArgs: string[]
  nativeOnly: boolean
}

export interface CompilerRunnerDependencies {
  resolveBinary(name: string): string
  binaryExists(filePath: string): boolean
  runCommand(command: string, args: string[]): Promise<CommandResult>
  writeStderr(message: string): void
  fallbackEnvValue?: string
}

function resolveLocalBinary(name: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  return path.join(process.cwd(), 'node_modules', '.bin', `${name}${suffix}`)
}

export function parseCompilerArgs(argv: string[]): ParsedCompilerArgs {
  let nativeOnly = false
  const forwardedArgs: string[] = []

  for (const arg of argv) {
    if (arg === '--native-only') {
      nativeOnly = true
      continue
    }

    forwardedArgs.push(arg)
  }

  return {
    forwardedArgs,
    nativeOnly,
  }
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

export function formatFailure(result: CommandResult): string {
  if (result.error) {
    return result.error.message
  }

  if (result.signal) {
    return `signal ${result.signal}`
  }

  return `exit code ${result.code ?? 'unknown'}`
}

function defaultWriteStderr(message: string): void {
  process.stderr.write(`${message}\n`)
}

function createDefaultDependencies(): CompilerRunnerDependencies {
  return {
    resolveBinary: resolveLocalBinary,
    binaryExists: existsSync,
    runCommand,
    writeStderr: defaultWriteStderr,
    fallbackEnvValue: process.env.AUTOBROWSER_TSC_FALLBACK,
  }
}

export async function runTypeScriptCompiler(
  argv: string[] = process.argv.slice(2),
  dependencyOverrides: Partial<CompilerRunnerDependencies> = {},
): Promise<number> {
  const dependencies: CompilerRunnerDependencies = {
    ...createDefaultDependencies(),
    ...dependencyOverrides,
  }

  const { forwardedArgs, nativeOnly } = parseCompilerArgs(argv)
  if (forwardedArgs.length === 0) {
    dependencies.writeStderr('usage: bun scripts/run-typescript-compiler.ts [tsc args...]')
    return 1
  }

  const nativeCommand = dependencies.resolveBinary('tsgo')
  const fallbackCommand = dependencies.resolveBinary('tsc')
  const allowFallback = !nativeOnly && dependencies.fallbackEnvValue !== '0'

  if (dependencies.binaryExists(nativeCommand)) {
    const nativeResult = await dependencies.runCommand(nativeCommand, forwardedArgs)
    if (!nativeResult.error && nativeResult.signal === null && nativeResult.code === 0) {
      return 0
    }

    if (!allowFallback) {
      return nativeResult.code ?? 1
    }

    // 只有原生编译器真实存在但执行失败时才提示 fallback；缺失场景保持安静，避免日常 check 输出被重复噪音淹没。
    dependencies.writeStderr(
      `[autobrowser] tsgo failed (${formatFailure(nativeResult)}); falling back to tsc`,
    )
  } else if (!allowFallback) {
    dependencies.writeStderr(`[autobrowser] tsgo is not installed locally: ${nativeCommand}`)
    return 1
  }

  const fallbackResult = await dependencies.runCommand(fallbackCommand, forwardedArgs)
  if (fallbackResult.error) {
    dependencies.writeStderr(`[autobrowser] tsc failed to start: ${fallbackResult.error.message}`)
    return 1
  }

  if (fallbackResult.signal) {
    dependencies.writeStderr(`[autobrowser] tsc exited via signal ${fallbackResult.signal}`)
    return 1
  }

  return fallbackResult.code ?? 1
}

if (import.meta.main) {
  runTypeScriptCompiler()
    .then((exitCode) => {
      process.exit(exitCode)
    })
    .catch((error) => {
      defaultWriteStderr(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
