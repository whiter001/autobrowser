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
    // 只给 session.emulation 最小结构：set 系列命令会记录覆盖摘要
    state: {
      session: { emulation: new Map<number, Record<string, unknown>>() },
    } as unknown as ExtensionState,
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

describe('session cookiesDelete', () => {
  test('只删除当前站点域名下指定名字的 cookie', async () => {
    const { session, debuggerCalls } = createCookiesClearHarness('https://app.example.com/path', [
      { name: 'session', domain: '.example.com', path: '/' },
      { name: 'session', domain: '.other-site.com', path: '/' },
      { name: 'theme', domain: '.example.com', path: '/' },
    ])

    const result = (await session.cookiesDelete(7, 'session')) as {
      deleted: number
      name: string
      domain: string
    }

    expect(result).toEqual({ deleted: 1, name: 'session', domain: 'app.example.com' })
    const deletions = debuggerCalls.filter((call) => call.method === 'Network.deleteCookies')
    expect(deletions).toHaveLength(1)
    expect(deletions[0]?.params).toEqual({ name: 'session', domain: '.example.com', path: '/' })
  })

  test('tab URL 无法解析域名时不删除任何 cookie', async () => {
    const { session, debuggerCalls } = createCookiesClearHarness('about:blank', [
      { name: 'session', domain: '.example.com', path: '/' },
    ])

    const result = (await session.cookiesDelete(7, 'session')) as { deleted: number }
    expect(result.deleted).toBe(0)
    expect(debuggerCalls.some((call) => call.method === 'Network.deleteCookies')).toBeFalse()
  })
})

describe('session cookiesGet filters', () => {
  const cookies = [
    { name: 'a', domain: '.example.com', path: '/' },
    { name: 'b', domain: 'api.example.com', path: '/v1' },
    { name: 'c', domain: '.other-site.com', path: '/' },
  ]

  test('按 domain 后缀匹配过滤', async () => {
    const { session } = createCookiesClearHarness('https://app.example.com/', cookies)

    const result = (await session.cookiesGet(7, { domain: 'example.com' })) as {
      cookies: Array<{ name: string }>
    }
    expect(result.cookies.map((cookie) => cookie.name)).toEqual(['a', 'b'])
  })

  test('按 path 精确匹配过滤', async () => {
    const { session } = createCookiesClearHarness('https://app.example.com/', cookies)

    const result = (await session.cookiesGet(7, { path: '/v1' })) as {
      cookies: Array<{ name: string }>
    }
    expect(result.cookies.map((cookie) => cookie.name)).toEqual(['b'])
  })

  test('无过滤时返回全部 cookie', async () => {
    const { session } = createCookiesClearHarness('https://app.example.com/', cookies)

    const result = (await session.cookiesGet(7)) as { cookies: unknown[] }
    expect(result.cookies).toHaveLength(3)
  })
})

interface SessionEvalHarnessOptions {
  tabUrl?: string
}

function createSessionEvalHarness(options: SessionEvalHarnessOptions = {}) {
  const evalCalls: Array<{ tabId: unknown; expression: string }> = []
  const debuggerCalls: DebuggerCall[] = []
  const session = createSessionDomain({
    // 只给 session.emulation 最小结构：set 系列命令会记录覆盖摘要
    state: {
      session: { emulation: new Map<number, Record<string, unknown>>() },
    } as unknown as ExtensionState,
    getTargetTab: async () =>
      ({ id: 7, url: options.tabUrl || 'https://app.example.com/' }) as TabWithId,
    evaluateInTabContext: async <TValue = unknown>(
      tabId: unknown,
      expression: string,
    ): Promise<{ tab: TabWithId; response: { result: unknown }; value: TValue | null }> => {
      evalCalls.push({ tabId, expression })
      return { tab: { id: 7 } as TabWithId, response: { result: null }, value: null }
    },
    sendDebuggerCommand: async <TResult>(
      tabId: number,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<TResult> => {
      debuggerCalls.push({ tabId, method, params })
      return {} as TResult
    },
    storageLocalGet: async () => ({}) as never,
    storageLocalSet: async () => {},
  })

  return { session, evalCalls, debuggerCalls }
}

describe('session storage --session', () => {
  test('session 模式下的 get/set/clear/delete 走 sessionStorage', async () => {
    const { session, evalCalls } = createSessionEvalHarness()

    await session.storageGet(7, 'k', null, true)
    await session.storageSet(7, 'k', 'v', null, true)
    await session.storageDelete(7, 'k', null, true)
    await session.storageClear(7, null, true)

    expect(evalCalls[0]?.expression).toContain('sessionStorage.getItem("k")')
    expect(evalCalls[1]?.expression).toContain('sessionStorage.setItem("k", "v")')
    expect(evalCalls[2]?.expression).toContain('sessionStorage.removeItem("k")')
    expect(evalCalls[3]?.expression).toContain('sessionStorage.clear()')
  })

  test('默认仍走 localStorage', async () => {
    const { session, evalCalls } = createSessionEvalHarness()

    await session.storageGet(7, 'k', null)
    await session.storageDelete(7, 'k', null)

    expect(evalCalls[0]?.expression).toContain('localStorage.getItem("k")')
    expect(evalCalls[1]?.expression).toContain('localStorage.removeItem("k")')
  })

  test('session 模式下读取全部 key 枚举 sessionStorage', async () => {
    const { session, evalCalls } = createSessionEvalHarness()

    await session.storageGet(7, null, null, true)

    expect(evalCalls[0]?.expression).toContain('sessionStorage.length')
    expect(evalCalls[0]?.expression).not.toContain('localStorage')
  })
})

describe('session set permission/ua/timezone/locale', () => {
  test('setPermission 授权到当前 tab origin', async () => {
    const { session, debuggerCalls } = createSessionEvalHarness({
      tabUrl: 'https://app.example.com/path?q=1',
    })

    await session.setPermission(7, 'geolocation')

    const call = debuggerCalls.find((item) => item.method === 'Browser.setPermission')
    expect(call?.params).toEqual({
      permission: { name: 'geolocation' },
      setting: 'granted',
      origin: 'https://app.example.com',
    })
  })

  test('setPermission --reset 恢复默认设置', async () => {
    const { session, debuggerCalls } = createSessionEvalHarness()

    await session.setPermission(7, 'clipboard-read', true)

    const call = debuggerCalls.find((item) => item.method === 'Browser.setPermission')
    expect(call?.params?.setting).toBe('default')
  })

  test('setUserAgent 空字符串恢复默认', async () => {
    const { session, debuggerCalls } = createSessionEvalHarness()

    await session.setUserAgent(7, 'My Agent 1.0')
    await session.setUserAgent(7, null)

    const calls = debuggerCalls.filter((item) => item.method === 'Emulation.setUserAgentOverride')
    expect(calls[0]?.params).toEqual({ userAgent: 'My Agent 1.0' })
    expect(calls[1]?.params).toEqual({ userAgent: '' })
  })

  test('setTimezone / setLocale 透传覆盖值，空值恢复', async () => {
    const { session, debuggerCalls } = createSessionEvalHarness()

    await session.setTimezone(7, 'Asia/Shanghai')
    await session.setLocale(7, 'zh-CN')
    await session.setLocale(7, null)

    const timezoneCall = debuggerCalls.find(
      (item) => item.method === 'Emulation.setTimezoneOverride',
    )
    const localeCalls = debuggerCalls.filter(
      (item) => item.method === 'Emulation.setLocaleOverride',
    )
    expect(timezoneCall?.params).toEqual({ timezoneId: 'Asia/Shanghai' })
    expect(localeCalls[0]?.params).toEqual({ locale: 'zh-CN' })
    expect(localeCalls[1]?.params).toEqual({ locale: '' })
  })
})

function createEmulationHarness() {
  const state = {
    session: { emulation: new Map<number, Record<string, unknown>>() },
  } as unknown as ExtensionState
  const session = createSessionDomain({
    state,
    getTargetTab: async () => ({ id: 7 }) as TabWithId,
    evaluateInTabContext: async () =>
      ({ tab: { id: 7 } as TabWithId, response: { result: null }, value: null }) as never,
    sendDebuggerCommand: async <TResult>(): Promise<TResult> => ({}) as TResult,
    storageLocalGet: async () => ({}) as never,
    storageLocalSet: async () => {},
  })
  return { session, state }
}

describe('session emulation overrides tracking', () => {
  test('records the keys that are actively overridden', async () => {
    const { session, state } = createEmulationHarness()

    await session.setViewport(7, 1280, 720)
    await session.setOffline(7, true)
    await session.setGeo(7, 31.2, 121.5)
    await session.setUserAgent(7, 'My Agent 1.0')
    await session.setHeaders(7, { 'x-api-key': 'secret' })
    await session.setMedia(7, 'dark')
    await session.setTimezone(7, 'Asia/Shanghai')
    await session.setLocale(7, 'zh-CN')

    expect(state.session.emulation.get(7)).toEqual({
      viewport: true,
      offline: true,
      geo: true,
      ua: true,
      headers: ['x-api-key'],
      media: true,
      timezone: true,
      locale: true,
    })
  })

  test('reset values remove their override keys and empty records are dropped', async () => {
    const { session, state } = createEmulationHarness()

    await session.setUserAgent(7, 'My Agent 1.0')
    await session.setLocale(7, 'zh-CN')
    await session.setTimezone(7, 'Asia/Shanghai')
    await session.setMedia(7, 'dark')
    await session.setOffline(7, true)
    await session.setHeaders(7, { 'x-api-key': 'secret' })

    // 空值/恢复默认：对应键从覆盖摘要里删除
    await session.setUserAgent(7, null)
    await session.setLocale(7, '')
    await session.setTimezone(7, null)
    await session.setMedia(7, null)
    await session.setOffline(7, false)
    await session.setHeaders(7, {})

    // 全部恢复默认后整条记录删除，meta 不再回显 emulation
    expect(state.session.emulation.get(7)).toBeUndefined()
  })
})
