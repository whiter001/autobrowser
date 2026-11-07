import { describe, expect, test } from 'bun:test'
import { runCli } from './command-line-test-utils.js'

describe('cli network/session command forwarding', () => {
  test('routes network route list to the extension', async () => {
    const result = await runCli(['network', 'route', 'list'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: { action: 'route', subaction: 'list' },
    })
  })

  test('forwards network route mock options to the extension', async () => {
    const result = await runCli([
      'network',
      'route',
      '**/api/*',
      '--status',
      '503',
      '--header',
      'X-Mock: yes',
      '--remove-headers',
      'authorization,x-debug',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'route',
        url: '**/api/*',
        abort: false,
        status: 503,
        headers: { 'X-Mock': 'yes' },
        removeHeaders: ['authorization', 'x-debug'],
      },
    })
  })

  test('forwards cookies get filters and delete to the extension', async () => {
    const filtered = await runCli(['cookies', 'get', '--domain', 'example.com', '--path', '/'])
    expect(filtered.fetchCalls[0].body).toEqual({
      command: 'cookies',
      args: { action: 'get', domain: 'example.com', path: '/' },
    })

    const listed = await runCli(['cookies', 'list', '--domain', 'example.com'])
    expect(listed.fetchCalls[0].body).toEqual({
      command: 'cookies',
      args: { action: 'get', domain: 'example.com' },
    })

    const deleted = await runCli(['cookies', 'delete', 'sid'])
    expect(deleted.fetchCalls[0].body).toEqual({
      command: 'cookies',
      args: { action: 'delete', name: 'sid' },
    })
  })

  test('forwards storage session flag and delete to the extension', async () => {
    const deleted = await runCli(['storage', 'delete', '--session', 'draft'])
    expect(deleted.fetchCalls[0].body).toEqual({
      command: 'storage',
      args: { action: 'delete', key: 'draft', session: true },
    })

    const listed = await runCli(['storage', 'get', '--session'])
    expect(listed.fetchCalls[0].body).toEqual({
      command: 'storage',
      args: { action: 'get', session: true },
    })
  })

  test('forwards set permission/ua/timezone/locale to the extension', async () => {
    const granted = await runCli(['set', 'permission', 'geolocation'])
    expect(granted.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'permission', name: 'geolocation' },
    })

    const resetPermission = await runCli(['set', 'permission', 'geolocation', '--reset'])
    expect(resetPermission.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'permission', name: 'geolocation', reset: true },
    })

    const ua = await runCli(['set', 'ua', 'My Agent 1.0'])
    expect(ua.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'ua', value: 'My Agent 1.0' },
    })

    const resetUa = await runCli(['set', 'ua', '--reset'])
    expect(resetUa.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'ua', value: '' },
    })

    const timezone = await runCli(['set', 'timezone', 'Asia/Shanghai'])
    expect(timezone.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'timezone', value: 'Asia/Shanghai' },
    })

    const locale = await runCli(['set', 'locale', 'zh-CN'])
    expect(locale.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'locale', value: 'zh-CN' },
    })
  })

  test('forwards console level filtering to the paginated extension query', async () => {
    const payload = {
      ok: true,
      result: {
        messages: [
          { type: 'error', text: 'e', timestamp: 1 },
          { type: 'warning', text: 'w', timestamp: 2 },
        ],
        pagination: { currentPage: 0, totalPages: 2, hasNextPage: true },
      },
    }

    const filtered = await runCli(['console', '--level', 'warning', '--page-size', '1'], payload)
    expect(filtered.exitCode).toBe(0)
    expect(filtered.fetchCalls[0].body).toEqual({
      command: 'console',
      args: { action: 'list', level: 'warning', pageSize: 1 },
    })
    const filteredOutput = JSON.parse(filtered.stdout)
    expect(filteredOutput.result.messages.map((message: { type: string }) => message.type)).toEqual(
      ['error', 'warning'],
    )
    expect(filteredOutput.result.pagination).toEqual({ hasMore: true })

    const unfiltered = await runCli(['console'], payload)
    expect(unfiltered.fetchCalls[0].body?.args).not.toHaveProperty('level')
  })
})
