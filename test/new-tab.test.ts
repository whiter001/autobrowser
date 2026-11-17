import { describe, expect, test } from 'bun:test'
import { validateCommandArgs } from '../src/core/command-spec.js'
import {
  NEW_TAB_FOLLOW_WAIT_MS,
  NEW_TAB_MAX_RECORDS,
  NEW_TAB_WINDOW_MS,
  createPointerCommands,
  findNewTabOpenedBy,
  pruneRecentlyCreatedTabs,
  recordCreatedTab,
} from '../extension/background/page-input-pointer.js'
import { createExtensionState } from '../extension/background/state.js'
import { createOperationContext } from '../extension/background/operation-context.js'
import type { CommandExecutionContext } from '../extension/background/command-queue.js'
import type { ExtensionState } from '../extension/background/types.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

/**
 * target=_blank 的新标签检测与显式跟随：
 * 扩展侧只负责识别并报告（不改当前目标），CLI 侧只有显式 --follow-new-tab 才接管。
 */

function createState(): ExtensionState {
  return createExtensionState(1)
}

describe('新标签记录（chrome.tabs.onCreated）', () => {
  test('记录新建标签的 id、打开者与创建时间', () => {
    const state = createState()

    recordCreatedTab(state, { id: 7, openerTabId: 3 })

    expect(state.targeting.recentlyCreatedTabs).toHaveLength(1)
    expect(state.targeting.recentlyCreatedTabs[0]).toMatchObject({ id: 7, openerTabId: 3 })
    expect(typeof state.targeting.recentlyCreatedTabs[0]?.createdAt).toBe('number')
  })

  test('没有打开者的标签记成 null，而不是 undefined', () => {
    const state = createState()

    recordCreatedTab(state, { id: 9 })

    expect(state.targeting.recentlyCreatedTabs[0]).toMatchObject({ id: 9, openerTabId: null })
  })

  test('超过时间窗的记录会被剪掉', () => {
    const state = createState()
    state.targeting.recentlyCreatedTabs.push({
      id: 5,
      openerTabId: 1,
      createdAt: Date.now() - NEW_TAB_WINDOW_MS - 1000,
    })
    recordCreatedTab(state, { id: 6, openerTabId: 1 })

    pruneRecentlyCreatedTabs(state)

    expect(state.targeting.recentlyCreatedTabs.map((record) => record.id)).toEqual([6])
  })

  test('记录条数有上限，不会随打开标签次数无限增长', () => {
    const state = createState()

    for (let index = 1; index <= NEW_TAB_MAX_RECORDS + 5; index += 1) {
      recordCreatedTab(state, { id: index, openerTabId: 1 })
    }

    expect(state.targeting.recentlyCreatedTabs).toHaveLength(NEW_TAB_MAX_RECORDS)
    // FIFO：最旧的被丢掉，最新的还在
    expect(state.targeting.recentlyCreatedTabs[0]?.id).toBe(6)
    expect(state.targeting.recentlyCreatedTabs.at(-1)?.id).toBe(NEW_TAB_MAX_RECORDS + 5)
  })

  test('只认打开者是源标签、且在点击开始之后创建的新标签', () => {
    const state = createState()
    const since = Date.now()
    recordCreatedTab(state, { id: 11, openerTabId: 3 })
    recordCreatedTab(state, { id: 12, openerTabId: 4 })

    expect(findNewTabOpenedBy(state, 3, since)).toBe(11)
    expect(findNewTabOpenedBy(state, 5, since)).toBeNull()
  })

  test('点击开始之前就已经存在的标签不算这次点击的产物', () => {
    const state = createState()
    const createdAt = Date.now()
    state.targeting.recentlyCreatedTabs.push({ id: 21, openerTabId: 3, createdAt })

    expect(findNewTabOpenedBy(state, 3, createdAt + 1)).toBeNull()
  })
})

interface ClickHarness {
  state: ExtensionState
  click: (
    selector: string,
    options?: { followNewTab?: boolean; context?: CommandExecutionContext },
  ) => Promise<Record<string, unknown>>
}

/**
 * 点击的执行环境替身。
 *
 * newTabId 会在鼠标事件派发期间触发 onCreated，等价于浏览器在这次点击里打开了新标签；
 * 记录发生在点击开始之后，才符合真实的时序。
 */
function createClickHarness(
  options: { navigated?: boolean; newTabId?: number; newTabDelayMs?: number } = {},
): ClickHarness {
  const state = createState()
  const tab = { id: 1, url: 'https://example.test/source', title: 'Source' }
  let observationCalls = 0

  const evaluateInTabContext = async <TValue>(
    _tabId: unknown,
    expression: string,
  ): Promise<{ tab: typeof tab; response: { result: unknown }; value: TValue | null }> => {
    if (expression.includes('getBoundingClientRect')) {
      return {
        tab,
        response: { result: null },
        value: { x: 10, y: 20, width: 4, height: 4 } as TValue,
      }
    }
    if (expression.includes('autobrowser.click.observation')) {
      observationCalls += 1
      const value =
        observationCalls === 1
          ? { found: true }
          : { found: true, events: ['click'], domClicked: false }
      return { tab, response: { result: null }, value: value as TValue }
    }
    return { tab, response: { result: null }, value: null as TValue }
  }

  const navigation = {
    detectNavigationAfterClick: async () => options.navigated === true,
    waitForPageSettled: async () => ({ settled: true, settledInMs: 1 }),
  }

  const sendDebuggerCommand = async (
    _tabId: number,
    method: string,
    params: Record<string, unknown>,
  ) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      if (typeof options.newTabId === 'number') {
        const openNewTab = () =>
          recordCreatedTab(state, { id: options.newTabId as number, openerTabId: 1 })
        // newTabDelayMs 模拟 onCreated 晚于点击返回到达的情况
        if (typeof options.newTabDelayMs === 'number') {
          setTimeout(openNewTab, options.newTabDelayMs)
        } else {
          openNewTab()
        }
      }
    }
    return {}
  }

  const pointer = createPointerCommands(
    {
      state,
      getTargetTab: async () => tab as never,
      resolveElementSelectorForTab: async (_tabId: unknown, selector: string) =>
        ({ tab, resolvedSelector: selector }) as never,
      resolveFrameTarget: async () => ({}) as never,
      evaluateInTabContext: evaluateInTabContext as never,
      sendDebuggerCommand: sendDebuggerCommand as never,
      sleep: async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)),
    } as never,
    navigation as never,
  )

  return {
    state,
    click: async (selector, clickOptions = {}) =>
      (await pointer.clickSelector(
        1,
        selector,
        null,
        1000,
        clickOptions.context,
        clickOptions.followNewTab === true,
      )) as never,
  }
}

describe('点击结果里的新标签', () => {
  test('不导航的点击也会报告新标签的 id 与句柄', async () => {
    const harness = createClickHarness({ newTabId: 7 })

    const result = await harness.click('#new-tab')

    expect(result.newTabId).toBe(7)
    expect(result.newTabHandle).toBe('t7')
  })

  test('导航的点击同样报告新标签', async () => {
    const harness = createClickHarness({ navigated: true, newTabId: 8 })

    const result = await harness.click('#new-tab')

    expect(result.newTabId).toBe(8)
    expect(result.newTabHandle).toBe('t8')
    expect(result.navigatedToUrl).toBe('https://example.test/source')
  })

  test('没有新标签时不加任何新标签字段', async () => {
    const harness = createClickHarness()

    const result = await harness.click('#plain')

    expect(result).not.toHaveProperty('newTabId')
    expect(result).not.toHaveProperty('newTabHandle')
  })

  test('只报告不接管：点击不会改变当前目标标签', async () => {
    const harness = createClickHarness({ newTabId: 7 })

    await harness.click('#new-tab')

    expect(harness.state.targeting.targetTabId).toBeNull()
  })
})

describe('显式跟随时对新标签的有界等待', () => {
  test('follow=true 时能等到晚到的新标签', async () => {
    const harness = createClickHarness({ newTabId: 7, newTabDelayMs: 200 })

    const result = await harness.click('#new-tab', { followNewTab: true })

    expect(result.newTabId).toBe(7)
    expect(result.newTabHandle).toBe('t7')
  })

  test('follow=false 时不等待晚到的新标签', async () => {
    const harness = createClickHarness({ newTabId: 7, newTabDelayMs: 200 })

    const startedAt = Date.now()
    const result = await harness.click('#new-tab', { followNewTab: false })

    expect(result).not.toHaveProperty('newTabId')
    expect(result).not.toHaveProperty('newTabHandle')
    // 没有等待：默认路径不能因为新标签检测多花时间
    expect(Date.now() - startedAt).toBeLessThan(150)
  })

  test('follow=true 但始终没有新标签时，等待有界且不返回新标签字段', async () => {
    const harness = createClickHarness()

    const startedAt = Date.now()
    const result = await harness.click('#new-tab', { followNewTab: true })
    const elapsed = Date.now() - startedAt

    expect(result).not.toHaveProperty('newTabId')
    expect(result).not.toHaveProperty('newTabHandle')
    expect(elapsed).toBeGreaterThanOrEqual(NEW_TAB_FOLLOW_WAIT_MS - 100)
    expect(elapsed).toBeLessThan(NEW_TAB_FOLLOW_WAIT_MS + 2000)
  })

  test('等待期间被取消时立即中断', async () => {
    const harness = createClickHarness({ newTabId: 7, newTabDelayMs: 5000 })
    const operation = createOperationContext('new-tab-test', null)

    const pending = harness.click('#new-tab', {
      followNewTab: true,
      context: operation.context,
    })
    setTimeout(() => operation.cancel('test cancellation'), 100)

    await expect(pending).rejects.toMatchObject({ code: 'COMMAND_CANCELLED' })
    operation.dispose()
  })
})

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    async json() {
      return payload
    },
    async text() {
      return `${JSON.stringify(payload)}\n`
    },
  }
}

const CLICK_RESULT = {
  ok: true,
  result: {
    found: true,
    selector: '#new-tab',
    newTabId: 7,
    newTabHandle: 't7',
    meta: {
      tabHandle: 't1',
      tabId: 1,
      url: 'https://example.test/source',
      title: 'Source',
      target: { tabId: 1, handle: 't1', explicit: true },
      pageEpoch: 11,
      frame: '@f2',
    },
  },
}

const ATTACH_RESULT = {
  ok: true,
  result: {
    attached: true,
    workspace: 'ws-1',
    attachment: 'owned',
    tab: {
      id: 7,
      handle: 't7',
      title: 'New tab',
      url: 'https://example.test/new',
      active: false,
    },
    meta: {
      tabHandle: 't7',
      tabId: 7,
      url: 'https://example.test/new',
      title: 'New tab',
      target: { tabId: 7, handle: 't7', explicit: true },
      pageEpoch: 1,
      frame: null,
    },
  },
}

describe('CLI 的显式跟随', () => {
  test('默认只报告新标签，不会调用 tab attach', async () => {
    const commands: string[] = []
    const result = await runCli(['click', '#new-tab'], CLICK_RESULT, {
      fetchImpl: async (_url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        commands.push(String(body.command))
        return jsonResponse(CLICK_RESULT)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(commands).toEqual(['click'])
    const output = JSON.parse(result.stdout)
    expect(output.result.newTabHandle).toBe('t7')
    expect(output.result).not.toHaveProperty('followedTab')
  })

  test('--follow-new-tab 会复用 tab attach 接管新标签', async () => {
    const commands: Array<{ command: string; args: Record<string, unknown> }> = []
    const result = await runCli(['click', '#new-tab', '--follow-new-tab'], CLICK_RESULT, {
      fetchImpl: async (_url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        commands.push({ command: String(body.command), args: body.args ?? {} })
        return jsonResponse(body.command === 'tab.attach' ? ATTACH_RESULT : CLICK_RESULT)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(commands.map((entry) => entry.command)).toEqual(['click', 'tab.attach'])
    expect(commands[1]?.args).toMatchObject({ handle: 't7' })

    const output = JSON.parse(result.stdout)
    expect(output.ok).toBe(true)
    // 原点击结果保留，同时给出跟随后的目标
    expect(output.result.found).toBe(true)
    expect(output.result.newTabHandle).toBe('t7')
    expect(output.result.followedTab).toMatchObject({
      handle: 't7',
      url: 'https://example.test/new',
    })
    expect(output.result.meta).toMatchObject({
      tabHandle: 't7',
      tabId: 7,
      url: 'https://example.test/new',
      title: 'New tab',
      target: { tabId: 7, handle: 't7', explicit: true },
      pageEpoch: 1,
      frame: null,
    })
  })

  test('无 workspace 模式退回 tab select 切换目标', async () => {
    const commands: string[] = []
    const result = await runCli(['click', '#new-tab', '--follow-new-tab'], CLICK_RESULT, {
      fetchImpl: async (_url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        commands.push(String(body.command))
        if (body.command === 'tab.attach') {
          return jsonResponse({
            ok: false,
            error: { message: 'this command requires a workspace', code: 'WORKSPACE_REQUIRED' },
          })
        }
        if (body.command === 'tab.select') {
          return jsonResponse({
            ok: true,
            result: {
              selected: true,
              tab: { id: 7, handle: 't7', title: 'New tab', url: 'https://example.test/new' },
            },
          })
        }
        return jsonResponse(CLICK_RESULT)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(commands).toEqual(['click', 'tab.attach', 'tab.select'])
    const output = JSON.parse(result.stdout)
    expect(output.result.followedTab).toMatchObject({ handle: 't7' })
    expect(output.result.follow.mode).toBe('select')
  })

  test('跟随失败时错误必须冒泡，不能当成成功', async () => {
    const result = await runCli(['click', '#new-tab', '--follow-new-tab'], CLICK_RESULT, {
      fetchImpl: async (_url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        if (body.command === 'tab.attach') {
          return jsonResponse({
            ok: false,
            error: { message: 'tab t7 is attached to workspace other', code: 'TAB_BUSY' },
          })
        }
        return jsonResponse(CLICK_RESULT)
      },
    })

    expect(result.exitCode).toBe(1)
    const output = JSON.parse(result.stdout)
    expect(output.ok).toBe(false)
    expect(output.error.code).toBe('TAB_BUSY')
    expect(output.error.message).toContain('tab t7 is attached to workspace other')
    expect(output.result.followedTab).toBeNull()
  })

  test('点击本身失败时不跟随', async () => {
    const commands: string[] = []
    const result = await runCli(
      ['click', '#new-tab', '--follow-new-tab'],
      {
        ok: false,
        error: { message: 'element not found' },
      },
      {
        fetchImpl: async (_url, init) => {
          const body = init.body ? JSON.parse(String(init.body)) : {}
          commands.push(String(body.command))
          return jsonResponse({ ok: false, error: { message: 'element not found' } })
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(commands).toEqual(['click'])
  })

  test('没有新标签时 --follow-new-tab 也不会去 attach', async () => {
    const commands: string[] = []
    const result = await runCli(
      ['click', '#plain', '--follow-new-tab'],
      { ok: true, result: { found: true, selector: '#plain' } },
      {
        fetchImpl: async (_url, init) => {
          const body = init.body ? JSON.parse(String(init.body)) : {}
          commands.push(String(body.command))
          return jsonResponse({ ok: true, result: { found: true, selector: '#plain' } })
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(commands).toEqual(['click'])
  })

  test('重复的 --follow-new-tab 报错', async () => {
    const result = await runCli(['click', '#new-tab', '--follow-new-tab', '--follow-new-tab'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain(
      'duplicate click option: --follow-new-tab',
    )
  })

  test('多余的位置参数报错', async () => {
    const result = await runCli(['click', '#new-tab', 'extra'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain(
      'unexpected extra argument for click: extra',
    )
  })
})

describe('命令规格里的 followNewTab', () => {
  test('接受布尔值', () => {
    expect(() => validateCommandArgs('click', { selector: '#x', followNewTab: true })).not.toThrow()
    expect(() =>
      validateCommandArgs('click', { selector: '#x', followNewTab: false }),
    ).not.toThrow()
  })

  test('非布尔值被拒绝', () => {
    expect(() => validateCommandArgs('click', { selector: '#x', followNewTab: 'yes' })).toThrow(
      /followNewTab must be a boolean/,
    )
  })
})
