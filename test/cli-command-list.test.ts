import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { main } from '../src/cli.js'

interface CapturedRequest {
  command: string
  args: Record<string, unknown>
}

async function runCommandList(argv: string[]): Promise<{
  exitCode: number | void
  requests: CapturedRequest[]
  stdout: string
}> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-cli-command-list-'))
  const previousHome = process.env.AUTOBROWSER_HOME
  const previousWorkspace = process.env.AUTOBROWSER_WORKSPACE
  const requests: CapturedRequest[] = []
  const stdout: string[] = []
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as CapturedRequest)
    return Response.json({ ok: true, result: { commands: [], total: 0 } })
  }) as typeof fetch)
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
  process.env.AUTOBROWSER_HOME = homeDir
  process.env.AUTOBROWSER_WORKSPACE = 'off'

  try {
    const exitCode = await main(['--json', '--server', 'http://127.0.0.1:3000', ...argv], {
      openUrl: async () => {},
    })
    return { exitCode, requests, stdout: stdout.join('') }
  } finally {
    fetchSpy.mockRestore()
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    if (previousHome === undefined) delete process.env.AUTOBROWSER_HOME
    else process.env.AUTOBROWSER_HOME = previousHome
    if (previousWorkspace === undefined) delete process.env.AUTOBROWSER_WORKSPACE
    else process.env.AUTOBROWSER_WORKSPACE = previousWorkspace
    await rm(homeDir, { recursive: true, force: true })
  }
}

describe('cli command list options', () => {
  test('forwards sort and for-tab to the extension', async () => {
    const { exitCode, requests } = await runCommandList([
      'command',
      'list',
      '--sort',
      'newest',
      '--for-tab',
      't2',
      '--limit',
      '5',
    ])

    expect(exitCode).toBe(0)
    expect(requests).toEqual([
      {
        command: 'command',
        args: { action: 'list', sort: 'newest', forTab: 't2', limit: 5 },
      },
    ])
  })

  test('keeps the default oldest-first list unchanged', async () => {
    const { exitCode, requests } = await runCommandList(['command', 'list'])

    expect(exitCode).toBe(0)
    expect(requests).toEqual([{ command: 'command', args: { action: 'list' } }])
  })

  test('rejects an unsupported sort value before contacting the extension', async () => {
    const { exitCode, requests, stdout } = await runCommandList([
      'command',
      'list',
      '--sort',
      'latest',
    ])

    expect(exitCode).toBe(1)
    expect(requests).toHaveLength(0)
    expect(stdout).toContain('unsupported command list sort')
  })

  test('rejects an unknown list option', async () => {
    const { exitCode, requests, stdout } = await runCommandList(['command', 'list', '--unknown'])

    expect(exitCode).toBe(1)
    expect(requests).toHaveLength(0)
    expect(stdout).toContain('unsupported command list option')
  })
})
