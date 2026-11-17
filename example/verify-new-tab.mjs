import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

/**
 * 验证 target=_blank 新标签的检测与显式跟随：
 *
 * 1. 第一次 click 只报告新标签（newTabId / newTabHandle），当前目标不变；
 * 2. 第二次 click --follow-new-tab 才会接管新标签，随后能读到新页面的 URL 与标题。
 *
 * 页面由本地 HTTP 服务提供，跑完会关掉全部新建标签并停掉服务。
 *
 * CLI 用异步 spawn 调用：同步的 spawnSync 会阻塞本进程的事件循环，
 * 本地 HTTP 服务在 CLI 等待期间无法响应，页面会加载超时。
 */

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const workspace = `example-new-tab-${process.pid}`
const env = { ...process.env, AUTOBROWSER_WORKSPACE: workspace }

const SOURCE_HTML = `<!doctype html>
<html>
  <head><title>Source Page</title></head>
  <body>
    <h1>Source Page</h1>
    <a id="new-tab" href="/target.html" target="_blank">open in new tab</a>
  </body>
</html>
`

const TARGET_HTML = `<!doctype html>
<html>
  <head><title>Target Page</title></head>
  <body>
    <h1>Target Page</h1>
    <p id="marker">opened in a new tab</p>
  </body>
</html>
`

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const INVOKE_TIMEOUT_MS = 45_000

/**
 * 调用 CLI 并等待结束。
 *
 * 必须用异步 spawn：CLI 会驱动浏览器去访问本进程的本地 HTTP 服务，
 * 同步等待会把事件循环占住，服务端根本没法回应请求。
 */
const invoke = async (args, { allowFailure = false } = {}) => {
  const child = spawn(cli, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${args.join(' ')} 超时（${INVOKE_TIMEOUT_MS}ms）`))
    }, INVOKE_TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })

  if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new Error(`${args.join(' ')} 输出超过 ${MAX_OUTPUT_BYTES} 字节`)
  }

  let output
  try {
    output = JSON.parse(result.stdout)
  } catch {
    throw new Error(`CLI 未返回 JSON：${result.stdout || result.stderr}`)
  }

  if (!allowFailure && (result.status !== 0 || output.ok === false)) {
    const error = new Error(`${args.join(' ')} 失败：${JSON.stringify(output.error ?? output)}`)
    error.output = output
    throw error
  }

  return output
}

function startServer() {
  const server = createServer((request, response) => {
    if (request.url === '/target.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(TARGET_HTML)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(SOURCE_HTML)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 })
    })
  })
}

const closedHandles = []
const closeTab = async (handle) => {
  if (!handle || closedHandles.includes(handle)) return
  closedHandles.push(handle)
  // 新标签默认不属于任何 workspace，先按 workspace 归属关闭，失败再按裸句柄关闭
  await invoke(['tab', 'close', handle], { allowFailure: true })
  await invoke(['--no-workspace', 'tab', 'close', handle], { allowFailure: true })
}

let server = null
let sourceHandle = null
let reportedHandle = null
let followedHandle = null
let primaryError = null
let cleanupError = null

try {
  const started = await startServer()
  server = started.server
  const sourceUrl = `http://127.0.0.1:${started.port}/source.html`
  const targetUrl = `http://127.0.0.1:${started.port}/target.html`

  const created = (await invoke(['tab', 'new', sourceUrl])).result
  sourceHandle = created.tab?.handle
  assert(sourceHandle, '新建标签页未返回 handle')

  await invoke(['--tab', sourceHandle, 'wait', '#new-tab', '--state', 'visible'])

  // 第一次点击：只报告新标签，当前目标不变
  const reported = (await invoke(['--tab', sourceHandle, 'click', '#new-tab'])).result
  reportedHandle = reported.newTabHandle
  assert(reported.newTabId !== undefined, '点击结果没有报告 newTabId')
  assert(reportedHandle, '点击结果没有报告 newTabHandle')
  assert(!reported.followedTab, '默认点击不应跟随新标签')

  const urlAfterReport = (await invoke(['get', 'url'])).result?.value
  assert(urlAfterReport === sourceUrl, `默认只报告时当前目标应仍是原页面，实际是 ${urlAfterReport}`)

  // 第二次点击前恢复原标签前台，确保 target=_blank 获得真实用户激活。
  await invoke(['tab', 'select', sourceHandle])
  let followed
  try {
    followed = (await invoke(['--tab', sourceHandle, 'click', '#new-tab', '--follow-new-tab']))
      .result
  } catch (error) {
    followedHandle = error.output?.result?.newTabHandle ?? null
    throw error
  }
  followedHandle = followed.newTabHandle
  assert(followedHandle, `跟随点击没有报告 newTabHandle：${JSON.stringify(followed)}`)
  assert(followed.followedTab?.handle === followedHandle, '跟随结果里的 followedTab 不匹配')
  assert(followed.meta?.tabHandle === followedHandle, '跟随后的 meta 没有指向新标签')

  // 新标签还在加载，等它把正文渲染出来再读标题
  await invoke(['wait', '--text', 'opened in a new tab'])

  const urlAfterFollow = (await invoke(['get', 'url'])).result?.value
  const titleAfterFollow = (await invoke(['get', 'title'])).result?.value
  assert(urlAfterFollow === targetUrl, `跟随后当前 URL 应为 ${targetUrl}，实际是 ${urlAfterFollow}`)
  assert(
    titleAfterFollow === 'Target Page',
    `跟随后标题应为 Target Page，实际是 ${titleAfterFollow}`,
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        sourceHandle,
        reportedHandle,
        followedHandle,
        urlAfterReport,
        urlAfterFollow,
        titleAfterFollow,
        checks: [
          'click reports newTabId/newTabHandle',
          'click does not follow by default',
          'click --follow-new-tab attaches the new tab',
          'followed target exposes url and title',
        ],
      },
      null,
      2,
    ),
  )
} catch (error) {
  primaryError = error
} finally {
  for (const handle of [followedHandle, reportedHandle, sourceHandle]) {
    try {
      await closeTab(handle)
    } catch (error) {
      cleanupError = cleanupError || error
    }
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve))
  }
}

if (primaryError || cleanupError) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: primaryError ? String(primaryError.message ?? primaryError) : null,
        cleanupError: cleanupError ? String(cleanupError.message ?? cleanupError) : null,
        sourceHandle,
        reportedHandle,
        followedHandle,
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
}
