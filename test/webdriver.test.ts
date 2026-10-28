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

function createDriverMock() {
  const requests: RecordedRequest[] = []
  let sessionCreates = 0
  let currentUrl = 'about:blank'
  let invalidStoredSession = false
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
      if (script.includes('localStorage') || script.includes('sessionStorage')) {
        return Response.json({ value: { key: 'key', value: 'stored' } })
      }
      return Response.json({
        value: {
          snapshotId: 'webdriver-1',
          elements: [{ ref: '@e1', role: 'button', text: 'Save' }],
          frames: [],
        },
      })
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
      const mock = createDriverMock()
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
