import { describe, expect, test } from 'bun:test'
import type { CommandResult } from '../scripts/run-typescript-compiler.js'
import { runTypeScriptCompiler } from '../scripts/run-typescript-compiler.js'

function createCommandResult(code: number, signal: NodeJS.Signals | null = null): CommandResult {
  return { code, signal }
}

describe('TypeScript compiler runner', () => {
  test('falls back to tsc quietly when tsgo is not installed', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const stderr: string[] = []

    const exitCode = await runTypeScriptCompiler(['--noEmit'], {
      resolveBinary: (name) => name,
      binaryExists: (filePath) => filePath === 'tsc',
      runCommand: async (command, args) => {
        calls.push({ command, args })
        return createCommandResult(0)
      },
      writeStderr: (message) => {
        stderr.push(message)
      },
    })

    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(calls).toEqual([
      {
        command: 'tsc',
        args: ['--noEmit'],
      },
    ])
  })

  test('fails clearly in native-only mode when tsgo is missing', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const stderr: string[] = []

    const exitCode = await runTypeScriptCompiler(['--native-only', '--noEmit'], {
      resolveBinary: (name) => `bin/${name}`,
      binaryExists: () => false,
      runCommand: async (command, args) => {
        calls.push({ command, args })
        return createCommandResult(0)
      },
      writeStderr: (message) => {
        stderr.push(message)
      },
    })

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['[autobrowser] tsgo is not installed locally: bin/tsgo'])
    expect(calls).toEqual([])
  })

  test('warns and falls back when tsgo exists but exits with an error', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const stderr: string[] = []

    const exitCode = await runTypeScriptCompiler(['-p', 'tsconfig.json'], {
      resolveBinary: (name) => name,
      binaryExists: (filePath) => filePath === 'tsgo' || filePath === 'tsc',
      runCommand: async (command, args) => {
        calls.push({ command, args })
        return command === 'tsgo' ? createCommandResult(2) : createCommandResult(0)
      },
      writeStderr: (message) => {
        stderr.push(message)
      },
    })

    expect(exitCode).toBe(0)
    expect(stderr).toEqual(['[autobrowser] tsgo failed (exit code 2); falling back to tsc'])
    expect(calls).toEqual([
      {
        command: 'tsgo',
        args: ['-p', 'tsconfig.json'],
      },
      {
        command: 'tsc',
        args: ['-p', 'tsconfig.json'],
      },
    ])
  })

  test('stops immediately when fallback is disabled explicitly', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const stderr: string[] = []

    const exitCode = await runTypeScriptCompiler(['--noEmit'], {
      resolveBinary: (name) => name,
      binaryExists: (filePath) => filePath === 'tsgo' || filePath === 'tsc',
      fallbackEnvValue: '0',
      runCommand: async (command, args) => {
        calls.push({ command, args })
        return command === 'tsgo' ? createCommandResult(3) : createCommandResult(0)
      },
      writeStderr: (message) => {
        stderr.push(message)
      },
    })

    expect(exitCode).toBe(3)
    expect(stderr).toEqual([])
    expect(calls).toEqual([
      {
        command: 'tsgo',
        args: ['--noEmit'],
      },
    ])
  })
})
