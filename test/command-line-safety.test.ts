import { describe, expect, test } from 'bun:test'
import { originalFetch, runCli } from './command-line-test-utils.js'

describe('command safety regressions', () => {
  for (const { argv, command, args, error } of [
    {
      argv: ['cookies', 'set', 'name'],
      command: 'cookies',
      args: { action: 'set', name: 'name' },
      error: 'missing value for cookies set',
    },
    {
      argv: ['storage', 'set', 'key'],
      command: 'storage',
      args: { action: 'set', key: 'key' },
      error: 'missing value for storage set',
    },
    {
      argv: ['storage', 'set', '--session', 'key'],
      command: 'storage',
      args: { action: 'set', key: 'key', session: true },
      error: 'missing value for storage set',
    },
    {
      argv: ['clipboard', 'write'],
      command: 'clipboard',
      args: { action: 'write' },
      error: 'missing text for clipboard write',
    },
  ]) {
    test(`${argv.join(' ')} rejects omission but accepts explicit empty content`, async () => {
      const missing = await runCli(argv)
      expect(missing.exitCode).toBe(1)
      expect(missing.fetchCalls).toHaveLength(0)
      expect(missing.stderr).toContain(error)
      for (const value of ['', '   ']) {
        const explicit = await runCli([...argv, value])
        expect(explicit.exitCode).toBe(0)
        expect(explicit.fetchCalls).toHaveLength(1)
        expect(explicit.fetchCalls[0].body).toEqual({
          command,
          args: { ...args, [command === 'clipboard' ? 'text' : 'value']: value },
        })
      }
    })
  }

  test('state write commands preserve explicit help without fetching', async () => {
    for (const argv of [
      ['cookies', 'set'],
      ['storage', 'set'],
      ['clipboard', 'write'],
    ]) {
      for (const help of ['-h', '--help']) {
        for (const prefix of [argv.slice(0, 1), argv]) {
          const result = await runCli([...prefix, help])
          expect(result.exitCode).toBe(0)
          expect(result.fetchCalls).toHaveLength(0)
          expect(result.stdout).toContain(argv[0])
          expect(result.stderr).toBe('')
        }
      }
    }
  })

  test('rejects missing input tokens before any fetch but preserves selector help', async () => {
    for (const argv of [
      ['fill', '#field'],
      ['type', '#field'],
      ['type', '#field', '--submit'],
      ...['type', 'inserttext', 'keydown', 'keyup'].map((action) => ['keyboard', action]),
      ...['keydown', 'keyup'].flatMap((action) =>
        ['', '   '].map((value) => ['keyboard', action, value]),
      ),
    ]) {
      const result = await runCli(argv)
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
    }
    for (const command of ['fill', 'type']) {
      const result = await runCli([command, '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls).toHaveLength(0)
      expect(result.stdout).toContain(command)
    }
  })

  test('forwards explicit empty and whitespace content without confusing it with omission', async () => {
    for (const value of ['', '   ']) {
      for (const command of ['fill', 'type']) {
        const result = await runCli([
          command,
          '#field',
          value,
          ...(command === 'type' ? ['--submit'] : []),
        ])
        expect(result.exitCode).toBe(0)
        expect(result.fetchCalls).toHaveLength(1)
        expect(result.fetchCalls[0].body).toEqual({
          command,
          args: { selector: '#field', value, ...(command === 'type' ? { submit: true } : {}) },
        })
      }
      for (const action of ['type', 'inserttext']) {
        const result = await runCli(['keyboard', action, value])
        expect(result.exitCode).toBe(0)
        expect(result.fetchCalls[0].body).toEqual({
          command: 'keyboard',
          args: { action, text: value },
        })
      }
    }
    for (const action of ['keydown', 'keyup']) {
      const result = await runCli(['keyboard', action, 'Enter'])
      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls[0].body?.args).toEqual({ action, text: 'Enter' })
    }
  })

  test('never replays response decoding or reading failures, even with connection words', async () => {
    for (const response of [
      () => new Response('ENOTFOUND'),
      () => new Response('{"ok":true,"result":'),
      () => new Response('ECONNREFUSED', { status: 503 }),
      () => ({
        async json() {
          throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
        },
      }),
    ]) {
      const result = await runCli(['fill', '#field', 'hello'], undefined, {
        fetchImpl: async () => response(),
        spawnDetachedProcess: () => {
          throw new Error('must not spawn')
        },
      })
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(1)
      expect(result.spawnCalls).toHaveLength(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'COMMAND_EXECUTION_UNKNOWN', details: { command: 'fill' } },
      })
    }
  })

  test('preserves valid HTTP error payloads containing connection words', async () => {
    const payload = {
      ok: false,
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'ENOTFOUND ECONNREFUSED',
        details: { source: 'page' },
      },
    }
    const result = await runCli(['fill', '#field', 'hello'], undefined, {
      fetchImpl: async () => Response.json(payload, { status: 502 }),
    })
    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toEqual(payload)
  })

  test('reset evidence wins over refusal text or codes', async () => {
    for (const error of [
      new Error('ENOTFOUND read ECONNRESET'),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNREFUSED' }),
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNRESET' }),
      }),
    ]) {
      const result = await runCli(['fill', '#field', 'hello'], undefined, {
        fetchImpl: async () => {
          throw error
        },
      })
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(1)
      expect(JSON.parse(result.stdout).error.code).toBe('COMMAND_EXECUTION_UNKNOWN')
    }
  })

  test('never recovers or replays ambiguous fetch failures after a command takes effect', async () => {
    for (const error of [
      ...[
        'ECONNREFUSED',
        'connection refused',
        'Unable to connect. Is the computer able to access the url?',
        'ENOTFOUND',
        'getaddrinfo',
        'EHOSTUNREACH',
        'fetch failed',
        'failed to fetch',
        'network error',
        'status unavailable',
      ].map((message) => new Error(message)),
      new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }),
      ...['EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].map((code) =>
        Object.assign(new Error('Unable to connect'), { code }),
      ),
      ...['ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].flatMap((code) => [
        Object.assign(new Error('connect failed'), {
          code: 'ECONNREFUSED',
          cause: Object.assign(new Error('connect failed'), { code }),
        }),
        Object.assign(new Error('connect failed'), {
          code,
          cause: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
        }),
      ]),
    ]) {
      const appliedCommands: unknown[] = []
      const result = await runCli(['fill', '#field', 'hello'], undefined, {
        fetchImpl: async (url, init) => {
          if (String(url).endsWith('/status')) {
            return Response.json({
              extensionConnected: true,
              token: 'live-token',
              relayPort: 57978,
              ipcPort: 57979,
            })
          }
          // 模拟命令已生效，随后 fetch 才报告连接错误。
          appliedCommands.push(JSON.parse(String(init.body)))
          throw error
        },
        spawnDetachedProcess: () => ({ pid: 12345, unref() {} }),
        openUrl: async () => {},
      })
      expect(result.exitCode).toBe(1)
      expect(appliedCommands).toEqual([
        { command: 'fill', args: { selector: '#field', value: 'hello' } },
      ])
      expect(result.fetchCalls.map((call) => String(call.url))).toEqual([
        'http://127.0.0.1:57979/command',
      ])
      expect(result.spawnCalls).toHaveLength(0)
      expect(result.openCalls).toHaveLength(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'COMMAND_EXECUTION_UNKNOWN',
          details: { command: 'fill', originalMessage: error.message },
        },
      })
    }
  })

  test('recovers actual fetch refusal and refusal causes behind generic fetch errors', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('unused'),
    })
    const url = `http://127.0.0.1:${server.port}/command`
    await server.stop(true)
    let refusal: Error | undefined
    try {
      await originalFetch(url, { method: 'POST' })
    } catch (error) {
      refusal = error instanceof Error ? error : new Error(String(error))
    }
    expect(refusal).toBeDefined()
    if (!refusal) {
      throw new Error('expected the closed port to reject the fetch')
    }
    for (const error of [
      refusal,
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
      }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      new TypeError('fetch failed', {
        cause: new Error('Unable to connect', {
          cause: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
        }),
      }),
    ]) {
      let commands = 0
      const result = await runCli(['fill', '#field', 'hello'], undefined, {
        fetchImpl: async (url) => {
          if (String(url).endsWith('/status')) {
            return Response.json({
              extensionConnected: true,
              token: 'live-token',
              relayPort: 57978,
              ipcPort: 57979,
            })
          }
          if (++commands === 1) throw error
          return Response.json({ ok: true, result: { filled: true } })
        },
      })
      expect(result.exitCode).toBe(0)
      expect(commands).toBe(2)
      expect(JSON.parse(result.stdout).result).toEqual({ filled: true })
    }
  })
})
