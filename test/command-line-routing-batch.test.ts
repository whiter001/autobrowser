import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

describe('cli command routing', () => {
  test('batch runs commands in sequence from file input', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-batch-'))
    const batchFile = path.join(homeDir, 'batch.json')
    await writeFile(
      batchFile,
      JSON.stringify(
        [
          { command: 'snapshot' },
          {
            command: 'goto',
            args: {
              url: 'https://example.com',
            },
          },
        ],
        null,
        2,
      ),
    )

    const result = await runCli(['batch', '--file', batchFile], undefined, {
      homeDir,
      fetchImpl: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null

        if (body?.command === 'batch') {
          return {
            ok: true,
            async json() {
              return {
                ok: true,
                result: {
                  steps: [
                    {
                      index: 1,
                      command: 'snapshot',
                      args: {},
                      label: null,
                      response: {
                        ok: true,
                        result: { snapshotId: 's1' },
                      },
                    },
                    {
                      index: 2,
                      command: 'goto',
                      args: {
                        url: 'https://example.com',
                      },
                      label: null,
                      response: {
                        ok: true,
                        result: { navigated: true },
                      },
                    },
                  ],
                },
              }
            },
          }
        }

        throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body?.command).toBe('batch')
    expect(result.fetchCalls[0].body?.args?.steps).toEqual([
      { command: 'snapshot', args: {}, label: null },
      {
        command: 'goto',
        args: {
          url: 'https://example.com',
        },
        label: null,
      },
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        steps: [
          {
            index: 1,
            command: 'snapshot',
            args: {},
            label: null,
            response: {
              ok: true,
              result: { snapshotId: 's1' },
            },
          },
          {
            index: 2,
            command: 'goto',
            args: {
              url: 'https://example.com',
            },
            label: null,
            response: {
              ok: true,
              result: { navigated: true },
            },
          },
        ],
      },
    })
  })

  test('batch rejects array args before sending requests', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-batch-args-'))
    const batchFile = path.join(homeDir, 'batch.json')
    await writeFile(
      batchFile,
      JSON.stringify([
        {
          command: 'goto',
          args: [],
        },
      ]),
    )

    const result = await runCli(['batch', '--file', batchFile], undefined, {
      homeDir,
      fetchImpl: async () => {
        throw new Error('batch should fail before making requests')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain(
      'invalid batch step 1: args must be an object',
    )
  })

  test('batch rejects invalid nested command argument types before sending requests', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-batch-schema-'))
    const batchFile = path.join(homeDir, 'batch.json')
    await writeFile(
      batchFile,
      JSON.stringify([
        {
          command: 'goto',
          args: {
            url: 123,
          },
        },
      ]),
    )

    const result = await runCli(['batch', '--file', batchFile], undefined, {
      homeDir,
      fetchImpl: async () => {
        throw new Error('batch should fail before making requests')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
  })

  test('batch stops on the first failed step and returns structured failure', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-batch-fail-'))
    const batchFile = path.join(homeDir, 'batch.json')
    await writeFile(
      batchFile,
      JSON.stringify(
        [
          { command: 'snapshot' },
          {
            command: 'goto',
            args: {
              url: 'chrome://settings',
            },
          },
        ],
        null,
        2,
      ),
    )

    const result = await runCli(['batch', '--file', batchFile], undefined, {
      homeDir,
      fetchImpl: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null

        if (body?.command === 'batch') {
          return {
            ok: true,
            async json() {
              return {
                ok: false,
                error: {
                  message: 'batch step 2 failed: goto',
                  code: 'BATCH_STEP_FAILED',
                  details: {
                    steps: [
                      {
                        index: 1,
                        command: 'snapshot',
                        args: {},
                        label: null,
                        response: {
                          ok: true,
                          result: { snapshotId: 's1' },
                        },
                      },
                      {
                        index: 2,
                        command: 'goto',
                        args: {
                          url: 'chrome://settings',
                        },
                        label: null,
                        response: {
                          ok: false,
                          error: {
                            message: 'cannot access chrome:// and edge:// urls',
                            code: 'EXTENSION_COMMAND_ERROR',
                          },
                        },
                      },
                    ],
                    failedStep: {
                      index: 2,
                      command: 'goto',
                      args: {
                        url: 'chrome://settings',
                      },
                      label: null,
                      response: {
                        ok: false,
                        error: {
                          message: 'cannot access chrome:// and edge:// urls',
                          code: 'EXTENSION_COMMAND_ERROR',
                        },
                      },
                    },
                  },
                },
              }
            },
          }
        }

        throw new Error(`unexpected request: ${String(url)} ${JSON.stringify(body)}`)
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body?.command).toBe('batch')
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'BATCH_STEP_FAILED',
      },
      result: {
        steps: [
          {
            index: 1,
            command: 'snapshot',
            response: {
              ok: true,
            },
          },
          {
            index: 2,
            command: 'goto',
            response: {
              ok: false,
              error: {
                message: 'cannot access chrome:// and edge:// urls',
              },
            },
          },
        ],
      },
    })
  })
})
