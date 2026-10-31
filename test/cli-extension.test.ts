import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { main } from '../src/cli.js'
import { printHelp } from '../src/cli/help.js'

const extensionInfo = {
  extensionId: 'test-extension',
  version: '0.1.3',
  buildTime: '2026-10-31T00:00:00.000Z',
  commit: 'abcdef1',
  userAgent: 'test-browser',
}

async function runExtension(args: string[]) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-cli-extension-'))
  const previousHome = process.env.AUTOBROWSER_HOME
  const stdout: string[] = []
  const stderr: string[] = []
  const requests: unknown[] = []
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    requests.push(request)
    return Response.json({
      ok: true,
      result:
        request.args.action === 'info'
          ? extensionInfo
          : {
              [request.args.action === 'reload' ? 'reloading' : 'reconnecting']: true,
              reconnectExpected: true,
            },
    })
  }) as typeof fetch)
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  process.env.AUTOBROWSER_HOME = homeDir
  try {
    const code = await main([
      '--json',
      '--server',
      'http://127.0.0.1:3000',
      '--tab',
      't99',
      '--frame',
      '@f99',
      'extension',
      ...args,
    ])
    return { code, requests, stdout: stdout.join(''), stderr: stderr.join('') }
  } finally {
    fetchSpy.mockRestore()
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    if (previousHome === undefined) delete process.env.AUTOBROWSER_HOME
    else process.env.AUTOBROWSER_HOME = previousHome
    await rm(homeDir, { recursive: true, force: true })
  }
}

describe('cli extension command', () => {
  for (const action of ['reload', 'reconnect']) {
    test(`forwards ${action} without ambient targets and writes the acknowledgement`, async () => {
      const result = await runExtension([action])
      expect(result.code).toBe(0)
      expect(result.requests).toEqual([{ command: 'extension', args: { action } }])
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        result: {
          [action === 'reload' ? 'reloading' : 'reconnecting']: true,
          reconnectExpected: true,
        },
      })
    })
  }

  test('forwards info without ambient targets and writes the version/build result', async () => {
    const result = await runExtension(['info'])
    expect(result.code).toBe(0)
    expect(result.requests).toEqual([{ command: 'extension', args: { action: 'info' } }])
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, result: extensionInfo })
    expect(printHelp(['extension', 'info'])).toContain('buildTime')
    expect(printHelp(['extension'])).toContain('Capabilities')
  })

  for (const args of [[], ['restart'], ['reload', 'extra'], ['info', 'extra']]) {
    test(`rejects invalid arguments ${JSON.stringify(args)} without forwarding`, async () => {
      const result = await runExtension(args)
      expect(result.code).toBe(1)
      expect(result.requests).toEqual([])
      expect(result.stdout + result.stderr).toMatch(
        /unsupported extension action|unexpected argument/,
      )
    })
  }

  test('help explains code reload, relay reconnect and recovery confirmation', () => {
    expect(printHelp(['extension'])).toContain('asynchronously after acknowledgement')
    expect(printHelp(['extension', 'reload'])).toContain('Reload extension code')
    expect(printHelp(['extension', 'reconnect'])).toContain('without reloading code')
    expect(printHelp(['extension', 'reload'])).toContain('status')
  })
})
