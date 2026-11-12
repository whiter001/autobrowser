import { describe, expect, test } from 'bun:test'
import { cliErrorPayload, runCli, type FetchResponseLike } from './command-line-test-utils.js'

const createdPayload = {
  ok: true,
  result: { tab: { id: 42, handle: 't42', url: 'about:blank' } },
}

function navigationFetchMock(
  gotoPayload: unknown = { ok: true, result: { settled: true, phase: 'settle' } },
  waitPayload: unknown = { ok: true, result: { waited: true } },
) {
  return async (_url: string, init: { body?: string } = {}): Promise<FetchResponseLike> => {
    const body = init.body ? JSON.parse(init.body) : null
    const payload =
      body?.command === 'tab.new'
        ? createdPayload
        : body?.command === 'goto'
          ? gotoPayload
          : waitPayload
    return {
      ok: true,
      async json() {
        return payload
      },
    }
  }
}

describe('tab new navigation wait options', () => {
  test('creates an attached blank tab and navigates its explicit handle only once', async () => {
    const result = await runCli(
      [
        'tab',
        'new',
        'https://example.com',
        '--wait-until',
        'domcontentloaded',
        '--timeout-ms',
        '8000',
        '--settle-timeout',
        '5000',
        '--dom-quiet-ms',
        '100',
      ],
      null,
      { fetchImpl: navigationFetchMock() },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.map((call) => call.body)).toEqual([
      { command: 'tab.new', args: { url: 'about:blank' } },
      {
        command: 'goto',
        args: {
          tabId: 't42',
          url: 'https://example.com',
          timeoutMs: 8000,
          waitUntil: 'domcontentloaded',
          settleTimeoutMs: 5000,
          domQuietMs: 100,
        },
      },
    ])
    expect(JSON.parse(result.stdout).result).toMatchObject({
      tab: { handle: 't42' },
      wait: { settled: true },
    })
  })

  test('forwards every real navigation wait mode to goto', async () => {
    for (const mode of ['commit', 'interactive', 'load', 'networkidle', 'domquiet']) {
      const result = await runCli(
        ['tab', 'new', 'https://example.com', '--wait-until', mode],
        null,
        { fetchImpl: navigationFetchMock() },
      )
      expect(result.fetchCalls.map((call) => call.body?.command)).toEqual(['tab.new', 'goto'])
      expect(result.fetchCalls[1].body?.args).toMatchObject({
        tabId: 't42',
        waitUntil: mode,
      })
    }
  })

  test('wait-until none keeps fire-and-forget creation without a second navigation', async () => {
    const result = await runCli(
      ['tab', 'new', 'https://example.com', '--wait-until', 'none'],
      createdPayload,
    )

    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body?.args).toEqual({ url: 'https://example.com' })
  })

  test('keeps the existing wait-for behavior and can combine it with navigation waiting', async () => {
    const waitForOnly = await runCli(
      ['tab', 'new', 'https://example.com', '--wait-for', 'selector', '#ready'],
      null,
      { fetchImpl: navigationFetchMock() },
    )
    expect(waitForOnly.fetchCalls.map((call) => call.body)).toEqual([
      { command: 'tab.new', args: { url: 'https://example.com' } },
      {
        command: 'wait',
        args: { tabId: 't42', type: 'selector', selector: '#ready', state: 'visible' },
      },
    ])

    const combined = await runCli(
      [
        'tab',
        'new',
        'https://example.com',
        '--wait-until',
        'load',
        '--wait-for',
        'selector',
        '#ready',
      ],
      null,
      { fetchImpl: navigationFetchMock() },
    )
    expect(combined.fetchCalls.map((call) => call.body?.command)).toEqual([
      'tab.new',
      'goto',
      'wait',
    ])
    expect(JSON.parse(combined.stdout).result).toMatchObject({
      navigation: { settled: true },
      wait: { waited: true },
    })
  })

  test('retains the created tab when navigation or the later condition fails', async () => {
    const navigationFailure = await runCli(
      ['tab', 'new', 'https://example.com', '--wait-until', 'load'],
      null,
      {
        fetchImpl: navigationFetchMock({
          ok: false,
          error: { code: 'COMMAND_TIMEOUT', message: 'navigation timed out' },
        }),
      },
    )
    expect(navigationFailure.exitCode).toBe(1)
    expect(JSON.parse(navigationFailure.stdout).result.tab).toMatchObject({ handle: 't42' })

    const conditionFailure = await runCli(
      ['tab', 'new', 'https://example.com', '--wait-for', 'selector', '#ready'],
      null,
      {
        fetchImpl: navigationFetchMock(undefined, {
          ok: false,
          error: { code: 'WAIT_TIMEOUT', message: 'selector timed out' },
        }),
      },
    )
    expect(conditionFailure.exitCode).toBe(1)
    expect(JSON.parse(conditionFailure.stdout).result.tab).toMatchObject({ handle: 't42' })
  })

  test('rejects unsupported or incomplete options before creating a tab', async () => {
    for (const args of [
      ['tab', 'new', 'https://example.com', '--wait'],
      ['tab', 'new', 'https://example.com', '--wait-until', 'bogus'],
      ['tab', 'new', 'https://example.com', '--timeout-ms', '1000'],
    ]) {
      const result = await runCli(args)
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(cliErrorPayload(result.stdout).error.message).toBeTruthy()
    }
  })
})
