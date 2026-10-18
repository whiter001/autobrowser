import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { main } from '../src/cli.js'
import { batchCommandRegistry } from '../src/cli/commands/batch.js'
import { MAX_BATCH_DEPTH } from '../src/core/command-budget.js'
import { validateCommandArgs } from '../src/core/command-spec.js'

function isBatchStep(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { command?: unknown }).command === 'batch'
  )
}

describe('cli batch command', () => {
  for (const args of [null, [], undefined, {}]) {
    test(`validates nested snapshot args ${JSON.stringify(args)} through CLI main before dispatch`, async () => {
      const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-cli-batch-'))
      const previousHome = process.env.AUTOBROWSER_HOME
      const stdout: string[] = []
      const requests: unknown[] = []
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true, result: { ok: true } })
      }) as typeof fetch)
      const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout.push(String(chunk))
        return true
      })
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
      process.env.AUTOBROWSER_HOME = homeDir

      const metadata = {
        id: 'nested-snapshot',
        label: 'baseline',
        when: { step: 1, truthy: true },
        skipRemainingOnFailure: true,
      }
      try {
        const exitCode = await main([
          '--json',
          '--server',
          'http://127.0.0.1:3000',
          '--tab',
          't2',
          '--frame',
          '@f1',
          'batch',
          JSON.stringify([
            {
              command: 'batch',
              args: {
                steps: ['snapshot', { command: ' snapshot ', args, ...metadata }],
              },
            },
          ]),
        ])

        if (args === null || Array.isArray(args)) {
          expect(exitCode).toBe(1)
          const payload = JSON.parse(stdout.join(''))
          expect(payload.ok).toBe(false)
          expect(payload.error.code).toBe('INVALID_COMMAND_ARGS')
          expect(payload.error.message).toContain('args must be an object')
          expect(fetchSpy).not.toHaveBeenCalled()
          expect(requests).toHaveLength(0)
        } else {
          expect(exitCode).toBe(0)
          expect(requests).toEqual([
            {
              command: 'batch',
              args: {
                steps: [
                  {
                    command: 'batch',
                    label: null,
                    args: {
                      steps: [
                        {
                          command: 'snapshot',
                          args: { tabId: 't2', frame: '@f1' },
                          label: null,
                        },
                        {
                          command: 'snapshot',
                          args: { tabId: 't2', frame: '@f1' },
                          ...metadata,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ])
        }
      } finally {
        fetchSpy.mockRestore()
        stdoutSpy.mockRestore()
        stderrSpy.mockRestore()
        if (previousHome === undefined) {
          delete process.env.AUTOBROWSER_HOME
        } else {
          process.env.AUTOBROWSER_HOME = previousHome
        }
        await rm(homeDir, { recursive: true, force: true })
      }
    })
  }

  test('forwards structured batch options and ambient targets', async () => {
    const requestCalls: Array<{ baseUrl: string; command: string; args: Record<string, unknown> }> =
      []

    const result = await batchCommandRegistry.batch([], {
      flags: {
        json: false,
        server: 'http://127.0.0.1:3000',
        relayPort: 3000,
        ipcPort: 3001,
        extensionId: null,
        autoConnect: false,
        browserCommand: null,
        browserArgs: [],
        stdin: false,
        file: null,
        base64: false,
        tab: 't2',
        frame: '@f1',
      },
      homeDir: '/tmp/autobrowser',
      dependencies: {},
      writeHelp: () => 0,
      writeResult: () => undefined,
      requestCommand: async (
        baseUrl: string,
        command: string,
        args: Record<string, unknown> = {},
      ) => {
        requestCalls.push({ baseUrl, command, args })
        return { ok: true, result: { ok: true } }
      },
      openConnectFlow: async () => false,
      getStatus: async () => ({}),
      resolveEvalScript: async () =>
        JSON.stringify({
          steps: [
            { command: 'snapshot' },
            { command: 'goto', args: { url: 'https://example.com' } },
          ],
          continueOnError: true,
          retries: 2,
          retryDelayMs: 25,
        }),
      getCdpUrl: async () => '',
      extractScreenshotData: () => {
        throw new Error('not used')
      },
      resolveScreenshotOutputPath: async () => '',
      collectHarFromNetwork: async () => ({}),
      writeHarFile: async () => '',
    } as never)

    expect(result).toBe(0)
    expect(requestCalls).toEqual([
      {
        baseUrl: 'http://127.0.0.1:3000',
        command: 'batch',
        args: {
          steps: [
            {
              command: 'snapshot',
              args: {
                tabId: 't2',
                frame: '@f1',
              },
              label: null,
            },
            {
              command: 'goto',
              args: {
                url: 'https://example.com',
                tabId: 't2',
              },
              label: null,
            },
          ],
          continueOnError: true,
          retries: 2,
          retryDelayMs: 25,
        },
      },
    ])
  })

  test('normalizes nested batch steps and never overrides explicit targets', async () => {
    const requestCalls: Array<Record<string, unknown>> = []
    const deepSteps = (depth: number): unknown =>
      depth >= 20 ? ['snapshot'] : [{ command: 'batch', args: { steps: deepSteps(depth + 1) } }]

    const result = await batchCommandRegistry.batch([], {
      flags: {
        json: false,
        server: 'http://127.0.0.1:3000',
        relayPort: 3000,
        ipcPort: 3001,
        extensionId: null,
        autoConnect: false,
        browserCommand: null,
        browserArgs: [],
        stdin: false,
        file: null,
        base64: false,
        tab: 't2',
        frame: '@f1',
      },
      homeDir: '/tmp/autobrowser',
      dependencies: {},
      writeHelp: () => 0,
      writeResult: () => undefined,
      requestCommand: async (
        _baseUrl: string,
        _command: string,
        args: Record<string, unknown> = {},
      ) => {
        requestCalls.push(args)
        return { ok: true, result: { ok: true } }
      },
      openConnectFlow: async () => false,
      getStatus: async () => ({}),
      resolveEvalScript: async () =>
        JSON.stringify([
          {
            command: 'batch',
            label: 'nested',
            args: {
              steps: [
                { command: 'click', args: { selector: '#a' } },
                { command: 'goto', args: { url: 'https://a.example', tabId: 't9' } },
                { command: 'click', args: { selector: '#b', handle: 'h7' } },
                { command: 'click', args: { selector: '#c', frame: '@f9' } },
                'snapshot',
                ' click ',
              ],
            },
          },
          { command: 'batch', label: 'deep', args: { steps: deepSteps(0) } },
        ]),
      getCdpUrl: async () => '',
      extractScreenshotData: () => {
        throw new Error('not used')
      },
      resolveScreenshotOutputPath: async () => '',
      collectHarFromNetwork: async () => ({}),
      writeHarFile: async () => '',
    } as never)

    expect(result).toBe(0)
    expect(requestCalls).toHaveLength(1)
    const steps = (requestCalls[0]?.steps ?? []) as Array<Record<string, any>>
    const nested = steps[0]!.args.steps as Array<Record<string, any>>
    expect(nested[0].args).toEqual({ selector: '#a', tabId: 't2', frame: '@f1' })
    expect(nested[1].args).toEqual({ url: 'https://a.example', tabId: 't9' })
    // 显式 handle 优先，全局 --tab 不能覆盖
    expect(nested[2].args).toEqual({ selector: '#b', handle: 'h7', frame: '@f1' })
    expect(nested[3].args).toEqual({ selector: '#c', tabId: 't2', frame: '@f9' })
    // 嵌套的字符串步骤同样要注入全局目标
    expect(nested[4]).toEqual({
      command: 'snapshot',
      args: { tabId: 't2', frame: '@f1' },
      label: null,
    })
    expect(nested[5]).toEqual({
      command: 'click',
      args: { tabId: 't2', frame: '@f1' },
      label: null,
    })

    // 超过深度上限的结构不再注入全局目标，交给 requestCommand 的参数校验报错
    const deep = steps[1]!.args.steps as unknown[]
    let cursor: unknown = deep
    let expanded = 0
    while (Array.isArray(cursor) && isBatchStep(cursor[0])) {
      expanded += 1
      cursor = (cursor[0] as { args: { steps: unknown } }).args.steps
    }
    expect(expanded).toBeGreaterThan(MAX_BATCH_DEPTH)
    // 未被展开的深层结构保持原样（仍是未归一化的字符串步骤），不会无限递归
    expect(cursor).toEqual(['snapshot'])
  })

  test('keeps nested step metadata and passes nested batches through the real validator', async () => {
    const requestCalls: Array<Record<string, unknown>> = []

    const result = await batchCommandRegistry.batch([], {
      flags: {
        json: false,
        server: 'http://127.0.0.1:3000',
        relayPort: 3000,
        ipcPort: 3001,
        extensionId: null,
        autoConnect: false,
        browserCommand: null,
        browserArgs: [],
        stdin: false,
        file: null,
        base64: false,
        tab: 't2',
        frame: '@f1',
      },
      homeDir: '/tmp/autobrowser',
      dependencies: {},
      writeHelp: () => 0,
      writeResult: () => undefined,
      requestCommand: async (
        baseUrl: string,
        command: string,
        args: Record<string, unknown> = {},
      ) => {
        requestCalls.push(args)
        // 真实请求也要能被 relay 侧参数校验接受
        validateCommandArgs(command, args)
        return { ok: true, result: { ok: true } }
      },
      openConnectFlow: async () => false,
      getStatus: async () => ({}),
      resolveEvalScript: async () =>
        JSON.stringify([
          {
            command: ' batch ',
            label: 'outer',
            args: {
              steps: [
                {
                  command: ' snapshot ',
                  id: 'first',
                  label: 'baseline',
                  args: { selector: '#main' },
                },
                {
                  command: 'fillform',
                  id: 'typed',
                  skipRemainingOnFailure: true,
                  when: { step: 'first', path: 'result.length', truthy: true },
                  args: { fields: [{ selector: '#a', value: 'x' }] },
                },
                {
                  command: 'click',
                  when: { step: 1, equals: { ok: true } },
                  args: { selector: '#submit' },
                },
              ],
            },
          },
        ]),
      getCdpUrl: async () => '',
      extractScreenshotData: () => {
        throw new Error('not used')
      },
      resolveScreenshotOutputPath: async () => '',
      collectHarFromNetwork: async () => ({}),
      writeHarFile: async () => '',
    } as never)

    expect(result).toBe(0)
    const steps = (requestCalls[0]?.steps ?? []) as Array<Record<string, any>>
    const nested = steps[0]!.args.steps as Array<Record<string, any>>
    // 归一化不能吃掉嵌套步骤的元数据，否则 when 条件与剩余步骤跳过语义会失效
    expect(nested[0]).toEqual({
      command: 'snapshot',
      id: 'first',
      label: 'baseline',
      args: { selector: '#main', tabId: 't2', frame: '@f1' },
    })
    expect(nested[1]).toEqual({
      command: 'fillform',
      id: 'typed',
      skipRemainingOnFailure: true,
      when: { step: 'first', path: 'result.length', truthy: true },
      args: { fields: [{ selector: '#a', value: 'x' }], tabId: 't2', frame: '@f1' },
    })
    expect(nested[2]).toEqual({
      command: 'click',
      when: { step: 1, equals: { ok: true } },
      args: { selector: '#submit', tabId: 't2', frame: '@f1' },
    })
  })

  test('surfaces invalid nested args instead of rewriting them as empty args', async () => {
    const validationErrors: string[] = []

    const result = await batchCommandRegistry.batch([], {
      flags: {
        json: false,
        server: 'http://127.0.0.1:3000',
        relayPort: 3000,
        ipcPort: 3001,
        extensionId: null,
        autoConnect: false,
        browserCommand: null,
        browserArgs: [],
        stdin: false,
        file: null,
        base64: false,
        tab: 't2',
        frame: null,
      },
      homeDir: '/tmp/autobrowser',
      dependencies: {},
      writeHelp: () => 0,
      writeResult: () => undefined,
      requestCommand: async (
        _baseUrl: string,
        command: string,
        args: Record<string, unknown> = {},
      ) => {
        try {
          validateCommandArgs(command, args)
        } catch (error) {
          validationErrors.push(error instanceof Error ? error.message : String(error))
        }
        return {
          ok: false,
          error: { message: 'invalid command arguments', code: 'INVALID_COMMAND_ARGS' },
        }
      },
      openConnectFlow: async () => false,
      getStatus: async () => ({}),
      resolveEvalScript: async () =>
        JSON.stringify([
          { command: 'batch', args: { steps: [{ command: 'click', args: 'oops' }] } },
        ]),
      getCdpUrl: async () => '',
      extractScreenshotData: () => {
        throw new Error('not used')
      },
      resolveScreenshotOutputPath: async () => '',
      collectHarFromNetwork: async () => ({}),
      writeHarFile: async () => '',
    } as never)

    expect(result).toBe(1)
    expect(validationErrors.join('\n')).toContain('args must be an object')
  })
})
