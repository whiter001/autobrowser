import path from 'node:path'
import { suggestedDownloadFilename } from '../../core/download-filename.js'
import { isRecord, type CommandResponse } from '../client.js'
import { downloadMediaWithHls, type BrowserDownloadResult } from '../hls-download.js'
import { parseNumberArg } from '../parse.js'
import {
  DEFAULT_DOWNLOAD_RETRIES,
  DEFAULT_DOWNLOAD_RETRY_DELAY_MS,
  MAX_DOWNLOAD_RETRIES,
  MAX_DOWNLOAD_RETRY_DELAY_MS,
} from '../../core/file-transfer.js'
import { COMMAND_ACTIONS, isCommandAction } from './actions.js'
import { helpRequested, throwCommandError } from './shared.js'
import type { CommandContext, CommandHandler, CommandRegistry } from './types.js'

interface DownloadOptions {
  sourceUrl: string
  outputPath: string
  quality: string
  timeoutMs?: number
  concurrency: number
  overwrite: boolean
  dedupeByContent: boolean
  resolveOutputPath?: (result: BrowserDownloadResult) => string
}

function commandError(payload: CommandResponse, fallback: string): Error {
  const source = payload.error
  return Object.assign(new Error(source?.message || fallback), {
    code: source?.code,
    details: source?.details,
    retryable: source?.retryable,
    suggestedAction: source?.suggestedAction || source?.suggestion,
  })
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
    ...(typeof result.suggestedFilename === 'string'
      ? { suggestedFilename: result.suggestedFilename }
      : {}),
  }
}

function outputFilename(sourceUrl: string): string {
  const basename = suggestedDownloadFilename(sourceUrl, null, null)
  if (/\.(m3u8|mpd)$/i.test(basename)) return basename.replace(/\.(m3u8|mpd)$/i, '.mp4')
  return basename
}

function resolveOutputPath(sourceUrl: string, outputPath: string | null, outputDir: string | null) {
  if (outputPath) return path.resolve(outputPath)
  if (!outputDir) throw new Error('download requires an output path or --output-dir')
  return path.resolve(outputDir, outputFilename(sourceUrl))
}

interface MediaScopeOptions {
  selector?: string
  includeBackground?: boolean
  mediaEpoch?: number
  waitFor?: string
}

function validateMediaResponse(result: Record<string, unknown>, options: MediaScopeOptions) {
  if (
    options.selector !== undefined &&
    (!isRecord(result.scope) || result.scope.selector !== options.selector)
  ) {
    throw new Error(
      'media response did not confirm the requested scope.selector; update the extension',
    )
  }
  if (options.includeBackground && result.includeBackground !== true) {
    throw new Error(
      'media response did not confirm includeBackground support; update the extension',
    )
  }
  if (
    options.waitFor !== undefined &&
    (!isRecord(result.wait) ||
      result.wait.completed !== true ||
      result.wait.selector !== options.waitFor)
  ) {
    throw new Error('media response did not confirm the requested wait; update the extension')
  }
  if (options.mediaEpoch !== undefined && result.pageEpoch !== options.mediaEpoch) {
    throw new Error(
      'STALE_MEDIA_STATE: media pageEpoch does not match --media-epoch; collect again',
    )
  }
}

async function resolveMediaSource(
  index: number,
  context: CommandContext,
  options: MediaScopeOptions,
): Promise<string> {
  const payload = await context.requestCommand(context.flags.server, 'media', {
    action: 'list',
    resolve: true,
    ...(options.selector !== undefined ? { selector: options.selector } : {}),
    ...(options.includeBackground ? { includeBackground: true } : {}),
    ...(options.mediaEpoch !== undefined ? { mediaEpoch: options.mediaEpoch } : {}),
  })
  if (!payload.ok || !isRecord(payload.result) || !Array.isArray(payload.result.media)) {
    throw commandError(payload, 'media discovery failed')
  }
  validateMediaResponse(payload.result, options)
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
  const mediaOptions: MediaScopeOptions = {}
  let quality = 'best'
  let concurrency = 4
  let retries = DEFAULT_DOWNLOAD_RETRIES
  let retryDelayMs = DEFAULT_DOWNLOAD_RETRY_DELAY_MS
  const retryOptionsSeen = new Set<string>()
  let timeoutMs: number | undefined
  let overwrite = true
  let overwriteSeen = false
  let dedupeByContent = false

  try {
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index]
      if (
        [
          '--media',
          '--selector',
          '--include-background',
          '--media-epoch',
          '--timeout-ms',
          '--dedupe-by-content',
        ].includes(value!)
      ) {
        if (retryOptionsSeen.has(value!)) throw new Error(`duplicate option: ${value}`)
        retryOptionsSeen.add(value!)
      }
      if (value === '--selector') {
        const next = rest[++index]
        if (!next || next.startsWith('--') || !next.trim())
          throw new Error('missing value for --selector')
        mediaOptions.selector = next.trim()
      } else if (value === '--include-background') {
        mediaOptions.includeBackground = true
      } else if (value === '--media-epoch') {
        mediaOptions.mediaEpoch = parseNumberArg(rest[++index], '--media-epoch', {
          min: 1,
          integer: true,
        })
      } else if (value === '--output-dir') {
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
      } else if (value === '--retries' || value === '--retry-delay-ms') {
        if (retryOptionsSeen.has(value)) throw new Error(`duplicate option: ${value}`)
        retryOptionsSeen.add(value)
        const next = rest[++index]
        if (!next || next.startsWith('--')) throw new Error(`missing value for ${value}`)
        const parsed = parseNumberArg(next, value, {
          min: 0,
          max: value === '--retries' ? MAX_DOWNLOAD_RETRIES : MAX_DOWNLOAD_RETRY_DELAY_MS,
          integer: true,
        })
        if (value === '--retries') retries = parsed
        else retryDelayMs = parsed
      } else if (value === '--timeout-ms') {
        timeoutMs = parseNumberArg(rest[index + 1], 'timeout ms', { min: 1, integer: true })
        index += 1
      } else if (value === '--dedupe-by-content') {
        dedupeByContent = true
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

    if (mediaIndex === null && Object.keys(mediaOptions).length > 0) {
      throw new Error('--selector, --include-background and --media-epoch require --media')
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
      mediaIndex === null
        ? positional[0]!
        : await resolveMediaSource(mediaIndex, context, mediaOptions)
    if (!/^https?:\/\//i.test(sourceUrl))
      throw new Error('download url must be an http or https URL')
    const options: DownloadOptions = {
      sourceUrl,
      outputPath: resolveOutputPath(sourceUrl, explicitOutput, outputDir),
      quality,
      concurrency,
      overwrite,
      dedupeByContent,
      ...(outputDir !== null
        ? {
            resolveOutputPath: (result: BrowserDownloadResult) =>
              path.join(
                outputDir!,
                result.suggestedFilename ||
                  suggestedDownloadFilename(result.finalUrl, result.contentType, null),
              ),
          }
        : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }
    const result = await downloadMediaWithHls({
      ...options,
      requestDownload: async (url, outputPath, remainingMs) => {
        const payload = await context.requestCommand(context.flags.server, 'download', {
          url,
          outputPath,
          retries,
          retryDelayMs,
          ...(remainingMs !== undefined ? { timeoutMs: remainingMs } : {}),
        })
        return readBrowserDownloadResult(payload)
      },
    })
    context.writeResult({ ok: true, result })
    return 0
  } catch (error) {
    return throwCommandError(error)
  }
}

const handleMedia: CommandHandler = async (rest, context) => {
  if (helpRequested(rest[0], context, ['media'])) return 0
  if (rest[0] === 'list' && helpRequested(rest[1], context, ['media', 'list'])) return 0
  if (!isCommandAction('media', rest[0])) {
    return throwCommandError(
      `unsupported media action; expected ${COMMAND_ACTIONS.media.actions.join('|')}`,
    )
  }
  const extra = rest.slice(1)
  let resolve = false
  let includeBackground = false
  let selector: string | undefined
  let waitFor: string | undefined
  let timeoutMs: number | undefined
  for (let index = 0; index < extra.length; index += 1) {
    if (extra[index] === '--timeout-ms') {
      if (timeoutMs !== undefined) return throwCommandError('duplicate option: --timeout-ms')
      try {
        timeoutMs = parseNumberArg(extra[++index], 'timeout ms', { min: 1, integer: true })
      } catch (error) {
        return throwCommandError(error)
      }
      continue
    }
    if (extra[index] === '--wait-for') {
      if (waitFor !== undefined) return throwCommandError('duplicate option: --wait-for')
      const next = extra[++index]
      if (!next || next.startsWith('--')) return throwCommandError('missing value for --wait-for')
      waitFor = next
      continue
    }
    const value = extra[index]!
    if (value === '--resolve') {
      if (resolve) return throwCommandError('duplicate option: --resolve')
      resolve = true
      continue
    }
    if (value === '--include-background') {
      if (includeBackground) return throwCommandError('duplicate option: --include-background')
      includeBackground = true
      continue
    }
    if (value === '--selector') {
      if (selector !== undefined) return throwCommandError('duplicate option: --selector')
      const next = extra[index + 1]
      if (!next || next.startsWith('--') || !next.trim())
        return throwCommandError('missing value for --selector')
      selector = next.trim()
      index += 1
      continue
    }
    return throwCommandError(
      'usage: autobrowser media list [--resolve] [--selector <css>] [--include-background] [--wait-for <css>] [--timeout-ms <ms>]',
    )
  }
  if (waitFor === undefined && timeoutMs !== undefined) {
    return throwCommandError('--timeout-ms requires --wait-for')
  }
  try {
    const payload = await context.requestCommand(context.flags.server, 'media', {
      action: 'list',
      resolve,
      ...(selector !== undefined ? { selector } : {}),
      ...(includeBackground ? { includeBackground: true } : {}),
      ...(waitFor !== undefined ? { waitFor } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    if (payload.ok) {
      if (!isRecord(payload.result) || !Array.isArray(payload.result.media)) {
        throw new Error('media returned an invalid result')
      }
      validateMediaResponse(payload.result, { selector, includeBackground, waitFor })
    }
    context.writeResult(payload)
    return payload.ok ? 0 : 1
  } catch (error) {
    return throwCommandError(error)
  }
}

export const mediaCommandRegistry: CommandRegistry = {
  download: handleDownload,
  media: handleMedia,
}
