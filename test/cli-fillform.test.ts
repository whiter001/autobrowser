import { describe, expect, test } from 'bun:test'
import { fillFormCommandRegistry } from '../src/cli/commands/fillform.js'
import type { CommandContext } from '../src/cli/commands/types.js'

function createContext(overrides?: {
  rawInput?: string
  requestCommand?: (
    command: string,
    args: Record<string, unknown>,
  ) => Promise<{
    ok: boolean
    result?: unknown
    error?: { message?: string }
  }>
}): {
  context: CommandContext
  requestCalls: Array<{ command: string; args: Record<string, unknown> }>
} {
  const requestCalls: Array<{ command: string; args: Record<string, unknown> }> = []
  const context = {
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
      tab: null,
      frame: null,
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
      requestCalls.push({ command, args })
      if (overrides?.requestCommand) {
        return await overrides.requestCommand(command, args)
      }
      return { ok: true, result: { results: [], succeeded: 0, failed: 0 } }
    },
    openConnectFlow: async () => false,
    getStatus: async () => ({}),
    resolveEvalScript: async () => overrides?.rawInput ?? '[]',
    getCdpUrl: async () => '',
    extractScreenshotData: () => {
      throw new Error('not used')
    },
    resolveScreenshotOutputPath: async () => '',
    collectHarFromNetwork: async () => ({}),
    writeHarFile: async () => '',
  } as unknown as CommandContext
  return { context, requestCalls }
}

describe('cli fillform command', () => {
  test('forwards a JSON array of fields', async () => {
    const { context, requestCalls } = createContext({
      rawInput: JSON.stringify([
        { selector: '#name', value: 'Ada' },
        { selector: '#age', value: '36' },
      ]),
    })

    const result = await fillFormCommandRegistry.fillform([], context)

    expect(result).toBe(0)
    expect(requestCalls).toEqual([
      {
        command: 'fillform',
        args: {
          fields: [
            { selector: '#name', value: 'Ada' },
            { selector: '#age', value: '36' },
          ],
        },
      },
    ])
  })

  test('forwards an object with a fields array', async () => {
    const { context, requestCalls } = createContext({
      rawInput: JSON.stringify({ fields: [{ selector: '#q', value: 'search' }] }),
    })

    const result = await fillFormCommandRegistry.fillform([], context)

    expect(result).toBe(0)
    expect(requestCalls).toEqual([
      { command: 'fillform', args: { fields: [{ selector: '#q', value: 'search' }] } },
    ])
  })

  test('rejects fields with a missing selector without sending a request', async () => {
    const { context, requestCalls } = createContext({
      rawInput: JSON.stringify([{ value: 'x' }]),
    })

    const result = await fillFormCommandRegistry.fillform([], context)

    expect(result).toBe(1)
    expect(requestCalls).toEqual([])
  })

  test('rejects malformed JSON without sending a request', async () => {
    const { context, requestCalls } = createContext({ rawInput: 'not json' })

    const result = await fillFormCommandRegistry.fillform([], context)

    expect(result).toBe(1)
    expect(requestCalls).toEqual([])
  })

  test('returns 1 when the extension rejects the payload', async () => {
    const { context } = createContext({
      rawInput: JSON.stringify([{ selector: '#a', value: '1' }]),
      requestCommand: async () => ({
        ok: false,
        error: {
          message: 'invalid command arguments for fillform: fields must contain 1 to 50 items',
        },
      }),
    })

    const result = await fillFormCommandRegistry.fillform([], context)

    expect(result).toBe(1)
  })
})
