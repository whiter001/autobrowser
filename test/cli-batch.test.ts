import { describe, expect, test } from 'bun:test'
import { batchCommandRegistry } from '../src/cli/commands/batch.js'

describe('cli batch command', () => {
  test('forwards structured batch options and ambient targets', async () => {
    const requestCalls: Array<{ baseUrl: string; command: string; args: Record<string, unknown> }> = []

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
      requestCommand: async (baseUrl: string, command: string, args: Record<string, unknown> = {}) => {
        requestCalls.push({ baseUrl, command, args })
        return { ok: true, result: { ok: true } }
      },
      openConnectFlow: async () => false,
      getStatus: async () => ({}),
      resolveEvalScript: async () =>
        JSON.stringify({
          steps: [{ command: 'snapshot' }, { command: 'goto', args: { url: 'https://example.com' } }],
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
})