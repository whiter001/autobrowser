import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  constants,
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {
  parseHlsMasterPlaylist,
  parseHlsMediaPlaylist,
  selectHlsAudioRendition,
  selectHlsVariant,
  type HlsMediaPlaylist,
} from './hls-manifest.js'

export interface BrowserDownloadResult {
  sourceUrl: string
  finalUrl: string
  contentType: string | null
  bytes: number
  sha256: string
  path: string
}

export interface HlsDownloadResult extends BrowserDownloadResult {
  hls?: boolean
  duration?: number
  width?: number
  height?: number
  segments?: number
}

export type HlsTool = 'ffmpeg' | 'ffprobe'

export interface HlsToolRunner {
  /** 工具是否可用；用于在开始下载前给出明确的“未安装”提示 */
  isAvailable(tool: HlsTool): Promise<boolean>
  run(tool: HlsTool, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>
}

export interface HlsDownloadOptions {
  sourceUrl: string
  outputPath: string
  /** best/worst 或高度（720、720p），默认 best */
  quality?: string
  /** 整个任务的总超时（毫秒），默认 DEFAULT_HLS_TIMEOUT_MS */
  timeoutMs?: number
  /** 单任务内的分片并发数，1..16，默认 4 */
  concurrency?: number
  /** 目标已存在时是否原子替换，默认 true */
  overwrite?: boolean
  /** 单任务总字节上限，默认 MAX_HLS_TOTAL_BYTES */
  maxTotalBytes?: number
  /** 单任务最大分片数，默认 MAX_HLS_SEGMENTS */
  maxSegments?: number
  /** 唯一的字节获取入口：manifest / init / 分片都必须走它 */
  requestDownload: (
    url: string,
    outputPath: string,
    timeoutMs?: number,
  ) => Promise<BrowserDownloadResult>
  /** 便于测试注入的 ffmpeg/ffprobe 执行器 */
  tools?: HlsToolRunner
}

export const DEFAULT_HLS_CONCURRENCY = 4
export const MAX_HLS_CONCURRENCY = 16
export const DEFAULT_HLS_TIMEOUT_MS = 120_000
/** 允许下载的最大分片数量 */
export const MAX_HLS_SEGMENTS = 2048
/** 任务总字节上限（2GiB） */
export const MAX_HLS_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
/** 播放列表递归层数上限 */
export const MAX_HLS_PLAYLIST_DEPTH = 4

const CHECKPOINT_VERSION = 1

interface CheckpointEntry {
  kind: 'init' | 'segment'
  track: 'video' | 'audio'
  index: number
  url: string
  path: string
  bytes: number
  sha256: string
}

interface CheckpointFile {
  version: number
  sourceUrl: string
  outputPath: string
  quality: string
  files: CheckpointEntry[]
}

interface DownloadTask {
  kind: 'init' | 'segment'
  track: 'video' | 'audio'
  index: number
  url: string
  path: string
}

interface TrackPlan {
  kind: 'video' | 'audio'
  playlist: HlsMediaPlaylist
}

export class HlsDownloadError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'HlsDownloadError'
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_HLS_CONCURRENCY
  return Math.min(MAX_HLS_CONCURRENCY, Math.max(1, Math.floor(value)))
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

async function readHead(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

function createDefaultToolRunner(): HlsToolRunner {
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

/**
 * 判断下载结果是不是 HLS：content-type、URL 路径和文件内容三者任一命中即可。
 * 内容特征优先，避免被伪装成 m3u8 的错误页面误导。
 */
export function detectHls(input: {
  contentType: string | null
  url: string
  head: string
}): boolean {
  const head = input.head.replace(/^﻿/, '').trimStart()
  if (head.startsWith('#EXTM3U')) return true
  const contentType = (input.contentType ?? '').toLowerCase()
  if (contentType.includes('mpegurl')) return true
  try {
    const pathname = new URL(input.url).pathname.toLowerCase()
    if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u')) return true
  } catch {
    // URL 解析失败时只能依赖 content-type 与内容特征
  }
  return false
}

function resolveContainer(outputPath: string): string {
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

function parseFfprobe(stdout: string): { duration?: number; width?: number; height?: number } {
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

function buildTasks(tracks: TrackPlan[], outputDir: string, filePrefix: string): DownloadTask[] {
  const tasks: DownloadTask[] = []
  for (const track of tracks) {
    const initSeen = new Set<string>()
    track.playlist.segments.forEach((segment, index) => {
      if (segment.initUrl && !initSeen.has(segment.initUrl)) {
        initSeen.add(segment.initUrl)
        tasks.push({
          kind: 'init',
          track: track.kind,
          index,
          url: segment.initUrl,
          path: path.join(
            outputDir,
            `${filePrefix}.init-${track.kind}-${shortHash(segment.initUrl)}.part`,
          ),
        })
      }
      tasks.push({
        kind: 'segment',
        track: track.kind,
        index,
        url: segment.url,
        path: path.join(
          outputDir,
          `${filePrefix}.seg-${track.kind}-${index}-${shortHash(segment.url)}.part`,
        ),
      })
    })
  }
  return tasks
}

/** 清理输出目录里属于本任务前缀的临时文件 */
async function removeTempFiles(
  outputDir: string,
  filePrefix: string,
  suffixes: string[],
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(outputDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(filePrefix)) continue
    if (suffixes.some((suffix) => entry.endsWith(suffix))) {
      await rm(path.join(outputDir, entry), { force: true })
    }
  }
}

async function loadCheckpoint(checkpointPath: string): Promise<CheckpointFile | null> {
  try {
    const raw = await readFile(checkpointPath, 'utf8')
    const parsed = JSON.parse(raw) as CheckpointFile
    if (!parsed || parsed.version !== CHECKPOINT_VERSION || !Array.isArray(parsed.files)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * 原子提交：覆盖时用 rename 直接替换；不覆盖时用同目录 hard link + unlink，
 * link 在目标已存在时会失败，从而不会破坏旧文件。
 */
async function commitFile(
  sourcePath: string,
  targetPath: string,
  overwrite: boolean,
): Promise<void> {
  if (overwrite) {
    try {
      await rename(sourcePath, targetPath)
      return
    } catch (error) {
      // 跨设备时 rename 会失败，退化成先复制再删除，语义仍然是“替换”
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await copyFile(sourcePath, targetPath)
      await rm(sourcePath, { force: true })
      return
    }
  }
  try {
    await link(sourcePath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      // 跨设备无法 hard link，退化成独占创建，目标已存在时同样会失败
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
      await rm(sourcePath, { force: true })
      return
    }
    throw new HlsDownloadError(
      `输出文件已存在，拒绝覆盖: ${targetPath}`,
      error instanceof Error ? error.message : undefined,
    )
  }
  await unlink(sourcePath).catch(() => undefined)
}

/**
 * ffmpeg 的 hls demuxer 会校验分片文件扩展名，本地临时文件用的是 .part，
 * 需要放开扩展名限制。不同 ffmpeg 版本支持的选项不同，因此先探测再拼参数。
 * 探测结果按 runner 缓存，避免注入不同 runner 时互相污染。
 */
const hlsDemuxerOptions = new WeakMap<HlsToolRunner, Set<string>>()

async function detectHlsDemuxerOptions(tools: HlsToolRunner): Promise<Set<string>> {
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

export async function downloadMediaWithHls(
  options: HlsDownloadOptions,
): Promise<HlsDownloadResult> {
  const outputPath = path.resolve(options.outputPath)
  const outputDir = path.dirname(outputPath)
  const baseName = path.basename(outputPath)
  const quality = (options.quality ?? 'best').trim() || 'best'
  const concurrency = clampConcurrency(options.concurrency)
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_HLS_TIMEOUT_MS)
  const overwrite = options.overwrite !== false
  const maxTotalBytes = options.maxTotalBytes ?? MAX_HLS_TOTAL_BYTES
  const maxSegments = options.maxSegments ?? MAX_HLS_SEGMENTS
  const deadline = Date.now() + timeoutMs
  const tools = options.tools ?? createDefaultToolRunner()

  if (!isHttpUrl(options.sourceUrl)) {
    throw new HlsDownloadError('下载地址必须是 http 或 https URL')
  }
  await mkdir(outputDir, { recursive: true })
  // 不允许覆盖时提前失败，避免白下载一遍再发现无法落盘
  if (!overwrite && (await fileExists(outputPath))) {
    throw new HlsDownloadError(`输出文件已存在，拒绝覆盖: ${outputPath}`)
  }

  const remaining = (): number => {
    const left = deadline - Date.now()
    if (left <= 0) {
      throw new HlsDownloadError(`下载任务超过总时限 ${timeoutMs}ms`)
    }
    return left
  }

  let downloadedBytes = 0

  /**
   * 所有字节都必须经过 requestDownload：下载后以本地文件为准计算字节与摘要，
   * 因为 relay 可能把路径解析到别处。
   */
  const fetchToFile = async (
    url: string,
    targetPath: string,
  ): Promise<{ result: BrowserDownloadResult; localPath: string; bytes: number }> => {
    const budget = remaining()
    const result = await options.requestDownload(url, targetPath, budget)
    const localPath = (await fileExists(targetPath))
      ? targetPath
      : result.path && (await fileExists(result.path))
        ? result.path
        : targetPath
    if (!(await fileExists(localPath))) {
      throw new HlsDownloadError(`下载没有产出文件: ${url}`)
    }
    const size = (await stat(localPath)).size
    downloadedBytes += size
    if (downloadedBytes > maxTotalBytes) {
      throw new HlsDownloadError(`下载字节超过上限 ${maxTotalBytes}`, `实际 ${downloadedBytes}`)
    }
    return { result, localPath, bytes: size }
  }

  // 第一步：把源地址下到同目录的 staging 文件，再据此判断是不是 HLS
  const stagingPath = path.join(outputDir, `.${baseName}.download-staging`)
  await rm(stagingPath, { force: true })
  const source = await fetchToFile(options.sourceUrl, stagingPath)
  const head = await readHead(source.localPath, 512)
  const isHls = detectHls({
    contentType: source.result.contentType,
    url: source.result.finalUrl || options.sourceUrl,
    head,
  })

  if (!isHls) {
    const isDash =
      /application\/dash\+xml/i.test(source.result.contentType || '') ||
      /\.mpd(?:$|\?)/i.test(source.result.finalUrl || options.sourceUrl) ||
      /<MPD[\s>]/i.test(head)
    if (isDash) {
      await rm(source.localPath, { force: true })
      throw new HlsDownloadError('DASH 目前只能发现，暂不支持合并下载；请改用 MP4 或 HLS 源')
    }
    // 非 HLS：把 staging 原子提交到目标文件，并保留原始结果字段
    await commitFile(source.localPath, outputPath, overwrite).catch(async (error) => {
      await rm(source.localPath, { force: true })
      throw error
    })
    return {
      sourceUrl: source.result.sourceUrl,
      finalUrl: source.result.finalUrl,
      contentType: source.result.contentType,
      bytes: source.result.bytes,
      sha256: source.result.sha256,
      path: outputPath,
      hls: false,
    }
  }

  // HLS：先确认 ffmpeg/ffprobe 可用，避免下载完才发现无法合并
  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    if (!(await tools.isAvailable(tool))) {
      throw new HlsDownloadError(
        `HLS 合并需要 ${tool}，但当前环境不可用；请先安装 ${tool} 并加入 PATH`,
      )
    }
  }

  // 所有临时文件都平铺放在输出同目录，便于原子提交与清理
  const filePrefix = `.${baseName}.hls`
  const checkpointPath = path.join(outputDir, `${filePrefix}-checkpoint.json`)

  const readPlaylist = async (
    url: string,
    localPath: string,
  ): Promise<{ text: string; finalUrl: string }> => {
    const downloaded = await fetchToFile(url, localPath)
    return {
      text: await readFile(downloaded.localPath, 'utf8'),
      finalUrl: downloaded.result.finalUrl || url,
    }
  }

  /**
   * 解析播放列表：主播放列表要选出变体与匹配的音轨组，再递归取媒体播放列表。
   * 递归层数受限，避免异常播放列表把下载拉成无界任务。
   */
  const resolve = async (
    first: { text: string; finalUrl: string },
    depth: number,
  ): Promise<{ video: TrackPlan; audio: TrackPlan | null }> => {
    if (depth > MAX_HLS_PLAYLIST_DEPTH) {
      throw new HlsDownloadError(`播放列表递归层数超过上限 ${MAX_HLS_PLAYLIST_DEPTH}`)
    }
    const master = parseHlsMasterPlaylist(first.text, first.finalUrl)
    if (master.variants.length === 0) {
      return {
        video: {
          kind: 'video',
          playlist: parseHlsMediaPlaylist(first.text, first.finalUrl),
        },
        audio: null,
      }
    }
    const variant = selectHlsVariant(master, quality)
    const rendition = selectHlsAudioRendition(master, variant)
    const variantPlaylist = await readPlaylist(
      variant.url,
      path.join(outputDir, `${filePrefix}-variant.m3u8`),
    )
    const nested = await resolve(variantPlaylist, depth + 1)
    // 变体播放列表本身是主播放列表时，音轨组由更内层决定
    let audio = nested.audio
    if (!audio && rendition?.url) {
      const audioPlaylist = await readPlaylist(
        rendition.url,
        path.join(outputDir, `${filePrefix}-audio.m3u8`),
      )
      audio = {
        kind: 'audio',
        playlist: parseHlsMediaPlaylist(audioPlaylist.text, audioPlaylist.finalUrl),
      }
    }
    return { video: nested.video, audio }
  }

  const resolved = await resolve(
    {
      text: await readFile(source.localPath, 'utf8'),
      finalUrl: source.result.finalUrl || options.sourceUrl,
    },
    1,
  )
  const tracks: TrackPlan[] = [resolved.video]
  if (resolved.audio) tracks.push(resolved.audio)

  for (const track of tracks) {
    if (track.playlist.encrypted) {
      throw new HlsDownloadError('不支持加密的 HLS（检测到 EXT-X-KEY）；请提供未加密的播放列表')
    }
    if (track.playlist.byteRange) {
      throw new HlsDownloadError('不支持 EXT-X-BYTERANGE 分片')
    }
    if (track.playlist.segments.length === 0) {
      throw new HlsDownloadError('HLS 播放列表里没有可下载的分片')
    }
  }

  const tasks = buildTasks(tracks, outputDir, filePrefix)
  if (tasks.length > maxSegments) {
    throw new HlsDownloadError(`HLS 分片数量超过上限 ${maxSegments}`, `实际 ${tasks.length}`)
  }

  // checkpoint 只记录 URL/路径/字节/sha256，不落盘任何 cookie 或令牌
  const checkpoint: CheckpointFile = {
    version: CHECKPOINT_VERSION,
    sourceUrl: options.sourceUrl,
    outputPath,
    quality,
    files: [],
  }
  const previous = await loadCheckpoint(checkpointPath)
  const resumable =
    previous !== null &&
    previous.version === CHECKPOINT_VERSION &&
    previous.sourceUrl === options.sourceUrl &&
    previous.outputPath === outputPath &&
    previous.quality === quality
  if (resumable) {
    checkpoint.files = previous.files
  } else {
    // 换了源地址、输出路径或清晰度，旧的断点数据不再适用
    await removeTempFiles(outputDir, filePrefix, ['.part'])
  }

  const entryKey = (task: { kind: string; track: string; index: number }): string =>
    `${task.kind}:${task.track}:${task.index}`
  const entries = new Map<string, CheckpointEntry>()
  const currentKeys = new Set(tasks.map((task) => entryKey(task)))
  for (const entry of checkpoint.files) {
    // 播放列表变化后，旧的条目已经对不上当前分片，直接丢弃
    if (!currentKeys.has(`${entry.kind}:${entry.track}:${entry.index}`)) continue
    entries.set(`${entry.kind}:${entry.track}:${entry.index}`, entry)
  }

  // checkpoint 写入需要串行化：并发 worker 同时写会互相覆盖临时文件
  let checkpointWrite: Promise<void> = Promise.resolve()
  const writeCheckpoint = (): Promise<void> => {
    checkpointWrite = checkpointWrite.then(async () => {
      checkpoint.files = [...entries.values()]
      const temp = `${checkpointPath}.${shortHash(String(Date.now()) + Math.random())}.tmp`
      await writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, checkpointPath)
    })
    return checkpointWrite
  }
  await writeCheckpoint()

  const done = new Set<string>()
  for (const task of tasks) {
    const entry = entries.get(entryKey(task))
    if (!entry || entry.url !== task.url) continue
    if (!(await fileExists(entry.path))) continue
    const size = (await stat(entry.path)).size
    if (size !== entry.bytes) continue
    // 已存在的分片必须校验 sha256 后才跳过
    if ((await sha256File(entry.path)) !== entry.sha256) continue
    done.add(entryKey(task))
    // 复用的分片同样计入任务总字节
    downloadedBytes += entry.bytes
  }
  if (downloadedBytes > maxTotalBytes) {
    throw new HlsDownloadError(`下载字节超过上限 ${maxTotalBytes}`, `实际 ${downloadedBytes}`)
  }

  const pending = tasks.filter((task) => !done.has(entryKey(task)))
  let failure: unknown = null
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (failure === null) {
      const index = cursor
      cursor += 1
      if (index >= pending.length) return
      const task = pending[index]!
      try {
        const budget = remaining()
        const result = await options.requestDownload(task.url, task.path, budget)
        const localPath = (await fileExists(task.path))
          ? task.path
          : result.path && (await fileExists(result.path))
            ? result.path
            : task.path
        if (!(await fileExists(localPath))) {
          throw new HlsDownloadError(`分片下载没有产出文件: ${task.url}`)
        }
        const size = (await stat(localPath)).size
        downloadedBytes += size
        if (downloadedBytes > maxTotalBytes) {
          throw new HlsDownloadError(`下载字节超过上限 ${maxTotalBytes}`, `实际 ${downloadedBytes}`)
        }
        entries.set(entryKey(task), {
          kind: task.kind,
          track: task.track,
          index: task.index,
          url: task.url,
          path: localPath,
          bytes: size,
          sha256: await sha256File(localPath),
        })
        await writeCheckpoint()
      } catch (error) {
        if (failure === null) failure = error
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()))
  if (failure !== null) {
    // 失败时保留 checkpoint 与分片，下一次可以从断点继续
    await writeCheckpoint()
    throw failure
  }
  await writeCheckpoint()

  // 用本地文件路径重写播放列表，ffmpeg 只读本地文件
  const localFiles = new Map<string, string>()
  for (const task of tasks) {
    const entry = entries.get(entryKey(task))
    if (!entry) throw new HlsDownloadError(`分片下载状态缺失: ${task.url}`)
    localFiles.set(task.url, entry.path)
  }
  const videoTrack = tracks.find((track) => track.kind === 'video')!
  const audioTrack = tracks.find((track) => track.kind === 'audio')
  const videoPlaylistPath = path.join(outputDir, `${filePrefix}-local-video.m3u8`)
  await writeFile(videoPlaylistPath, buildLocalPlaylist(videoTrack, localFiles))
  const audioPlaylistPath = path.join(outputDir, `${filePrefix}-local-audio.m3u8`)
  if (audioTrack) {
    await writeFile(audioPlaylistPath, buildLocalPlaylist(audioTrack, localFiles))
  }

  const demuxerOptions = await detectHlsDemuxerOptions(tools)
  const inputOptions = ['-protocol_whitelist', 'file']
  if (demuxerOptions.has('allowed_extensions')) {
    inputOptions.push('-allowed_extensions', 'ALL')
  }
  if (demuxerOptions.has('allowed_segment_extensions')) {
    inputOptions.push('-allowed_segment_extensions', 'ALL')
  }
  if (demuxerOptions.has('extension_picky')) {
    inputOptions.push('-extension_picky', '0')
  }

  const mergedPath = path.join(outputDir, `${filePrefix}-merged`)
  const container = resolveContainer(outputPath)
  const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
  args.push(...inputOptions, '-i', videoPlaylistPath)
  if (audioTrack) {
    args.push(...inputOptions, '-i', audioPlaylistPath)
  }
  args.push('-map', '0:v:0')
  args.push('-map', audioTrack ? '1:a:0' : '0:a:0?')
  args.push('-c', 'copy')
  if (container === 'mp4' || container === 'mov') {
    args.push('-movflags', '+faststart')
  }
  args.push('-f', container)
  args.push(mergedPath)

  try {
    await tools.run('ffmpeg', args, remaining())
  } catch (error) {
    throw error instanceof HlsDownloadError
      ? error
      : new HlsDownloadError(
          'ffmpeg 合并 HLS 失败',
          error instanceof Error ? error.message : undefined,
        )
  }

  const mergedStat = await stat(mergedPath).catch(() => null)
  if (!mergedStat || mergedStat.size === 0) {
    throw new HlsDownloadError('ffmpeg 没有产出有效的媒体文件')
  }

  const probe = await tools
    .run(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mergedPath],
      remaining(),
    )
    .catch((error) => {
      throw error instanceof HlsDownloadError
        ? error
        : new HlsDownloadError(
            'ffprobe 探测失败',
            error instanceof Error ? error.message : undefined,
          )
    })
  const metadata = parseFfprobe(probe.stdout)

  await commitFile(mergedPath, outputPath, overwrite).catch(async (error) => {
    // 提交失败时清掉合并产物，但保留 checkpoint 与分片以便续传
    await rm(mergedPath, { force: true })
    throw error
  })

  // 成功后清理所有临时文件与 checkpoint
  await removeTempFiles(outputDir, filePrefix, ['.part', '.m3u8', '-merged', '.tmp'])
  await rm(checkpointPath, { force: true })
  await rm(stagingPath, { force: true })

  return {
    sourceUrl: options.sourceUrl,
    finalUrl: source.result.finalUrl,
    contentType: source.result.contentType,
    bytes: mergedStat.size,
    sha256: await sha256File(outputPath),
    path: outputPath,
    hls: true,
    segments: tasks.filter((task) => task.kind === 'segment').length,
    ...(metadata.duration !== undefined ? { duration: metadata.duration } : {}),
    ...(metadata.width !== undefined ? { width: metadata.width } : {}),
    ...(metadata.height !== undefined ? { height: metadata.height } : {}),
  }
}
