import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const pageScript = fileURLToPath(new URL('./bilibili-feed-page.js', import.meta.url))
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-bilibili-feed-${process.pid}` }
const pageUrl = 'https://www.bilibili.com/'

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

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
  tabHandle = (await invoke(['tab', 'new', 'about:blank'])).result.tab?.handle
  assert(tabHandle, '新建标签未返回 handle')
  // 先禁掉页面自己的脚本，避免真实首页的卡片和脚本干扰采集结果。
  await invoke([
    '--tab',
    tabHandle,
    'cdp',
    'Emulation.setScriptExecutionDisabled',
    '--params',
    JSON.stringify({ value: true }),
  ])
  await invoke(['--tab', tabHandle, 'goto', pageUrl, '--wait-until', 'domcontentloaded'])

  await invoke(['--tab', tabHandle, 'run', pageScript, '--timeout-ms', '30000'])
  const feed = (
    await invoke([
      '--tab',
      tabHandle,
      'feed',
      'collect',
      '.bili-video-card',
      '--limit',
      '2',
      '--max-scrolls',
      '0',
      '--pause-ms',
      '0',
      '--dedupe',
      'url',
    ])
  ).result
  assert(feed.count === 2, `B 站条目数量不正确：${feed.count}`)

  const [normal, ad] = feed.items
  assert(normal.adapter === 'bilibili', `未启用 B 站适配器：${normal.adapter}`)
  assert(normal.author === '老番茄', `作者提取不正确：${JSON.stringify(normal)}`)
  assert(normal.handle === null, `B 站不应伪造 handle：${normal.handle}`)
  assert(normal.time === '2024-05-01', `发布时间提取不正确：${normal.time}`)
  assert(normal.promoted === false, '普通视频被误判成广告')
  assert(
    normal.authorUrl === 'https://space.bilibili.com/123456',
    `作者主页提取不正确：${normal.authorUrl}`,
  )
  assert(normal.trackingUrl === null, `普通视频不应有跟踪链接：${normal.trackingUrl}`)
  assert(
    normal.url === 'https://www.bilibili.com/video/BV1xx411c7mD',
    `BV 链接提取不正确：${normal.url}`,
  )
  assert(normal.mediaUrls.length === 1, '封面未保留为正文媒体')

  assert(ad.adapter === 'bilibili', `未启用 B 站适配器：${ad.adapter}`)
  assert(ad.promoted === true, '广告卡未被标记为推广')
  assert(
    typeof ad.trackingUrl === 'string' && ad.trackingUrl.includes('cm.bilibili.com'),
    `广告跟踪链接提取不正确：${ad.trackingUrl}`,
  )
  assert(ad.url === null, `广告卡不应有内容链接：${ad.url}`)
  assert(ad.authorUrl === null, `广告卡不应有作者主页：${ad.authorUrl}`)

  summary = {
    ok: true,
    tab: tabHandle,
    checks: [
      'adapter-host-and-dom-match',
      'author-from-owner',
      'no-fake-handle',
      'publish-time',
      'promoted-flag',
      'author-space-url',
      'tracking-url',
      'tracking-url-not-identity',
      'both-items-kept',
    ],
    items: [
      {
        adapter: normal.adapter,
        author: normal.author,
        handle: normal.handle,
        time: normal.time,
        url: normal.url,
        promoted: normal.promoted,
        authorUrl: normal.authorUrl,
        trackingUrl: normal.trackingUrl,
        mediaUrls: normal.mediaUrls,
      },
      {
        adapter: ad.adapter,
        author: ad.author,
        handle: ad.handle,
        time: ad.time,
        url: ad.url,
        promoted: ad.promoted,
        authorUrl: ad.authorUrl,
        trackingUrl: ad.trackingUrl,
      },
    ],
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
