import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type ScreenshotArgs } from './parse.js'

async function mkTempScreenshotDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-'))
}

// 结果里可能是裸 base64，也可能是 dataUrl。MCP 侧要原样透传 base64 串，CLI 落盘侧要 Buffer，
// 所以解析只做一次，解码交给调用方，避免两套实现各写一遍 dataUrl/mimeType 兜底逻辑。
export function extractScreenshotBase64(result: Record<string, unknown> | undefined): {
  data: string
  mimeType: string
} {
  const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl : ''
  const rawData =
    typeof result?.data === 'string'
      ? result.data
      : dataUrl.includes(',')
        ? dataUrl.slice(dataUrl.indexOf(',') + 1)
        : ''

  if (!rawData) {
    throw new Error('missing screenshot data')
  }

  const mimeType =
    typeof result?.mimeType === 'string'
      ? result.mimeType
      : dataUrl.startsWith('data:image/jpeg')
        ? 'image/jpeg'
        : 'image/png'

  return { data: rawData, mimeType }
}

export function extractScreenshotData(result: Record<string, unknown> | undefined): {
  data: Buffer
  mimeType: string
} {
  const { data, mimeType } = extractScreenshotBase64(result)
  return { data: Buffer.from(data, 'base64'), mimeType }
}

export async function resolveScreenshotOutputPath(screenshotArgs: ScreenshotArgs): Promise<string> {
  if (screenshotArgs.path) {
    await mkdir(path.dirname(screenshotArgs.path), { recursive: true })
    return screenshotArgs.path
  }

  const outputDir = screenshotArgs.screenshotDir || (await mkTempScreenshotDir())
  await mkdir(outputDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const extension = screenshotArgs.format === 'jpeg' ? 'jpeg' : 'png'
  return path.join(outputDir, `screenshot-${timestamp}.${extension}`)
}
