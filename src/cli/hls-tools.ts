import { spawn } from 'node:child_process'
import path from 'node:path'
import type { HlsMediaPlaylist } from './hls-manifest.js'
import { HlsDownloadError } from './hls-error.js'

export type HlsTool = 'ffmpeg' | 'ffprobe'

export interface HlsToolRunner {
  /** 工具是否可用；用于在开始下载前给出明确的“未安装”提示 */
  isAvailable(tool: HlsTool): Promise<boolean>
  run(tool: HlsTool, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>
}

export interface TrackPlan {
  kind: 'video' | 'audio'
  playlist: HlsMediaPlaylist
}

export function createDefaultToolRunner(): HlsToolRunner {
  const run = (
    tool: HlsTool,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(
        () => {
          child.kill('SIGKILL')
          reject(new HlsDownloadError(`${tool} 执行超时（${timeoutMs}ms）`))
        },
        Math.max(1, timeoutMs),
      )
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (error.code === 'ENOENT') {
          reject(new HlsDownloadError(`找不到可执行文件 ${tool}`, error.message))
          return
        }
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }
        reject(
          new HlsDownloadError(
            `${tool} 执行失败（退出码 ${code}）`,
            stderr.trim().split('\n').slice(-8).join('\n'),
          ),
        )
      })
    })

  return {
    isAvailable: async (tool) => {
      try {
        await run(tool, ['-version'], 15_000)
        return true
      } catch {
        return false
      }
    },
    run,
  }
}

export function resolveContainer(outputPath: string): string {
  const extension = path.extname(outputPath).toLowerCase()
  if (extension === '.mkv') return 'matroska'
  if (extension === '.webm') return 'webm'
  if (extension === '.ts' || extension === '.m2ts') return 'mpegts'
  if (extension === '.mov') return 'mov'
  return 'mp4'
}

/**
 * 本地重写的播放列表：只引用本地文件路径，ffmpeg 因此不会访问任何远程地址。
 * EXT-X-MAP 在初始化分片切换的位置原样输出，保持 fMP4 的分片边界语义。
 */
export function buildLocalPlaylist(plan: TrackPlan, files: Map<string, string>): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:7']
  const targetDuration = Math.max(1, Math.ceil(plan.playlist.targetDuration || 0))
  lines.push(`#EXT-X-TARGETDURATION:${targetDuration}`)
  lines.push('#EXT-X-MEDIA-SEQUENCE:0')
  let currentInit: string | null = null
  for (const segment of plan.playlist.segments) {
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
    if (segment.initUrl && segment.initUrl !== currentInit) {
      const initPath = files.get(segment.initUrl)
      if (!initPath) {
        throw new HlsDownloadError(`本地播放列表缺少初始化分片: ${segment.initUrl}`)
      }
      lines.push(`#EXT-X-MAP:URI="${initPath}"`)
      currentInit = segment.initUrl
    }
    lines.push(`#EXTINF:${segment.duration.toFixed(3)},`)
    const local = files.get(segment.url)
    if (!local) {
      throw new HlsDownloadError(`本地播放列表缺少分片文件: ${segment.url}`)
    }
    lines.push(local)
  }
  if (plan.playlist.endList) lines.push('#EXT-X-ENDLIST')
  return `${lines.join('\n')}\n`
}

export function parseFfprobe(stdout: string): {
  duration?: number
  width?: number
  height?: number
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new HlsDownloadError('ffprobe 输出不是合法 JSON')
  }
  const result: { duration?: number; width?: number; height?: number } = {}
  if (parsed && typeof parsed === 'object') {
    const root = parsed as { format?: { duration?: string }; streams?: unknown[] }
    const duration = Number(root.format?.duration)
    if (Number.isFinite(duration)) result.duration = duration
    const streams = Array.isArray(root.streams) ? root.streams : []
    for (const stream of streams) {
      if (!stream || typeof stream !== 'object') continue
      const entry = stream as { codec_type?: string; width?: number; height?: number }
      if (entry.codec_type === 'video' && result.width === undefined) {
        if (typeof entry.width === 'number') result.width = entry.width
        if (typeof entry.height === 'number') result.height = entry.height
      }
    }
  }
  return result
}

/**
 * ffmpeg 的 hls demuxer 会校验分片文件扩展名，本地临时文件用的是 .part，
 * 需要放开扩展名限制。不同 ffmpeg 版本支持的选项不同，因此先探测再拼参数。
 * 探测结果按 runner 缓存，避免注入不同 runner 时互相污染。
 */
const hlsDemuxerOptions = new WeakMap<HlsToolRunner, Set<string>>()

export async function detectHlsDemuxerOptions(tools: HlsToolRunner): Promise<Set<string>> {
  const cached = hlsDemuxerOptions.get(tools)
  if (cached) return cached
  const options = new Set<string>()
  try {
    const { stdout } = await tools.run('ffmpeg', ['-hide_banner', '-h', 'demuxer=hls'], 15_000)
    for (const line of stdout.split('\n')) {
      const match = /^\s+-(\w+)\s/.exec(line)
      if (match?.[1]) options.add(match[1])
    }
  } catch {
    // 探测失败时按最保守的默认值处理
  }
  hlsDemuxerOptions.set(tools, options)
  return options
}
