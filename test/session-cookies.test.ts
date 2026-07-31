import { describe, expect, test } from 'bun:test'
import { createSessionDomain } from '../extension/background/session.js'
import type { ExtensionState, TabWithId } from '../extension/background/types.js'

interface DebuggerCall {
  tabId: number
  method: string
  params?: Record<string, unknown>
}

function createCookiesClearHarness(tabUrl: string, cookies: unknown[]) {
  const debuggerCalls: DebuggerCall[] = []
  const session = createSessionDomain({
    state: {} as ExtensionState,
    getTargetTab: async () => ({ id: 7, url: tabUrl }) as TabWithId,
    evaluateInTabContext: async () => {
      throw new Error('not used in this test')
    },
    sendDebuggerCommand: async <TResult>(
      tabId: number,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<TResult> => {
      debuggerCalls.push({ tabId, method, params })
      if (method === 'Network.getCookies') {
        return { cookies } as TResult
      }
      return {} as TResult
    },
    storageLocalGet: async () => ({}) as never,
    storageLocalSet: async () => {},
  })

  return { session, debuggerCalls }
}

describe('session cookiesClear', () => {
  test('只删除当前站点域名（含父域/子域）的 cookie', async () => {
    const { session, debuggerCalls } = createCookiesClearHarness('https://app.example.com/path', [
      { name: 'session', domain: '.example.com', path: '/' },
      { name: 'sub', domain: 'api.app.example.com', path: '/' },
      { name: 'host-only', domain: 'app.example.com', path: '/' },
      { name: 'other', domain: '.other-site.com', path: '/' },
      { name: 'similar', domain: 'notexample.com', path: '/' },
    ])

    const result = (await session.cookiesClear(7)) as { cleared: number; domain: string }

    expect(result).toEqual({ cleared: 3, domain: 'app.example.com' })
    const deletions = debuggerCalls.filter((call) => call.method === 'Network.deleteCookies')
    expect(deletions.map((call) => call.params?.name)).toEqual(['session', 'sub', 'host-only'])
    expect(debuggerCalls.some((call) => call.method === 'Network.clearBrowserCookies')).toBeFalse()
  })

  test('无法解析 tab URL 域名时不清除任何 cookie', async () => {
    const { session, debuggerCalls } = createCookiesClearHarness('about:blank', [
      { name: 'session', domain: '.example.com', path: '/' },
    ])

    const result = (await session.cookiesClear(7)) as { cleared: number; domain: string | null }

    expect(result).toEqual({ cleared: 0, domain: null })
    expect(debuggerCalls.some((call) => call.method === 'Network.deleteCookies')).toBeFalse()
  })
})
