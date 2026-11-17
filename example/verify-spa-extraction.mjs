import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const pageScript = fileURLToPath(new URL('./spa-extraction.js', import.meta.url))
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-spa-extraction-${process.pid}` }
const artifacts = await mkdtemp(join(tmpdir(), 'autobrowser-spa-example-'))
const outputPath = join(artifacts, 'research-items.json')

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })

  if (url.pathname === '/search') {
    response.end(`<!doctype html>
      <html lang="zh-CN">
        <head><title>搜索中</title></head>
        <body>
          <div class="ai-summary" hidden>重复的隐藏摘要</div>
          <main id="search-root">加载中</main>
          <script>
            setTimeout(() => {
              const root = document.querySelector('#search-root')
              root.replaceChildren()
              const summary = document.createElement('div')
              summary.className = 'ai-summary'
              summary.textContent = '可见的知乎 AI 摘要'
              root.append(summary)
              const link = document.createElement('a')
              link.dataset.targetAnswer = ''
              link.href = '/question/1/answer/target'
              link.textContent = '目标回答'
              root.append(link)
              for (let index = 0; index < 280; index += 1) {
                const card = document.createElement('a')
                card.href = '/item/' + index
                card.textContent = '动态结果 ' + index
                root.append(card)
              }
              document.title = '(35 封私信) 动态搜索结果'
            }, 60)
          </script>
        </body>
      </html>`)
    return
  }

  if (url.pathname === '/question/1/answer/target') {
    response.end(`<!doctype html>
      <html lang="zh-CN">
        <head><title>(35 封私信) 目标回答 - 知乎</title></head>
        <body>
          <article id="answer-other">
            <div class="author">其他作者</div>
            <div class="RichContent-inner">其他回答正文</div>
          </article>
          <article id="answer-target">
            <div class="author">目标作者</div>
            <time class="published-at">2026-11-17</time>
            <div class="RichContent-inner">目标回答正文：保留来源元数据，再整理报告。</div>
          </article>
        </body>
      </html>`)
    return
  }

  response.statusCode = 404
  response.end('not found')
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address === 'object', '本地 SPA 服务启动失败')
const searchUrl = `http://127.0.0.1:${address.port}/search`

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
let summary
let primaryError
let cleanupError

try {
  tabHandle = (await invoke(['tab', 'new', searchUrl])).result.tab?.handle
  assert(tabHandle, '新建 SPA 标签未返回 handle')
  await invoke(['--tab', tabHandle, 'wait', '.ai-summary:not([hidden])', '--state', 'visible'])

  const snapshot = (await invoke(['--tab', tabHandle, 'snapshot', '--limit', '50'])).result
  assert(snapshot.truncated === true, '动态节点应触发快照截断')
  assert(snapshot.totalElements > snapshot.returnedElements, '快照计数未反映截断')

  const runResult = (await invoke(['--tab', tabHandle, 'run', pageScript, '--timeout-ms', '30000']))
    .result.value
  for (const check of ['visible-deduplication', 'target-answer-container', 'dynamic-title']) {
    assert(runResult.checks?.includes(check), `SPA 提取缺少断言：${check}`)
  }

  const exported = (
    await invoke([
      '--tab',
      tabHandle,
      'eval',
      '--expr',
      'window.researchItems',
      '--output',
      outputPath,
    ])
  ).result
  assert(exported.format === 'json', 'eval --output 未声明 JSON 格式')
  assert(exported.bytes > 32 * 1024, '导出结果未超过 concise 的 32KiB 上限')

  const items = JSON.parse(await readFile(outputPath, 'utf8'))
  assert(Array.isArray(items) && items.length === 140, 'JSON 导出条目数量不正确')
  assert(items[0].title === '结构化条目 1' && items[139].id === 140, 'JSON 导出内容不完整')

  summary = {
    ok: true,
    tab: tabHandle,
    checks: [
      'bounded-snapshot',
      'dynamic-spa-wait',
      ...runResult.checks,
      'large-eval-output',
      'json-file-roundtrip',
    ],
    answer: runResult.answer,
    exported: { format: exported.format, bytes: exported.bytes, itemCount: items.length },
  }
} catch (error) {
  primaryError = error
} finally {
  if (tabHandle) {
    try {
      await invoke(['tab', 'close', tabHandle])
    } catch (error) {
      cleanupError = error
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
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
} else {
  console.log(JSON.stringify(summary, null, 2))
}
