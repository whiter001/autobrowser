import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildPdfJsAssets } from '../scripts/lib/pdfjs-assets.js'

async function readAsset(filePath: string): Promise<string> {
  return await readFile(filePath, 'utf8')
}

describe('build:chrome 的 pdf.js 资产', () => {
  test('产出经典脚本 pdf.min.js / pdf.worker.min.js 且可重复', async () => {
    const root = path.resolve(import.meta.dir, '..')
    const firstDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-pdfjs-a-'))
    const secondDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-pdfjs-b-'))

    const first = await buildPdfJsAssets(firstDir, root)
    const second = await buildPdfJsAssets(secondDir, root)

    expect(first.libPath.endsWith(path.join('vendor', 'pdfjs', 'pdf.min.js'))).toBe(true)
    expect(first.workerPath.endsWith(path.join('vendor', 'pdfjs', 'pdf.worker.min.js'))).toBe(true)
    expect(first.libBytes).toBeGreaterThan(100_000)
    expect(first.workerBytes).toBeGreaterThan(100_000)

    const lib = await readAsset(first.libPath)
    const worker = await readAsset(first.workerPath)
    // 注入到 MAIN world 后必须能以经典脚本执行：无 import/export，靠全局取库。
    expect(lib).toContain('globalThis.pdfjsLib')
    expect(lib).not.toContain('import.meta')
    expect(lib).not.toMatch(/(^|\n)\s*import\s/)
    expect(lib).not.toMatch(/(^|\n)\s*export\s/)
    expect(worker).toContain('globalThis.pdfjsWorker')
    expect(worker).not.toContain('import.meta')
    expect(worker).not.toMatch(/(^|\n)\s*export\s/)

    // 同样的依赖与入口必须得到逐字节相同的产物，避免 build 结果漂移。
    const [libAgain, workerAgain] = await Promise.all([
      readFile(second.libPath),
      readFile(second.workerPath),
    ])
    expect(Buffer.from(lib).equals(libAgain)).toBe(true)
    expect(Buffer.from(worker).equals(workerAgain)).toBe(true)

    const license = await readFile(path.join(firstDir, 'vendor', 'pdfjs', 'LICENSE'), 'utf8')
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0, January 2004')
  }, 60_000)
})
