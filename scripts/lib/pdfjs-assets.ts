import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PDFJS_LIB_FILENAME,
  PDFJS_VENDOR_DIR,
  PDFJS_WORKER_FILENAME,
} from '../../src/core/pdfjs-assets.js'

export interface PdfJsAssetBuildResult {
  libPath: string
  workerPath: string
  libBytes: number
  workerBytes: number
}

/**
 * pdfjs-dist 的 legacy .mjs 仍保留 Node 分支里的 createRequire(import.meta.url)
 * 和 worker 的 import.meta.url；format:"iife" 不会消掉它们，经典脚本一解析就报
 * "Cannot use 'import.meta' outside a module"。只在打包这两份上游文件时把
 * import.meta.url 换成页面 location，不改 node_modules。
 */
function pdfjsImportMetaPlugin(): Parameters<typeof Bun.build>[0]['plugins'] {
  return [
    {
      name: 'pdfjs-legacy-import-meta',
      setup(build) {
        build.onLoad(
          { filter: /[\\/]pdfjs-dist[\\/]legacy[\\/]build[\\/][^\\/]+\.mjs$/ },
          async (args) => ({
            contents: (await Bun.file(args.path).text()).replaceAll(
              'import.meta.url',
              'globalThis.location?.href || ""',
            ),
            loader: 'js',
          }),
        )
      },
    },
  ]
}

/**
 * 把 pdfjs-dist 打成经典 IIFE 脚本。
 *
 * pdfjs-dist 4 起只发 ESM（legacy 构建也是 .mjs），而 chrome.scripting 注入的
 * files 按经典脚本执行，所以这里在构建期生成 UMD 风格的 pdf.min.js /
 * pdf.worker.min.js；产物仍然完全来自 node_modules 里的锁定版本。
 */
export async function buildPdfJsAssets(
  outputDir: string,
  rootDir: string = process.cwd(),
): Promise<PdfJsAssetBuildResult> {
  const vendorDir = path.join(outputDir, PDFJS_VENDOR_DIR)
  const build = await Bun.build({
    entrypoints: [
      path.join(rootDir, 'scripts', 'pdfjs', 'pdf.min.ts'),
      path.join(rootDir, 'scripts', 'pdfjs', 'pdf.worker.min.ts'),
    ],
    outdir: vendorDir,
    target: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: 'none',
    plugins: pdfjsImportMetaPlugin(),
  })
  if (!build.success) {
    throw new Error(`failed to bundle pdf.js assets:\n${build.logs.map(String).join('\n')}`)
  }

  const libPath = path.join(vendorDir, PDFJS_LIB_FILENAME)
  const workerPath = path.join(vendorDir, PDFJS_WORKER_FILENAME)
  const byName = new Map(build.outputs.map((output) => [path.basename(output.path), output]))
  // Bun 的输出文件名由入口名决定；名字对不上时明确失败，不能让 chrome/ 里缺文件。
  for (const name of [PDFJS_LIB_FILENAME, PDFJS_WORKER_FILENAME]) {
    if (!byName.has(name)) {
      throw new Error(`pdf.js bundle did not produce ${name}`)
    }
  }

  // 随打包产物保留上游许可证，满足 pdf.js 的再分发要求。
  await copyFile(
    path.join(rootDir, 'node_modules', 'pdfjs-dist', 'LICENSE'),
    path.join(vendorDir, 'LICENSE'),
  )

  const [lib, worker] = await Promise.all([Bun.file(libPath).stat(), Bun.file(workerPath).stat()])
  return { libPath, workerPath, libBytes: lib.size, workerBytes: worker.size }
}
