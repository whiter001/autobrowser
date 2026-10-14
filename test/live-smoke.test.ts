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
    <button id="regression-click" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Top click</button>
    <div id="editable" contenteditable="true"></div>
    <input id="form-input" type="text" />
    <iframe id="offset-frame" style="display:block; margin:45px 0 0 170px; border:13px solid black; width:340px; height:150px"
      srcdoc="<!doctype html><html><body style='margin:20px'><button id='regression-click' data-clicks='0' onclick='this.dataset.clicks = String(Number(this.dataset.clicks) + 1)'>Frame click</button></body></html>"></iframe>
    <script>
      const editable = document.getElementById('editable');
      editable.dataset.inputs = '0';
      editable.addEventListener('input', () => {
        editable.dataset.inputs = String(Number(editable.dataset.inputs) + 1);
        editable.dataset.lastInputText = editable.textContent;
      });
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

  async function checkedCommand<T = unknown>(
    commandName: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await command(commandName, args)
    expect(response.error).toBeUndefined()
    expect(response.ok).toBe(true)
    // 对象型结果附带路由 meta，数据断言只剥离该协议字段，保留所有实际返回字段。
    if (response.result && typeof response.result === 'object' && !Array.isArray(response.result)) {
      const { meta: _meta, ...result } = response.result as Record<string, unknown>
      return result as T
    }
    return response.result as T
  }

  async function loadSmokePage(url = pageUrl): Promise<void> {
    await checkedCommand('frame', { selector: 'top' })
    await checkedCommand('goto', { url })
    await checkedCommand('wait', { type: 'selector', selector: '#increment', timeout: 15_000 })
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

    httpServer = createHttpServer((request, response) => {
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
      if (pathname === '/redirect-start' || pathname === '/redirect-middle') {
        response.writeHead(pathname === '/redirect-start' ? 301 : 302, {
          location: pathname === '/redirect-start' ? '/redirect-middle' : '/redirect-final',
          'cache-control': 'no-store',
        })
        response.end()
        return
      }
      if (pathname === '/redirect-final') {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end('synthetic redirect final body')
        return
      }
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

  test('click translates bordered iframe coordinates and honors explicit/default/top frames', async () => {
    await loadSmokePage()
    try {
      await checkedCommand('wait', {
        type: 'selector',
        selector: '#regression-click',
        frame: '#offset-frame',
        timeout: 15_000,
      })
      const geometry = await checkedCommand<{ left: number; top: number; border: number }>('eval', {
        frame: 'top',
        script: `(() => {
          const frame = document.getElementById('offset-frame');
          const rect = frame.getBoundingClientRect();
          return { left: rect.left, top: rect.top, border: frame.clientLeft };
        })()`,
      })
      expect(geometry.left).toBeGreaterThan(150)
      expect(geometry.top).toBeGreaterThan(100)
      expect(geometry.border).toBe(13)

      await checkedCommand('click', { selector: '#regression-click', frame: '#offset-frame' })
      expect(
        await checkedCommand<string>('eval', {
          frame: '#offset-frame',
          script: 'document.getElementById("regression-click").dataset.clicks',
        }),
      ).toBe('1')

      await checkedCommand('frame', { selector: '#offset-frame' })
      await checkedCommand('click', { selector: '#regression-click' })
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("regression-click").dataset.clicks',
        }),
      ).toBe('2')

      // 两层使用相同 selector，确保显式 top 覆盖默认 frame，而非仅返回 found。
      await checkedCommand('click', { selector: '#regression-click', frame: 'top' })
      expect(
        await checkedCommand<string>('eval', {
          frame: 'top',
          script: 'document.getElementById("regression-click").dataset.clicks',
        }),
      ).toBe('1')
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("regression-click").dataset.clicks',
        }),
      ).toBe('2')

      await checkedCommand('frame', { selector: 'top' })
      await checkedCommand('click', { selector: '#regression-click' })
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("regression-click").dataset.clicks',
        }),
      ).toBe('2')
    } finally {
      await loadSmokePage()
    }
  }, 60_000)

  test('fill and fillform write contenteditable as plain text and dispatch input after mutation', async () => {
    await loadSmokePage()
    const readEditable = () =>
      checkedCommand('eval', {
        script: `(() => {
        const node = document.getElementById('editable');
        return { text: node.textContent, children: node.childElementCount,
          inputs: Number(node.dataset.inputs), lastInputText: node.dataset.lastInputText,
          formValue: document.getElementById('form-input').value };
      })()`,
      })
    try {
      const first = '<b data-synthetic="true">not markup</b> & <img src="synthetic">'
      await checkedCommand('fill', { selector: '#editable', value: first })
      expect(await readEditable()).toEqual({
        text: first,
        children: 0,
        inputs: 1,
        lastInputText: first,
        formValue: '',
      })
      const second = '<em>batch plain text</em> & replacement'
      const batch = await checkedCommand('fillform', {
        fields: [
          { selector: '#editable', value: second },
          { selector: '#form-input', value: 'synthetic batch input' },
        ],
      })
      expect(batch).toEqual({
        succeeded: 2,
        failed: 0,
        results: [
          { selector: '#editable', ok: true },
          { selector: '#form-input', ok: true },
        ],
      })
      expect(await readEditable()).toEqual({
        text: second,
        children: 0,
        inputs: 2,
        lastInputText: second,
        formValue: 'synthetic batch input',
      })
    } finally {
      await loadSmokePage()
    }
  }, 60_000)

  test('state save/load restores synthetic host-only and domain cookie attributes on a random port', async () => {
    interface Cookie {
      name: string
      value: string
      domain: string
      path: string
      httpOnly: boolean
      secure: boolean
      sameSite: string
      session: boolean
      expires: number
      sourceScheme: string
      sourcePort: number
    }
    const expires = Math.floor(Date.now() / 1000) + 3600
    const port = Number(new URL(pageUrl).port)
    // IP 和单段 localhost 域名会被 Chrome 归一化；*.localhost 始终解析至本机回环。
    const scopes = [
      { url: pageUrl, domain: '127.0.0.1', prefix: 'synthetic_host', domainCookie: false },
      {
        url: pageUrl.replace('127.0.0.1', 'smoke.localhost'),
        domain: '.smoke.localhost',
        prefix: 'synthetic_domain',
        domainCookie: true,
      },
    ]
    try {
      for (const scope of scopes) {
        await loadSmokePage(scope.url)
        const cookies = [
          {
            name: `${scope.prefix}_persistent`,
            value: 'synthetic-persistent',
            httpOnly: true,
            sameSite: 'Strict',
            expires,
          },
          {
            name: `${scope.prefix}_session`,
            value: 'synthetic-session',
            httpOnly: false,
            sameSite: 'Lax',
          },
        ].map((cookie) => ({
          ...cookie,
          url: scope.url,
          ...(scope.domainCookie ? { domain: scope.domain } : {}),
          path: '/',
          secure: false,
          sourceScheme: 'NonSecure',
          sourcePort: port,
        }))
        await cdp!.send('Storage.setCookies', { cookies })
        const name = `${scope.prefix}_state`
        const saved = await checkedCommand<{ saved: boolean; cookies: Cookie[] }>('state', {
          action: 'save',
          name,
        })
        expect(saved.saved).toBe(true)
        const synthetic = saved.cookies.filter((cookie) => cookie.name.startsWith(scope.prefix))
        expect(synthetic).toHaveLength(2)
        for (const cookie of synthetic) {
          const persistent = cookie.name.endsWith('_persistent')
          expect(cookie).toMatchObject({
            value: persistent ? 'synthetic-persistent' : 'synthetic-session',
            domain: scope.domain,
            path: '/',
            secure: false,
            httpOnly: persistent,
            sameSite: persistent ? 'Strict' : 'Lax',
            session: !persistent,
            sourceScheme: 'NonSecure',
            sourcePort: port,
          })
          expect(cookie.expires).toBe(persistent ? expires : -1)
          const deleted = await checkedCommand<{ deleted: number }>('cookies', {
            action: 'delete',
            name: cookie.name,
          })
          expect(deleted.deleted).toBe(1)
        }
        const empty = await checkedCommand<{ cookies: Cookie[] }>('cookies', { action: 'get' })
        expect(empty.cookies.filter((cookie) => cookie.name.startsWith(scope.prefix))).toHaveLength(
          0,
        )
        expect(await checkedCommand('state', { action: 'load', name })).toMatchObject({
          loaded: true,
          name,
        })
        const restored = await checkedCommand<{ cookies: Cookie[] }>('cookies', { action: 'get' })
        const roundtrip = restored.cookies.filter((cookie) => cookie.name.startsWith(scope.prefix))
        expect(roundtrip).toHaveLength(2)
        for (const cookie of synthetic) {
          expect(roundtrip.find((candidate) => candidate.name === cookie.name)).toEqual(cookie)
        }
        const visible = await checkedCommand<string>('eval', { script: 'document.cookie' })
        expect(visible).toContain(`${scope.prefix}_session=synthetic-session`)
        expect(visible).not.toContain(`${scope.prefix}_persistent=`)
        for (const cookie of synthetic) {
          await checkedCommand('cookies', { action: 'delete', name: cookie.name })
        }
      }
    } finally {
      // 仅删除测试创建的 cookie；无论断言在哪一步失败都恢复原始页面和 top。
      for (const scope of scopes) {
        await loadSmokePage(scope.url)
        for (const suffix of ['persistent', 'session']) {
          await checkedCommand('cookies', { action: 'delete', name: `${scope.prefix}_${suffix}` })
        }
      }
      await loadSmokePage()
    }
  }, 90_000)

  test('HAR records real HTTP redirects in hop order with statuses, Location and final body', async () => {
    await loadSmokePage()
    let recording = false
    try {
      await checkedCommand('network', { action: 'har', subaction: 'start' })
      recording = true
      expect(
        await checkedCommand<{ status: number; url: string; body: string }>('eval', {
          script:
            '(async () => { const response = await fetch("/redirect-start", { cache: "no-store" }); return { status: response.status, url: response.url, body: await response.text() }; })()',
        }),
      ).toEqual({
        status: 200,
        url: new URL('/redirect-final', pageUrl).href,
        body: 'synthetic redirect final body',
      })
      const stopped = await checkedCommand<{
        recording: boolean
        har: {
          log: {
            entries: Array<{
              request: { url: string }
              response: {
                status: number
                redirectURL: string
                headers: Array<{ name: string; value: string }>
                content: { text?: string }
              }
            }>
          }
        }
      }>('network', { action: 'har', subaction: 'stop' })
      recording = false
      expect(stopped.recording).toBe(false)
      const hops = stopped.har.log.entries.filter((entry) =>
        new URL(entry.request.url).pathname.startsWith('/redirect-'),
      )
      expect(hops.map((entry) => entry.request.url)).toEqual([
        new URL('/redirect-start', pageUrl).href,
        new URL('/redirect-middle', pageUrl).href,
        new URL('/redirect-final', pageUrl).href,
      ])
      expect(hops.map((entry) => entry.response.status)).toEqual([301, 302, 200])
      for (const [index, location] of ['/redirect-middle', '/redirect-final'].entries()) {
        const response = hops[index]!.response
        expect(
          response.headers.find((header) => header.name.toLowerCase() === 'location')?.value,
        ).toBe(location)
        expect(response.redirectURL).toBe(location)
      }
      expect(hops[2]!.response.content.text).toBe('synthetic redirect final body')
    } finally {
      if (recording) await checkedCommand('network', { action: 'har', subaction: 'stop' })
      await loadSmokePage()
    }
  }, 60_000)
})
