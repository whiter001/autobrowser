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
            const { sessionId, ...commandParams } = params
            socket.send(
              JSON.stringify({
                id,
                method,
                params: commandParams,
                ...(sessionId ? { sessionId } : {}),
              }),
            )
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
  const batchSignals = new Set<string>()
  const harBody = 'synthetic-har-body:'.padEnd(256 * 1024, 'h')

  interface Snapshot {
    full?: boolean
    removedRefs?: string[]
    elements: Array<{
      ref: string
      role: string
      name: string
      checked?: boolean
      disabled?: boolean
      href?: string
      value?: string
    }>
    frames: Array<{ ref: string }>
  }

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
    if (!response.ok)
      console.error(`[live-smoke] ${commandName} failed: ${JSON.stringify(response.error)}`)
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
    // Chrome 后台/被遮挡时可能暂停 rAF；先激活本测试 target，再给 compositor 切换文档的机会。
    if (cdp) {
      const targets = (await cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; url: string }>
      }
      const target = targets.targetInfos.find((entry) => entry.url === url)
      if (target) await cdp.send('Target.activateTarget', { targetId: target.targetId })
    }
    await Bun.sleep(150)
  }

  /** 打开第二个本地冒烟页 tab 并等它就绪；handle/targeting 用例的真实目标 tab */
  async function openExtraTab(): Promise<{ handle: string; tabId: number }> {
    const created = await checkedCommand<{ tab: { id?: number | null; handle?: string | null } }>(
      'tab.new',
      { url: pageUrl },
    )
    const handle = created.tab.handle || ''
    expect(handle).toMatch(/^t\d+$/)
    expect(typeof created.tab.id).toBe('number')
    await checkedCommand('wait', { selector: '#increment', handle, timeout: 15_000 })
    return { handle, tabId: created.tab.id as number }
  }

  /** 当前默认目标 tab 的 handle（冒烟页），用于区分新建的临时 tab */
  async function smokeTabHandle(): Promise<string> {
    const listed = await checkedCommand<{ tabs: Array<{ handle?: string | null; url?: string }> }>(
      'tab.list',
    )
    const smoke = listed.tabs.find(
      (tab) =>
        String(tab.url || '').includes('live-smoke.html') &&
        /^t\d+$/.test(String(tab.handle || '')),
    )
    expect(smoke?.handle).toBeTruthy()
    return String(smoke!.handle)
  }

  /** 关闭临时 tab 并把默认目标切回冒烟页；无论断言在哪一步失败都要恢复 */
  async function closeExtraTab(
    extra: { handle: string } | null,
    home: string | null,
  ): Promise<void> {
    if (extra) await command('tab.close', { handle: extra.handle })
    if (home) await command('tab.select', { handle: home })
  }

  async function logExtensionDiagnostics(): Promise<void> {
    if (!cdp) return
    try {
      const targets = (await cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; type: string; url: string }>
      }
      const worker = targets.targetInfos.find(
        (target) =>
          target.type === 'service_worker' &&
          target.url.startsWith(`chrome-extension://${getExtensionId()}/`),
      )
      if (!worker) return
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: worker.targetId,
        flatten: true,
      })
      try {
        const diagnostics = await cdp.send('Runtime.evaluate', {
          sessionId,
          awaitPromise: true,
          returnByValue: true,
          expression:
            'chrome.storage.local.get("autobrowserConnectionDiagnostics").then(value => value.autobrowserConnectionDiagnostics)',
        })
        console.error(
          `[live-smoke] isolated extension connection diagnostics: ${JSON.stringify(diagnostics)}`,
        )
      } finally {
        await cdp.send('Target.detachFromTarget', { sessionId })
      }
    } catch (error) {
      console.error('[live-smoke] could not read isolated extension diagnostics', error)
    }
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
      if (pathname.startsWith('/batch-signal/')) {
        batchSignals.add(pathname.split('/').pop()!)
        response.writeHead(200, { 'cache-control': 'no-store' })
        response.end('ok')
        return
      }
      if (pathname === '/regression-frame') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(
          '<!doctype html><button id="same" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Same frame button</button>',
        )
        return
      }
      if (pathname.startsWith('/har-body/')) {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(harBody)
        return
      }
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
      // 分开延迟响应头和尾部，真实 CDP timing 必须体现 wait/receive 两个阶段。
      if (pathname === '/routed-probe-slow') {
        setTimeout(() => {
          response.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          })
          response.write('slow-')
          setTimeout(() => response.end('probe-body'), 300)
        }, 400)
        return
      }
      if (pathname === '/download-probe') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="live-probe.txt"',
          'content-length': Buffer.byteLength(harBody),
          'cache-control': 'no-store',
        })
        response.end(harBody)
        return
      }
      // route 用例的真实回源响应：unroute 之后必须拿到这里的正文，而不是 mock 正文
      if (pathname === '/routed-probe-a' || pathname === '/routed-probe-b') {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(`real-probe-body:${pathname.slice('/routed-probe-'.length)}`)
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

  test('snapshot and find never recycle removed highest or all element/frame refs', async () => {
    await loadSmokePage()
    const index = (ref: string) => Number(ref.match(/[ef](\d+)/)![1])
    const locate = () =>
      checkedCommand<{ match: { ref: string } }>('find', {
        strategy: 'role',
        role: 'button',
        name: 'Fresh',
        exact: true,
      })
    try {
      await checkedCommand('eval', {
        script: `document.body.innerHTML = '<button>Keep</button><button id="highest">Highest</button><iframe src="/regression-frame"></iframe><iframe id="highest-frame" src="/regression-frame"></iframe>'; true`,
      })
      const first = await checkedCommand<Snapshot>('snapshot')
      expect(first.elements).toHaveLength(2)
      expect(first.frames).toHaveLength(2)
      const oldElement = first.elements.reduce((a, b) => (index(a.ref) > index(b.ref) ? a : b)).ref
      const oldFrame = first.frames.reduce((a, b) => (index(a.ref) > index(b.ref) ? a : b)).ref
      await checkedCommand('eval', {
        script: `document.getElementById('highest').remove(); document.getElementById('highest-frame').remove(); document.body.insertAdjacentHTML('beforeend', '<button id="fresh" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Fresh</button><iframe src="/regression-frame"></iframe>'); true`,
      })
      const fresh = await locate()
      expect(index(fresh.match.ref)).toBeGreaterThan(index(oldElement))
      const second = await checkedCommand<Snapshot>('snapshot')
      expect(second.elements.find((item) => item.name === 'Fresh')?.ref).toBe(fresh.match.ref)
      expect(Math.max(...second.frames.map((item) => index(item.ref)))).toBeGreaterThan(
        index(oldFrame),
      )
      const staleClick = await command('click', { selector: oldElement })
      expect(staleClick.ok).toBe(false)
      expect(staleClick.error?.code).toBe('STALE_REFERENCE')
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("fresh").dataset.clicks || "0"',
        }),
      ).toBe('0')
      expect((await command('frame', { selector: oldFrame })).ok).toBe(false)
      await checkedCommand('frame', { selector: 'top' })

      // 保留同一个 document，只删除全部 ref 节点，不能靠导航 epoch 避免复用。
      await checkedCommand('eval', {
        script: `document.body.innerHTML = '<button id="fresh" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Fresh</button><iframe src="/regression-frame"></iframe>'; true`,
      })
      const third = await checkedCommand<Snapshot>('snapshot')
      expect(index(third.elements[0]!.ref)).toBeGreaterThan(
        Math.max(...second.elements.map((item) => index(item.ref))),
      )
      expect(index(third.frames[0]!.ref)).toBeGreaterThan(
        Math.max(...second.frames.map((item) => index(item.ref))),
      )
      expect((await locate()).match.ref).toBe(third.elements[0]!.ref)
      expect((await command('click', { selector: fresh.match.ref })).error?.code).toBe(
        'STALE_REFERENCE',
      )
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("fresh").dataset.clicks || "0"',
        }),
      ).toBe('0')
      expect((await command('frame', { selector: second.frames.at(-1)!.ref })).ok).toBe(false)
    } finally {
      await loadSmokePage()
    }
  }, 60_000)

  test('changed snapshots include semantic-only mutations and removedRefs', async () => {
    await loadSmokePage()
    try {
      await checkedCommand('eval', {
        script: `document.body.innerHTML = '<input id="check" aria-label="Check" type="checkbox"><button id="disable">Disable</button><a id="link" href="/before">Link</a><input id="value" aria-label="Value" value="before"><button id="remove">Remove</button>'; true`,
      })
      const first = await checkedCommand<Snapshot>('snapshot', { changed: true })
      expect(first.full).toBe(true)
      expect(first.elements).toHaveLength(5)
      expect((await checkedCommand<Snapshot>('snapshot', { changed: true })).elements).toHaveLength(
        0,
      )
      const cases = [
        {
          name: 'Check',
          script: 'document.getElementById("check").checked = true',
          field: { checked: true },
        },
        {
          name: 'Disable',
          script: 'document.getElementById("disable").disabled = true',
          field: { disabled: true },
        },
        {
          name: 'Link',
          script: 'document.getElementById("link").href = "/after"',
          field: { href: new URL('/after', pageUrl).href },
        },
        {
          name: 'Value',
          script: 'document.getElementById("value").value = "after"',
          field: { value: 'after' },
        },
      ]
      for (const mutation of cases) {
        await checkedCommand('eval', { script: mutation.script })
        const delta = await checkedCommand<Snapshot>('snapshot', { changed: true })
        expect(delta.full).toBe(false)
        expect(delta.elements).toHaveLength(1)
        expect(delta.elements[0]).toMatchObject({ name: mutation.name, ...mutation.field })
        expect(delta.removedRefs).toEqual([])
      }
      const removed = first.elements.find((item) => item.name === 'Remove')!.ref
      await checkedCommand('eval', { script: 'document.getElementById("remove").remove(); true' })
      const delta = await checkedCommand<Snapshot>('snapshot', { changed: true })
      expect(delta.elements).toHaveLength(0)
      expect(delta.removedRefs).toEqual([removed])
    } finally {
      await loadSmokePage()
    }
  }, 60_000)

  test('identical iframe snapshots isolate explicit/selected baselines and reset on document navigation', async () => {
    await loadSmokePage()
    try {
      await checkedCommand('eval', {
        script: `document.body.innerHTML = '<iframe id="one" src="/regression-frame?one"></iframe><iframe id="two" src="/regression-frame?two"></iframe>'; true`,
      })
      for (const frame of ['#one', '#two']) {
        await checkedCommand('wait', { selector: '#same', frame, timeout: 15_000 })
        const full = await checkedCommand<Snapshot>('snapshot', { frame, changed: true })
        expect(full.full).toBe(true)
        expect(full.elements).toHaveLength(1)
        expect(full.elements[0]!.name).toBe('Same frame button')
        expect(
          (await checkedCommand<Snapshot>('snapshot', { frame, changed: true })).elements,
        ).toHaveLength(0)
      }
      await checkedCommand('frame', { selector: '#one' })
      expect((await checkedCommand<Snapshot>('snapshot', { changed: true })).elements).toHaveLength(
        0,
      )
      await checkedCommand('eval', { script: 'document.getElementById("same").disabled = true' })
      await checkedCommand('frame', { selector: '#two' })
      expect((await checkedCommand<Snapshot>('snapshot', { changed: true })).elements).toHaveLength(
        0,
      )
      const changedOne = await checkedCommand<Snapshot>('snapshot', {
        frame: '#one',
        changed: true,
      })
      expect(changedOne.elements).toHaveLength(1)
      expect(changedOne.elements[0]!.disabled).toBe(true)
      await checkedCommand('eval', {
        frame: 'top',
        script: 'document.getElementById("one").src = "/regression-frame?navigated"; true',
      })
      await checkedCommand('wait', {
        frame: '#one',
        fn: 'location.search === "?navigated" && document.readyState === "complete"',
        timeout: 15_000,
      })
      const navigated = await checkedCommand<Snapshot>('snapshot', { frame: '#one', changed: true })
      expect(navigated.full).toBe(true)
      expect(navigated.elements).toHaveLength(1)
      expect(navigated.elements[0]!.disabled).toBe(false)
      expect(navigated.removedRefs).toEqual([])
      expect((await checkedCommand<Snapshot>('snapshot', { changed: true })).elements).toHaveLength(
        0,
      )
    } finally {
      await loadSmokePage()
    }
  }, 60_000)

  test('find write ambiguity has no side effects, while exact and explicit position act', async () => {
    await loadSmokePage()
    try {
      await checkedCommand('eval', {
        script: `document.body.innerHTML = '<button id="save" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Save</button><button id="copy" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Save copy</button>'; true`,
      })
      const target = { strategy: 'role', role: 'button', name: 'Save' }
      const readClicks = () =>
        checkedCommand('eval', {
          script:
            'Array.from(document.querySelectorAll("button"), node => Number(node.dataset.clicks || 0))',
        })
      expect((await checkedCommand<{ match: { name: string } }>('find', target)).match.name).toBe(
        'Save',
      )
      const ambiguous = await command('find', { ...target, action: 'click' })
      expect(ambiguous.ok).toBe(false)
      expect(ambiguous.error?.code).toBe('AMBIGUOUS_TARGET')
      expect(ambiguous.error?.suggestedAction).toContain('exact:true')
      expect(await readClicks()).toEqual([0, 0])
      await checkedCommand('find', { ...target, action: 'click', exact: true })
      expect(await readClicks()).toEqual([1, 0])
      await checkedCommand('find', { ...target, action: 'click', position: 'last' })
      expect(await readClicks()).toEqual([1, 1])
    } finally {
      await loadSmokePage()
    }
  }, 60_000)

  test('search paginates 10000 consecutive UTF-8 matches without gaps within line/byte budgets', async () => {
    await loadSmokePage()
    interface SearchResult {
      totalMatches: number
      truncated: boolean
      nextStartLine?: number
      windows: Array<{ lines: Array<{ line: number; text: string; matched: boolean }> }>
    }
    try {
      await checkedCommand('eval', {
        script: `document.body.innerHTML = '<pre id="lines"></pre>'; document.getElementById('lines').textContent = Array.from({ length: 10000 }, (_, i) => '命中-' + String(i + 1).padStart(5, '0') + '-' + '界'.repeat(220)).join('\\n'); true`,
      })
      let startLine = 1
      let count = 0
      let pages = 0
      while (true) {
        const result = await checkedCommand<SearchResult>('search', {
          query: '/命中/g',
          context: 50,
          limit: 200,
          startLine,
        })
        const lines = result.windows.flatMap((window) => window.lines)
        expect(result.totalMatches).toBe(10000)
        expect(lines.length).toBeGreaterThan(0)
        expect(lines.length).toBeLessThanOrEqual(200)
        expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(100_000)
        for (const [offset, line] of lines.entries()) {
          expect(line.line).toBe(startLine + offset)
          expect(line.text).toBe(
            `命中-${String(count + offset + 1).padStart(5, '0')}-${'界'.repeat(220)}`,
          )
          expect(line.matched).toBe(true)
        }
        count += lines.length
        pages++
        if (result.nextStartLine === undefined) break
        expect(result.truncated).toBe(true)
        expect(result.nextStartLine).toBe(startLine + lines.length)
        startLine = result.nextStartLine
        expect(pages).toBeLessThan(200)
      }
      expect(count).toBe(10000)
      expect(pages).toBeGreaterThan(50)
      console.info(`[live-smoke] search read all ${count} UTF-8 lines in ${pages} pages`)
    } finally {
      await loadSmokePage()
    }
  }, 90_000)

  test('cancelling a running batch prevents its next click and releases the queue', async () => {
    await loadSmokePage()
    const signal = crypto.randomUUID()
    let batch: Promise<CommandResponse> | undefined
    let runningId: string | undefined
    try {
      batch = command('batch', {
        steps: [
          {
            command: 'eval',
            args: {
              script: `(async () => { await fetch('/batch-signal/${signal}'); await new Promise(resolve => setTimeout(resolve, 2500)); window.batchFinished = true; return true; })()`,
            },
          },
          { command: 'click', args: { selector: '#increment' } },
        ],
      })
      await waitFor(
        'the first batch eval to start in Chrome',
        () => batchSignals.has(signal),
        10_000,
      )
      const listed = await checkedCommand<{ commands: Array<{ id: string; state: string }> }>(
        'command',
        { action: 'list' },
      )
      const running = listed.commands.filter((entry) => entry.state === 'running')
      expect(running).toHaveLength(1)
      runningId = running[0]!.id
      expect(
        await checkedCommand('command', { action: 'cancel', commandId: runningId }),
      ).toMatchObject({ cancelled: true })
      const cancelled = await batch
      expect(cancelled.ok).toBe(false)
      expect(cancelled.error?.code).toBe('COMMAND_CANCELLED')
      // 先证明取消后队列可用，再等原 CDP promise 真正结束，不能仅在延迟中检查未点击。
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("counter").textContent',
        }),
      ).toBe('0')
      await checkedCommand('wait', { fn: 'window.batchFinished === true', timeout: 10_000 })
      await Bun.sleep(150)
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("counter").textContent',
        }),
      ).toBe('0')
      await checkedCommand('click', { selector: '#increment' })
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("counter").textContent',
        }),
      ).toBe('1')
    } finally {
      if (runningId) await command('command', { action: 'cancel', commandId: runningId })
      if (batch) await batch
      batchSignals.delete(signal)
      await loadSmokePage()
    }
  }, 30_000)

  test('greater-than-16MiB eval strings, objects and HAR-shaped results round-trip intact', async () => {
    await loadSmokePage()
    const bytes = 17 * 1024 * 1024
    try {
      const text = await checkedCommand<string>('eval', {
        script: `'begin:' + 'x'.repeat(${bytes}) + ':end'`,
      })
      expect(text).toBe(`begin:${'x'.repeat(bytes)}:end`)
      const object = await checkedCommand<{ payload: string; nested: { tail: string } }>('eval', {
        script: `({ payload: '界'.repeat(${6 * 1024 * 1024}), nested: { tail: 'synthetic-object-end' } })`,
      })
      expect(new TextEncoder().encode(JSON.stringify(object)).length).toBeGreaterThan(
        16 * 1024 * 1024,
      )
      expect(object).toEqual({
        payload: '界'.repeat(6 * 1024 * 1024),
        nested: { tail: 'synthetic-object-end' },
      })
      const shaped = await checkedCommand<{
        har: { log: { entries: Array<{ response: { content: { text: string } } }> } }
      }>('eval', {
        script: `({ har: { log: { entries: Array.from({ length: 65 }, (_, i) => ({ response: { content: { text: String(i).padStart(3, '0') + 'h'.repeat(256 * 1024) } } })) } } })`,
      })
      expect(new TextEncoder().encode(JSON.stringify(shaped)).length).toBeGreaterThan(
        16 * 1024 * 1024,
      )
      expect(shaped.har.log.entries).toHaveLength(65)
      for (const [i, entry] of shaped.har.log.entries.entries()) {
        expect(entry.response.content.text).toBe(
          `${String(i).padStart(3, '0')}${'h'.repeat(256 * 1024)}`,
        )
      }
      expect(
        await checkedCommand<string>('eval', { script: '"healthy after chunked transfers"' }),
      ).toBe('healthy after chunked transfers')
    } finally {
      await loadSmokePage()
    }
  }, 90_000)

  test('HAR exports bodies for 65 real local 256KiB responses and keeps the connection usable', async () => {
    await loadSmokePage()
    let recording = false
    try {
      await checkedCommand('network', {
        action: 'har',
        subaction: 'start',
        maxRequests: 100,
        maxBodyBytes: 1024 * 1024,
      })
      recording = true
      const fetched = await checkedCommand<number[]>('eval', {
        timeoutMs: 60_000,
        script: `(async () => { const lengths = []; for (let i = 0; i < 65; i++) { const response = await fetch('/har-body/' + i, { cache: 'no-store' }); lengths.push((await response.text()).length); await new Promise(resolve => setTimeout(resolve, 25)); } return lengths; })()`,
      })
      expect(fetched).toEqual(Array(65).fill(harBody.length))
      const stopped = await checkedCommand<{
        requestCount: number
        har: {
          log: {
            entries: Array<{
              request: { url: string }
              response: { status: number; content: { text?: string; comment?: string } }
            }>
          }
        }
      }>('network', { action: 'har', subaction: 'stop' })
      recording = false
      const entries = stopped.har.log.entries.filter((entry) =>
        new URL(entry.request.url).pathname.startsWith('/har-body/'),
      )
      expect(entries).toHaveLength(65)
      expect(stopped.requestCount).toBeGreaterThanOrEqual(65)
      for (const [i, entry] of entries.entries()) {
        expect(new URL(entry.request.url).pathname).toBe(`/har-body/${i}`)
        expect(entry.response.status).toBe(200)
        expect(entry.response.content.comment).toBeUndefined()
        expect(entry.response.content.text).toBe(harBody)
      }
      expect(new TextEncoder().encode(JSON.stringify(stopped)).length).toBeGreaterThan(
        16 * 1024 * 1024,
      )
      expect(await checkedCommand<number>('eval', { script: '65' })).toBe(65)
    } catch (error) {
      await logExtensionDiagnostics()
      throw error
    } finally {
      if (recording) await checkedCommand('network', { action: 'har', subaction: 'stop' })
      await loadSmokePage()
    }
  }, 90_000)

  test('eval honors an explicit 60s budget for a real 35s promise', async () => {
    await loadSmokePage()
    try {
      const started = performance.now()
      expect(
        await checkedCommand<string>('eval', {
          timeoutMs: 60_000,
          script: 'new Promise(resolve => setTimeout(() => resolve("35s complete"), 35000))',
        }),
      ).toBe('35s complete')
      expect(performance.now() - started).toBeGreaterThanOrEqual(35_000)
      expect(await checkedCommand<string>('eval', { script: '"healthy after long eval"' })).toBe(
        'healthy after long eval',
      )
    } finally {
      await loadSmokePage()
    }
  }, 90_000)

  test('reports actual find/snapshot timing on 100 controls plus 20000 divs', async () => {
    await loadSmokePage()
    try {
      expect(
        await checkedCommand<{ divs: number; inputs: number }>('eval', {
          script: `document.body.innerHTML = Array.from({ length: 20000 }, (_, i) => '<div id="decoration-' + i + '">synthetic div ' + i + '</div>').join('') + Array.from({ length: 100 }, (_, i) => '<label for="control-' + i + '">Control ' + i + '</label><input id="control-' + i + '">').join(''); ({ divs: document.querySelectorAll('div').length, inputs: document.querySelectorAll('input').length })`,
        }),
      ).toEqual({ divs: 20000, inputs: 100 })
      const findMs: number[] = []
      const snapshotMs: number[] = []
      for (let i = 0; i < 3; i++) {
        const snapshotStart = performance.now()
        const snapshot = await checkedCommand<Snapshot>('snapshot')
        snapshotMs.push(Number((performance.now() - snapshotStart).toFixed(2)))
        expect(snapshot.elements).toHaveLength(100)
        const findStart = performance.now()
        const response = await command('find', {
          strategy: 'role',
          role: 'textbox',
          name: 'Control 99',
          exact: true,
        })
        findMs.push(Number((performance.now() - findStart).toFixed(2)))
        console.info(
          `[live-smoke] large DOM sample ${i + 1}: snapshot=${snapshotMs.at(-1)}ms, find=${findMs.at(-1)}ms, find.ok=${response.ok}`,
        )
        expect(response.error).toBeUndefined()
        expect(response.ok).toBe(true)
        const found = response.result as { match: { name: string; ref: string } }
        expect(found.match.name).toBe('Control 99')
        expect(snapshot.elements.find((item) => item.name === 'Control 99')?.ref).toBe(
          found.match.ref,
        )
      }
      console.info(
        `[live-smoke] 20000 divs + 100 controls, wall-clock ms: find=${JSON.stringify(findMs)}, snapshot=${JSON.stringify(snapshotMs)} (no baseline comparison)`,
      )
    } finally {
      await loadSmokePage()
    }
  }, 60_000)

  test('explicit handle different from the current target acts on and reports that tab', async () => {
    interface CommandMeta {
      tabHandle?: string | null
      tabId?: number | null
      frame?: string | null
      url?: string | null
      target?: { tabId?: number; handle?: string | null; explicit?: boolean; note?: string }
    }
    await loadSmokePage()
    let home: string | null = null
    let extra: { handle: string; tabId: number } | null = null
    try {
      home = await smokeTabHandle()
      extra = await openExtraTab()
      expect(extra.handle).not.toBe(home)
      // tab.new 会把默认目标改成新 tab，先切回冒烟页，确保后续默认值与显式 handle 真的不同
      await checkedCommand('tab.select', { handle: home })

      const clickResponse = await command('click', { selector: '#increment', handle: extra.handle })
      expect(clickResponse.error).toBeUndefined()
      expect(clickResponse.ok).toBe(true)
      const meta = (clickResponse.result as { meta?: CommandMeta }).meta
      expect(meta).toMatchObject({
        tabHandle: extra.handle,
        tabId: extra.tabId,
        frame: null,
        url: pageUrl,
      })
      expect(meta?.target).toMatchObject({
        tabId: extra.tabId,
        handle: extra.handle,
        explicit: true,
      })
      // 显式指定了 handle，不应出现“兜底到非活动 tab”的提示
      expect(meta?.target?.note).toBeUndefined()

      // 动作真的发生在显式 handle 的 tab 上，默认目标 tab 不受影响
      expect(
        await checkedCommand('eval', {
          handle: extra.handle,
          script: 'document.getElementById("counter").textContent',
        }),
      ).toBe('1')
      expect(
        await checkedCommand('eval', {
          handle: home,
          script: 'document.getElementById("counter").textContent',
        }),
      ).toBe('0')

      const snapshotResponse = await command('snapshot', { handle: extra.handle })
      expect(snapshotResponse.ok).toBe(true)
      const snapshot = snapshotResponse.result as { url?: string; meta?: CommandMeta }
      expect(snapshot.url).toBe(pageUrl)
      expect(snapshot.meta?.tabHandle).toBe(extra.handle)
      expect(snapshot.meta?.tabId).toBe(extra.tabId)

      // 显式 handle 命中后默认目标跟随该 tab，与 meta 回显一致
      expect(
        await checkedCommand<{ targetTabId: number | null }>('target', { action: 'show' }),
      ).toMatchObject({ targetTabId: extra.tabId })
    } finally {
      await closeExtraTab(extra, home)
      await loadSmokePage()
    }
  }, 90_000)

  test('queued default-target command keeps the tab pinned from enqueue time', async () => {
    await loadSmokePage()
    const signal = crypto.randomUUID()
    let home: string | null = null
    let extra: { handle: string; tabId: number } | null = null
    let blocker: Promise<CommandResponse> | undefined
    try {
      home = await smokeTabHandle()
      extra = await openExtraTab()
      await checkedCommand('tab.select', { handle: home })

      // 先用显式 handle 占住冒烟页的串行队列；signal 确认它已在 Chrome 中执行
      blocker = command('eval', {
        handle: home,
        timeoutMs: 20_000,
        script: `(async () => { await fetch('/batch-signal/${signal}'); await new Promise(resolve => setTimeout(resolve, 2500)); return 'blocker-done'; })()`,
      })
      await waitFor(
        'the queue-blocking eval to start in Chrome',
        () => batchSignals.has(signal),
        10_000,
      )

      // 未显式指定目标：入队时默认目标就是冒烟页
      const pinned = command('eval', {
        script: 'window.pinProbe = "pinned-to-home"; "pinned-result"',
      })
      // 前置条件：这条命令确实在队列里等待，而不是立刻执行完
      await waitFor(
        'the pinned eval to wait behind the blocking eval',
        async () => {
          const listed = await checkedCommand<{ commands: Array<{ state?: string }> }>('command', {
            action: 'list',
          })
          return listed.commands.some((entry) => entry.state === 'queued')
        },
        5_000,
      )
      // 排队等待期间改掉默认目标；已入队的命令不能漂移到新 tab
      await checkedCommand('tab.select', { handle: extra.handle })
      const pinnedResponse = await pinned
      expect(pinnedResponse.error).toBeUndefined()
      expect(pinnedResponse.ok).toBe(true)
      expect(pinnedResponse.result).toBe('pinned-result')
      expect(await blocker).toMatchObject({ ok: true })

      expect(
        await checkedCommand<string | null>('eval', {
          handle: home,
          script: 'window.pinProbe || null',
        }),
      ).toBe('pinned-to-home')
      expect(
        await checkedCommand<string | null>('eval', {
          handle: extra.handle,
          script: 'window.pinProbe || null',
        }),
      ).toBe(null)
    } finally {
      if (blocker) await blocker
      batchSignals.delete(signal)
      await closeExtraTab(extra, home)
      await loadSmokePage()
    }
  }, 90_000)

  test('fill, storage and cookies accept empty values and default cookie scope', async () => {
    const cookieName = 'autobrowser_live_default_scope'
    const storageKey = 'autobrowser-live-empty'
    try {
      await loadSmokePage()
      await checkedCommand('fill', { selector: '#name-input', value: 'about-to-be-cleared' })
      expect(await checkedCommand('fill', { selector: '#name-input', value: '' })).toMatchObject({
        found: true,
        selector: '#name-input',
      })
      expect(
        await checkedCommand<string>('eval', {
          script: 'document.getElementById("name-input").value',
        }),
      ).toBe('')

      for (const sessionOnly of [false, true]) {
        expect(
          await checkedCommand('storage', {
            action: 'set',
            key: storageKey,
            value: '',
            session: sessionOnly,
          }),
        ).toMatchObject({ key: storageKey, value: '', set: true })
        expect(
          await checkedCommand('storage', { action: 'get', key: storageKey, session: sessionOnly }),
        ).toMatchObject({ key: storageKey, value: '' })
        expect(
          await checkedCommand<string | null>('eval', {
            script: `${sessionOnly ? 'sessionStorage' : 'localStorage'}.getItem(${JSON.stringify(storageKey)})`,
          }),
        ).toBe('')
      }

      // 只给 name/value：不带 domain/path 时用当前页面 URL 作为 cookie 作用域
      expect(
        await checkedCommand('cookies', { action: 'set', name: cookieName, value: '' }),
      ).toMatchObject({ set: true, name: cookieName, value: '', domain: '127.0.0.1' })
      const listed = await checkedCommand<{
        cookies: Array<{ name?: string; value?: string; domain?: string; path?: string }>
      }>('cookies', { action: 'get' })
      const stored = listed.cookies.filter((cookie) => cookie.name === cookieName)
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ value: '', domain: '127.0.0.1', path: '/' })
      expect(await checkedCommand('eval', { script: 'document.cookie' })).toContain(
        `${cookieName}=`,
      )
    } finally {
      await loadSmokePage()
      await checkedCommand('cookies', { action: 'delete', name: cookieName })
      for (const sessionOnly of [false, true]) {
        await checkedCommand('storage', {
          action: 'delete',
          key: storageKey,
          session: sessionOnly,
        })
      }
      await loadSmokePage()
    }
  }, 90_000)

  test('same ids in two shadow roots keep their own label for and aria-labelledby names', async () => {
    interface ShadowClicks {
      saveLabel: string
      deleteLabel: string
      saveHint: string
      deleteHint: string
    }
    const readClicks = () =>
      checkedCommand<ShadowClicks>('eval', {
        script: `(() => {
          const clicks = (hostId, index) => {
            const host = document.getElementById(hostId);
            return host.shadowRoot.querySelectorAll('input')[index].dataset.clicks || '0';
          };
          return {
            saveLabel: clicks('save-host', 0),
            deleteLabel: clicks('delete-host', 0),
            saveHint: clicks('save-host', 1),
            deleteHint: clicks('delete-host', 1),
          };
        })()`,
      })
    try {
      await loadSmokePage()
      // 两个 shadow root 复用同样的 id，只有 name index 按 tree scope 分桶才不会串名
      await checkedCommand('eval', {
        script: `(() => {
          document.body.innerHTML = '';
          const build = (hostId, labelText, hintText) => {
            const host = document.createElement('div');
            host.id = hostId;
            const root = host.attachShadow({ mode: 'open' });
            root.innerHTML = '<label for="field">' + labelText + '</label><input id="field"><span id="hint">' + hintText + '</span><input aria-labelledby="hint">';
            for (const input of root.querySelectorAll('input')) {
              input.addEventListener('click', () => {
                input.dataset.clicks = String(Number(input.dataset.clicks || 0) + 1);
              });
            }
            document.body.appendChild(host);
          };
          build('save-host', 'Save', 'Save note');
          build('delete-host', 'Delete', 'Delete note');
          return true;
        })()`,
      })

      const snapshot = await checkedCommand<Snapshot>('snapshot')
      const textboxes = snapshot.elements.filter((element) => element.role === 'textbox')
      expect(textboxes.map((element) => element.name).sort()).toEqual([
        'Delete',
        'Delete note',
        'Save',
        'Save note',
      ])
      expect(await readClicks()).toEqual({
        saveLabel: '0',
        deleteLabel: '0',
        saveHint: '0',
        deleteHint: '0',
      })

      // label for 与 aria-labelledby 各自命中本 shadow root 的控件
      await checkedCommand('find', {
        strategy: 'role',
        role: 'textbox',
        name: 'Save',
        exact: true,
        action: 'click',
      })
      await checkedCommand('find', {
        strategy: 'role',
        role: 'textbox',
        name: 'Delete note',
        exact: true,
        action: 'click',
      })
      expect(await readClicks()).toEqual({
        saveLabel: '1',
        deleteLabel: '0',
        saveHint: '0',
        deleteHint: '1',
      })

      const located = await checkedCommand<{ match: { ref: string; name: string } }>('find', {
        strategy: 'role',
        role: 'textbox',
        name: 'Delete',
        exact: true,
      })
      expect(located.match.name).toBe('Delete')
      const deleteRef = located.match.ref
      await checkedCommand('find', {
        strategy: 'role',
        role: 'textbox',
        name: 'Save note',
        exact: true,
        action: 'click',
      })
      expect(await readClicks()).toEqual({
        saveLabel: '1',
        deleteLabel: '0',
        saveHint: '1',
        deleteHint: '1',
      })
      // find 返回的 ref 与 snapshot 的 ref 同源，按 ref 点击仍然命中另一个 shadow root 的控件
      const snapshotted = await checkedCommand<Snapshot>('snapshot')
      expect(snapshotted.elements.find((element) => element.name === 'Delete')?.ref).toBe(deleteRef)
      expect(await checkedCommand('click', { selector: deleteRef })).toMatchObject({ found: true })
      expect((await readClicks()).deleteLabel).toBe('1')
    } finally {
      await loadSmokePage()
    }
  }, 90_000)

  test('routed fetch yields one HAR entry with millisecond timings, and unroute without url clears all', async () => {
    interface HarEntry {
      startedDateTime?: string
      time?: number
      request: { url: string }
      response: { status: number; content: { text?: string } }
      timings: Record<string, number>
    }
    await loadSmokePage()
    let recording = false
    const pattern = (suffix: string) => `/routed-probe-${suffix}`
    try {
      // 两条独立 mock 路由：省略 url 的 unroute 必须一次清空全部
      const routed = await checkedCommand<{ route: { pattern?: string }; routes: unknown[] }>(
        'network',
        {
          action: 'route',
          url: pattern('a'),
          body: '{"mocked":"a"}',
          status: 200,
          contentType: 'application/json',
        },
      )
      expect(routed.route.pattern).toBe(pattern('a'))
      await checkedCommand('network', {
        action: 'route',
        url: pattern('b'),
        body: '{"mocked":"b"}',
        status: 201,
      })
      expect(
        await checkedCommand<{ routes: unknown[] }>('network', {
          action: 'route',
          subaction: 'list',
        }),
      ).toMatchObject({ routes: [{ pattern: pattern('a') }, { pattern: pattern('b') }] })

      await checkedCommand('network', { action: 'har', subaction: 'start' })
      recording = true
      expect(
        await checkedCommand('eval', {
          script: `(async () => { const response = await fetch('${pattern('a')}', { cache: 'no-store' }); return { status: response.status, body: await response.text(), type: response.headers.get('content-type') }; })()`,
        }),
      ).toEqual({ status: 200, body: '{"mocked":"a"}', type: 'application/json' })

      const stopped = await checkedCommand<{
        har: { log: { entries: HarEntry[] } }
      }>('network', { action: 'har', subaction: 'stop' })
      recording = false
      // Fetch 拦截与 Network 事件必须合并成同一条记录，不能出现重复 entry
      const entries = stopped.har.log.entries.filter(
        (entry) => new URL(entry.request.url).pathname === pattern('a'),
      )
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry.response.status).toBe(200)
      expect(entry.response.content.text).toBe('{"mocked":"a"}')
      expect(Number.isNaN(Date.parse(String(entry.startedDateTime)))).toBe(false)

      // 耗时单位必须是毫秒：既不为负、也不会因为秒/毫秒混用放大 1000 倍
      expect(typeof entry.time).toBe('number')
      expect(entry.time).toBeGreaterThanOrEqual(0)
      expect(entry.time).toBeLessThan(30_000)
      const timingValues = Object.values(entry.timings)
      expect(timingValues.length).toBeGreaterThan(0)
      for (const value of timingValues) {
        expect(value).toBeGreaterThanOrEqual(-1)
        expect(value).toBeLessThan(30_000)
      }
      console.info(
        `[live-smoke] routed fetch HAR entry time=${entry.time}ms timings=${JSON.stringify(entry.timings)}`,
      )

      const requests = await checkedCommand<{
        requests: Array<{ url?: string }>
      }>('network', { action: 'requests', filter: pattern('a') })
      expect(
        (requests.requests || []).filter(
          (request) => new URL(String(request.url)).pathname === pattern('a'),
        ),
      ).toHaveLength(1)

      // 省略 url 的 unroute 清空全部路由，两个 URL 都应回到真实响应
      expect(
        await checkedCommand<{ routes: unknown[] }>('network', { action: 'unroute' }),
      ).toMatchObject({ routes: [] })
      for (const suffix of ['a', 'b']) {
        expect(
          await checkedCommand('eval', {
            script: `fetch('${pattern(suffix)}', { cache: 'no-store' }).then(response => response.text())`,
          }),
        ).toBe(`real-probe-body:${suffix}`)
      }
      expect(
        await checkedCommand<{ routes: unknown[] }>('network', {
          action: 'route',
          subaction: 'list',
        }),
      ).toMatchObject({ routes: [] })
    } finally {
      if (recording) await command('network', { action: 'har', subaction: 'stop' })
      await command('network', { action: 'unroute' })
      await loadSmokePage()
    }
  }, 90_000)

  test('continued slow HTTP route has real CDP HAR phases on the wall-clock millisecond scale', async () => {
    await loadSmokePage()
    let recording = false
    try {
      await checkedCommand('network', { action: 'route', url: '/routed-probe-slow' })
      await checkedCommand('network', { action: 'har', subaction: 'start' })
      recording = true
      const fetched = await checkedCommand<{ status: number; body: string; elapsedMs: number }>(
        'eval',
        {
          script: `(async () => {
            const started = performance.now();
            const response = await fetch('/routed-probe-slow', { cache: 'no-store' });
            const body = await response.text();
            return { status: response.status, body, elapsedMs: performance.now() - started };
          })()`,
        },
      )
      expect(fetched).toMatchObject({ status: 200, body: 'slow-probe-body' })
      expect(fetched.elapsedMs).toBeGreaterThanOrEqual(650)
      const stopped = await checkedCommand<{
        har: {
          log: {
            entries: Array<{
              time: number
              request: { url: string }
              response: { status: number; content: { text: string } }
              timings: Record<string, number>
            }>
          }
        }
      }>('network', { action: 'har', subaction: 'stop' })
      recording = false
      const entries = stopped.har.log.entries.filter(
        (entry) => new URL(entry.request.url).pathname === '/routed-probe-slow',
      )
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry.response).toMatchObject({ status: 200, content: { text: 'slow-probe-body' } })
      // 验证 CDP ResourceTiming 阶段字段，而不只检查总耗时或 mock 的 fallback。
      expect(Object.keys(entry.timings).sort()).toEqual([
        'blocked',
        'connect',
        'dns',
        'receive',
        'send',
        'ssl',
        'wait',
      ])
      expect(entry.timings.wait).toBeGreaterThanOrEqual(200)
      expect(entry.timings.receive).toBeGreaterThanOrEqual(150)
      expect(entry.time / fetched.elapsedMs).toBeGreaterThan(0.5)
      expect(entry.time / fetched.elapsedMs).toBeLessThan(2)
      for (const value of Object.values(entry.timings)) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(-1)
        expect(value).toBeLessThan(fetched.elapsedMs * 2)
      }
      // ssl 包含在 connect 中，不重复求和；宽松比例容纳事件派发误差，却不能容忍千倍单位错误。
      const phaseTotal = Object.entries(entry.timings)
        .filter(([phase]) => phase !== 'ssl')
        .reduce((sum, [, value]) => sum + Math.max(0, value), 0)
      expect(phaseTotal / fetched.elapsedMs).toBeGreaterThan(0.5)
      expect(phaseTotal / fetched.elapsedMs).toBeLessThan(2)
      const recorded = await checkedCommand<{
        requests: Array<{ url: string; routeAction?: string }>
      }>('network', { action: 'requests', filter: '/routed-probe-slow' })
      expect(recorded.requests).toHaveLength(1)
      expect(recorded.requests[0]?.routeAction).toBe('continue')
      console.info(
        `[live-smoke] continued slow fetch wall=${fetched.elapsedMs}ms HAR=${entry.time}ms timings=${JSON.stringify(entry.timings)}`,
      )
    } finally {
      if (recording) await command('network', { action: 'har', subaction: 'stop' })
      await command('network', { action: 'unroute' })
      await loadSmokePage()
    }
  }, 60_000)

  test('completed local download refreshes terminal byte counts and end time', async () => {
    await loadSmokePage()
    // 下载仅写入 harness 的临时目录，afterAll 先关闭隔离 Chrome 再删除，失败时也不会留下用户文件。
    const downloadPath = await mkdtemp(path.join(homeDir, 'downloads-'))
    const downloadUrl = new URL('/download-probe', pageUrl).href
    try {
      await cdp!.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath })
      await checkedCommand('eval', {
        script: `(() => {
          const anchor = document.createElement('a');
          anchor.href = ${JSON.stringify(downloadUrl)};
          anchor.download = 'live-probe.txt';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          return true;
        })()`,
      })
      interface Download {
        url: string
        filename: string
        state: string
        bytesReceived: number
        totalBytes: number
        endTime?: string | null
      }
      let completed: Download | undefined
      await waitFor(
        'the local download terminal snapshot',
        async () => {
          const listed = await checkedCommand<{ downloads: Download[] }>('downloads')
          completed = listed.downloads.find((item) => item.url === downloadUrl)
          return (
            completed?.state === 'complete' &&
            Boolean(completed.endTime) &&
            completed.bytesReceived === Buffer.byteLength(harBody)
          )
        },
        15_000,
      )
      expect(completed).toMatchObject({
        state: 'complete',
        bytesReceived: Buffer.byteLength(harBody),
        totalBytes: Buffer.byteLength(harBody),
      })
      expect(Number.isFinite(Date.parse(completed!.endTime!))).toBe(true)
      expect(completed!.filename).toBe(path.join(downloadPath, 'live-probe.txt'))
      expect(await readFile(path.join(downloadPath, 'live-probe.txt'), 'utf8')).toBe(harBody)
    } finally {
      await cdp!.send('Browser.setDownloadBehavior', { behavior: 'deny' })
      await loadSmokePage()
    }
  }, 60_000)
})
