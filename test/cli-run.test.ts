import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateCommandArgs } from '../src/core/command-spec.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

describe('cli run', () => {
  test('loads a Playwright function from file and forwards tab and timeout', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-run-cli-'))
    try {
      const scriptPath = path.join(directory, 'script.js')
      const source = 'async (page) => ({ title: await page.title() })'
      await writeFile(scriptPath, source)
      const result = await runCli(['run', '--tab', 't7', scriptPath, '--timeout-ms', '60000'], {
        ok: true,
        result: { value: { title: 'Example' } },
      })
      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls).toHaveLength(1)
      expect(result.fetchCalls[0].body).toEqual({
        command: 'run',
        args: { source, tabId: 't7', timeoutMs: 60000 },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('accepts --timeout as the alias of --timeout-ms and rejects duplicate names', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-run-alias-'))
    try {
      const scriptPath = path.join(directory, 'script.js')
      const source = 'async (page) => await page.url()'
      await writeFile(scriptPath, source)

      const aliased = await runCli(['run', '--tab', 't7', scriptPath, '--timeout', '45000'], {
        ok: true,
        result: { value: 'https://example.com/' },
      })
      expect(aliased.exitCode).toBe(0)
      expect(aliased.fetchCalls[0].body).toEqual({
        command: 'run',
        args: { source, tabId: 't7', timeoutMs: 45000 },
      })

      for (const timeoutArgs of [
        ['--timeout-ms', '45000', '--timeout', '30000'],
        ['--timeout-ms', '45000', '--timeout-ms', '30000'],
        ['--timeout', '45000', '--timeout', '30000'],
      ]) {
        const duplicate = await runCli(['run', scriptPath, ...timeoutArgs])
        expect(duplicate.exitCode).toBe(1)
        expect(duplicate.fetchCalls).toHaveLength(0)
        const error = cliErrorPayload(duplicate.stdout).error
        expect(error.code).toBe('CLI_INVALID_ARGUMENT')
        expect(error.message).toContain('duplicate')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('supports the shared --file source input', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-run-file-'))
    try {
      const scriptPath = path.join(directory, 'script.js')
      await writeFile(scriptPath, '\uFEFFasync (page) => await page.url()')
      const result = await runCli(['run', '--file', scriptPath])
      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls[0].body?.args?.source).toBe('async (page) => await page.url()')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects frame targeting and batch nesting before sending a request', async () => {
    const result = await runCli(['run', '--frame', '@f1', 'script.js'])
    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain('does not accept --frame')
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'run', args: { source: 'async (page) => page.url()' } }],
      }),
    ).toThrow(/run cannot run as a batch step/)
  })
})
