import { describe, expect, spyOn, test } from 'bun:test'
import {
  createInitScriptDomain,
  INIT_SCRIPTS_STORAGE_KEY,
  type InitScriptStorage,
} from '../extension/background/init-scripts.js'
import { createExtensionState } from '../extension/background/state.js'

interface DebuggerCall {
  tabId: number
  method: string
  params: Record<string, unknown>
}

/** 内存版 storage.session：浏览器重启后清空、SW 回收后仍在的语义由"同一个对象跨 createDomain"模拟 */
function createMemoryStorage(initial: Record<string, unknown> = {}) {
  const items: Record<string, unknown> = { ...initial }
  const storage: InitScriptStorage = {
    get: async <T extends Record<string, unknown> = Record<string, unknown>>(
      keys: string | string[] | null,
    ) => {
      const wanted = keys === null ? Object.keys(items) : Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(
        wanted.filter((key) => key in items).map((key) => [key, items[key]]),
      ) as T
    },
    set: async (next: Record<string, unknown>) => {
      Object.assign(items, next)
    },
  }
  return { items, storage }
}

function createDomain(
  attachedTabs: number[] = [],
  failingTabs: number[] = [],
  storage?: InitScriptStorage,
) {
  const state = createExtensionState(57978)
  for (const tabId of attachedTabs) {
    state.targeting.attachedTabs.add(tabId)
  }

  const calls: DebuggerCall[] = []
  let nextIdentifier = 1
  const domain = createInitScriptDomain({
    state,
    ...(storage ? { storage } : {}),
    sendRawDebuggerCommand: async <TResult = unknown>(
      tabId: number,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<TResult> => {
      calls.push({ tabId, method, params })
      if (failingTabs.includes(tabId) && method === 'Page.addScriptToEvaluateOnNewDocument') {
        throw new Error(`debugger is not attached to tab ${tabId}`)
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return { identifier: `cdp-${nextIdentifier++}` } as TResult
      }
      return {} as TResult
    },
  })

  return { state, domain, calls }
}

describe('init script domain', () => {
  test('add registers the script on every attached tab and returns a preview', async () => {
    const { state, domain, calls } = createDomain([1, 2])

    const result = (await domain.addScript('window.__flag = true')) as {
      script: { id: string; preview: string; sourceLength: number; registeredTabs: number[] }
      scripts: unknown[]
    }

    expect(result.script.id).toMatch(/^script_/)
    expect(result.script.preview).toBe('window.__flag = true')
    expect(result.script.sourceLength).toBe('window.__flag = true'.length)
    expect(result.script.registeredTabs).toEqual([1, 2])
    expect(result.scripts).toHaveLength(1)
    expect(state.initScripts).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')).toEqual(
      [
        {
          tabId: 1,
          method: 'Page.addScriptToEvaluateOnNewDocument',
          params: { source: 'window.__flag = true' },
        },
        {
          tabId: 2,
          method: 'Page.addScriptToEvaluateOnNewDocument',
          params: { source: 'window.__flag = true' },
        },
      ],
    )
  })

  test('replayForTab registers existing scripts on a newly attached tab', async () => {
    const { domain, calls } = createDomain([1])

    await domain.addScript('a = 1')
    await domain.addScript('b = 2')
    calls.length = 0

    // 模拟新 tab attach（或 debugger 重连）后的 replay
    await domain.replayForTab(9)

    expect(calls).toEqual([
      { tabId: 9, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: 'a = 1' } },
      { tabId: 9, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: 'b = 2' } },
    ])
  })

  test('list returns machine-readable summaries without full sources', async () => {
    const { domain } = createDomain()

    await domain.addScript(`// ${'x'.repeat(500)}`)

    const result = (await domain.listScripts()) as {
      scripts: Array<{ id: string; preview: string; sourceLength: number; createdAt: string }>
    }

    expect(result.scripts).toHaveLength(1)
    expect(result.scripts[0].sourceLength).toBe(503)
    expect(result.scripts[0].preview.length).toBeLessThanOrEqual(121)
    expect(result.scripts[0].preview.endsWith('…')).toBe(true)
    expect(result.scripts[0].createdAt.length).toBeGreaterThan(0)
  })

  test('remove unregisters on attached tabs only and drops the record', async () => {
    const { state, domain, calls } = createDomain([1, 2])

    const added = (await domain.addScript('window.x = 1')) as { script: { id: string } }
    // tab 2 之后 detach，remove 时不应再向它发 CDP 命令
    state.targeting.attachedTabs.delete(2)
    calls.length = 0

    const result = (await domain.removeScript(added.script.id)) as {
      removed: string
      scripts: unknown[]
    }

    expect(result.removed).toBe(added.script.id)
    expect(result.scripts).toEqual([])
    expect(state.initScripts).toEqual([])
    expect(calls).toEqual([
      {
        tabId: 1,
        method: 'Page.removeScriptToEvaluateOnNewDocument',
        params: { identifier: 'cdp-1' },
      },
    ])

    await expect(domain.removeScript(added.script.id)).rejects.toThrow('init script not found')
  })

  test('removeAllScripts unregisters everything and clears state', async () => {
    const { state, domain } = createDomain([1])

    await domain.addScript('a = 1')
    await domain.addScript('b = 2')

    const result = (await domain.removeAllScripts()) as { removed: string[]; scripts: unknown[] }

    expect(result.removed).toHaveLength(2)
    expect(result.scripts).toEqual([])
    expect(state.initScripts).toEqual([])
  })
  test('addScript says it only stored configuration when no tab is attached', async () => {
    // 现象：ok: true + registeredTabs: [] 看不出脚本到底有没有生效。
    const { domain } = createDomain()

    const result = (await domain.addScript('window.__flag = true')) as {
      script: { registeredTabs: number[] }
      registration: {
        appliesTo: string
        attachedTabs: number[]
        failures: unknown[]
        warnings: string[]
      }
    }

    expect(result.script.registeredTabs).toEqual([])
    expect(result.registration).toMatchObject({
      appliesTo: 'next-document-load',
      attachedTabs: [],
      failures: [],
    })
    expect(result.registration.warnings[0]).toContain('no tab is attached')
  })

  test('addScript reports per-tab registration failures instead of swallowing them', async () => {
    const { domain } = createDomain([1, 2], [2])

    const result = (await domain.addScript('window.__flag = true')) as {
      script: { registeredTabs: number[] }
      registration: { failures: Array<{ tabId: number; message: string }>; warnings: string[] }
    }

    expect(result.script.registeredTabs).toEqual([1])
    expect(result.registration.failures).toEqual([
      { tabId: 2, message: 'debugger is not attached to tab 2' },
    ])
    expect(result.registration.warnings[0]).toContain('failed to register')
  })
  test('restores scripts from storage.session after the service worker restarts', async () => {
    // 现象：SW 被回收后内存态清空，重连后 script list 为空、导航也不再注入。
    const { items, storage } = createMemoryStorage()
    const first = createDomain([1], [], storage)
    const added = (await first.domain.addScript('window.__flag = true')) as {
      script: { id: string; createdAt: string }
    }
    expect(items[INIT_SCRIPTS_STORAGE_KEY]).toBeDefined()

    // 新 state 模拟 SW 重启：内存全空，只剩 storage.session
    const restarted = createDomain([], [], storage)
    const listed = (await restarted.domain.listScripts()) as {
      scripts: Array<{
        id: string
        sourceLength: number
        createdAt: string
        registeredTabs: number[]
      }>
    }

    expect(listed.scripts).toHaveLength(1)
    expect(listed.scripts[0].id).toBe(added.script.id)
    expect(listed.scripts[0].createdAt).toBe(added.script.createdAt)
    expect(listed.scripts[0].sourceLength).toBe('window.__flag = true'.length)
    // identifier 属于旧 CDP 会话，恢复后必须为空，等重新 attach 时 replay 重建
    expect(listed.scripts[0].registeredTabs).toEqual([])

    // 重新 attach 后的 replay 能把恢复出来的脚本注册到新会话
    await restarted.domain.replayForTab(9)
    expect(restarted.calls).toEqual([
      {
        tabId: 9,
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: { source: 'window.__flag = true' },
      },
    ])
  })

  test('removeScript drops the persisted entry too', async () => {
    const { storage } = createMemoryStorage()
    const first = createDomain([], [], storage)
    const added = (await first.domain.addScript('a = 1')) as { script: { id: string } }

    await first.domain.removeScript(added.script.id)

    const restarted = createDomain([], [], storage)
    const listed = (await restarted.domain.listScripts()) as { scripts: unknown[] }
    expect(listed.scripts).toEqual([])
  })

  test('ignores persisted payloads with the wrong shape or version', async () => {
    const { storage } = createMemoryStorage({
      [INIT_SCRIPTS_STORAGE_KEY]: { version: 99, scripts: [{ id: 'x', source: 'y' }] },
    })

    const { domain } = createDomain([], [], storage)

    expect(await domain.listScripts()).toEqual({ scripts: [] })
  })

  test('keeps working when storage.session is unavailable or failing', async () => {
    const failing: InitScriptStorage = {
      get: async () => {
        throw new Error('storage.session is not available')
      },
      set: async () => {
        throw new Error('storage.session is not available')
      },
    }
    const { domain } = createDomain([1], [], failing)
    // 存储故障只应降级为"不跨重启"，命令本身必须成功；这条路径会打 warn，测试里静音
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = (await domain.addScript('a = 1')) as {
        script: { registeredTabs: number[] }
      }

      expect(result.script.registeredTabs).toEqual([1])
      const listed = (await domain.listScripts()) as { scripts: unknown[] }
      expect(listed.scripts).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})
