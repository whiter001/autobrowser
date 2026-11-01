import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWebDriverCommandHandler } from '../src/cli/webdriver.js'
import { getStateDir, writeJsonFile } from '../src/core/protocol.js'

interface RecordedRequest {
  method: string
  url: string
  body: unknown
}

/**
 * 极简 DOM 桩，只覆盖 WebDriver 适配器脚本真正用到的能力。
 *
 * 关键点：execute/sync 必须**真的执行脚本**并按 W3C 语义取值。
 * W3C 规定 execute/sync 的 body 是函数体，脚本必须显式 return 才有返回值；
 * 裸 IIFE（`(() => {...})()`）会被当成未返回的表达式语句，value 恒为 null。
 * 早期 mock 无视脚本内容直接返回预设结果，因此这类缺陷无法被测出来。
 */
interface StubElement {
  tagName: string
  attributes: Record<string, string>
  textContent: string
  innerText: string
  html: string
  value?: string
  disabled?: boolean
  checked?: boolean
  rect: { width: number; height: number }
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
}

function createStubElement(tagName: string, overrides: Partial<StubElement> = {}): StubElement {
  const base: StubElement = {
    tagName: tagName.toUpperCase(),
    attributes: {},
    textContent: '',
    innerText: '',
    html: '',
    rect: { width: 100, height: 20 },
    getAttribute(name: string) {
      return this.attributes[name] ?? null
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, ...this.rect }
    },
  }
  return { ...base, ...overrides }
}

function createStubDocument() {
  const elements: StubElement[] = []
  const documentStub = {
    title: 'Example',
    activeElement: null as StubElement | null,
    querySelector(selector: string): StubElement | null {
      return elements.find((element) => matchesStubSelector(element, selector)) ?? null
    },
    querySelectorAll(selector: string): StubElement[] {
      return elements.filter((element) => matchesStubSelector(element, selector))
    },
    getElementById: (id: string) =>
      elements.find((element) => element.attributes.id === id) ?? null,
  }
  return { documentStub, elements }
}

/** 只支持适配器脚本实际用到的选择器：标签名、#id、.class，以及逗号分隔的组合。 */
function matchesStubSelector(element: StubElement, selector: string): boolean {
  const trimmed = selector.trim()
  if (!trimmed) return false
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSingleSelector(element, part))
}

function matchesSingleSelector(element: StubElement, selector: string): boolean {
  if (selector.startsWith('#')) return element.attributes.id === selector.slice(1)
  if (selector.startsWith('.')) {
    const className = selector.slice(1)
    return (element.attributes.class ?? '').split(/\s+/).includes(className)
  }
  if (selector.startsWith('[')) {
    // 形如 [role] / [data-x="value"]：匹配存在该属性（且值相等）的元素。
    const inner = selector.replace(/^\[|\]$/g, '')
    const separator = inner.indexOf('=')
    if (separator < 0) return inner in element.attributes
    const name = inner.slice(0, separator).trim()
    const expected = inner
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    return element.attributes[name] === expected
  }
  return element.tagName.toLowerCase() === selector.toLowerCase()
}

/**
 * 按 W3C execute/sync 语义执行脚本：body 是函数体，隐式返回最后一个 return 的值。
 * 用 new Function 构造真实函数作用域，而不是 eval。
 */
function executeScriptInProtocol(script: string, scope: Record<string, unknown>): unknown {
  const factory = new Function(...Object.keys(scope), `"use strict";\n${script}`) as (
    ...args: unknown[]
  ) => unknown
  return factory(...Object.values(scope))
}

/** 极简 Storage 桩，够适配器的 get/set/delete/clear 使用。 */
function createStorageStub() {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => (entries.has(key) ? entries.get(key)! : null),
    setItem: (key: string, value: string) => {
      entries.set(key, String(value))
    },
    removeItem: (key: string) => {
      entries.delete(key)
    },
    clear: () => {
      entries.clear()
    },
    get length() {
      return entries.size
    },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
  }
}

function createDriverMock(options: { elements?: StubElement[] } = {}) {
  const requests: RecordedRequest[] = []
  let sessionCreates = 0
  let currentUrl = 'about:blank'
  let invalidStoredSession = false
  const { documentStub, elements } = createStubDocument()
  for (const element of options.elements ?? []) {
    elements.push(element)
  }
  // 同一会话内 localStorage / sessionStorage 是持久存储，
  // 必须复用同一个实例，否则 set 之后 get 读不到值。
  const localStorage = createStorageStub()
  const sessionStorage = createStorageStub()
  const fetchImpl = (async (input, init = {}) => {
    const url = String(input)
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : null
    requests.push({ method, url, body })
    if (url.endsWith('/session') && method === 'POST') {
      sessionCreates += 1
      return Response.json({ value: { sessionId: `session-${sessionCreates}`, capabilities: {} } })
    }
    if (url.includes('/session/stale/url')) {
      invalidStoredSession = true
      return Response.json(
        { value: { error: 'invalid session id', message: 'stale session' } },
        { status: 404 },
      )
    }
    if (url.endsWith('/url') && method === 'GET') return Response.json({ value: currentUrl })
    if (url.endsWith('/url') && method === 'POST') {
      currentUrl = String(body.url)
      return Response.json({ value: null })
    }
    if (url.endsWith('/title')) return Response.json({ value: 'Example' })
    if (url.endsWith('/execute/sync')) {
      const script = String(body.script)
      // 真实执行脚本：只有显式 return 的脚本才有返回值，
      // 裸 IIFE 会得到 undefined -> null，与真实 driver 行为一致。
      const value = executeScriptInProtocol(script, {
        document: documentStub,
        window: { document: documentStub },
        location: { href: currentUrl },
        getComputedStyle: (_node: StubElement) => ({
          display: 'block',
          visibility: 'visible',
        }),
        localStorage,
        sessionStorage,
      })
      return Response.json({ value: value === undefined ? null : value })
    }
    if (url.endsWith('/element') && method === 'POST') {
      return Response.json({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-1' } })
    }
    if (url.endsWith('/screenshot')) return Response.json({ value: 'cG5nLWRhdGE=' })
    if (url.endsWith('/cookie') && method === 'GET') {
      return Response.json({ value: [{ name: 'sid', domain: 'example.com', path: '/' }] })
    }
    return Response.json({ value: null })
  }) as typeof fetch
  return {
    requests,
    fetchImpl,
    elements,
    getSessionCreates: () => sessionCreates,
    wasStale: () => invalidStoredSession,
  }
}

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-webdriver-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('WebDriver engine adapter', () => {
  test('creates Firefox with standard capabilities, navigates and reuses the persisted session', async () => {
    await withTempHome(async (home) => {
      const mock = createDriverMock()
      const options = {
        engine: 'firefox' as const,
        driverUrl: 'http://127.0.0.1:4444',
        homeDir: home,
        fetchImpl: mock.fetchImpl,
      }
      const first = createWebDriverCommandHandler(options)
      expect(await first('goto', { url: 'https://example.com' })).toMatchObject({
        ok: true,
        result: { url: 'https://example.com', title: 'Example' },
      })
      const create = mock.requests.find((request) => request.url.endsWith('/session'))
      expect(create?.body).toMatchObject({
        capabilities: { alwaysMatch: { browserName: 'firefox' } },
      })

      const second = createWebDriverCommandHandler(options)
      expect((await second('status', {})).ok).toBe(true)
      expect(mock.getSessionCreates()).toBe(1)
    })
  })

  test('uses Safari capabilities and native element interaction endpoints', async () => {
    await withTempHome(async (home) => {
      const mock = createDriverMock()
      const handler = createWebDriverCommandHandler({
        engine: 'webkit',
        driverUrl: 'http://127.0.0.1:4723',
        homeDir: home,
        fetchImpl: mock.fetchImpl,
      })
      await handler('click', { selector: '#save' })
      await handler('fill', { selector: '#name', value: 'Ada' })
      await handler('type', { selector: '#name', value: 'Lovelace', submit: true })
      const create = mock.requests.find((request) => request.url.endsWith('/session'))
      expect(create?.body).toMatchObject({
        capabilities: { alwaysMatch: { browserName: 'safari' } },
      })
      expect(
        mock.requests.some((request) => request.url.endsWith('/element/element-1/click')),
      ).toBe(true)
      expect(
        mock.requests.some((request) => request.url.endsWith('/element/element-1/clear')),
      ).toBe(true)
      const input = mock.requests
        .filter((request) => request.url.endsWith('/element/element-1/value'))
        .at(-1)
      expect(input?.body).toMatchObject({ text: 'Lovelace\ue007' })
    })
  })

  test('returns real driver-shaped snapshot, storage, cookies and PNG screenshot results', async () => {
    await withTempHome(async (home) => {
      const mock = createDriverMock({
        elements: [
          createStubElement('button', {
            innerText: 'Save',
            attributes: { role: 'button' },
          }),
        ],
      })
      const handler = createWebDriverCommandHandler({
        engine: 'firefox',
        driverUrl: 'http://127.0.0.1:4444',
        homeDir: home,
        fetchImpl: mock.fetchImpl,
      })
      expect(await handler('snapshot', {})).toMatchObject({
        ok: true,
        result: { elements: [{ ref: '@e1', role: 'button' }] },
      })
      expect(
        await handler('storage', { action: 'set', key: 'key', value: 'stored' }),
      ).toMatchObject({
        ok: true,
        result: { key: 'key', value: 'stored' },
      })
      expect(await handler('storage', { action: 'get', key: 'key' })).toMatchObject({
        ok: true,
        result: { key: 'key', value: 'stored' },
      })
      expect(await handler('cookies', { action: 'get' })).toMatchObject({
        ok: true,
        result: { cookies: [{ name: 'sid' }] },
      })
      expect(await handler('screenshot', {})).toMatchObject({
        ok: true,
        result: { data: 'cG5nLWRhdGE=', mimeType: 'image/png' },
      })
    })
  })

  test('executes injected scripts with W3C semantics so script-backed commands return real values', async () => {
    // 回归：W3C execute/sync 的 body 是函数体，必须显式 return 才有返回值。
    // 之前的实现用裸 IIFE（`(() => {...})()`），真实 driver 上 value 恒为 null，
    // 导致 snapshot/get/is/storage 全部失败；旧 mock 直接返回预设结果，掩盖了该问题。
    await withTempHome(async (home) => {
      const mock = createDriverMock({
        elements: [
          createStubElement('h1', { innerText: 'Hello', textContent: 'Hello' }),
          createStubElement('button', { innerText: 'Save', attributes: { role: 'button' } }),
        ],
      })
      const handler = createWebDriverCommandHandler({
        engine: 'firefox',
        driverUrl: 'http://127.0.0.1:4444',
        homeDir: home,
        fetchImpl: mock.fetchImpl,
      })

      const snapshot = await handler('snapshot', {})
      expect(snapshot.ok).toBe(true)
      expect(snapshot.result).toMatchObject({
        elements: [{ ref: '@e1', role: 'button', text: 'Save' }],
      })

      expect(await handler('get', { attr: 'text', selector: 'h1' })).toMatchObject({
        ok: true,
        result: 'Hello',
      })
      expect(await handler('is', { selector: 'h1', state: 'visible' })).toMatchObject({
        ok: true,
        result: true,
      })
      expect(await handler('storage', { action: 'set', key: 'k', value: 'v' })).toMatchObject({
        ok: true,
        result: { key: 'k', value: 'v' },
      })
      expect(await handler('storage', { action: 'get', key: 'k' })).toMatchObject({
        ok: true,
        result: { key: 'k', value: 'v' },
      })

      // 显式断言协议层语义：所有注入脚本都必须带显式 return。
      const scripts = mock.requests
        .filter((request) => request.url.endsWith('/execute/sync'))
        .map((request) => String((request.body as { script: string }).script))
      expect(scripts.length).toBeGreaterThan(0)
      for (const script of scripts) {
        expect(script.trimStart().startsWith('return ')).toBe(true)
      }
    })
  })

  test('returns structured unsupported errors without creating a browser session', async () => {
    await withTempHome(async (home) => {
      const mock = createDriverMock()
      const handler = createWebDriverCommandHandler({
        engine: 'webkit',
        driverUrl: 'http://127.0.0.1:4723',
        homeDir: home,
        fetchImpl: mock.fetchImpl,
      })
      expect(await handler('network', { action: 'requests' })).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_CAPABILITY_UNSUPPORTED', details: { engine: 'webkit' } },
      })
      expect(await handler('screenshot', { full: true })).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_CAPABILITY_UNSUPPORTED' },
      })
      expect(
        await handler('goto', {
          url: 'https://example.com',
          waitFor: 'selector',
          selector: 'article',
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_CAPABILITY_UNSUPPORTED' },
      })
      expect(mock.getSessionCreates()).toBe(0)
    })
  })

  test('replaces only an invalid stored session and preserves command errors', async () => {
    await withTempHome(async (home) => {
      await writeJsonFile(path.join(getStateDir(home), 'webdriver-firefox.json'), {
        sessionId: 'stale',
      })
      const mock = createDriverMock()
      const handler = createWebDriverCommandHandler({
        engine: 'firefox',
        driverUrl: 'http://127.0.0.1:4444',
        homeDir: home,
        fetchImpl: mock.fetchImpl,
      })
      expect(await handler('status', {})).toMatchObject({ ok: true })
      expect(mock.wasStale()).toBe(true)
      expect(mock.getSessionCreates()).toBe(1)
    })
  })

  test('reports driver connection failures with an actionable error', async () => {
    await withTempHome(async (home) => {
      const handler = createWebDriverCommandHandler({
        engine: 'webkit',
        driverUrl: 'http://127.0.0.1:4723',
        homeDir: home,
        fetchImpl: (async () => {
          throw new Error('connection refused')
        }) as unknown as typeof fetch,
      })
      expect(await handler('status', {})).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_DRIVER_UNAVAILABLE' },
      })
    })
  })
})
