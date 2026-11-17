import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const pageScript = fileURLToPath(new URL('./youtube-feed-page.js', import.meta.url))
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-youtube-feed-${process.pid}` }
const pageUrl = 'https://www.youtube.com/'

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
      'ytd-video-renderer',
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
  assert(feed.count === 1, `YouTube 条目数量不正确：${feed.count}`)
  const item = feed.items[0]
  assert(item.adapter === 'youtube', `未启用 YouTube 适配器：${item.adapter}`)
  assert(item.author === 'MoonBit', `作者提取不正确：${JSON.stringify(item)}`)
  assert(item.handle === '@MoonBit_lang', `频道 handle 提取不正确：${item.handle}`)
  assert(item.time === '3个月前', `发布时间提取不正确：${item.time}`)
  assert(item.mediaUrls.length === 1, '视频缩略图未保留为正文媒体')
  assert(item.mediaUrls[0].includes('i.ytimg.com/vi/'), '正文媒体不是视频缩略图')
  assert(item.avatarUrls.length === 1, '频道头像未单独提取')
  assert(item.avatarUrls[0].includes('yt3.ggpht.com'), '头像 URL 不正确')
  assert(
    item.mediaUrls.every((url) => !url.includes('yt3.ggpht.com')),
    '频道头像仍混入 mediaUrls',
  )
  assert(item.timelineContext === null && item.repostBy === null, 'YouTube 被误加转帖上下文')

  summary = {
    ok: true,
    tab: tabHandle,
    checks: [
      'adapter-host-and-dom-match',
      'author',
      'channel-handle',
      'relative-time',
      'avatar-separation',
      'video-thumbnail',
      'no-repost-context',
    ],
    item: {
      adapter: item.adapter,
      author: item.author,
      handle: item.handle,
      time: item.time,
      url: item.url,
      mediaUrls: item.mediaUrls,
      avatarUrls: item.avatarUrls,
    },
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
