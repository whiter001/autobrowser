import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-feed-context-${process.pid}` }

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/profile_images/') || url.pathname.startsWith('/media/')) {
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    return
  }

  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html>
    <html lang="zh-CN">
      <head><title>feed context fixture</title></head>
      <body style="height: 5000px">
        <article>
          <div data-testid="socialContext">Hongbo Zhang 已转帖</div>
          <div data-testid="Tweet-User-Avatar"><img src="/profile_images/ada.png"></div>
          <div data-testid="User-Name">Ada · @ada</div>
          <time datetime="2026-11-17T00:00:00.000Z"></time>
          <div data-testid="tweetText">正文图片与头像应分离</div>
          <a href="/status/1">查看</a>
          <div data-testid="tweetPhoto"><img src="/media/ada.png"></div>
        </article>
        <article>
          <div data-testid="User-Name">Bob · @bob</div>
          <img src="/profile_images/bob.png">
          <div data-testid="tweetText">普通帖子不应误带转帖上下文</div>
          <a href="/status/2">查看</a>
          <div class="retweet-action"><button data-testid="retweet" role="button">3 次转帖。转帖</button></div>
        </article>
        <article>
          <div data-testid="User-Name">Carol · @carol</div>
          <div data-testid="tweetText">普通站点图片仍是正文媒体</div>
          <a href="/status/3">查看</a>
          <img src="/media/generic.png">
        </article>
      </body>
    </html>`)
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address === 'object', '本地服务启动失败')
const pageUrl = `http://127.0.0.1:${address.port}/`

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
  tabHandle = (await invoke(['tab', 'new', pageUrl])).result.tab?.handle
  assert(tabHandle, '新建标签未返回 handle')
  await invoke(['--tab', tabHandle, 'wait', 'article'])

  const feed = (
    await invoke([
      '--tab',
      tabHandle,
      'feed',
      'collect',
      'article',
      '--limit',
      '10',
      '--max-scrolls',
      '0',
      '--pause-ms',
      '0',
    ])
  ).result
  assert(feed.count === 3, `feed 条目数量不正确：${feed.count}`)
  const [repost, plain, generic] = feed.items

  assert(repost.timelineContext === 'Hongbo Zhang 已转帖', '转帖上下文不正确')
  assert(repost.repostBy === 'Hongbo Zhang', '转帖人提取不正确')
  assert(repost.author === 'Ada', '原作者字段被转帖人覆盖')
  assert(
    repost.mediaUrls.every((url) => !url.includes('/profile_images/')),
    'mediaUrls 仍含头像',
  )
  assert(repost.mediaUrls[0].endsWith('/media/ada.png'), '正文图片缺失')
  assert(repost.avatarUrls[0].endsWith('/profile_images/ada.png'), '头像未单独提取')

  assert(plain.mediaUrls.length === 0 && plain.avatarUrls.length === 1, '纯头像条目分类不正确')
  assert(plain.timelineContext === null && plain.repostBy === null, '操作按钮被误判为转帖上下文')
  assert(generic.mediaUrls[0].endsWith('/media/generic.png'), '普通图片未回退为正文媒体')
  assert(generic.avatarUrls.length === 0, '普通图片被误判为头像')

  await invoke(['--tab', tabHandle, 'scroll', '0', '1800'])
  const scrolled = (await invoke(['--tab', tabHandle, 'eval', '--expr', 'window.scrollY'])).result
  assert(scrolled === 1800, `双数字页面滚动不正确：${scrolled}`)

  await invoke(['--tab', tabHandle, 'scroll', '-600'])
  const restored = (await invoke(['--tab', tabHandle, 'eval', '--expr', 'window.scrollY'])).result
  assert(restored === 1200, `单数字纵向滚动不正确：${restored}`)

  summary = {
    ok: true,
    tab: tabHandle,
    checks: [
      'body-media',
      'avatar-separation',
      'generic-media-fallback',
      'repost-context',
      'no-action-button-context',
      'numeric-scroll',
      'single-axis-scroll',
    ],
    scroll: { scrolled, restored },
    items: feed.items.map((item) => ({
      author: item.author,
      mediaUrls: item.mediaUrls,
      avatarUrls: item.avatarUrls,
      timelineContext: item.timelineContext,
      repostBy: item.repostBy,
    })),
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
