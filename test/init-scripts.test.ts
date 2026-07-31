import { describe, expect, test } from 'bun:test'
import { createInitScriptDomain } from '../extension/background/init-scripts.js'
import { createExtensionState } from '../extension/background/state.js'

interface DebuggerCall {
  tabId: number
  method: string
  params: Record<string, unknown>
}

function createDomain(attachedTabs: number[] = []) {
  const state = createExtensionState(57978)
  for (const tabId of attachedTabs) {
    state.targeting.attachedTabs.add(tabId)
  }

  const calls: DebuggerCall[] = []
  let nextIdentifier = 1
  const domain = createInitScriptDomain({
    state,
    sendRawDebuggerCommand: async <TResult = unknown>(
      tabId: number,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<TResult> => {
      calls.push({ tabId, method, params })
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
})
