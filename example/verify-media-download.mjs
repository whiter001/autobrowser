import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-media-download-${process.pid}` }
const artifacts = await mkdtemp(join(tmpdir(), 'autobrowser-media-example-'))
let server
let invoke
let tabHandle
let summary
let primaryError
let cleanupError

try {
  const hlsDir = join(artifacts, 'hls')
  const variantDir = join(hlsDir, 'low')
  const mp4Path = join(artifacts, 'fixture.mp4')
  const outputPath = join(artifacts, 'downloaded.mp4')
  await mkdir(variantDir, { recursive: true })

  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  const runTool = async (command, args) => {
    try {
      return await execFileAsync(command, args, { maxBuffer: 4 * 1024 * 1024 })
    } catch (error) {
      throw new Error(`${command} 执行失败，请确认已安装并位于 PATH：${error.message}`)
    }
  }

  await runTool('ffmpeg', ['-version'])
  await runTool('ffprobe', ['-version'])
  const inputs = [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=128x96:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=44100',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '10',
    '-c:a',
    'aac',
  ]
  await runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, mp4Path])
  await runTool('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    join(variantDir, 'segment-%03d.ts'),
    join(variantDir, 'index.m3u8'),
  ])
  const masterPath = join(hlsDir, 'master.m3u8')
  await writeFile(
    masterPath,
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=128000,RESOLUTION=128x96\nlow/index.m3u8\n',
  )

  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/mse') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
      <html lang="zh-CN">
        <head><title>MSE fixture</title></head>
        <body>
          <article><video id="video" muted autoplay></video></article>
          <script>
            (async () => {
              const video = document.querySelector('#video')
              const response = await fetch('/fixture.mp4')
              video.src = URL.createObjectURL(await response.blob())
              window.probeCalls = { play: 0, pause: 0, muted: 0 }
              const play = video.play.bind(video)
              const pause = video.pause.bind(video)
              video.play = (...args) => { window.probeCalls.play += 1; return play(...args) }
              video.pause = (...args) => { window.probeCalls.pause += 1; return pause(...args) }
              const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted')
              Object.defineProperty(video, 'muted', {
                get() { return descriptor.get.call(this) },
                set(value) {
                  window.probeCalls.muted += 1
                  descriptor.set.call(this, value)
                },
              })
              await play()
              window.probeCalls = { play: 0, pause: 0, muted: 0 }
              document.body.dataset.playing = 'true'
            })().catch((error) => {
              document.body.dataset.playbackError = error.message
            })
          </script>
        </body>
      </html>`)
      return
    }

    const filePath = url.pathname === '/fixture.mp4' ? mp4Path : join(hlsDir, url.pathname)
    if (url.pathname !== '/fixture.mp4' && !filePath.startsWith(hlsDir)) {
      response.writeHead(400)
      response.end()
      return
    }
    try {
      const data = await readFile(filePath)
      const contentType = filePath.endsWith('.m3u8')
        ? 'application/x-mpegURL'
        : filePath.endsWith('.ts')
          ? 'video/mp2t'
          : 'video/mp4'
      response.writeHead(200, { 'content-type': contentType })
      response.end(data)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object', '本地媒体服务启动失败')
  const baseUrl = `http://127.0.0.1:${address.port}`

  invoke = (args, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const child = spawn(cli, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`${args.join(' ')} 超时`))
      }, timeoutMs)
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

  tabHandle = (await invoke(['tab', 'new', `${baseUrl}/mse`])).result.tab?.handle
  assert(tabHandle, '新建媒体标签未返回 handle')
  await invoke(['--tab', tabHandle, 'wait', 'body[data-playing="true"]', '--timeout-ms', '15000'])

  const resolveStartedAt = Date.now()
  const listed = (
    await invoke(['--tab', tabHandle, 'media', 'list', '--selector', 'article', '--resolve'])
  ).result
  const resolveMs = Date.now() - resolveStartedAt
  const item = listed.media[0]
  assert(item, '未找到 blob 视频')
  assert(item.url.startsWith('blob:'), '测试视频不是 blob 源')
  assert(item.sources.length === 0, 'blob 不应产生可信 DOM 源')
  assert(item.primarySource === 'none', 'blob 主来源应为 none')
  assert(item.suggestedAction.includes('network har start'), '缺少 fresh HAR 恢复指引')
  assert(item.suggestedAction.includes('master m3u8'), '恢复指引缺少 master m3u8')
  assert(resolveMs < 10_000, `MSE 探测未快速返回：${resolveMs}ms`)

  const probeCalls = (await invoke(['--tab', tabHandle, 'eval', '--expr', 'window.probeCalls']))
    .result
  assert(probeCalls.play === 0, '已播放视频被重复调用 play()')
  assert(probeCalls.pause === 0, '已播放视频被 pause()')
  assert(probeCalls.muted === 0, '已播放视频被改写 muted')

  const downloaded = (
    await invoke(
      [
        '--tab',
        tabHandle,
        'download',
        `${baseUrl}/master.m3u8`,
        outputPath,
        '--quality',
        'worst',
        '--concurrency',
        '2',
        '--timeout-ms',
        '60000',
        '--retries',
        '0',
      ],
      90_000,
    )
  ).result
  assert(downloaded.hls === true, 'master URL 未按 HLS 下载')
  assert(downloaded.segments >= 2, 'HLS 分片数量不正确')
  assert(downloaded.bytes > 0, '下载文件为空')

  const probe = JSON.parse(
    (
      await runTool('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration,size:stream=codec_type,codec_name,width,height',
        '-of',
        'json',
        outputPath,
      ])
    ).stdout,
  )
  const video = probe.streams.find((stream) => stream.codec_type === 'video')
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  assert(video?.codec_name === 'h264', '下载文件缺少 H.264 视频流')
  assert(video.width === 128 && video.height === 96, '下载分辨率不正确')
  assert(audio?.codec_name === 'aac', '下载文件缺少 AAC 音频流')
  assert(Number(probe.format.duration) >= 1.5, '下载视频时长不完整')
  const sha256 = createHash('sha256')
    .update(await readFile(outputPath))
    .digest('hex')
  assert(sha256 === downloaded.sha256, '下载文件 SHA-256 不匹配')

  summary = {
    ok: true,
    tab: tabHandle,
    checks: [
      'mse-fast-fallback',
      'no-playback-side-effects',
      'fresh-har-guidance',
      'hls-download',
      'ffprobe-validation',
      'sha256-validation',
    ],
    resolveMs,
    probeCalls,
    download: {
      segments: downloaded.segments,
      bytes: downloaded.bytes,
      duration: Number(probe.format.duration),
      width: video.width,
      height: video.height,
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
  if (server) {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
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
