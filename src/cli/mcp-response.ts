import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getHomeDir } from '../core/protocol.js'
import { isRecord } from './client.js'
import { extractScreenshotBase64 } from './screenshot.js'
import { presentCommandResult } from './response-presenters.js'
import type { ResponseFormat } from './response-format.js'
import { errorRetryable } from '../core/tool-error.js'
import { describeErrorCode } from '../core/error-actions.js'

// 超过该体积的截图 base64 不再内联进 MCP 响应（会爆模型上下文），改为落盘后回文本路径
const SCREENSHOT_MAX_INLINE_BYTES = 2 * 1024 * 1024

export function toErrorResult(
  code: string | undefined,
  message: string,
  error: {
    suggestion?: string
    suggestedAction?: string
    retryable?: boolean
    details?: unknown
  } = {},
): CallToolResult {
  const suggestedAction =
    error.suggestedAction || error.suggestion || describeErrorCode(code)?.action
  const text = suggestedAction ? `${message}\n\n[AI SUGGESTION]: ${suggestedAction}` : message
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      error: {
        ...(code ? { code } : {}),
        message,
        retryable: error.retryable ?? errorRetryable(code),
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        ...(suggestedAction ? { suggestedAction } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
  }
}

export function toSuccessResult(
  result: unknown,
  options: { command?: string; responseFormat?: ResponseFormat } = {},
): CallToolResult {
  const responseFormat = options.responseFormat ?? 'concise'
  const presented = options.command
    ? presentCommandResult(options.command, result, responseFormat)
    : result
  const structuredContent = isRecord(presented) && !Array.isArray(presented) ? presented : undefined
  const spacing = responseFormat === 'concise' ? undefined : 2
  return {
    content: [{ type: 'text', text: JSON.stringify(presented, null, spacing) }],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

export function toScreenshotResult(result: Record<string, unknown>): Promise<CallToolResult> {
  const { data, mimeType } = extractScreenshotBase64(result)
  const summary: Record<string, unknown> = { mimeType }
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'data' && key !== 'dataUrl') {
      summary[key] = value
    }
  }
  const dimensions =
    typeof result.width === 'number' && typeof result.height === 'number'
      ? ` (${result.width}x${result.height})`
      : ''
  const byteLength = Buffer.from(data, 'base64').length
  if (byteLength > SCREENSHOT_MAX_INLINE_BYTES) {
    return writeOversizedScreenshot(result, summary, data, mimeType, byteLength)
  }
  return Promise.resolve({
    content: [
      { type: 'image', data, mimeType },
      { type: 'text', text: `Screenshot captured as ${mimeType}${dimensions}.` },
    ],
    structuredContent: summary,
  })
}

/** 超过 2MB 的截图落盘到 ~/.autobrowser/screenshots/，只回文本路径，避免 base64 进模型上下文 */
async function writeOversizedScreenshot(
  result: Record<string, unknown>,
  summary: Record<string, unknown>,
  data: string,
  mimeType: string,
  byteLength: number,
): Promise<CallToolResult> {
  const extension = mimeType === 'image/jpeg' ? 'jpeg' : 'png'
  const directory = path.join(getHomeDir(), '.autobrowser', 'screenshots')
  await mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `autobrowser-${Date.now()}.${extension}`)
  await writeFile(filePath, data, 'base64')

  const sizeMb = (byteLength / (1024 * 1024)).toFixed(1)
  const sizeText =
    typeof result.width === 'number' && typeof result.height === 'number'
      ? `${result.width}x${result.height} pixels`
      : `${byteLength} bytes`
  const text = `screenshot saved to ${filePath} (${sizeText}, ${sizeMb} MB, too large to inline)`
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ...summary, path: filePath },
  }
}

export async function toVideoResult(result: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof result.data !== 'string') return toSuccessResult(result)
  const { data, ...summary } = result
  const directory = path.join(getHomeDir(), '.autobrowser', 'videos')
  await mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `video-${Date.now()}.webm`)
  await writeFile(filePath, data, 'base64')
  let chaptersPath: string | undefined
  if (Array.isArray(result.chapters) && result.chapters.length) {
    chaptersPath = filePath.replace(/\.webm$/i, '') + '.chapters.json'
    await writeFile(chaptersPath, `${JSON.stringify(result.chapters, null, 2)}\n`)
  }
  return {
    content: [{ type: 'text', text: `video saved to ${filePath}` }],
    structuredContent: { ...summary, path: filePath, chaptersPath },
  }
}

export async function toTracingResult(result: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof result.data !== 'string') return toSuccessResult(result)
  const { data, ...summary } = result
  const directory = path.join(getHomeDir(), '.autobrowser', 'tracing')
  await mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `trace-${Date.now()}.json`)
  await writeFile(filePath, data, result.base64Encoded === true ? 'base64' : 'utf8')
  return {
    content: [{ type: 'text', text: `trace saved to ${filePath}` }],
    structuredContent: { ...summary, path: filePath },
  }
}
