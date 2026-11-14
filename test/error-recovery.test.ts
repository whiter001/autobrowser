import { describe, expect, test } from 'bun:test'
import { buildCliErrorPayload } from '../src/cli/cli-error.js'
import { HlsDownloadError } from '../src/cli/hls-error.js'
import { toErrorResult } from '../src/cli/mcp-response.js'
import { createToolError } from '../src/core/tool-error.js'
import { createSemanticFindFeature } from '../extension/background/page-observe-find.js'
import { computeSearchPageTextMatches } from '../extension/background/page-observe-search.js'
import { createExtensionState } from '../extension/background/state.js'
import { serializeCommandError } from '../extension/background/errors.js'
import { runCli } from './command-line-test-utils.js'

describe('error recovery contract', () => {
  test('derives retryability and repair guidance from the central error table', () => {
    const timeout = createToolError('COMMAND_TIMEOUT', 'command timed out')
    expect(timeout).toMatchObject({
      code: 'COMMAND_TIMEOUT',
      retryable: true,
      suggestedAction: expect.stringContaining('command list'),
    })

    const unknown = createToolError('COMMAND_EXECUTION_UNKNOWN', 'connection lost after dispatch')
    expect(unknown.retryable).toBe(false)
    expect(unknown.suggestedAction).toContain('never replay')
    expect(serializeCommandError(unknown)).toMatchObject({
      code: 'COMMAND_EXECUTION_UNKNOWN',
      retryable: false,
    })
    expect(serializeCommandError(timeout)).toMatchObject({
      code: 'COMMAND_TIMEOUT',
      retryable: true,
    })

    const cli = buildCliErrorPayload(timeout, { command: 'eval' })
    expect(cli.error).toMatchObject({ code: 'COMMAND_TIMEOUT', retryable: true })

    const hls = buildCliErrorPayload(
      new HlsDownloadError('ffmpeg 执行失败（退出码 254）', 'Error opening local segment'),
      { command: 'download' },
    )
    expect(hls.error.details).toMatchObject({
      command: 'download',
      detail: 'Error opening local segment',
    })

    const mcp = toErrorResult(
      'WAIT_NOT_CONFIRMED',
      'selector is not visible',
      {},
      {
        responseMode: 'both',
      },
    )
    expect(mcp.structuredContent).toMatchObject({
      error: {
        code: 'WAIT_NOT_CONFIRMED',
        retryable: true,
        suggestedAction: expect.stringContaining('longer timeout'),
      },
    })
  })

  test('distinguishes find locate no-match from action target failure', async () => {
    const createFind = () =>
      createSemanticFindFeature({
        state: createExtensionState(57978),
        getTargetTab: async () => ({ id: 1 }) as never,
        evaluateInTabContext: async () => ({
          value: { found: false, reason: 'no text match found: absent' },
        }),
      } as never)
    const options = {
      strategy: 'text',
      role: '',
      query: 'absent',
      name: '',
      exact: false,
    }

    await expect(
      createFind().findSemanticTarget(1, { ...options, allowNoMatch: true }, null),
    ).resolves.toMatchObject({
      found: false,
      empty: true,
      emptyReason: 'NO_MATCH',
    })
    await expect(createFind().findSemanticTarget(1, options, null)).rejects.toMatchObject({
      code: 'ELEMENT_NOT_FOUND',
      retryable: true,
      suggestedAction: expect.stringContaining('selected frame'),
    })
  })

  test('reports position range and keeps empty CLI queries successful', async () => {
    const find = createSemanticFindFeature({
      state: createExtensionState(57978),
      getTargetTab: async () => ({ id: 1 }) as never,
      evaluateInTabContext: async () => ({
        value: {
          found: false,
          code: 'INVALID_COMMAND_ARGS',
          reason: 'nth position out of range',
          details: { field: 'position', expected: 'nth=1..nth=2', received: 'nth=3' },
        },
      }),
    } as never)

    await expect(
      find.findSemanticTarget(
        1,
        {
          strategy: 'text',
          role: '',
          query: 'item',
          name: '',
          exact: false,
          position: 'nth=3',
          allowNoMatch: true,
        },
        null,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_COMMAND_ARGS',
      details: { field: 'position', expected: 'nth=1..nth=2' },
    })

    const empty = await runCli(['find', 'text', 'absent'], {
      ok: true,
      result: { found: false, empty: true, emptyReason: 'NO_MATCH' },
    })
    expect(empty.exitCode).toBe(0)

    const failure = await runCli(['find', 'text', 'absent', 'click'], {
      ok: false,
      error: { code: 'ELEMENT_NOT_FOUND', message: 'no text match found: absent' },
    })
    expect(failure.exitCode).toBe(1)
  })
})

describe('empty search results', () => {
  test('distinguishes no match from an empty document', () => {
    expect(
      computeSearchPageTextMatches('Alpha', 'missing', 'missing', 'i', 0, 10, 240, 'complete'),
    ).toMatchObject({ empty: true, emptyReason: 'NO_MATCH', totalMatches: 0 })
    expect(
      computeSearchPageTextMatches('', 'missing', 'missing', 'i', 0, 10, 240, 'complete'),
    ).toMatchObject({ empty: true, emptyReason: 'NO_DATA', totalMatches: 0 })
  })
})
