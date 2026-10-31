import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildLocalPlaylist,
  detectHls,
  downloadMediaWithHls,
  MAX_HLS_SEGMENTS,
  type BrowserDownloadResult,
  type HlsTool,
  type HlsToolRunner,
} from '../src/cli/hls-download.js'
import {
  parseHlsMasterPlaylist,
  parseHlsMediaPlaylist,
  selectHlsAudioRendition,
  selectHlsVariant,
} from '../src/cli/hls-manifest.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hls-download-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

/** 记录下载调用的假 requestDownload，模拟 relay 把字节写到目标路径。 */
interface FakeDownloader {
  requestDownload: (
    url: string,
    outputPath: string,
    timeoutMs?: number,
  ) => Promise<BrowserDownloadResult>
  calls: Array<{ url: string; outputPath: string; timeoutMs?: number }>
  concurrent: number
  maxConcurrent: number
}

function createFakeDownloader(
  files: Record<string, { body: string | Buffer; contentType?: string }>,
  options: {
    failOn?: (url: string, callIndex: number) => boolean
    delayMs?: number
    onCall?: (url: string) => void | Promise<void>
  } = {},
): FakeDownloader {
  const state: FakeDownloader = {
    calls: [],
    concurrent: 0,
    maxConcurrent: 0,
    requestDownload: async (url, outputPath, timeoutMs) => {
      state.calls.push({ url, outputPath, timeoutMs })
      const index = state.calls.length - 1
      state.concurrent += 1
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent)
      try {
        if (options.onCall) await options.onCall(url)
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        if (options.failOn?.(url, index)) {
          throw new Error(`模拟下载失败: ${url}`)
        }
        const entry = files[url]
        if (!entry) throw new Error(`未注册的下载 URL: ${url}`)
        await mkdir(path.dirname(outputPath), { recursive: true })
        await writeFile(outputPath, entry.body)
        return {
          sourceUrl: url,
          finalUrl: url,
          contentType: entry.contentType ?? null,
          bytes: Buffer.byteLength(entry.body),
          sha256: 'fake-sha256',
          path: outputPath,
        }
      } finally {
        state.concurrent -= 1
      }
    },
  }
  return state
}

/** 假的 ffmpeg/ffprobe：不真的执行二进制，只按调用约定产出结果。 */
function createFakeTools(
  options: {
    ffmpegOutput?: string
    ffprobeJson?: string
    available?: boolean
    failFfmpeg?: boolean
  } = {},
): HlsToolRunner & { ffmpegArgs: string[][] } {
  const ffmpegArgs: string[][] = []
  const runner = {
    ffmpegArgs,
    isAvailable: async (_tool: HlsTool) => options.available !== false,
    run: async (tool: HlsTool, args: string[]) => {
      // 模块会先探测 hls demuxer 支持哪些选项，这里返回一份常见的选项清单
      if (tool === 'ffmpeg' && args.includes('-h')) {
        return {
          stdout: [
            'hls demuxer AVOptions:',
            '  -allowed_extensions <string>  List of file extensions',
            '  -allowed_segment_extensions <string>  List of file extensions',
            '  -extension_picky <boolean>  Be picky with all extensions matching',
            '',
          ].join('\n'),
          stderr: '',
        }
      }
      if (tool === 'ffmpeg') {
        ffmpegArgs.push(args)
        if (options.failFfmpeg) throw new Error('模拟 ffmpeg 失败')
        const output = args[args.length - 1]!
        await writeFile(output, options.ffmpegOutput ?? 'merged-bytes')
        return { stdout: '', stderr: '' }
      }
      return {
        stdout:
          options.ffprobeJson ??
          JSON.stringify({
            format: { duration: '12.5' },
            streams: [{ codec_type: 'video', width: 1280, height: 720 }],
          }),
        stderr: '',
      }
    },
  }
  return runner
}

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="en",DEFAULT=YES,URI="audio.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="fr",DEFAULT=NO,URI="audio-fr.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="a1"',
  'low/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a1"',
  'mid/index.m3u8?token=abc',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="a1"',
  'high/index.m3u8',
  '',
].join('\n')

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:6.000,',
  'seg0.m4s',
  '#EXTINF:6.000,',
  'https://cdn.example.com/seg1.m4s?sig=xyz',
  '#EXT-X-ENDLIST',
  '',
].join('\n')

const AUDIO_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:6.000,',
  'audio0.aac',
  '#EXTINF:6.000,',
  'audio1.aac',
  '#EXT-X-ENDLIST',
  '',
].join('\n')

describe('hls manifest 解析', () => {
  test('解析主播放列表的清晰度、音轨组与相对地址', () => {
    const master = parseHlsMasterPlaylist(
      MASTER_PLAYLIST,
      'https://video.example.com/hls/master.m3u8',
    )
    expect(master.variants).toHaveLength(3)
    expect(master.variants[0]!.url).toBe('https://video.example.com/hls/low/index.m3u8')
    expect(master.variants[1]!.url).toBe('https://video.example.com/hls/mid/index.m3u8?token=abc')
    expect(master.variants[1]!.averageBandwidth).toBe(2_000_000)
    expect(master.variants[0]!.width).toBe(640)
    expect(master.variants[0]!.height).toBe(360)
    expect(master.variants[0]!.codecs).toBe('avc1.4d401e,mp4a.40.2')
    expect(master.variants[0]!.audioGroupId).toBe('a1')
    expect(master.renditions).toHaveLength(2)
    expect(master.renditions[0]!.url).toBe('https://video.example.com/hls/audio.m3u8')
    expect(master.renditions[0]!.isDefault).toBe(true)
  })

  test('quality 选择 best/worst/高度', () => {
    const master = parseHlsMasterPlaylist(MASTER_PLAYLIST, 'https://video.example.com/master.m3u8')
    expect(selectHlsVariant(master, 'best').url).toContain('high/index.m3u8')
    expect(selectHlsVariant(master, 'worst').url).toContain('low/index.m3u8')
    expect(selectHlsVariant(master, '720').url).toContain('mid/index.m3u8')
    expect(selectHlsVariant(master, '720p').url).toContain('mid/index.m3u8')
    expect(selectHlsVariant(master, '1080').url).toContain('high/index.m3u8')
    expect(selectHlsVariant(master, '360p').url).toContain('low/index.m3u8')
  })

  test('quality 选择与音频组匹配', () => {
    const master = parseHlsMasterPlaylist(MASTER_PLAYLIST, 'https://video.example.com/master.m3u8')
    const variant = selectHlsVariant(master, '720')
    const audio = selectHlsAudioRendition(master, variant)
    expect(audio?.url).toBe('https://video.example.com/audio.m3u8')
  })

  test('解析媒体播放列表的 init/EXTINF/ENDLIST/绝对地址与 query', () => {
    const media = parseHlsMediaPlaylist(
      MEDIA_PLAYLIST,
      'https://video.example.com/hls/v/index.m3u8',
    )
    expect(media.segments).toHaveLength(2)
    expect(media.segments[0]!.url).toBe('https://video.example.com/hls/v/seg0.m4s')
    expect(media.segments[0]!.initUrl).toBe('https://video.example.com/hls/v/init.mp4')
    expect(media.segments[0]!.duration).toBe(6)
    expect(media.segments[1]!.url).toBe('https://cdn.example.com/seg1.m4s?sig=xyz')
    expect(media.endList).toBe(true)
    expect(media.targetDuration).toBe(6)
    expect(media.totalDuration).toBe(12)
    expect(media.encrypted).toBe(false)
  })

  test('识别加密与 byte range 播放列表', () => {
    const encrypted = parseHlsMediaPlaylist(
      ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXTINF:4,', 'a.ts'].join('\n'),
      'https://v.example.com/i.m3u8',
    )
    expect(encrypted.encrypted).toBe(true)
    const ranged = parseHlsMediaPlaylist(
      ['#EXTM3U', '#EXT-X-BYTERANGE:1000@0', '#EXTINF:4,', 'a.ts'].join('\n'),
      'https://v.example.com/i.m3u8',
    )
    expect(ranged.byteRange).toBe(true)
  })
})

describe('HLS 识别', () => {
  test('按 content-type、URL 路径和内容识别', () => {
    expect(detectHls({ contentType: 'application/vnd.apple.mpegurl', url: 'x', head: '' })).toBe(
      true,
    )
    expect(detectHls({ contentType: null, url: 'https://a/b.m3u8?x=1', head: '' })).toBe(true)
    expect(detectHls({ contentType: null, url: 'https://a/b', head: '#EXTM3U\n' })).toBe(true)
    expect(detectHls({ contentType: 'video/mp4', url: 'https://a/b.mp4', head: 'binary' })).toBe(
      false,
    )
  })
})

describe('非 HLS 下载', () => {
  test('原子提交到目标路径并保留原始字段', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader({
      'https://example.com/movie.mp4': { body: 'video-bytes', contentType: 'video/mp4' },
    })

    const result = await downloadMediaWithHls({
      sourceUrl: 'https://example.com/movie.mp4',
      outputPath,
      requestDownload: downloader.requestDownload,
    })

    expect(result.hls).toBe(false)
    expect(result.path).toBe(outputPath)
    expect(result.contentType).toBe('video/mp4')
    expect(result.bytes).toBe('video-bytes'.length)
    expect(result.sourceUrl).toBe('https://example.com/movie.mp4')
    expect(await readFile(outputPath, 'utf8')).toBe('video-bytes')
    // staging 文件不应该留下
    expect(await readdir(dir)).toEqual(['movie.mp4'])
  })

  test('DASH 明确拒绝，不把 MPD XML 伪装成视频保存', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader({
      'https://example.com/manifest.mpd': {
        body: '<?xml version="1.0"?><MPD type="static"></MPD>',
        contentType: 'application/dash+xml',
      },
    })
    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://example.com/manifest.mpd',
        outputPath,
        requestDownload: downloader.requestDownload,
      }),
    ).rejects.toThrow(/DASH/)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('目标文件保护', () => {
  test('overwrite=false 时目标已存在必须失败且不破坏旧文件', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    await writeFile(outputPath, 'original')
    const downloader = createFakeDownloader({
      'https://example.com/movie.mp4': { body: 'new-bytes' },
    })

    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://example.com/movie.mp4',
        outputPath,
        overwrite: false,
        requestDownload: downloader.requestDownload,
      }),
    ).rejects.toThrow(/已存在/)

    expect(await readFile(outputPath, 'utf8')).toBe('original')
  })

  test('overwrite=true 时原子替换', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    await writeFile(outputPath, 'original')
    const downloader = createFakeDownloader({
      'https://example.com/movie.mp4': { body: 'new-bytes' },
    })

    await downloadMediaWithHls({
      sourceUrl: 'https://example.com/movie.mp4',
      outputPath,
      overwrite: true,
      requestDownload: downloader.requestDownload,
    })

    expect(await readFile(outputPath, 'utf8')).toBe('new-bytes')
  })
})

describe('HLS 下载', () => {
  function hlsFiles(): Record<string, { body: string; contentType?: string }> {
    return {
      'https://video.example.com/hls/master.m3u8': {
        body: MASTER_PLAYLIST,
        contentType: 'application/vnd.apple.mpegurl',
      },
      'https://video.example.com/hls/mid/index.m3u8?token=abc': {
        body: MEDIA_PLAYLIST,
        contentType: 'application/vnd.apple.mpegurl',
      },
      'https://video.example.com/hls/audio.m3u8': {
        body: AUDIO_PLAYLIST,
        contentType: 'application/vnd.apple.mpegurl',
      },
      'https://video.example.com/hls/mid/init.mp4': { body: 'init-bytes' },
      'https://video.example.com/hls/mid/seg0.m4s': { body: 'seg0-bytes' },
      'https://cdn.example.com/seg1.m4s?sig=xyz': { body: 'seg1-bytes' },
      'https://video.example.com/hls/audio0.aac': { body: 'a0' },
      'https://video.example.com/hls/audio1.aac': { body: 'a1' },
    }
  }

  test('按 quality 选轨、下载分片并合并', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader(hlsFiles())
    const tools = createFakeTools()

    const result = await downloadMediaWithHls({
      sourceUrl: 'https://video.example.com/hls/master.m3u8',
      outputPath,
      quality: '720',
      requestDownload: downloader.requestDownload,
      tools,
    })

    expect(result.hls).toBe(true)
    expect(result.duration).toBe(12.5)
    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
    expect(result.segments).toBe(4)
    // 变体 + 音轨播放列表都通过 requestDownload 获取
    const urls = downloader.calls.map((call) => call.url)
    expect(urls).toContain('https://video.example.com/hls/mid/index.m3u8?token=abc')
    expect(urls).toContain('https://video.example.com/hls/audio.m3u8')
    // 所有下载都落在输出目录的临时位置
    for (const call of downloader.calls) {
      expect(path.dirname(call.outputPath)).toBe(dir)
      expect(call.outputPath).not.toBe(outputPath)
    }
    // ffmpeg 只被允许访问本地文件
    const ffmpegArgs = tools.ffmpegArgs[0]!
    expect(ffmpegArgs).toContain('-protocol_whitelist')
    expect(ffmpegArgs[ffmpegArgs.indexOf('-protocol_whitelist') + 1]).toBe('file')
    expect(ffmpegArgs).toContain('-c')
    expect(ffmpegArgs[ffmpegArgs.indexOf('-c') + 1]).toBe('copy')
    expect(ffmpegArgs.join(' ')).not.toMatch(/https?:\/\//)
  })

  test('overwrite=false 时 HLS 也不覆盖已存在的目标文件', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    await writeFile(outputPath, 'original')
    const downloader = createFakeDownloader(hlsFiles())

    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://video.example.com/hls/master.m3u8',
        outputPath,
        quality: '720',
        overwrite: false,
        requestDownload: downloader.requestDownload,
        tools: createFakeTools(),
      }),
    ).rejects.toThrow(/已存在/)

    expect(await readFile(outputPath, 'utf8')).toBe('original')
  })

  test('成功后清理 checkpoint 与临时文件', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader(hlsFiles())

    await downloadMediaWithHls({
      sourceUrl: 'https://video.example.com/hls/master.m3u8',
      outputPath,
      quality: '720',
      requestDownload: downloader.requestDownload,
      tools: createFakeTools(),
    })

    expect(await readdir(dir)).toEqual(['movie.mp4'])
  })

  test('并发受限于 concurrency 参数', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader(hlsFiles(), { delayMs: 10 })

    await downloadMediaWithHls({
      sourceUrl: 'https://video.example.com/hls/master.m3u8',
      outputPath,
      quality: '720',
      concurrency: 2,
      requestDownload: downloader.requestDownload,
      tools: createFakeTools(),
    })

    expect(downloader.maxConcurrent).toBeGreaterThan(1)
    expect(downloader.maxConcurrent).toBeLessThanOrEqual(2)
  })

  test('总 deadline 到期后停止并报错', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader(hlsFiles(), { delayMs: 40 })

    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://video.example.com/hls/master.m3u8',
        outputPath,
        quality: '720',
        concurrency: 1,
        timeoutMs: 30,
        requestDownload: downloader.requestDownload,
        tools: createFakeTools(),
      }),
    ).rejects.toThrow(/时限/)

    // 失败时不应该留下最终文件
    expect(await stat(outputPath).catch(() => null)).toBeNull()
  })

  test('失败保留 checkpoint 与分片，下次从断点继续', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const checkpointPath = path.join(dir, '.movie.mp4.hls-checkpoint.json')

    const failing = createFakeDownloader(hlsFiles(), {
      failOn: (url) => url.includes('seg1.m4s'),
    })
    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://video.example.com/hls/master.m3u8',
        outputPath,
        quality: '720',
        requestDownload: failing.requestDownload,
        tools: createFakeTools(),
      }),
    ).rejects.toThrow(/模拟下载失败/)

    // checkpoint 与分片保留下来
    expect(await stat(checkpointPath)).toBeTruthy()
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
    expect(checkpoint.files.length).toBeGreaterThan(0)
    for (const entry of checkpoint.files) {
      expect(Object.keys(entry).sort()).toEqual([
        'bytes',
        'index',
        'kind',
        'path',
        'sha256',
        'track',
        'url',
      ])
    }
    // checkpoint 不落盘任何 cookie / 令牌
    const checkpointText = await readFile(checkpointPath, 'utf8')
    expect(checkpointText).not.toMatch(/cookie|authorization|bearer/i)

    // 失败时不会产出目标文件
    expect(await stat(outputPath).catch(() => null)).toBeNull()

    // 第二次运行跳过已下载的分片
    const resumed = createFakeDownloader(hlsFiles())
    await downloadMediaWithHls({
      sourceUrl: 'https://video.example.com/hls/master.m3u8',
      outputPath,
      quality: '720',
      requestDownload: resumed.requestDownload,
      tools: createFakeTools(),
    })

    const resumedSegmentUrls = resumed.calls
      .map((call) => call.url)
      .filter((url) => url.includes('seg0.m4s') || url.includes('seg1.m4s'))
    expect(resumedSegmentUrls).toEqual(['https://cdn.example.com/seg1.m4s?sig=xyz'])
    // 成功后 checkpoint 被清理
    expect(await stat(checkpointPath).catch(() => null)).toBeNull()
  })

  test('续传时复用的分片也计入总字节上限', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const checkpointPath = path.join(dir, '.movie.mp4.hls-checkpoint.json')

    // 第一次运行只让 init 成功，其余分片失败
    const failing = createFakeDownloader(hlsFiles(), {
      failOn: (url) => url.includes('seg0.m4s') || url.includes('seg1.m4s') || url.includes('.aac'),
    })
    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://video.example.com/hls/master.m3u8',
        outputPath,
        quality: '720',
        requestDownload: failing.requestDownload,
        tools: createFakeTools(),
      }),
    ).rejects.toThrow(/模拟下载失败/)
    expect(await stat(checkpointPath)).toBeTruthy()

    // 第二次运行上限很小：复用的 init 也要算进总量，因此仍然超限
    const resumed = createFakeDownloader(hlsFiles())
    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://video.example.com/hls/master.m3u8',
        outputPath,
        quality: '720',
        maxTotalBytes: 1,
        requestDownload: resumed.requestDownload,
        tools: createFakeTools(),
      }),
    ).rejects.toThrow(/字节超过上限/)
  })

  test('加密 HLS 明确报错且不产出文件', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader({
      'https://v.example.com/enc.m3u8': {
        body: [
          '#EXTM3U',
          '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
          '#EXTINF:4.000,',
          'seg0.ts',
          '#EXT-X-ENDLIST',
          '',
        ].join('\n'),
        contentType: 'application/vnd.apple.mpegurl',
      },
    })

    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://v.example.com/enc.m3u8',
        outputPath,
        requestDownload: downloader.requestDownload,
        tools: createFakeTools(),
      }),
    ).rejects.toThrow(/加密/)

    expect(await stat(outputPath).catch(() => null)).toBeNull()
  })

  test('ffmpeg 不可用时报清晰错误', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader(hlsFiles())

    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://video.example.com/hls/master.m3u8',
        outputPath,
        quality: '720',
        requestDownload: downloader.requestDownload,
        tools: createFakeTools({ available: false }),
      }),
    ).rejects.toThrow(/ffmpeg/)

    expect(await stat(outputPath).catch(() => null)).toBeNull()
  })

  test('分片数量超过上限时报错', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:1']
    for (let index = 0; index <= MAX_HLS_SEGMENTS; index += 1) {
      lines.push('#EXTINF:1.000,', `seg${index}.ts`)
    }
    const downloader = createFakeDownloader({
      'https://v.example.com/big.m3u8': {
        body: `${lines.join('\n')}\n`,
        contentType: 'application/vnd.apple.mpegurl',
      },
    })

    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://v.example.com/big.m3u8',
        outputPath,
        requestDownload: downloader.requestDownload,
        tools: createFakeTools(),
      }),
    ).rejects.toThrow(/上限/)
  })

  test('总字节超过上限时报错', async () => {
    const dir = await makeTempDir()
    const outputPath = path.join(dir, 'movie.mp4')
    const downloader = createFakeDownloader({
      'https://v.example.com/huge.m3u8': {
        body: ['#EXTM3U', '#EXTINF:1.000,', 'seg0.ts', '#EXT-X-ENDLIST', ''].join('\n'),
        contentType: 'application/vnd.apple.mpegurl',
      },
      'https://v.example.com/seg0.ts': { body: 'x'.repeat(1024) },
    })

    await expect(
      downloadMediaWithHls({
        sourceUrl: 'https://v.example.com/huge.m3u8',
        outputPath,
        maxTotalBytes: 512,
        requestDownload: downloader.requestDownload,
        tools: createFakeTools(),
      }),
    ).rejects.toThrow(/字节超过上限/)

    expect(await stat(outputPath).catch(() => null)).toBeNull()
  })
})

describe('本地播放列表重写', () => {
  test('只引用本地文件路径并保留 EXT-X-MAP/EXTINF/ENDLIST', () => {
    const media = parseHlsMediaPlaylist(MEDIA_PLAYLIST, 'https://v.example.com/hls/v/index.m3u8')
    const files = new Map<string, string>([
      ['https://v.example.com/hls/v/init.mp4', '/tmp/parts/init.part'],
      ['https://v.example.com/hls/v/seg0.m4s', '/tmp/parts/seg0.part'],
      ['https://cdn.example.com/seg1.m4s?sig=xyz', '/tmp/parts/seg1.part'],
    ])
    const playlist = buildLocalPlaylist({ kind: 'video', playlist: media }, files)

    expect(playlist).toContain('#EXT-X-MAP:URI="/tmp/parts/init.part"')
    expect(playlist).toContain('#EXTINF:6.000,')
    expect(playlist).toContain('/tmp/parts/seg0.part')
    expect(playlist).toContain('/tmp/parts/seg1.part')
    expect(playlist).toContain('#EXT-X-ENDLIST')
    expect(playlist).not.toMatch(/https?:\/\//)
  })
})
