import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from './command-line-test-utils.js'

describe('cli script command forwarding', () => {
  test('documents script help output', async () => {
    const scriptHelp = await runCli(['help', 'script'])
    expect(scriptHelp.exitCode).toBe(0)
    expect(scriptHelp.stdout).toContain('autobrowser script <add|list|remove>')
    expect(scriptHelp.stdout).toContain(
      'autobrowser script add [--stdin|--file <path>|--base64] <source>',
    )
    expect(scriptHelp.stdout).toContain('autobrowser script remove <id|--all>')
  })

  test('forwards script add with a positional source', async () => {
    const result = await runCli(['script', 'add', 'window.__injected = true'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'add', source: 'window.__injected = true' },
    })
  })

  test('forwards script add reading the source from --file and --base64', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-script-'))
    const scriptPath = path.join(tempDir, 'init.js')
    await writeFile(scriptPath, 'window.__fromFile = 1\n', 'utf8')

    const fromFile = await runCli(['script', 'add', '--file', scriptPath])
    expect(fromFile.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'add', source: 'window.__fromFile = 1' },
    })

    const fromBase64 = await runCli([
      'script',
      'add',
      '--base64',
      Buffer.from('window.__b64 = 2', 'utf8').toString('base64'),
    ])
    expect(fromBase64.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'add', source: 'window.__b64 = 2' },
    })
  })

  test('forwards script list and remove to the extension', async () => {
    const listed = await runCli(['script', 'list'])
    expect(listed.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'list' },
    })

    const removed = await runCli(['script', 'remove', 'script_abc'])
    expect(removed.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'remove', id: 'script_abc' },
    })

    const removedAll = await runCli(['script', 'remove', '--all'])
    expect(removedAll.fetchCalls[0].body).toEqual({
      command: 'script',
      args: { action: 'remove', all: true },
    })
  })
})
