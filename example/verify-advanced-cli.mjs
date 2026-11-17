import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const pageScript = fileURLToPath(new URL('./verify-advanced-page.js', import.meta.url))
const workspace = `example-advanced-smoke-${process.pid}`
const env = { ...process.env, AUTOBROWSER_WORKSPACE: workspace }
const requests = []
const artifacts = await mkdtemp(join(tmpdir(), 'autobrowser-advanced-example-'))
const uploadPath = join(artifacts, 'upload.txt')
const downloadPath = join(artifacts, 'download.txt')
const screenshotPath = join(artifacts, 'page.png')
const pdfPath = join(artifacts, 'page.pdf')
const harPath = join(artifacts, 'network.har')
await writeFile(uploadPath, 'upload-content')

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const send = (response, status, body, contentType = 'text/html; charset=utf-8') => {
  response.writeHead(status, { 'content-type': contentType })
  response.end(body)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  requests.push(`${url.pathname}${url.search}`)

  if (url.pathname === '/') {
    send(response, 200, '<!doctype html><title>advanced fixture</title>')
    return
  }
  if (url.pathname === '/frame') {
    send(
      response,
      200,
      `<!doctype html>
        <button id="frame-action" type="button">Frame action</button>
        <output id="frame-result">waiting</output>
        <script>
          document.querySelector('#frame-action').addEventListener('click', () => {
            document.querySelector('#frame-result').textContent = 'frame-ready'
          })
        </script>`,
    )
    return
  }
  if (url.pathname === '/api/items') {
    await new Promise((resolve) => setTimeout(resolve, 40))
    const query = url.searchParams.get('query')
    const mode = url.searchParams.get('mode')
    send(
      response,
      200,
      JSON.stringify({ items: [`query:${query}`, `mode:${mode}`, 'server:ok'] }),
      'application/json',
    )
    return
  }
  if (url.pathname === '/api/should-be-mocked') {
    send(response, 500, JSON.stringify({ error: 'route interception failed' }), 'application/json')
    return
  }
  if (url.pathname === '/artifact.txt') {
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="advanced.txt"',
    })
    response.end('download-content')
    return
  }
  send(response, 404, 'not found', 'text/plain')
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address === 'object', '本地 HTTP 服务启动失败')
const baseUrl = `http://127.0.0.1:${address.port}/`

const invoke = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cli, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${args.join(' ')} 超时`))
    }, 45_000)

    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      let output
      try {
        output = JSON.parse(stdout)
      } catch {
        reject(new Error(`CLI 未返回 JSON：${stdout || stderr}`))
        return
      }
      if (status !== 0 || output.ok === false) {
        reject(new Error(`${args.join(' ')} 失败：${JSON.stringify(output.error ?? output)}`))
        return
      }
      resolve(output)
    })
  })

let tabHandle
let routeActive = false
let harCaptureId
let summary
let primaryError
let cleanupError

try {
  const version = (await invoke(['version', '--json'])).result
  assert(version.versionSkew?.consistent, 'CLI 与扩展版本或 commit 不一致')

  const status = await invoke(['status', '--json'])
  assert(status.extensionConnected, 'Chrome 扩展未连接')

  const created = (await invoke(['tab', 'new', baseUrl])).result
  tabHandle = created.tab?.handle
  assert(tabHandle, '新建标签页未返回 handle')

  const runResult = (await invoke(['--tab', tabHandle, 'run', pageScript, '--timeout-ms', '30000']))
    .result.value
  for (const check of [
    'validation-error',
    'form-and-async-fetch',
    'route-interception',
    'iframe-interaction',
    'native-dialog',
    'storage-and-cookie',
  ]) {
    assert(runResult.checks?.includes(check), `run 缺少断言：${check}`)
  }

  const stored = (await invoke(['--tab', tabHandle, 'storage', 'get', 'advanced-smoke'])).result
  assert(stored.empty === false, 'CLI 未读到 localStorage')
  const storedValue = JSON.parse(stored.value)
  assert(
    storedValue.query === 'alpha' && storedValue.mode === 'deep' && storedValue.count === 3,
    'CLI 读取的 localStorage 内容不正确',
  )

  const cookieResult = (
    await invoke(['--tab', tabHandle, 'cookies', 'get', '--domain', '127.0.0.1'])
  ).result
  const cookie = cookieResult.cookies?.find((item) => item.name === 'advanced_smoke')
  assert(cookie?.value === 'ready', 'CLI 未读到页面写入的 cookie')

  const network = (
    await invoke(['--tab', tabHandle, 'network', 'requests', '--filter', '/api/', '--limit', '50'])
  ).result
  const urls = network.requests?.map((request) => request.url) ?? []
  assert(
    urls.some((url) => new URL(url).pathname === '/api/items'),
    'CLI 网络记录缺少真实 API 请求',
  )

  assert(
    requests.filter((path) => path.startsWith('/api/items?')).length === 1,
    '本地服务收到的真实 API 请求次数不正确',
  )
  assert(!requests.includes('/api/should-be-mocked'), '被拦截的请求不应到达本地服务')

  await invoke(['--tab', tabHandle, 'upload', '#upload', uploadPath])
  await invoke([
    '--tab',
    tabHandle,
    'wait',
    '--fn',
    'document.querySelector("#upload-result")?.textContent === "upload.txt:upload-content"',
  ])
  const uploadResult = (
    await invoke([
      '--tab',
      tabHandle,
      'eval',
      '--expr',
      'document.querySelector("#upload-result").textContent',
    ])
  ).result
  assert(uploadResult === 'upload.txt:upload-content', 'CLI 上传后的文件内容不正确')

  await invoke([
    '--tab',
    tabHandle,
    'download',
    `${baseUrl}artifact.txt`,
    downloadPath,
    '--retries',
    '0',
  ])
  assert((await readFile(downloadPath, 'utf8')) === 'download-content', 'CLI 下载文件内容不正确')

  await invoke(['--tab', tabHandle, 'screenshot', screenshotPath, '--full'])
  const screenshot = await readFile(screenshotPath)
  assert(
    screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    '截图不是有效 PNG 文件',
  )

  const pdf = (await invoke(['--tab', tabHandle, 'pdf'])).result
  assert(pdf.mimeType === 'application/pdf', 'PDF MIME 类型不正确')
  const pdfData = Buffer.from(pdf.dataUrl?.split(',')[1] ?? '', 'base64')
  assert(pdfData.subarray(0, 4).toString() === '%PDF', 'PDF 文件头不正确')
  await writeFile(pdfPath, pdfData)

  await invoke([
    '--tab',
    tabHandle,
    'network',
    'route',
    '/api/cli-route',
    '--body',
    JSON.stringify({ source: 'cli-har', value: 7 }),
    '--content-type',
    'application/json',
  ])
  routeActive = true
  const harStart = (
    await invoke([
      '--tab',
      tabHandle,
      'network',
      'har',
      'start',
      '--include-pattern',
      '/api/cli-route',
    ])
  ).result
  harCaptureId = harStart.captureId
  assert(harCaptureId, 'HAR 未返回 captureId')

  const routed = (
    await invoke([
      '--tab',
      tabHandle,
      'eval',
      '--expr',
      '(async () => { const response = await fetch("/api/cli-route"); return { status: response.status, body: await response.json() }; })()',
    ])
  ).result
  assert(
    routed.status === 200 && routed.body.source === 'cli-har' && routed.body.value === 7,
    'CLI 网络路由响应不正确',
  )

  await invoke([
    '--tab',
    tabHandle,
    'network',
    'har',
    'stop',
    harPath,
    '--capture-id',
    harCaptureId,
  ])
  harCaptureId = null
  const har = JSON.parse(await readFile(harPath, 'utf8'))
  const harEntries = har.log.entries.filter(
    (entry) => new URL(entry.request.url).pathname === '/api/cli-route',
  )
  assert(harEntries.length === 1, 'HAR 中 CLI 路由请求数量不正确')
  const harBody = JSON.parse(harEntries[0].response.content.text)
  assert(harBody.source === 'cli-har' && harBody.value === 7, 'HAR 响应体不正确')

  await invoke(['--tab', tabHandle, 'network', 'unroute', '/api/cli-route'])
  routeActive = false
  assert(!requests.includes('/api/cli-route'), 'CLI 拦截的请求不应到达本地服务')

  const cdp = (
    await invoke([
      '--tab',
      tabHandle,
      'cdp',
      'Runtime.evaluate',
      '--params',
      JSON.stringify({ expression: '6 * 7', returnByValue: true }),
    ])
  ).result
  assert(cdp.result?.result?.value === 42, 'CDP Runtime.evaluate 返回值不正确')

  summary = {
    ok: true,
    cli: version.cli,
    extension: version.extension,
    tab: tabHandle,
    checks: [
      'version',
      'connection',
      'tab-new',
      ...runResult.checks,
      'storage-cli',
      'cookies-cli',
      'network-cli',
      'server-route-isolation',
      'upload-cli',
      'download-cli',
      'screenshot-file',
      'pdf-data',
      'cli-route-har',
      'cdp',
    ],
    localRequests: requests,
  }
} catch (error) {
  primaryError = error
} finally {
  if (tabHandle) {
    const cleanupCommands = []
    if (harCaptureId) {
      cleanupCommands.push([
        '--tab',
        tabHandle,
        'network',
        'har',
        'stop',
        harPath,
        '--capture-id',
        harCaptureId,
      ])
    }
    if (routeActive) {
      cleanupCommands.push(['--tab', tabHandle, 'network', 'unroute', '/api/cli-route'])
    }
    cleanupCommands.push(
      ['--tab', tabHandle, 'storage', 'clear'],
      ['--tab', tabHandle, 'cookies', 'delete', 'advanced_smoke'],
      ['tab', 'close', tabHandle],
    )
    for (const args of cleanupCommands) {
      try {
        await invoke(args)
      } catch (error) {
        cleanupError ??= error
      }
    }
  }
  server.closeAllConnections()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
  try {
    await rm(artifacts, { recursive: true, force: true })
  } catch (error) {
    cleanupError ??= error
  }
}

if (primaryError || cleanupError) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: primaryError ? String(primaryError.message ?? primaryError) : null,
        cleanupError: cleanupError ? String(cleanupError.message ?? cleanupError) : null,
        tab: tabHandle,
        localRequests: requests,
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
} else {
  console.log(JSON.stringify(summary, null, 2))
}
