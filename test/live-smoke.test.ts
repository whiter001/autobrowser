import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getStatus, requestCommandRaw, type CommandResponse } from '../src/cli/client.js'
import { getExtensionId, getExtensionUrl } from '../src/core/extension.js'
import { startServers } from '../src/server.js'

// 真实浏览器冒烟测试（opt-in）：
//   AUTOBROWSER_LIVE=1 bun test test/live-smoke.test.ts
// 默认 bun test 走 bun:test 的 skip 机制，不依赖 Chrome。
const LIVE_TOKEN = 'live-smoke-token'
const EXTENSION_DIR = path.resolve(import.meta.dir, '..', 'chrome')

const SMOKE_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>autobrowser live smoke</title>
  </head>
  <body>
    <h1 id="live-smoke-heading">Live Smoke Test</h1>
    <p id="counter">0</p>
    <button id="increment">Increment</button>
    <input id="name-input" type="text" placeholder="enter name" />
    <script>
      const counter = document.getElementById('counter');
      const button = document.getElementById('increment');
      let count = 0;
      button.addEventListener('click', () => {
        count += 1;
        counter.textContent = String(count);
      });
    </script>
  </body>
</html>`

const liveEnabled = process.env.AUTOBROWSER_LIVE === '1'
const extensionBuilt = existsSync(path.join(EXTENSION_DIR, 'manifest.json'))
// Chrome 137+ 的品牌版（如本机 Chrome 150）会静默忽略 --load-extension，只有
// Chrome for Testing 能可靠加载扩展。候选顺序：CHROME_BIN 环境变量（显式指定）
// → Playwright 缓存里的 CfT（按 revision 降序）→ 系统 Chrome 兜底。
const chromeBinaries = resolveBinaries()

if (liveEnabled && chromeBinaries.length === 0) {
  console.warn(
    '[live-smoke] AUTOBROWSER_LIVE=1 set but no Chrome binary was found (checked CHROME_BIN, the Playwright cache and common install paths); skipping live smoke test',
  )
}
if (liveEnabled && !extensionBuilt) {
  console.warn(
    `[live-smoke] AUTOBROWSER_LIVE=1 set but ${EXTENSION_DIR} is not built; run 'bun run build:chrome' first; skipping live smoke test`,
  )
}

const runLive = liveEnabled && chromeBinaries.length > 0 && extensionBuilt
const suite = runLive ? describe : describe.skip

interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  close(): void
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a test port')))
        return
      }

      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(
  description: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return
    }
    await Bun.sleep(250)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`)
}

function connectCdp(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    // 新版 Chrome 会校验 CDP WebSocket 的 Origin；Bun 客户端默认不带 Origin 头，
    // 配合 Chrome 侧 --remote-allow-origins=* 可放行（也兜底其它客户端）。
    const socket = new WebSocket(wsUrl)
    const pending = new Map<
      number,
      { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }
    >()
    let nextId = 1

    const timer = setTimeout(() => {
      reject(new Error(`timed out connecting to CDP endpoint ${wsUrl} after ${timeoutMs}ms`))
      try {
        socket.close()
      } catch {
        // 连接可能尚未建立，close 抛异常可忽略
      }
    }, timeoutMs)

    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send(method, params = {}) {
          return new Promise<Record<string, unknown>>((resolveSend, rejectSend) => {
            const id = nextId++
            pending.set(id, { resolve: resolveSend, reject: rejectSend })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close() {
          try {
            socket.close()
          } catch {
            // 连接已关闭时 close 抛异常可忽略
          }
        },
      })
    })

    socket.addEventListener('message', (event) => {
      let message: {
        id?: number
        result?: Record<string, unknown>
        error?: { message?: string }
      } | null
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }
      if (!message || typeof message.id !== 'number') {
        return
      }
      const waiter = pending.get(message.id)
      if (!waiter) {
        return
      }
      pending.delete(message.id)
      if (message.error) {
        waiter.reject(new Error(message.error.message || 'CDP command failed'))
      } else {
        waiter.resolve(message.result || {})
      }
    })

    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`CDP connection to ${wsUrl} failed`))
    })

    socket.addEventListener('close', () => {
      clearTimeout(timer)
      for (const waiter of pending.values()) {
        waiter.reject(new Error('CDP connection closed before the command completed'))
      }
      pending.clear()
    })
  })
}

function findChromeForTesting(): string[] {
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(cacheDir)) {
    return []
  }

  let entries: string[] = []
  try {
    entries = readdirSync(cacheDir)
  } catch {
    return []
  }

  const revisions = entries
    .filter((entry) => /^chromium-(\d+)$/.test(entry))
    .map((entry) => {
      const revision = /^chromium-(\d+)$/.exec(entry)?.[1] ?? '0'
      return { dir: entry, revision: Number.parseInt(revision, 10) }
    })
    .sort((a, b) => b.revision - a.revision)

  const found: string[] = []
  for (const { dir } of revisions) {
    const base = path.join(cacheDir, dir)
    const candidates: string[] = []
    if (process.platform === 'darwin') {
      // Playwright 的 Chrome for Testing 目录形如 chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app
      for (const archDir of ['chrome-mac-arm64', 'chrome-mac']) {
        const appDir = path.join(base, archDir)
        if (!existsSync(appDir)) {
          continue
        }
        for (const appName of readdirSync(appDir)) {
          if (!appName.endsWith('.app')) {
            continue
          }
          const macosDir = path.join(appDir, appName, 'Contents', 'MacOS')
          if (!existsSync(macosDir)) {
            continue
          }
          for (const executable of readdirSync(macosDir)) {
            candidates.push(path.join(macosDir, executable))
          }
        }
      }
    } else if (process.platform === 'linux') {
      candidates.push(path.join(base, 'chrome-linux', 'chrome'))
    } else if (process.platform === 'win32') {
      candidates.push(path.join(base, 'chrome-win', 'chrome.exe'))
    }
    for (const candidate of candidates) {
      if (existsSync(candidate) && !found.includes(candidate)) {
        found.push(candidate)
      }
    }
  }
  return found
}

function resolveBinaries(): string[] {
  const explicit = process.env.CHROME_BIN
  const binaries = new Set<string>()
  if (explicit) {
    binaries.add(explicit)
  } else {
    for (const bin of findChromeForTesting()) {
      binaries.add(bin)
    }
    if (process.platform === 'darwin') {
      binaries.add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    } else if (process.platform === 'win32') {
      binaries.add(
        path.join(
          process.env.PROGRAMFILES || 'C:\\Program Files',
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
      )
    } else {
      binaries.add('/usr/bin/google-chrome')
      binaries.add('/usr/bin/chromium')
      binaries.add('/usr/bin/chromium-browser')
    }
  }
  return [...binaries].filter((bin) => existsSync(bin))
}

function launchChrome(
  bin: string,
  profileDir: string,
): { process: ChildProcess; stderr: () => string } {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
  ]
  const process = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  process.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000)
  })
  // 候选二进制可能不可执行（spawn 异步抛 error）；若不监听会触发未处理的
  // error 事件直接中断测试，而这里应让它在 DevToolsActivePort 超时后换下一个候选
  process.once('error', () => {})
  return { process, stderr: () => stderr }
}

async function killChrome(process: ChildProcess | null): Promise<void> {
  if (!process || !process.pid) {
    return
  }
  try {
    process.kill('SIGTERM')
  } catch {
    // 进程可能已经退出
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && process.exitCode === null) {
    await Bun.sleep(200)
  }
  if (process.exitCode === null) {
    try {
      process.kill('SIGKILL')
    } catch {
      // 进程可能已经退出
    }
  }
}

async function waitForDevToolsActivePort(profileDir: string, timeoutMs: number): Promise<string> {
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const content = await readFile(portFile, 'utf8')
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const port = Number.parseInt(lines[0] || '', 10)
      if (lines.length >= 2 && Number.isInteger(port) && port > 0) {
        // 第二行是 browser 级 WebSocket 路径，如 /devtools/browser/<uuid>
        return `ws://127.0.0.1:${port}${lines[1]}`
      }
    } catch {
      // DevToolsActivePort 尚未写入，继续轮询
    }
    await Bun.sleep(250)
  }
  throw new Error(`Chrome did not write DevToolsActivePort within ${timeoutMs}ms`)
}

suite('live browser smoke test', () => {
  let baseUrl = ''
  let pageUrl = ''
  let homeDir = ''
  let userDataDir = ''
  let server: { stop(): void } | null = null
  let httpServer: HttpServer | null = null
  let chromeProcess: ChildProcess | null = null
  let chromeStderr = ''
  let cdp: CdpClient | null = null

  async function command(
    commandName: string,
    args: Record<string, unknown> = {},
  ): Promise<CommandResponse> {
    return await requestCommandRaw(baseUrl, commandName, args, { token: LIVE_TOKEN })
  }

  beforeAll(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-live-home-'))
    const relayPort = await getFreePort()
    const ipcPort = await getFreePort()
    server = await startServers({
      homeDir,
      relayPort,
      ipcPort,
      token: LIVE_TOKEN,
    })
    baseUrl = `http://127.0.0.1:${ipcPort}`

    httpServer = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(SMOKE_PAGE_HTML)
    })
    const httpPort = await new Promise<number>((resolve, reject) => {
      httpServer?.once('error', reject)
      httpServer?.listen(0, '127.0.0.1', () => {
        const address = httpServer?.address()
        if (!address || typeof address === 'string') {
          reject(new Error('failed to bind the smoke page http server'))
          return
        }
        resolve(address.port)
      })
    })
    pageUrl = `http://127.0.0.1:${httpPort}/live-smoke.html`

    // 逐个候选启动 Chrome 并验证扩展真的连上了 relay；失败则清理后换下一个
    let lastError: Error | null = null
    for (const bin of chromeBinaries) {
      userDataDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-live-chrome-'))
      try {
        const launched = launchChrome(bin, userDataDir)
        chromeProcess = launched.process
        chromeStderr = launched.stderr()

        let devtoolsWsUrl: string
        try {
          devtoolsWsUrl = await waitForDevToolsActivePort(userDataDir, 20_000)
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nChrome binary: ${bin}\nChrome stderr:\n${chromeStderr}`,
          )
        }
        cdp = await connectCdp(devtoolsWsUrl)

        const connectUrl = getExtensionUrl(
          '/connect.html',
          {
            token: LIVE_TOKEN,
            relayPort,
            ipcPort,
          },
          getExtensionId(),
        )
        await cdp.send('Target.createTarget', { url: connectUrl })

        // MV3 的 service worker 是懒启动的，CDP target 列表里看不到扩展，
        // 因此以 relay 侧的 extensionConnected 作为扩展真正加载并连上的判据
        await waitFor(
          'the extension to connect to the relay server',
          async () => {
            const status = await getStatus(baseUrl)
            return status.extensionConnected === true
          },
          25_000,
        )
        break
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        // 本候选失败：清理 Chrome 进程与 user-data-dir，继续尝试下一个候选
        cdp?.close()
        cdp = null
        await killChrome(chromeProcess)
        chromeProcess = null
        await rm(userDataDir, { recursive: true, force: true })
        userDataDir = ''
      }
    }

    if (!chromeProcess) {
      throw new Error(
        [
          'no Chrome binary could load the autobrowser extension; tried:',
          ...chromeBinaries.map((bin) => `  - ${bin}`),
          'Chrome 137+ branded builds silently ignore --load-extension. Install Chrome for Testing',
          "(e.g. 'bunx playwright install chromium', or place it under the Playwright cache) or set CHROME_BIN.",
          `Last failure: ${lastError?.message || 'unknown'}`,
        ].join('\n'),
      )
    }

    await cdp!.send('Target.createTarget', { url: pageUrl })

    // 通过 tab.list 定位冒烟页面 tab 并选中，之后命令无需再显式传 tab
    let smokeTab: { handle?: string; url?: string } | null = null
    await waitFor(
      'the smoke page tab to appear in tab.list',
      async () => {
        const response = await command('tab.list')
        if (!response.ok) {
          return false
        }
        const tabs =
          (response.result as { tabs?: Array<{ handle?: string; url?: string }> })?.tabs || []
        smokeTab = tabs.find((tab) => String(tab.url).includes('live-smoke.html')) || null
        return smokeTab !== null
      },
      15_000,
    )

    const selectResponse = await command('tab.select', { handle: smokeTab!.handle })
    if (!selectResponse.ok) {
      throw new Error(
        `tab.select failed: ${JSON.stringify(selectResponse.error || selectResponse)}`,
      )
    }
  }, 180_000)

  afterAll(async () => {
    cdp?.close()
    cdp = null

    await killChrome(chromeProcess)
    chromeProcess = null

    server?.stop()
    server = null

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer?.close(() => resolve())
      })
      httpServer = null
    }

    // 先删 Chrome 的 user-data-dir，再稍作延迟删 homeDir：runtime 的
    // schedulePersist 可能仍在异步写 homeDir/.autobrowser/state.json，
    // 立刻删除会让写盘的原子 rename 因目标目录缺失而抛 ENOENT。
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true })
      userDataDir = ''
    }
    if (homeDir) {
      await Bun.sleep(400)
      await rm(homeDir, { recursive: true, force: true })
      homeDir = ''
    }
  }, 30_000)

  test('goto loads the local smoke page', async () => {
    const response = await command('goto', { url: pageUrl })
    expect(response.ok).toBe(true)
    expect(response.error).toBeUndefined()
    const result = response.result as { tabId?: number; url?: string }
    expect(typeof result.tabId).toBe('number')
    expect(result.url).toBe(pageUrl)

    // Page.navigate 不等待加载完成，先等关键元素可见再继续
    const waitResponse = await command('wait', {
      type: 'selector',
      selector: '#increment',
      timeout: 15_000,
    })
    expect(waitResponse.ok).toBe(true)
  }, 30_000)

  test('snapshot exposes element refs and page state', async () => {
    const response = await command('snapshot')
    expect(response.ok).toBe(true)
    const result = response.result as {
      url?: string
      pageEpoch?: number
      title?: string | null
      text?: string
      elements?: Array<{ ref?: string }>
    }
    expect(result.url).toBe(pageUrl)
    expect(typeof result.pageEpoch).toBe('number')
    expect(result.title).toBe('autobrowser live smoke')
    expect(typeof result.text).toBe('string')
    const elements = result.elements || []
    expect(elements.length).toBeGreaterThan(0)
    expect(elements.some((element) => String(element.ref || '').startsWith('@e'))).toBe(true)
  }, 30_000)

  test('search finds visible page text', async () => {
    const response = await command('search', { query: 'Increment', context: 3, limit: 10 })
    expect(response.ok).toBe(true)
    const result = response.result as { totalMatches?: number; windows?: Array<unknown> }
    expect(typeof result.totalMatches).toBe('number')
    expect(result.totalMatches || 0).toBeGreaterThan(0)
    expect(Array.isArray(result.windows)).toBe(true)
    expect((result.windows || []).length).toBeGreaterThan(0)
  }, 30_000)

  test('click and eval mutate the page state', async () => {
    const clickResponse = await command('click', { selector: '#increment' })
    expect(clickResponse.ok).toBe(true)
    const clickResult = clickResponse.result as { found?: boolean }
    expect(clickResult.found).toBe(true)

    const evalResponse = await command('eval', {
      script: 'document.getElementById("counter").textContent',
    })
    expect(evalResponse.ok).toBe(true)
    expect(evalResponse.result).toBe('1')
  }, 30_000)

  test('fill sets the input value', async () => {
    const fillResponse = await command('fill', {
      selector: '#name-input',
      value: 'autobrowser-live',
    })
    expect(fillResponse.ok).toBe(true)
    const fillResult = fillResponse.result as { found?: boolean }
    expect(fillResult.found).toBe(true)

    const evalResponse = await command('eval', {
      script: 'document.getElementById("name-input").value',
    })
    expect(evalResponse.ok).toBe(true)
    expect(evalResponse.result).toBe('autobrowser-live')
  }, 30_000)

  test('network records page requests', async () => {
    const response = await command('network', { action: 'requests' })
    expect(response.ok).toBe(true)
    const result = response.result as { total?: number; requests?: Array<{ url?: string }> }
    expect(typeof result.total).toBe('number')
    expect(result.total || 0).toBeGreaterThan(0)
    expect(Array.isArray(result.requests)).toBe(true)
    expect((result.requests || []).length).toBeGreaterThan(0)
  }, 30_000)

  test('snapshot supports roles and changed filters', async () => {
    const rolesResponse = await command('snapshot', { roles: ['button'] })
    expect(rolesResponse.ok).toBe(true)
    const rolesResult = rolesResponse.result as { elements?: Array<{ role?: string }> }
    const rolesElements = rolesResult.elements || []
    expect(rolesElements.length).toBeGreaterThan(0)
    expect(rolesElements.every((element) => element.role === 'button')).toBe(true)

    const changedResponse = await command('snapshot', { changed: true })
    expect(changedResponse.ok).toBe(true)
    const changedResult = changedResponse.result as { elements?: Array<unknown> }
    expect(Array.isArray(changedResult.elements)).toBe(true)
  }, 30_000)
})
