import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type ScreenshotArgs } from './parse.js'

async function mkTempScreenshotDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-'))
}

export function extractScreenshotData(result: Record<string, unknown> | undefined): {
  data: Buffer
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

  return {
    data: Buffer.from(rawData, 'base64'),
    mimeType,
  }
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
