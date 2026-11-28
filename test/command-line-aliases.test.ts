import { describe, expect, test } from 'bun:test'
import { runCli } from './command-line-test-utils.js'

/**
 * 命令别名与默认子命令的等价性：别名不是 help 文案层面的装饰，
 * 必须让同一份参数产生完全相同的扩展请求。
 */
describe('cli command aliases', () => {
  const TAB_LIST_OPTIONS = [
    '--active',
    '--current-window',
    '--filter',
    'Sign',
    '--page',
    '1',
    '--page-size',
    '5',
  ]

  test('tabs list 与 tab list 发送完全相同的请求', async () => {
    const tab = await runCli(['tab', 'list', ...TAB_LIST_OPTIONS])
    const tabs = await runCli(['tabs', 'list', ...TAB_LIST_OPTIONS])

    expect(tab.exitCode).toBe(0)
    expect(tabs.exitCode).toBe(0)
    expect(tab.fetchCalls).toHaveLength(1)
    expect(tabs.fetchCalls).toHaveLength(1)
    expect(tabs.fetchCalls[0].body).toEqual(tab.fetchCalls[0].body)
    expect(tabs.fetchCalls[0].body).toEqual({
      command: 'tab.list',
      args: { active: true, currentWindow: true, filter: 'Sign', pageIdx: 1, pageSize: 5 },
    })
  })

  test('tabs 省略子命令时与 tab 一致（打印帮助，不发请求）', async () => {
    const tab = await runCli(['tab'])
    const tabs = await runCli(['tabs'])

    expect(tabs.exitCode).toBe(tab.exitCode)
    expect(tab.fetchCalls).toHaveLength(0)
    expect(tabs.fetchCalls).toHaveLength(0)
    expect(tabs.stdout).toBe(tab.stdout)
  })

  test('tabs <handle> 与 tab <handle> 一样当作 select', async () => {
    const tab = await runCli(['tab', 't3'])
    const tabs = await runCli(['tabs', 't3'])

    expect(tabs.fetchCalls[0]?.body).toEqual(tab.fetchCalls[0]?.body)
    expect(tabs.fetchCalls[0]?.body).toEqual({
      command: 'tab.select',
      args: { handle: 't3' },
    })
  })

  test('console list 与省略 action 的 console 发送完全相同的请求', async () => {
    const plain = await runCli(['console'])
    const explicit = await runCli(['console', 'list'])

    expect(explicit.fetchCalls[0]?.body).toEqual(plain.fetchCalls[0]?.body)
    expect(explicit.fetchCalls[0]?.body).toEqual({ command: 'console', args: { action: 'list' } })
  })

  test('console list 后面的筛选参数与 console 完全一致', async () => {
    const options = [
      '--level',
      'warning',
      '--page',
      '2',
      '--page-size',
      '10',
      '--since',
      '123',
      '--all-epochs',
    ]
    const plain = await runCli(['console', ...options])
    const explicit = await runCli(['console', 'list', ...options])

    expect(explicit.fetchCalls[0]?.body).toEqual(plain.fetchCalls[0]?.body)
    expect(explicit.fetchCalls[0]?.body).toEqual({
      command: 'console',
      args: {
        action: 'list',
        level: 'warning',
        pageIdx: 2,
        pageSize: 10,
        since: 123,
        allEpochs: true,
      },
    })
  })

  test('console clear 不因 list 别名改动', async () => {
    const result = await runCli(['console', 'clear'])

    expect(result.fetchCalls[0]?.body).toEqual({ command: 'console', args: { action: 'clear' } })
  })
})
