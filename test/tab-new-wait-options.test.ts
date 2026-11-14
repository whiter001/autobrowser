import { describe, expect, test } from 'bun:test'
import { cliErrorPayload, runCli, type FetchResponseLike } from './command-line-test-utils.js'

const createdPayload = {
  ok: true,
  result: { tab: { id: 42, handle: 't42', url: 'about:blank', status: 'loading' } },
}

// 导航/等待后的真实摘要：URL 已不是创建时的 about:blank。
const listedPayload = {
  ok: true,
  result: {
    tabs: [
      {
        id: 42,
        handle: 't42',
        title: 'Example Domain',
        url: 'https://example.com/',
        active: true,
        pinned: false,
        status: 'complete',
        windowId: 1,
      },
    ],
  },
}

const gotoMeta = {
  tabHandle: 't42',
  tabId: 42,
  frame: null,
  pageEpoch: 2,
  url: 'https://example.com/',
  title: 'Example Domain',
}

const waitMeta = { ...gotoMeta, pageEpoch: 3, url: 'https://example.com/#ready' }

function navigationFetchMock(
  gotoPayload: unknown = { ok: true, result: { settled: true, phase: 'settle', meta: gotoMeta } },
  waitPayload: unknown = { ok: true, result: { waited: true, meta: waitMeta } },
  tabListPayload: unknown = listedPayload,
) {
  return async (_url: string, init: { body?: string } = {}): Promise<FetchResponseLike> => {
    const body = init.body ? JSON.parse(init.body) : null
    const payload =
      body?.command === 'tab.new'
        ? createdPayload
        : body?.command === 'goto'
          ? gotoPayload
          : body?.command === 'tab.list'
            ? tabListPayload
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
      { command: 'tab.list', args: { limit: 200 } },
    ])
    expect(JSON.parse(result.stdout).result).toMatchObject({
      tab: { handle: 't42' },
      wait: { settled: true },
    })
  })

  test('refreshes the created tab from tab.list after navigation-only success', async () => {
    const result = await runCli(
      ['tab', 'new', 'https://example.com', '--wait-until', 'load'],
      null,
      { fetchImpl: navigationFetchMock() },
    )

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    // 创建时的 about:blank 摘要必须被最新 tab 摘要替换，meta 来自最后一次成功响应（goto）。
    expect(output.result.tab).toEqual(listedPayload.result.tabs[0])
    expect(output.result.meta).toEqual(gotoMeta)
    expect(output.result.tab.url).not.toBe('about:blank')
  })

  test('refreshes the created tab and copies meta from the successful wait', async () => {
    const result = await runCli(
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

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.map((call) => call.body?.command)).toEqual([
      'tab.new',
      'goto',
      'wait',
      'tab.list',
    ])
    const output = JSON.parse(result.stdout)
    expect(output.result.tab).toEqual(listedPayload.result.tabs[0])
    // 最后一次成功响应是 wait，而不是更早的 goto
    expect(output.result.meta).toEqual(waitMeta)
  })

  test('forwards every real navigation wait mode to goto', async () => {
    for (const mode of ['commit', 'interactive', 'load', 'networkidle', 'domquiet']) {
      const result = await runCli(
        ['tab', 'new', 'https://example.com', '--wait-until', mode],
        null,
        { fetchImpl: navigationFetchMock() },
      )
      expect(result.fetchCalls.map((call) => call.body?.command)).toEqual([
        'tab.new',
        'goto',
        'tab.list',
      ])
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
      { command: 'tab.list', args: { limit: 200 } },
    ])
    expect(JSON.parse(waitForOnly.stdout).result.tab).toEqual(listedPayload.result.tabs[0])

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
      'tab.list',
    ])
    expect(JSON.parse(combined.stdout).result).toMatchObject({
      navigation: { settled: true },
      wait: { waited: true },
    })
  })

  test('falls back to meta url/title when the tab summary refresh fails', async () => {
    for (const tabListPayload of [
      { ok: false, error: { code: 'COMMAND_TIMEOUT', message: 'tab list timed out' } },
      { ok: true, result: { tabs: [] } },
      { ok: true, result: { tabs: [{ id: 7, handle: 't7', url: 'https://other.example/' }] } },
    ]) {
      const result = await runCli(
        ['tab', 'new', 'https://example.com', '--wait-for', 'selector', '#ready'],
        null,
        { fetchImpl: navigationFetchMock(undefined, undefined, tabListPayload) },
      )

      // 摘要刷新只是补充信息：失败或找不到该 tab 不能把已成功的等待改成失败。
      expect(result.exitCode).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.ok).toBe(true)
      expect(output.result.tab).toMatchObject({
        handle: 't42',
        url: waitMeta.url,
        title: waitMeta.title,
        // 保留创建时的状态，不伪造 complete
        status: 'loading',
      })
      expect(output.result.meta).toEqual(waitMeta)
    }
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
    expect(navigationFailure.fetchCalls.map((call) => call.body?.command)).toEqual([
      'tab.new',
      'goto',
    ])
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
    // 失败路径不做摘要刷新
    expect(conditionFailure.fetchCalls.map((call) => call.body?.command)).toEqual([
      'tab.new',
      'wait',
    ])
    expect(JSON.parse(conditionFailure.stdout).result.tab).toEqual(createdPayload.result.tab)
  })

  test('accepts --timeout as the alias of --timeout-ms for tab new', async () => {
    const result = await runCli(
      [
        'tab',
        'new',
        'https://example.com',
        '--wait-until',
        'load',
        '--wait-for',
        'selector',
        '#ready',
        '--timeout',
        '7000',
      ],
      null,
      { fetchImpl: navigationFetchMock() },
    )

    expect(result.exitCode).toBe(0)
    // 发往 relay 的字段仍是 timeoutMs，别名只影响 CLI 解析
    expect(result.fetchCalls[1].body?.args).toMatchObject({ timeoutMs: 7000 })
    expect(result.fetchCalls[2].body).toEqual({
      command: 'wait',
      args: { tabId: 't42', type: 'selector', selector: '#ready', state: 'visible', timeout: 7000 },
    })
  })

  test('rejects a tab new timeout alias without any wait option', async () => {
    const result = await runCli(['tab', 'new', 'https://example.com', '--timeout', '1000'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain('requires a wait option')
  })

  test('rejects duplicate timeout names for tab new before creating a tab', async () => {
    for (const timeoutArgs of [
      // 跨名字重复
      ['--timeout-ms', '1000', '--timeout', '2000'],
      // 同名重复
      ['--timeout-ms', '1000', '--timeout-ms', '2000'],
      ['--timeout', '1000', '--timeout', '2000'],
    ]) {
      const result = await runCli([
        'tab',
        'new',
        'https://example.com',
        '--wait-for',
        'selector',
        '#ready',
        ...timeoutArgs,
      ])

      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      const error = cliErrorPayload(result.stdout).error
      expect(error.code).toBe('CLI_INVALID_ARGUMENT')
      expect(error.message).toContain('duplicate')
    }
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
