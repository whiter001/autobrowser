import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { tabCommandRegistry } from '../src/cli/commands/tabs.js'
import type { CommandContext } from '../src/cli/commands/types.js'

// Run real CLI processes so ambient targets, response exit codes and multi-request output
// are tested without replacing process-global streams in other CLI suites.
async function runCli(argv: string[], replies: unknown[]) {
  const requests: Array<{ command: string; args: Record<string, unknown> }> = []
  const home = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-ready-'))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number])
      return Response.json(
        replies[requests.length - 1] ?? { ok: false, error: { message: 'unexpected request' } },
      )
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
        env: { ...process.env, AUTOBROWSER_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr, requests }
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

const success = { ok: true, result: { waited: true } }
const failure = { ok: false, error: { code: 'TIMEOUT', message: 'selector wait timed out' } }
const created = { ok: true, result: { tab: { id: 42, handle: 't7', url: 'https://example.com' } } }

describe('CLI navigation and media readiness', () => {
  for (const command of ['goto', 'open']) {
    for (const type of ['url', 'selector']) {
      test(`${command} forwards ${type} wait without overwriting destination`, async () => {
        const result = await runCli(
          [command, 'https://example.com', '--wait-for', type, '#ready', '--timeout-ms', '45000'],
          [
            {
              ok: true,
              result: {
                url: 'https://example.com',
                wait: { type, value: '#ready', completed: true },
              },
            },
          ],
        )
        expect(result.exitCode).toBe(0)
        expect(result.requests).toEqual([
          {
            command: 'goto',
            args: {
              url: 'https://example.com',
              waitFor: type,
              [type === 'url' ? 'waitUrl' : 'selector']: '#ready',
              timeoutMs: 45000,
            },
          },
        ])
      })
    }
  }

  for (const command of ['goto', 'open']) {
    for (const type of ['url', 'selector']) {
      for (const wait of [
        undefined,
        { type, value: 'wrong', completed: true },
        { type, value: '#ready', completed: false },
      ]) {
        test(`${command} rejects missing/mismatched ${type} wait proof: ${JSON.stringify(wait)}`, async () => {
          const result = await runCli(
            [command, 'https://example.com', '--wait-for', type, '#ready'],
            [{ ok: true, result: { url: 'https://example.com/final', wait } }],
          )
          expect(result.exitCode).toBe(1)
          expect(result.requests).toHaveLength(1)
          expect(JSON.parse(result.stdout)).toMatchObject({
            ok: false,
            result: { url: 'https://example.com/final' },
            error: { code: 'WAIT_NOT_CONFIRMED' },
          })
        })
      }
    }
    test(`${command} preserves successful navigation in a failed wait response`, async () => {
      const reply = {
        ...failure,
        result: {
          navigated: true,
          url: 'https://example.com/final',
          navigationResult: { navigated: true, url: 'https://example.com/final' },
        },
      }
      const result = await runCli(
        [command, 'https://example.com', '--wait-for', 'selector', 'article'],
        [reply],
      )
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual(reply)
      expect(result.requests).toHaveLength(1)
    })
  }

  for (const command of [
    ['goto', 'https://example.com'],
    ['open', 'https://example.com'],
    ['tab', 'new'],
  ]) {
    for (const options of [
      ['--wait-for', 'url', '#a', '--wait-for', 'url', '#b'],
      ['--wait-for', 'url', '#a', '--wait-for', 'selector', 'article'],
      ['--wait-for', 'selector', 'article', '--timeout-ms', '10', '--timeout-ms', '20'],
    ]) {
      test(`rejects duplicate readiness flags: ${[...command, ...options].join(' ')}`, async () => {
        const result = await runCli([...command, ...options], [])
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain('duplicate')
        expect(result.requests).toHaveLength(0)
      })
    }
  }

  test('tab new fails explicitly for a missing frame in the new tab without closing it', async () => {
    const missingFrame = {
      ok: false,
      error: { code: 'FRAME_NOT_FOUND', message: 'frame selector not found: #old-frame' },
    }
    const result = await runCli(
      ['--tab', 't1', '--frame', '#old-frame', 'tab', 'new', '--wait-for', 'selector', 'article'],
      [created, missingFrame],
    )
    expect(result.exitCode).toBe(1)
    expect(result.requests.map((request) => request.command)).toEqual(['tab.new', 'wait'])
    expect(result.requests[1]?.args).toMatchObject({ tabId: 't7', frame: '#old-frame' })
    expect(JSON.parse(result.stdout)).toMatchObject({
      ...missingFrame,
      result: { tab: created.result.tab },
    })
  })

  for (const status of [{}, { captureId: null }, { captureId: 'other' }]) {
    test(`guarded HAR stop refuses old/mismatched status: ${JSON.stringify(status)}`, async () => {
      const result = await runCli(
        ['--tab', 't3', 'network', 'har', 'stop', '--capture-id', 'wanted'],
        [{ ok: true, result: status }],
      )
      expect(result.exitCode).toBe(1)
      expect(result.requests).toEqual([
        { command: 'network', args: { action: 'har', subaction: 'status', tabId: 't3' } },
      ])
      expect(result.stderr).toContain('stop was not sent')
    })
  }

  for (const captureId of [undefined, 'changed']) {
    test(`guarded HAR stop verifies returned identity: ${captureId}`, async () => {
      const result = await runCli(
        ['--tab', 't3', 'network', 'har', 'stop', '--capture-id', 'wanted'],
        [
          { ok: true, result: { captureId: 'wanted' } },
          { ok: true, result: { captureId, har: { log: { entries: [] } } } },
        ],
      )
      expect(result.exitCode).toBe(1)
      expect(result.requests).toEqual([
        { command: 'network', args: { action: 'har', subaction: 'status', tabId: 't3' } },
        {
          command: 'network',
          args: { action: 'har', subaction: 'stop', captureId: 'wanted', tabId: 't3' },
        },
      ])
      expect(result.stderr).toContain('network har recover')
    })
  }

  test('old extension include-urls failure explains that capture may be stopped and recoverable', async () => {
    const result = await runCli(
      ['network', 'har', 'stop', '--include-urls'],
      [{ ok: true, result: { har: { log: { entries: [] } } } }],
    )
    expect(result.exitCode).toBe(1)
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0]?.args.subaction).toBe('stop')
    expect(result.stderr).toContain('capture may already be stopped')
    expect(result.stderr).toContain('network har recover')
  })

  for (const waited of [success, failure]) {
    test(`tab new binds new handle and preserves tab on wait ${waited.ok}`, async () => {
      const result = await runCli(
        [
          '--tab',
          't1',
          '--frame',
          '#content',
          'tab',
          'new',
          'https://example.com',
          '--wait-for',
          'selector',
          'article',
          '--timeout-ms',
          '45000',
        ],
        [created, waited],
      )
      expect(result.exitCode).toBe(waited.ok ? 0 : 1)
      expect(result.requests).toEqual([
        { command: 'tab.new', args: { url: 'https://example.com' } },
        {
          command: 'wait',
          args: {
            tabId: 't7',
            frame: '#content',
            type: 'selector',
            selector: 'article',
            state: 'visible',
            timeout: 45000,
          },
        },
      ])
      const output = JSON.parse(result.stdout)
      expect(output.ok).toBe(waited.ok)
      expect(output.result.tab).toEqual(created.result.tab)
      if (!waited.ok) expect(output.error).toEqual(failure.error)
    })
  }

  test('tab new url condition uses the new handle', async () => {
    const result = await runCli(
      ['tab', 'new', 'https://example.com', '--wait-for', 'url', '#ready'],
      [created, success],
    )
    expect(result.requests[1]).toEqual({
      command: 'wait',
      args: { tabId: 't7', type: 'url', url: '#ready' },
    })
    expect(result.exitCode).toBe(0)
  })

  test('tab new missing handle fails without waiting on an ambient tab', async () => {
    const result = await runCli(
      ['tab', 'new', '--wait-for', 'selector', 'article'],
      [{ ok: true, result: { tab: { url: 'about:blank' } } }],
    )
    expect(result.exitCode).toBe(1)
    expect(result.requests).toHaveLength(1)
    expect(JSON.parse(result.stdout).result.tab.url).toBe('about:blank')
  })

  test('failed creation never issues a wait', async () => {
    const result = await runCli(['tab', 'new', '--wait-for', 'selector', 'article'], [failure])
    expect(result.requests).toHaveLength(1)
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual(failure)
  })

  test('a thrown wait transport error retains the created handle in the final failure', async () => {
    const output: unknown[] = []
    const requests: string[] = []
    const context = {
      flags: { server: 'http://test' },
      writeHelp: () => 0,
      writeResult: (payload: unknown) => output.push(payload),
      requestCommand: async (_server: string, command: string) => {
        requests.push(command)
        if (command === 'tab.new') return created
        throw new Error('transport disconnected')
      },
    } as unknown as CommandContext
    expect(
      await tabCommandRegistry.tab!(['new', '--wait-for', 'selector', 'article'], context),
    ).toBe(1)
    expect(requests).toEqual(['tab.new', 'wait'])
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      ok: false,
      result: { tab: created.result.tab },
      error: { message: 'transport disconnected' },
    })
  })

  test('tab new without options retains the original response', async () => {
    const result = await runCli(['tab', 'new', 'https://example.com'], [created])
    expect(result.stdout).toBe(`${JSON.stringify(created, null, 2)}\n`)
    expect(result.requests).toHaveLength(1)
  })

  test('goto fallback also honors the wait on the new handle and final failure', async () => {
    const result = await runCli(
      ['open', 'https://example.com', '--wait-for', 'selector', 'article'],
      [{ ok: false, error: { message: 'cannot access chrome://' } }, created, failure],
    )
    expect(result.requests.map((request) => request.command)).toEqual(['goto', 'tab.new', 'wait'])
    expect(result.requests[2]?.args.tabId).toBe('t7')
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout).result.tab.handle).toBe('t7')
  })

  for (const ok of [true, false]) {
    test(`media wait and collection use one target-bound request: ${ok}`, async () => {
      const reply = ok
        ? {
            ok: true,
            result: {
              media: [],
              scope: { selector: 'article' },
              wait: { selector: 'article', completed: true },
            },
          }
        : failure
      const result = await runCli(
        [
          '--tab',
          't3',
          '--frame',
          '#content',
          'media',
          'list',
          '--wait-for',
          'article',
          '--selector',
          'article',
          '--timeout-ms',
          '45000',
          '--resolve',
        ],
        [reply],
      )
      expect(result.exitCode).toBe(ok ? 0 : 1)
      expect(result.requests).toEqual([
        {
          command: 'media',
          args: {
            action: 'list',
            resolve: true,
            selector: 'article',
            waitFor: 'article',
            timeoutMs: 45000,
            tabId: 't3',
            frame: '#content',
          },
        },
      ])
      expect(JSON.parse(result.stdout)).toEqual(reply)
    })
  }

  for (const [extra, result] of [
    [['--selector', 'article'], { media: [] }],
    [['--selector', 'article'], { media: [], scope: { selector: 'body' } }],
    [['--include-background'], { media: [] }],
    [['--wait-for', 'article'], { media: [] }],
    [['--wait-for', 'article'], { media: [], wait: { selector: 'body', completed: true } }],
  ] as const) {
    test(`rejects old/unconfirmed extension response: ${extra.join(' ')} ${JSON.stringify(result)}`, async () => {
      const reply = await runCli(['media', 'list', ...extra], [{ ok: true, result }])
      expect(reply.exitCode).toBe(1)
      expect(reply.stderr).toContain('did not confirm')
      expect(reply.requests).toHaveLength(1)
    })
  }

  for (const argv of [
    ['goto', 'https://example.com', '--wait-for', 'load', 'x'],
    ['open', 'https://example.com', '--wait-for', 'selector'],
    ['tab', 'new', '--wait-for', 'url'],
    ['tab', 'new', '--timeout-ms', '100'],
    ['media', 'list', '--wait-for'],
    ['media', 'list', '--wait-for', 'article', '--timeout-ms', '0'],
    ['media', 'list', '--timeout-ms', '100'],
  ]) {
    test(`rejects invalid readiness arguments: ${argv.join(' ')}`, async () => {
      const result = await runCli(argv, [])
      expect(result.exitCode).toBe(1)
      expect(result.requests).toHaveLength(0)
    })
  }
})
