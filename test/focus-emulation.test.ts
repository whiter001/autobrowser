import { describe, expect, test } from 'bun:test'
import {
  createSessionCommandHandler,
  type SessionDomain,
} from '../extension/background/command-router-session.js'
import type { CommandRunScope } from '../extension/background/command-router-context.js'
import { createSessionDomain } from '../extension/background/session.js'
import type { ExtensionState, TabInput, TabWithId } from '../extension/background/types.js'
import { runCli } from './command-line-test-utils.js'

interface DebuggerCall {
  tabId: number
  method: string
  params?: Record<string, unknown>
}

function createFocusHarness(options: { tabId?: number; tabUrl?: string } = {}) {
  const tabId = options.tabId ?? 7
  const debuggerCalls: DebuggerCall[] = []
  const targetTabInputs: TabInput[] = []
  const state = {
    session: { emulation: new Map<number, Record<string, unknown>>() },
  } as unknown as ExtensionState

  const session = createSessionDomain({
    state,
    getTargetTab: async (tabInput) => {
      targetTabInputs.push(tabInput)
      return { id: tabId, url: options.tabUrl || 'https://app.example.com/' } as TabWithId
    },
    evaluateInTabContext: async () => {
      throw new Error('not used in this test')
    },
    sendDebuggerCommand: async <TResult>(
      callTabId: number,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<TResult> => {
      debuggerCalls.push({ tabId: callTabId, method, params })
      return {} as TResult
    },
    storageLocalGet: async () => ({}) as never,
    storageLocalSet: async () => {},
  })

  return { session, state, debuggerCalls, targetTabInputs, tabId }
}

describe('cli set focus forwarding', () => {
  const cases: Array<{ args: string[]; enabled: boolean }> = [
    { args: ['set', 'focus'], enabled: true },
    { args: ['set', 'focus', 'on'], enabled: true },
    { args: ['set', 'focus', 'true'], enabled: true },
    { args: ['set', 'focus', '1'], enabled: true },
    { args: ['set', 'focus', 'off'], enabled: false },
    { args: ['set', 'focus', 'false'], enabled: false },
    { args: ['set', 'focus', '0'], enabled: false },
  ]

  for (const { args, enabled } of cases) {
    test(`${args.join(' ')} 转发 enabled=${enabled}`, async () => {
      const result = await runCli(args)

      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls).toHaveLength(1)
      expect(result.fetchCalls[0].body).toEqual({
        command: 'set',
        args: { type: 'focus', enabled },
      })
    })
  }
})

describe('session setFocus', () => {
  test('对目标 tab 发送 CDP 焦点仿真并返回开关状态', async () => {
    const { session, debuggerCalls, targetTabInputs, tabId } = createFocusHarness()

    await expect(session.setFocus('tab-handle', true)).resolves.toEqual({ focus: true })

    expect(targetTabInputs).toEqual(['tab-handle'])
    expect(debuggerCalls).toEqual([
      { tabId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
    ])
  })

  test('关闭时发送 enabled=false', async () => {
    const { session, debuggerCalls, tabId } = createFocusHarness()

    await expect(session.setFocus(7, false)).resolves.toEqual({ focus: false })

    expect(debuggerCalls).toEqual([
      { tabId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } },
    ])
  })
})

describe('session setFocus emulation overrides', () => {
  test('启用时记录 focus，关闭时删除并在为空时丢弃记录', async () => {
    const { session, state, tabId } = createFocusHarness()

    await session.setFocus(7, true)
    expect(state.session.emulation.get(tabId)).toEqual({ focus: true })

    await session.setFocus(7, false)
    expect(state.session.emulation.get(tabId)).toBeUndefined()
  })

  test('只切换 focus，不影响其他仿真覆盖', async () => {
    const { session, state, tabId } = createFocusHarness()

    await session.setViewport(7, 1280, 720)
    await session.setOffline(7, true)
    await session.setFocus(7, true)
    expect(state.session.emulation.get(tabId)).toEqual({
      viewport: true,
      offline: true,
      focus: true,
    })

    await session.setFocus(7, false)
    expect(state.session.emulation.get(tabId)).toEqual({
      viewport: true,
      offline: true,
    })
  })
})

describe('command router routes type=focus', () => {
  function createRoutingHarness() {
    const calls: Array<{ tabId: TabInput; enabled: boolean }> = []
    const session = {
      setFocus: async (tabId: TabInput, enabled: boolean) => {
        calls.push({ tabId, enabled })
        return { focus: enabled }
      },
    } as unknown as SessionDomain
    const { handleSessionCommand } = createSessionCommandHandler({
      state: { session: {} } as unknown as ExtensionState,
      session,
    })
    return { handleSessionCommand, calls }
  }

  function scope(args: Record<string, unknown>, tabId: TabInput): CommandRunScope {
    return {
      command: 'set',
      args,
      action: '',
      tabId,
      frameSelector: null,
    } as unknown as CommandRunScope
  }

  test('type=focus 调用 setFocus 并透传 tab 与 enabled', async () => {
    const { handleSessionCommand, calls } = createRoutingHarness()

    await expect(
      handleSessionCommand(scope({ type: 'focus', enabled: false }, 42)),
    ).resolves.toEqual({ focus: false })
    expect(calls).toEqual([{ tabId: 42, enabled: false }])
  })

  test('enabled 缺省按 true 处理', async () => {
    const { handleSessionCommand, calls } = createRoutingHarness()

    await expect(handleSessionCommand(scope({ type: 'focus' }, 42))).resolves.toEqual({
      focus: true,
    })
    expect(calls).toEqual([{ tabId: 42, enabled: true }])
  })
})
