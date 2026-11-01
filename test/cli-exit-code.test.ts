import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { main } from '../src/cli.js'
import { COMMAND_REGISTRY } from '../src/cli/commands/index.js'
import type { CommandHandler } from '../src/cli/commands/types.js'

const failure = {
  ok: false,
  error: {
    message: 'command failed',
    code: 'TEST_FAILURE',
    details: { reason: 'test' },
    suggestedAction: 'Inspect the page before retrying.',
  },
}
const success = { ok: true, result: { value: 42 } }

async function runCli(argv: string[], payload: unknown = success, handler?: CommandHandler) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-cli-exit-'))
  const previousHome = process.env.AUTOBROWSER_HOME
  const stdout: string[] = []
  const stderr: string[] = []
  let requestCount = 0
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, _init) => {
    requestCount += 1
    return Response.json(payload)
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
  if (handler) COMMAND_REGISTRY['test-exit-code'] = handler

  try {
    const exitCode = await main(argv)
    return { exitCode, stdout: stdout.join(''), stderr: stderr.join(''), requestCount }
  } finally {
    delete COMMAND_REGISTRY['test-exit-code']
    fetchSpy.mockRestore()
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    if (previousHome === undefined) delete process.env.AUTOBROWSER_HOME
    else process.env.AUTOBROWSER_HOME = previousHome
    await rm(homeDir, { recursive: true, force: true })
  }
}

describe('CLI response exit codes', () => {
  for (const argv of [
    ['eval', '42'],
    ['tab', 'new', 'https://example.com'],
  ]) {
    for (const payload of [failure, success]) {
      test(`${argv.join(' ')} exits ${payload.ok ? 0 : 1} with unchanged JSON`, async () => {
        const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-cli-exit-process-'))
        const requests: string[] = []
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(request) {
            const body = (await request.json()) as { command: string }
            requests.push(body.command)
            return Response.json(payload)
          },
        })
        try {
          const child = Bun.spawn(
            [
              process.execPath,
              path.resolve(import.meta.dir, '../src/cli.ts'),
              '--server',
              `http://127.0.0.1:${server.port}`,
              ...argv,
            ],
            {
              env: { ...process.env, AUTOBROWSER_HOME: homeDir },
              stdout: 'pipe',
              stderr: 'pipe',
            },
          )
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          expect(exitCode).toBe(payload.ok ? 0 : 1)
          expect(stdout).toBe(`${JSON.stringify(payload, null, 2)}\n`)
          expect(stderr).toBe('')
          expect(requests).toEqual([argv[0] === 'eval' ? 'eval' : 'tab.new'])
        } finally {
          server.stop(true)
          await rm(homeDir, { recursive: true, force: true })
        }
      })
    }
  }

  for (const mode of ['--raw', '--brief']) {
    test(`${mode} preserves failure text and exits 1`, async () => {
      const result = await runCli([mode, 'eval', '42'], failure)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(
        'command failed\n\n[AI SUGGESTION]: Inspect the page before retrying.\n',
      )
    })
  }

  test('uses only the final top-level batch response with continueOnError', async () => {
    const payload = {
      ok: true,
      result: {
        steps: [{ index: 1, command: 'eval', response: failure }],
        summary: { failed: 1 },
      },
    }
    const result = await runCli(
      [
        'batch',
        JSON.stringify({
          steps: [{ command: 'eval', args: { script: '42' } }],
          continueOnError: true,
        }),
      ],
      payload,
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(`${JSON.stringify(payload, null, 2)}\n`)
    expect(result.stderr).toBe('')
  })

  for (const { name, outputs, code, expected } of [
    { name: 'failure then recovery', outputs: [failure, success], code: 0, expected: 0 },
    { name: 'success then failure', outputs: [success, failure], code: 0, expected: 1 },
    { name: 'failure with void return', outputs: [failure], code: undefined, expected: 1 },
    {
      name: 'local output cannot mask failure',
      outputs: [failure, 'done', { value: 42 }],
      code: 0,
      expected: 1,
    },
    { name: 'explicit nonzero after failure', outputs: [failure], code: 7, expected: 7 },
    { name: 'explicit nonzero after recovery', outputs: [failure, success], code: 7, expected: 7 },
    {
      name: 'strict false only',
      outputs: [{ ok: 0 }, { ok: 'false' }, { ok: null }],
      code: 0,
      expected: 0,
    },
    { name: 'local scalar success', outputs: [false, 0, 'done'], code: 0, expected: 0 },
    { name: 'no response', outputs: [], code: 0, expected: 0 },
    { name: 'no response with void return', outputs: [], code: undefined, expected: undefined },
  ]) {
    test(name, async () => {
      const result = await runCli(['test-exit-code'], success, async (_rest, context) => {
        for (const output of outputs) context.writeResult(output)
        return code
      })
      expect(result.exitCode).toBe(expected)
      expect(result.stdout).toBe(
        outputs.map((output) => `${JSON.stringify(output, null, 2)}\n`).join(''),
      )
      expect(result.stderr).toBe('')
    })
  }

  test('help does not dispatch a request or fail', async () => {
    const result = await runCli(['eval', '--help'], failure)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('eval')
    expect(result.stderr).toBe('')
    expect(result.requestCount).toBe(0)
  })

  test('an unwritten failed request does not override the final successful response', async () => {
    const result = await runCli(['test-exit-code'], failure, async (_rest, context) => {
      await context.requestCommand(context.flags.server, 'eval', { script: '42' })
      context.writeResult(success)
      return 0
    })
    expect(result.requestCount).toBe(1)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(`${JSON.stringify(success, null, 2)}\n`)
    expect(result.stderr).toBe('')
  })

  test('response state does not leak into the next invocation', async () => {
    expect((await runCli(['eval', '42'], failure)).exitCode).toBe(1)
    expect((await runCli(['eval', '42'], success)).exitCode).toBe(0)
  })
})
