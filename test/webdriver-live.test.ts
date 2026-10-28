import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWebDriverCommandHandler } from '../src/cli/webdriver.js'

const runLive = process.env.AUTOBROWSER_WEBDRIVER_LIVE === '1'
const suite = runLive ? describe : describe.skip

for (const engine of ['firefox', 'webkit'] as const) {
  suite(`${engine} WebDriver live smoke`, () => {
    test('navigates, snapshots, interacts, stores and captures a real PNG', async () => {
      const homeDir = await mkdtemp(path.join(os.tmpdir(), `autobrowser-${engine}-live-`))
      const handler = createWebDriverCommandHandler({
        engine,
        driverUrl:
          process.env[`AUTOBROWSER_${engine.toUpperCase()}_DRIVER_URL`] ||
          (engine === 'firefox' ? 'http://127.0.0.1:4444' : 'http://127.0.0.1:4723'),
        homeDir,
      })
      try {
        expect(
          await handler('goto', {
            url: 'data:text/html,<title>WebDriver smoke</title><input id="name"><button id="save">Save</button>',
          }),
        ).toMatchObject({ ok: true })
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
        expect(screenshot).toMatchObject({
          ok: true,
          result: { mimeType: 'image/png', data: expect.any(String) },
        })
        expect((screenshot.result as { data: string }).data.length).toBeGreaterThan(100)
      } finally {
        await handler('close', { all: true })
        await rm(homeDir, { recursive: true, force: true })
      }
    }, 60_000)
  })
}
