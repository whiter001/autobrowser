import { describe, expect, test } from 'bun:test'
import { createExtensionState } from '../extension/background/state.js'
import { createWorkspaceManager } from '../extension/background/workspaces.js'
import { createMinimalRouter } from './command-router.test.js'
import { runCli } from './command-line-test-utils.js'

type RouterOverrides = NonNullable<Parameters<typeof createMinimalRouter>[0]>

interface TabFixture {
  id: number
  url: string
  active?: boolean
}

function tab(id: number, url: string, active = false) {
  return {
    id,
    handle: `t${id}`,
    title: `tab ${id}`,
    url,
    active,
    pinned: false,
    status: 'complete',
    windowId: 1,
  }
}

function tabIdFromInput(input: unknown): number {
  if (typeof input === 'number') return input
  const match = /^t(\d+)$/.exec(String(input || ''))
  return match ? Number(match[1]) : 1
}

/** 直接驱动 workspaceManager，便于断言自动认领的选择顺序 */
function createManager(tabs: TabFixture[]) {
  return createWorkspaceManager({
    state: createExtensionState(1),
    listTabs: async () => tabs,
    getTargetTab: async (input) => ({ id: tabIdFromInput(input) }) as never,
  })
}

/** 通过完整路由器验证 meta 与命令级行为 */
function routerWithTabs(tabs: TabFixture[], overrides: RouterOverrides = {}) {
  return createMinimalRouter({
    listTabs: async () => tabs,
    getTargetTab: async (input) => ({ id: tabIdFromInput(input) }),
    ...overrides,
  })
}

function metaOf(result: unknown): Record<string, unknown> {
  return (result as { meta: Record<string, unknown> }).meta
}

describe('workspace auto attach candidate selection', () => {
  test('prefers active unattached tabs and otherwise keeps tabId order', async () => {
    const manager = createManager([
      tab(9, 'https://nine.example', true),
      tab(5, 'https://five.example'),
      tab(3, 'https://three.example', true),
      tab(1, 'https://one.example'),
    ])

    expect(await manager.resolveCommandTab('ai-a', 'snapshot', {})).toBe(3)
    // 剩下的 active tab 仍优先于 id 更小的普通 tab
    expect(await manager.resolveCommandTab('ai-b', 'snapshot', {})).toBe(9)
    expect(await manager.resolveCommandTab('ai-c', 'snapshot', {})).toBe(1)
    expect(await manager.resolveCommandTab('ai-d', 'snapshot', {})).toBe(5)
  })

  test('accepts localhost and about:blank pages regardless of scheme', async () => {
    const manager = createManager([
      tab(2, 'http://localhost:3000/dashboard'),
      tab(1, 'about:blank'),
    ])

    expect(await manager.resolveCommandTab('ai-a', 'snapshot', {})).toBe(1)
    expect(await manager.resolveCommandTab('ai-b', 'snapshot', {})).toBe(2)
  })

  test('skips undebuggable browser pages and reports no candidate otherwise', async () => {
    const manager = createManager([
      tab(1, 'chrome://settings'),
      tab(2, 'edge://settings'),
      tab(3, 'devtools://devtools/bundled/inspector.html'),
      tab(4, 'chrome-extension://abcdef/page.html'),
      tab(5, 'edge-extension://abcdef/page.html'),
      tab(6, 'https://example.com/app'),
    ])

    expect(await manager.resolveCommandTab('ai-a', 'snapshot', {})).toBe(6)

    const blocked = createManager([
      tab(1, 'chrome://settings'),
      tab(2, 'edge-extension://abcdef/page.html'),
    ])
    await expect(blocked.resolveCommandTab('ai-a', 'snapshot', {})).rejects.toMatchObject({
      code: 'WORKSPACE_TARGET_REQUIRED',
      message: expect.stringContaining('auto-attach'),
    })
  })

  test('does not turn a tab enumeration failure into an empty candidate list', async () => {
    const state = createExtensionState(1)
    const manager = createWorkspaceManager({
      state,
      listTabs: async () => {
        throw new Error('browser tab enumeration failed')
      },
      getTargetTab: async (input) => ({ id: tabIdFromInput(input) }) as never,
    })

    await expect(manager.resolveCommandTab('ai-a', 'snapshot', {})).rejects.toThrow(
      'browser tab enumeration failed',
    )
    expect(state.workspaces.attachments.size).toBe(0)
  })

  test('falls back to the next candidate after TAB_BUSY instead of stealing ownership', async () => {
    const state = createExtensionState(1)
    let firstTargetEntered!: () => void
    const firstTargetStarted = new Promise<void>((resolve) => {
      firstTargetEntered = resolve
    })
    let releaseFirstTarget!: () => void
    const firstTargetGate = new Promise<void>((resolve) => {
      releaseFirstTarget = resolve
    })
    const calls: number[] = []
    const manager = createWorkspaceManager({
      state,
      listTabs: async () => [tab(1, 'https://one.example'), tab(2, 'https://two.example')],
      getTargetTab: async (input) => {
        const id = tabIdFromInput(input)
        calls.push(id)
        // 第一次解析 tab 1 时挂起，让另一个 workspace 先完成绑定，从而制造 TAB_BUSY
        if (id === 1 && calls.filter((call) => call === 1).length === 1) {
          firstTargetEntered()
          await firstTargetGate
        }
        return { id } as never
      },
    })

    const first = manager.resolveCommandTab('ai-a', 'snapshot', {})
    await firstTargetStarted
    const second = await manager.resolveCommandTab('ai-b', 'snapshot', {})
    releaseFirstTarget()

    expect(second).toBe(1)
    expect(await first).toBe(2)
    expect(state.workspaces.attachments.get(1)?.workspaceId).toBe('ai-b')
    expect(state.workspaces.attachments.get(2)?.workspaceId).toBe('ai-a')
  })
})

describe('workspace auto attach through the command router', () => {
  test('reports autoAttached only on the first command and keeps the target stable', async () => {
    const { router } = routerWithTabs([
      tab(2, 'https://two.example'),
      tab(1, 'https://one.example', true),
    ])

    const first = await router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a' } })
    expect(first).toMatchObject({
      meta: { workspace: 'ai-a', tabId: 1, autoAttached: true, autoAttachedTabId: 1 },
    })
    expect(first).not.toHaveProperty('targetFallback')
    expect(metaOf(first).target).toMatchObject({ explicit: false })
    expect((metaOf(first).target as Record<string, unknown>).note).toBeUndefined()

    const second = await router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a' } })
    expect(second).toMatchObject({ meta: { workspace: 'ai-a', tabId: 1 } })
    expect(metaOf(second)).not.toHaveProperty('autoAttached')
    expect(metaOf(second)).not.toHaveProperty('autoAttachedTabId')
  })

  test('run assertions consume their own auto-attach marker', async () => {
    const { router } = routerWithTabs([tab(1, 'http://localhost:5173')])

    const assertion = await router.handleCommand({
      command: 'workspace',
      args: { workspace: 'ai-a', action: 'assert' },
    })
    expect(assertion).toMatchObject({
      tabId: 1,
      autoAttached: true,
      autoAttachedTabId: 1,
    })

    const snapshot = await router.handleCommand({
      command: 'snapshot',
      args: { workspace: 'ai-a' },
    })
    expect(metaOf(snapshot)).not.toHaveProperty('autoAttached')
  })

  test('keeps TAB_NOT_ATTACHED for an explicit tab even when free tabs exist', async () => {
    const { router } = routerWithTabs([
      tab(1, 'https://one.example'),
      tab(2, 'https://two.example'),
    ])

    await expect(
      router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a', tabId: 1 } }),
    ).rejects.toMatchObject({ code: 'TAB_NOT_ATTACHED' })

    const listed = (await router.handleCommand({ command: 'tab.list', args: {} })) as {
      tabs: Array<{ workspace: string | null; attachable: boolean }>
    }
    expect(listed.tabs.every((item) => item.workspace === null && item.attachable)).toBe(true)
  })

  test('honors autoAttach:false sent by the CLI', async () => {
    const { router } = routerWithTabs([tab(1, 'https://one.example')])

    await expect(
      router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a', autoAttach: false } }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_TARGET_REQUIRED' })

    const listed = (await router.handleCommand({ command: 'tab.list', args: {} })) as {
      tabs: Array<{ workspace: string | null }>
    }
    expect(listed.tabs.every((item) => item.workspace === null)).toBe(true)
  })

  test('propagates the outer autoAttach:false to every batch step without override', async () => {
    const { router } = routerWithTabs([tab(1, 'https://one.example')])

    const objectSteps = (await router
      .handleCommand({
        command: 'batch',
        args: {
          workspace: 'ai-a',
          autoAttach: false,
          steps: [{ command: 'snapshot', args: { autoAttach: true } }],
        },
      })
      .catch((error) => error)) as {
      code?: string
      details?: { failedStep?: { response?: { error?: { code?: string } } } }
    }
    expect(objectSteps.code).toBe('BATCH_STEP_FAILED')
    expect(objectSteps.details?.failedStep?.response?.error?.code).toBe('WORKSPACE_TARGET_REQUIRED')

    // 字符串步骤同样继承外层开关，避免以"省略 args"的方式重新开启自动认领
    const stringSteps = (await router
      .handleCommand({
        command: 'batch',
        args: { workspace: 'ai-a', autoAttach: false, steps: ['snapshot'] },
      })
      .catch((error) => error)) as {
      code?: string
      details?: { failedStep?: { response?: { error?: { code?: string } } } }
    }
    expect(stringSteps.code).toBe('BATCH_STEP_FAILED')
    expect(stringSteps.details?.failedStep?.response?.error?.code).toBe('WORKSPACE_TARGET_REQUIRED')
  })

  test('keeps invalid batch step arguments as errors when applying outer overrides', async () => {
    const { router, snapshotCalls } = routerWithTabs([tab(1, 'https://one.example')])

    await expect(
      router.handleCommand({
        command: 'batch',
        args: {
          workspace: 'ai-a',
          autoAttach: false,
          steps: [{ command: 'snapshot', args: [] }],
        },
      }),
    ).rejects.toThrow('args must be an object')
    expect(snapshotCalls).toHaveLength(0)
  })

  test('fails a plain command with no candidate but lets open create a tab', async () => {
    const { router, navigateCalls } = createMinimalRouter({
      listTabs: async () => [tab(1, 'chrome://settings')],
      getTargetTab: async (input) => ({ id: tabIdFromInput(input) }),
      createTab: async (url) => ({ id: 9, url }),
    })

    await expect(
      router.handleCommand({ command: 'snapshot', args: { workspace: 'ai-a' } }),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_TARGET_REQUIRED',
      message: expect.stringContaining('auto-attach'),
    })

    const opened = await router.handleCommand({
      command: 'open',
      args: { workspace: 'ai-a', url: 'https://new.example' },
    })
    expect(opened).toMatchObject({ navigated: true, url: 'https://new.example' })
    expect(navigateCalls).toEqual([{ tabId: 9, url: 'https://new.example' }])
  })

  test('open auto-attaches an existing tab instead of creating a new one', async () => {
    const { router, navigateCalls } = routerWithTabs([tab(4, 'https://existing.example')], {
      createTab: async (url) => ({ id: 9, url }),
    })

    const result = await router.handleCommand({
      command: 'open',
      args: { workspace: 'ai-a', url: 'https://next.example' },
    })

    expect(navigateCalls).toEqual([{ tabId: 4, url: 'https://next.example' }])
    expect(result).toMatchObject({ meta: { autoAttached: true, autoAttachedTabId: 4 } })
  })
})

describe('workspace auto attach CLI flag', () => {
  test('forwards --no-auto-attach only when the flag is set', async () => {
    const disabled = await runCli(['--workspace', 'ai-a', '--no-auto-attach', 'snapshot'])
    expect(disabled.exitCode).toBe(0)
    expect(disabled.fetchCalls[0].body).toMatchObject({
      command: 'snapshot',
      args: { workspace: 'ai-a', autoAttach: false },
    })

    const defaults = await runCli(['--workspace', 'ai-a', 'snapshot'])
    expect(defaults.fetchCalls[0].body?.args).not.toHaveProperty('autoAttach')
  })
})
