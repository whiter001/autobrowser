import path from 'node:path'
import { isRecord, type CommandResponse } from '../client.js'
import { downloadMediaWithHls, type BrowserDownloadResult } from '../hls-download.js'
import { parseNumberArg } from '../parse.js'
import { helpRequested, requestAndWrite, writeCommandError } from './shared.js'
import type { CommandContext, CommandHandler, CommandRegistry } from './types.js'

interface DownloadOptions {
  sourceUrl: string
  outputPath: string
  quality: string
  timeoutMs?: number
  concurrency: number
  overwrite: boolean
}

function commandError(payload: CommandResponse, fallback: string): Error {
  const detail = payload.error?.suggestedAction || payload.error?.suggestion
  return new Error(`${payload.error?.message || fallback}${detail ? `\n${detail}` : ''}`)
}

function readBrowserDownloadResult(payload: CommandResponse): BrowserDownloadResult {
  if (!payload.ok || !isRecord(payload.result)) throw commandError(payload, 'download failed')
  const result = payload.result
  if (
    typeof result.sourceUrl !== 'string' ||
    typeof result.finalUrl !== 'string' ||
    (typeof result.contentType !== 'string' && result.contentType !== null) ||
    typeof result.bytes !== 'number' ||
    typeof result.sha256 !== 'string' ||
    typeof result.path !== 'string'
  ) {
    throw new Error('download returned an invalid file result')
  }
  return {
    sourceUrl: result.sourceUrl,
    finalUrl: result.finalUrl,
    contentType: result.contentType,
    bytes: result.bytes,
    sha256: result.sha256,
    path: result.path,
  }
}

function outputFilename(sourceUrl: string): string {
  let basename = ''
  try {
    basename = decodeURIComponent(
      new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1) || '',
    )
  } catch {
    // URL 已在参数校验和 media source 选择时检查；这里只负责保守命名。
  }
  basename = basename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  if (!basename) basename = 'download.bin'
  if (/\.(m3u8|mpd)$/i.test(basename)) basename = basename.replace(/\.(m3u8|mpd)$/i, '.mp4')
  return basename
}

function resolveOutputPath(sourceUrl: string, outputPath: string | null, outputDir: string | null) {
  if (outputPath) return path.resolve(outputPath)
  if (!outputDir) throw new Error('download requires an output path or --output-dir')
  return path.resolve(outputDir, outputFilename(sourceUrl))
}

async function resolveMediaSource(index: number, context: CommandContext): Promise<string> {
  const payload = await context.requestCommand(context.flags.server, 'media', {
    action: 'list',
    resolve: true,
  })
  if (!payload.ok || !isRecord(payload.result) || !Array.isArray(payload.result.media)) {
    throw commandError(payload, 'media discovery failed')
  }
  const item = payload.result.media.find(
    (candidate) => isRecord(candidate) && candidate.index === index,
  )
  if (!isRecord(item)) throw new Error(`media index ${index} was not found`)
  const sources = Array.isArray(item.sources) ? item.sources : []
  const sourceUrl = [
    item.url,
    ...sources.map((source) => (isRecord(source) ? source.url : null)),
  ].find((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value))
  if (!sourceUrl) {
    const detail = [item.error, item.suggestedAction].filter(Boolean).join('\n')
    throw new Error(
      `media index ${index} has no downloadable http(s) source${detail ? `\n${detail}` : ''}`,
    )
  }
  return sourceUrl
}

async function handleDownload(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['download'])) return 0

  const positional: string[] = []
  let outputDir: string | null = null
  let mediaIndex: number | null = null
  let quality = 'best'
  let concurrency = 4
  let timeoutMs: number | undefined
  let overwrite = true
  let overwriteSeen = false

  try {
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index]
      if (value === '--output-dir') {
        if (!rest[index + 1]) throw new Error('missing value for --output-dir')
        outputDir = rest[++index]!
      } else if (value === '--media') {
        mediaIndex = parseNumberArg(rest[index + 1], 'media index', { min: 0, integer: true })
        index += 1
      } else if (value === '--quality') {
        quality = rest[++index] || ''
        if (!/^(best|worst|\d+p?)$/i.test(quality)) {
          throw new Error('quality must be best, worst, or a height such as 720 or 720p')
        }
      } else if (value === '--concurrency') {
        concurrency = parseNumberArg(rest[index + 1], 'concurrency', {
          min: 1,
          max: 16,
          integer: true,
        })
        index += 1
      } else if (value === '--timeout-ms') {
        timeoutMs = parseNumberArg(rest[index + 1], 'timeout ms', { min: 1, integer: true })
        index += 1
      } else if (value === '--overwrite' || value === '--no-clobber') {
        if (overwriteSeen) throw new Error('--overwrite and --no-clobber are mutually exclusive')
        overwriteSeen = true
        overwrite = value === '--overwrite'
      } else if (value.startsWith('--')) {
        throw new Error(`unsupported download option: ${value}`)
      } else {
        positional.push(value)
      }
    }

    if (mediaIndex !== null && positional.length > 1) {
      throw new Error('download --media accepts at most one output path')
    }
    if (mediaIndex === null && (positional.length < 1 || positional.length > 2)) {
      throw new Error('download requires <url> and an optional output path')
    }
    if (mediaIndex !== null && /^https?:\/\//i.test(positional[0] || '')) {
      throw new Error('a URL and --media are mutually exclusive')
    }
    const explicitOutput = mediaIndex === null ? positional[1] || null : positional[0] || null
    if (outputDir !== null && explicitOutput) {
      throw new Error('an explicit output path cannot be combined with --output-dir')
    }
    const sourceUrl =
      mediaIndex === null ? positional[0]! : await resolveMediaSource(mediaIndex, context)
    if (!/^https?:\/\//i.test(sourceUrl))
      throw new Error('download url must be an http or https URL')
    const options: DownloadOptions = {
      sourceUrl,
      outputPath: resolveOutputPath(sourceUrl, explicitOutput, outputDir),
      quality,
      concurrency,
      overwrite,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }
    const result = await downloadMediaWithHls({
      ...options,
      requestDownload: async (url, outputPath, remainingMs) => {
        const payload = await context.requestCommand(context.flags.server, 'download', {
          url,
          outputPath,
          ...(remainingMs !== undefined ? { timeoutMs: remainingMs } : {}),
        })
        return readBrowserDownloadResult(payload)
      },
    })
    context.writeResult({ ok: true, result })
    return 0
  } catch (error) {
    return writeCommandError(error)
  }
}

const handleMedia: CommandHandler = async (rest, context) => {
  if (helpRequested(rest[0], context, ['media'])) return 0
  if (rest[0] !== 'list') return writeCommandError('unsupported media action; expected list')
  const extra = rest.slice(1)
  if (extra.some((value) => value !== '--resolve') || new Set(extra).size !== extra.length) {
    return writeCommandError('usage: autobrowser media list [--resolve]')
  }
  await requestAndWrite(context, 'media', {
    action: 'list',
    resolve: extra.includes('--resolve'),
  })
  return 0
}

export const mediaCommandRegistry: CommandRegistry = {
  download: handleDownload,
  media: handleMedia,
}
