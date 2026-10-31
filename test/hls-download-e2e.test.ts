import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { downloadMediaWithHls } from '../src/cli/hls-download.js'

/**
 * 端到端用例：用真实的 ffmpeg/ffprobe 跑通一次 HLS 合并，
 * 验证产出的目标文件确实可以被解码。ffmpeg 不可用时跳过。
 */

function runCommand(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function hasFfmpeg(): Promise<boolean> {
  const result = await runCommand('ffmpeg', ['-version'])
  return result.code === 0
}

describe('HLS 真实合并（需要本机 ffmpeg）', () => {
  test('下载分片并合并出可解码的目标文件', async () => {
    if (!(await hasFfmpeg())) {
      return
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hls-e2e-'))
    try {
      // 用 ffmpeg 造一个极小的 HLS 素材，避免依赖真实网络媒体
      const fixtureDir = path.join(dir, 'fixture')
      await Bun.write(path.join(dir, 'placeholder'), '')
      await runCommand('mkdir', ['-p', fixtureDir])
      const generate = await runCommand('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=64x48:rate=5:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'hls',
        '-hls_time',
        '1',
        '-hls_list_size',
        '0',
        '-hls_segment_filename',
        path.join(fixtureDir, 'seg%d.ts'),
        path.join(fixtureDir, 'index.m3u8'),
      ])
      expect(generate.code).toBe(0)

      const playlist = await readFile(path.join(fixtureDir, 'index.m3u8'), 'utf8')
      const segmentFiles = await readdir(fixtureDir)
      const segments = segmentFiles.filter((name) => name.endsWith('.ts')).sort()

      const master = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=64x48,CODECS="avc1.42c00e"',
        'index.m3u8',
        '',
      ].join('\n')
      await writeFile(path.join(fixtureDir, 'master.m3u8'), master)

      const files: Record<string, Buffer> = {
        'https://media.example.com/hls/master.m3u8': Buffer.from(master),
        'https://media.example.com/hls/index.m3u8': Buffer.from(playlist),
      }
      for (const segment of segments) {
        files[`https://media.example.com/hls/${segment}`] = await readFile(
          path.join(fixtureDir, segment),
        )
      }

      const outputPath = path.join(dir, 'output.mp4')
      const result = await downloadMediaWithHls({
        sourceUrl: 'https://media.example.com/hls/master.m3u8',
        outputPath,
        requestDownload: async (url, targetPath) => {
          const body = files[url]
          if (!body) throw new Error(`未注册的 URL: ${url}`)
          await writeFile(targetPath, body)
          return {
            sourceUrl: url,
            finalUrl: url,
            contentType: url.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
            bytes: body.byteLength,
            sha256: 'e2e',
            path: targetPath,
          }
        },
      })

      expect(result.hls).toBe(true)
      expect(result.segments).toBe(segments.length)
      expect(result.duration).toBeGreaterThan(0)
      expect(result.width).toBe(64)
      expect(result.height).toBe(48)
      expect((await stat(outputPath)).size).toBeGreaterThan(0)

      // 目标文件可以被 ffprobe 解码
      const probe = await runCommand('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        outputPath,
      ])
      expect(probe.code).toBe(0)
      const metadata = JSON.parse(probe.stdout)
      expect(
        metadata.streams.some((stream: { codec_type: string }) => stream.codec_type === 'video'),
      ).toBe(true)

      // 临时文件与 checkpoint 都清理干净
      const remaining = await readdir(dir)
      expect(remaining.filter((name) => name.startsWith('.output.mp4'))).toEqual([])
      expect(remaining).toContain('output.mp4')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
