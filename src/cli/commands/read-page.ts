import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isRecord } from '../client.js'
import { CLI_ERROR_CODES, CliUsageError } from '../cli-error.js'
import {
  READ_PAGE_MAX_CHARS_LIMIT,
  READ_PAGE_MAX_SCREENS_LIMIT,
  READ_PAGE_MAX_TIMEOUT_MS,
  READ_PAGE_MIN_CHARS,
  READ_PAGE_MIN_SCREENS,
  READ_PAGE_MIN_TIMEOUT_MS,
} from '../../core/read-page.js'
import { helpRequested, parseOrThrow } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

export interface ReadPageCliOptions {
  cursor?: string
  maxChars?: number
  maxScreens?: number
  timeoutMs?: number
  outputPath?: string
}

function usageError(message: string, details?: unknown): CliUsageError {
  return new CliUsageError(message, {
    details: { path: 'read_page', ...(isRecord(details) ? details : {}) },
    suggestedAction:
      "Run 'autobrowser help read_page' to see the accepted options, then run read_page again with corrected values.",
  })
}

function parseBoundedInteger(
  raw: string | undefined,
  label: string,
  min: number,
  max: number,
): number {
  if (raw === undefined) throw usageError(`missing value for ${label}`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usageError(`--${label} must be an integer between ${min} and ${max}`, {
      field: label,
      value: raw,
    })
  }
  return value
}

/**
 * 解析 read_page 的命令级选项。
 *
 * --cursor 只能与 --max-chars/--output 组合：续读只回放已捕获的缓存，
 * 不会重新滚动扫描，因此 --max-screens/--timeout-ms 在续读时没有意义，
 * 直接报错比让用户以为它们会重新生效更诚实。
 */
export function parseReadPageArgs(rest: string[]): ReadPageCliOptions {
  const options: ReadPageCliOptions = {}

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--cursor') {
      if (options.cursor !== undefined) throw usageError('duplicate --cursor option')
      const cursor = rest[index + 1]
      if (!cursor || cursor.startsWith('--')) throw usageError('missing value for --cursor')
      options.cursor = cursor
      index += 1
      continue
    }
    if (value === '--max-chars') {
      if (options.maxChars !== undefined) throw usageError('duplicate --max-chars option')
      options.maxChars = parseBoundedInteger(
        rest[index + 1],
        'max-chars',
        READ_PAGE_MIN_CHARS,
        READ_PAGE_MAX_CHARS_LIMIT,
      )
      index += 1
      continue
    }
    if (value === '--max-screens') {
      if (options.maxScreens !== undefined) throw usageError('duplicate --max-screens option')
      options.maxScreens = parseBoundedInteger(
        rest[index + 1],
        'max-screens',
        READ_PAGE_MIN_SCREENS,
        READ_PAGE_MAX_SCREENS_LIMIT,
      )
      index += 1
      continue
    }
    if (value === '--timeout-ms') {
      if (options.timeoutMs !== undefined) throw usageError('duplicate --timeout-ms option')
      options.timeoutMs = parseBoundedInteger(
        rest[index + 1],
        'timeout-ms',
        READ_PAGE_MIN_TIMEOUT_MS,
        READ_PAGE_MAX_TIMEOUT_MS,
      )
      index += 1
      continue
    }
    if (value === '--output') {
      if (options.outputPath !== undefined) throw usageError('duplicate --output option')
      const output = rest[index + 1]
      if (!output || output.startsWith('--')) throw usageError('missing value for --output')
      options.outputPath = output
      index += 1
      continue
    }
    if (value.startsWith('--')) {
      throw usageError(`unsupported read_page option: ${value}`)
    }
    throw usageError(`unexpected extra argument for read_page: ${value}`)
  }

  if (options.cursor !== undefined && options.maxScreens !== undefined) {
    throw usageError('--cursor cannot be combined with --max-screens', {
      field: 'max-screens',
      reason: 'a cursor replays the captured buffer and never rescans the page',
    })
  }
  if (options.cursor !== undefined && options.timeoutMs !== undefined) {
    throw usageError('--cursor cannot be combined with --timeout-ms', {
      field: 'timeout-ms',
      reason: 'a cursor replays the captured buffer and never rescans the page',
    })
  }

  return options
}

/**
 * 把捕获到的完整文本写到本地文件，并用 {path, bytes} 摘要替换正文。
 *
 * 落盘的是「本次扫描捕获的完整文本」，不只是 stdout 当前分片；
 * 这样一次长文读取不会因为分片而丢内容。
 *
 * 落盘字符数单独用 capturedChars 表示：complete/stopReason/truncated/chars
 * 仍按本次读取的真实语义返回，不能因为写了文件就把「只读到一部分」说成读完。
 */
export async function writeReadPageOutput(
  result: Record<string, unknown>,
  outputPath: string,
): Promise<Record<string, unknown>> {
  const capturedText = result.capturedText
  if (typeof capturedText !== 'string') {
    throw new CliUsageError(
      'the extension did not return the captured text; the read_page --output flow needs a matching extension build',
      {
        code: CLI_ERROR_CODES.FAILED,
        suggestedAction:
          "Rebuild and reload the extension ('bun run build:chrome' then 'autobrowser extension reload'), then run read_page --output again.",
      },
    )
  }

  const resolvedPath = path.resolve(outputPath)
  await mkdir(path.dirname(resolvedPath), { recursive: true })
  await writeFile(resolvedPath, capturedText, 'utf8')

  const { capturedText: _capturedText, text: _text, ...meta } = result
  return {
    ...meta,
    capturedChars: capturedText.length,
    output: {
      path: resolvedPath,
      bytes: Buffer.byteLength(capturedText, 'utf8'),
    },
  }
}

async function handleReadPage(rest: string[], context: CommandContext): Promise<number | void> {
  if (helpRequested(rest[0], context, ['read_page'])) {
    return 0
  }

  const options = parseOrThrow(() => parseReadPageArgs(rest))
  const args: Record<string, unknown> = {}
  if (options.cursor !== undefined) args.cursor = options.cursor
  if (options.maxChars !== undefined) args.maxChars = options.maxChars
  if (options.maxScreens !== undefined) args.maxScreens = options.maxScreens
  if (options.timeoutMs !== undefined) args.timeoutMs = options.timeoutMs
  if (options.outputPath !== undefined) args.includeCapturedText = true

  const payload = await context.requestCommand(context.flags.server, 'read_page', args)
  if (payload.ok === false) {
    context.writeResult(payload)
    return 1
  }

  if (options.outputPath === undefined) {
    context.writeResult(payload)
    return 0
  }

  const result = isRecord(payload.result) ? payload.result : {}
  const written = await writeReadPageOutput(result, options.outputPath)
  context.writeResult({ ok: true, result: written })
  return 0
}

export const readPageCommandRegistry: CommandRegistry = {
  read_page: handleReadPage,
}
