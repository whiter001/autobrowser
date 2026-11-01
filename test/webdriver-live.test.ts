import { describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWebDriverCommandHandler } from '../src/cli/webdriver.js'

const runLive = process.env.AUTOBROWSER_WEBDRIVER_LIVE === '1'
const suite = runLive ? describe : describe.skip

const SMOKE_PAGE_HTML = `<!doctype html>
<html>
  <head><title>WebDriver smoke</title></head>
  <body>
    <input id="name">
    <button id="save">Save</button>
  </body>
</html>`

/**
 * 起一个本地 HTTP 服务提供 smoke 页面。
 *
 * 不能用 data: URL：Firefox 对 data: URL 页面禁用 localStorage，
 * 写入会抛 SecurityError: The operation is insecure，
 * 会让 storage 断言在真实 driver 上永远失败。
 * 用普通 http 源才有正常的同源存储语义。
 */
async function startSmokePageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(SMOKE_PAGE_HTML)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind the webdriver smoke page http server')
  }
  return {
    url: `http://127.0.0.1:${address.port}/webdriver-smoke.html`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

for (const engine of ['firefox', 'webkit'] as const) {
  suite(`${engine} WebDriver live smoke`, () => {
    test('navigates, snapshots, interacts, stores and captures a real PNG', async () => {
      const homeDir = await mkdtemp(path.join(os.tmpdir(), `autobrowser-${engine}-live-`))
      const page = await startSmokePageServer()
      const handler = createWebDriverCommandHandler({
        engine,
        driverUrl:
          process.env[`AUTOBROWSER_${engine.toUpperCase()}_DRIVER_URL`] ||
          (engine === 'firefox' ? 'http://127.0.0.1:4444' : 'http://127.0.0.1:4723'),
        homeDir,
      })
      try {
        expect(await handler('goto', { url: page.url })).toMatchObject({
          ok: true,
        })
        expect(await handler('snapshot', {})).toMatchObject({
          ok: true,
          result: { elements: expect.any(Array) },
        })
        expect(await handler('fill', { selector: '#name', value: 'Ada' })).toMatchObject({
          ok: true,
        })
        expect(await handler('get', { attr: 'value', selector: '#name' })).toMatchObject({
          ok: true,
          result: 'Ada',
        })
        expect(
          await handler('storage', { action: 'set', key: 'smoke', value: 'ok' }),
        ).toMatchObject({
          ok: true,
        })
        expect(await handler('storage', { action: 'get', key: 'smoke' })).toMatchObject({
          ok: true,
          result: { key: 'smoke', value: 'ok' },
        })
        const screenshot = await handler('screenshot', {})
        expect(screenshot.ok).toBe(true)
        const screenshotResult = screenshot.result as { mimeType?: string; data?: string }
        expect(screenshotResult.mimeType).toBe('image/png')
        // 不要用 toMatchObject + expect.any(String) 断言 data：
        // toMatchObject 会把匹配上的字段原地替换成 matcher 占位对象，
        // 之后再读 result.data 拿到的不是字符串，.length 断言会失败。
        expect(typeof screenshotResult.data).toBe('string')
        expect((screenshotResult.data as string).length).toBeGreaterThan(100)
      } finally {
        await handler('close', { all: true })
        await page.close()
        await rm(homeDir, { recursive: true, force: true })
      }
    }, 60_000)
  })
}
