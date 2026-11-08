import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  collectDiffRegions,
  compositeOverWhite,
  diffImages,
  renderDiffImage,
  scaleImage,
} from './lib/image.js'
import { decodePng, encodePng } from './lib/png.js'

const execFileAsync = promisify(execFile)

/**
 * 视觉对齐检查：把 Figma 导出图按页面截图的实际物理像素缩放后逐像素对比，输出差异报告。
 *
 * 之所以不直接用设计稿原始像素对比，是因为浏览器渲染的物理像素受系统缩放影响
 * （本机 Windows 125% 缩放下，1440 CSS 像素的视口只产出 1152 像素宽的截图），
 * 真正的对齐基准是截图的实际像素尺寸，缩放系数由此反推。
 */

interface CliOptions {
  mode: 'run' | 'capture' | 'compare'
  design: string | null
  screenshot: string | null
  url: string | null
  tab: string | null
  cssWidth: number | null
  cssHeight: number | null
  designDpr: number
  dpr: number
  tolerance: number
  outDir: string
  cell: number
  top: number
  failRatio: number
  cli: string
  fullPage: boolean
}

interface CliResponse {
  ok: boolean
  result?: Record<string, unknown>
  error?: { message?: string; code?: string }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'run',
    design: null,
    screenshot: null,
    url: null,
    tab: null,
    cssWidth: null,
    cssHeight: null,
    designDpr: 1,
    dpr: 1,
    tolerance: 8,
    outDir: 'visual-diff-out',
    cell: 50,
    top: 15,
    failRatio: 0,
    cli: '',
    fullPage: false,
  }

  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`)
      i += 1
      return value
    }
    switch (arg) {
      case '--design':
        options.design = next()
        break
      case '--screenshot':
        options.screenshot = next()
        break
      case '--url':
        options.url = next()
        break
      case '--tab':
        options.tab = next()
        break
      case '--css-width':
        options.cssWidth = Number(next())
        break
      case '--css-height':
        options.cssHeight = Number(next())
        break
      case '--design-dpr':
        options.designDpr = Number(next())
        break
      case '--dpr':
        options.dpr = Number(next())
        break
      case '--tolerance':
        options.tolerance = Number(next())
        break
      case '--out':
        options.outDir = next()
        break
      case '--cell':
        options.cell = Number(next())
        break
      case '--top':
        options.top = Number(next())
        break
      case '--fail-ratio':
        options.failRatio = Number(next())
        break
      case '--cli':
        options.cli = next()
        break
      case '--full':
        options.fullPage = true
        break
      default:
        if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
        positional.push(arg)
    }
  }

  if (positional.length > 0) {
    const mode = positional[0]!
    if (mode !== 'run' && mode !== 'capture' && mode !== 'compare') {
      throw new Error(`未知子命令：${mode}（可选 run / capture / compare）`)
    }
    options.mode = mode
  }
  return options
}

function usage(): string {
  return `用法：
  bun scripts/visual-diff.ts run     --design <figma.png> [--url <url>] [--tab <tN>] [选项]
  bun scripts/visual-diff.ts capture --tab <tN> [--url <url>] [--css-width <n>] [--css-height <n>] [选项]
  bun scripts/visual-diff.ts compare --design <figma.png> --screenshot <shot.png> [选项]

选项：
  --design <path>        Figma 导出图（run / compare 必需）
  --screenshot <path>    已有的页面截图（compare 必需）
  --url <url>            需要打开的地址；不给则使用当前标签页
  --tab <tN>             指定标签页
  --css-width <n>        视口 CSS 宽度，默认取设计稿宽度 ÷ --design-dpr
  --css-height <n>       视口 CSS 高度，默认取设计稿高度 ÷ --design-dpr
  --design-dpr <n>       设计稿自身的像素密度，默认 1
  --dpr <n>              截图时的 deviceScaleFactor 参数，默认 1
  --tolerance <n>        单通道色差容差 0-255，默认 8；文字边缘的缩放重采样噪声通常需要 16~24
  --out <dir>            输出目录，默认 visual-diff-out
  --cell <n>             热区网格边长（像素），默认 50
  --top <n>              最多列出多少个热区，默认 15
  --fail-ratio <n>       差异率超过该值时退出码为 1，默认 0（不失败）
  --cli <path>           autobrowser 可执行文件路径，默认从 PATH 查找
  --full                 整页截图而非视口截图
`
}

async function runAutobrowser(options: CliOptions, args: string[]): Promise<CliResponse> {
  const candidates = options.cli
    ? [options.cli]
    : process.platform === 'win32'
      ? ['autobrowser.exe', 'autobrowser']
      : ['autobrowser']

  let lastError: unknown = null
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--json', ...args], {
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
      })
      const parsed = JSON.parse(stdout.trim()) as CliResponse
      if (!parsed.ok) {
        const message = parsed.error?.message ?? '未知错误'
        throw new Error(`${candidate} ${args.join(' ')} 执行失败：${message}`)
      }
      return parsed
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${candidate} `)) throw error
      lastError = error
    }
  }
  throw new Error(
    `无法执行 autobrowser（尝试过 ${candidates.join('、')}）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

function globalArgs(options: CliOptions): string[] {
  return options.tab ? ['--tab', options.tab] : []
}

async function readMetrics(options: CliOptions): Promise<{
  innerWidth: number
  innerHeight: number
  dpr: number
}> {
  const response = await runAutobrowser(options, [
    ...globalArgs(options),
    'eval',
    'return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio }',
  ])
  const result = response.result as
    | { innerWidth: number; innerHeight: number; dpr: number }
    | undefined
  if (!result) throw new Error('读取页面尺寸失败：eval 未返回预期字段')
  return result
}

/**
 * 把 CSS 视口对准目标尺寸。
 *
 * 系统显示缩放会让「传入的视口宽」与「真实 CSS 像素宽」不一致（本机是 1.25 倍），
 * 所以先设一次再读回真实值，用比例修正后重设，一次即可收敛。
 */
async function alignViewport(
  options: CliOptions,
  cssWidth: number,
  cssHeight: number,
): Promise<{ innerWidth: number; innerHeight: number; dpr: number; scale: number }> {
  const setViewport = async (width: number, height: number): Promise<void> => {
    await runAutobrowser(options, [
      ...globalArgs(options),
      'set',
      'viewport',
      // 向下取整，避免 CSS 视口超出设计稿宽度后触发横向滚动或断点偏移。
      String(Math.max(1, Math.floor(width))),
      String(Math.max(1, Math.floor(height))),
      String(options.dpr),
    ])
  }

  await setViewport(cssWidth, cssHeight)
  let metrics = await readMetrics(options)
  // 缩放系数可能是 1.25 这类无法整除的倍率，一次修正只能逼近到个位像素，
  // 因此迭代几轮，并保留误差更小的那次结果。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const gap = Math.abs(metrics.innerWidth - cssWidth)
    if (gap <= 1) break
    const scale = metrics.innerWidth / cssWidth
    await setViewport(cssWidth / scale, cssHeight / scale)
    const next = await readMetrics(options)
    if (Math.abs(next.innerWidth - cssWidth) >= gap) break
    metrics = next
  }
  return { ...metrics, scale: metrics.innerWidth / cssWidth }
}

async function capture(options: CliOptions, outputPath: string): Promise<void> {
  if (options.url) {
    await runAutobrowser(options, [...globalArgs(options), 'open', options.url])
  }
  // 等渲染稳定再截图，否则动画或字体加载会造成大面积假差异。
  await runAutobrowser(options, [...globalArgs(options), 'wait', '--state', 'stable']).catch(
    () => {},
  )
  const args = [...globalArgs(options), 'screenshot', outputPath]
  if (options.fullPage) args.push('--full')
  await runAutobrowser(options, args)
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.mode !== 'capture' && options.design === null) {
    console.error(usage())
    throw new Error(`${options.mode} 模式需要 --design 指定 Figma 导出图`)
  }
  if (options.mode === 'compare' && options.screenshot === null) {
    console.error(usage())
    throw new Error('compare 模式需要 --screenshot 指定页面截图')
  }

  const outDir = path.resolve(process.cwd(), options.outDir)
  await mkdir(outDir, { recursive: true })

  const design = decodePng(new Uint8Array(await readFile(options.design!)))
  const designCssWidth = options.cssWidth ?? design.width / options.designDpr
  const designCssHeight = options.cssHeight ?? design.height / options.designDpr

  let screenshotPath = options.screenshot
  let metrics: { innerWidth: number; innerHeight: number; dpr: number; scale: number } | null = null

  if (options.mode !== 'compare') {
    metrics = await alignViewport(options, designCssWidth, designCssHeight)
    screenshotPath = path.join(outDir, 'screenshot.png')
    await capture(options, screenshotPath)
    console.log(
      `视口已对齐：CSS ${metrics.innerWidth}×${metrics.innerHeight}（换算系数 ${metrics.scale.toFixed(3)}）`,
    )
  }

  const screenshot = decodePng(new Uint8Array(await readFile(screenshotPath!)))
  // 截图的实际物理像素才是对齐基准，缩放系数由此反推，不写死 0.8。
  const scale = screenshot.width / design.width
  const scaledDesign = scaleImage(design, screenshot.width, Math.round(design.height * scale))
  await writeFile(path.join(outDir, 'design-scaled.png'), encodePng(scaledDesign))

  const baseline = compositeOverWhite(scaledDesign)
  const candidate = compositeOverWhite(screenshot)
  const diff = diffImages(baseline, candidate, options.tolerance)
  await writeFile(path.join(outDir, 'diff.png'), encodePng(renderDiffImage(baseline, diff)))

  const regions = collectDiffRegions(diff, options.cell, options.top)
  const uncovered = scaledDesign.height - diff.comparedHeight
  const report: string[] = []
  report.push('# 视觉差异报告')
  report.push('')
  report.push(`- 生成时间：${new Date().toISOString()}`)
  report.push(
    `- 设计稿：\`${options.design}\`（${design.width}×${design.height}，${options.designDpr}x）`,
  )
  report.push(`- 页面截图：\`${screenshotPath}\`（${screenshot.width}×${screenshot.height}）`)
  report.push(`- 缩放系数：${scale.toFixed(4)}（设计稿 → 截图物理像素）`)
  report.push(`- 对比区域：${diff.comparedWidth}×${diff.comparedHeight}`)
  report.push(
    `- 差异像素：${diff.diffPixels.toLocaleString('en-US')} / ${diff.totalPixels.toLocaleString('en-US')}（${formatPercent(diff.ratio)}）`,
  )
  report.push(`- 容差：${options.tolerance}/255（实测最大单通道色差 ${diff.maxDelta}）`)
  if (metrics) {
    report.push(
      `- 视口：CSS ${metrics.innerWidth}×${metrics.innerHeight}，devicePixelRatio ${metrics.dpr.toFixed(3)}`,
    )
    const widthGap = metrics.innerWidth - designCssWidth
    if (Math.abs(widthGap) > 1) {
      report.push(
        `- ⚠️ 视口宽度与设计稿 CSS 宽度相差 ${widthGap.toFixed(0)}px，响应式断点可能与设计意图不一致`,
      )
    }
  }
  if (uncovered > 0) {
    report.push(
      `- ⚠️ 设计稿底部有 ${uncovered} 行未覆盖：页面比视口更高，需要整页截图（\`--full\`）或分段对比`,
    )
  }
  report.push('')
  report.push('## 差异热区')
  report.push('')
  if (regions.length === 0) {
    report.push('未发现超出容差的像素。')
  } else {
    report.push('| 位置 (x, y) | 区块尺寸 | 差异像素 | 差异率 |')
    report.push('| --- | --- | --- | --- |')
    for (const region of regions) {
      report.push(
        `| ${region.x}, ${region.y} | ${region.width}×${region.height} | ${region.diffPixels.toLocaleString('en-US')} | ${formatPercent(region.ratio)} |`,
      )
    }
  }
  report.push('')
  report.push('## 产出文件')
  report.push('')
  report.push(
    `- \`design-scaled.png\` 缩放后的设计稿（${scaledDesign.width}×${scaledDesign.height}）`,
  )
  report.push(`- \`screenshot.png\` 页面截图（${screenshot.width}×${screenshot.height}）`)
  report.push(`- \`diff.png\` 差异图（红色为超出容差的像素）`)
  report.push(`- \`report.md\` 本报告`)

  const reportPath = path.join(outDir, 'report.md')
  await writeFile(reportPath, `${report.join('\n')}\n`, 'utf8')

  console.log('')
  console.log(
    `差异像素 ${diff.diffPixels.toLocaleString('en-US')} / ${diff.totalPixels.toLocaleString('en-US')}（${formatPercent(diff.ratio)}），最大色差 ${diff.maxDelta}`,
  )
  if (regions.length > 0) {
    const top = regions[0]!
    console.log(
      `差异最集中的区块：(${top.x}, ${top.y}) ${top.width}×${top.height}，差异率 ${formatPercent(top.ratio)}`,
    )
  }
  console.log(`报告：${reportPath}`)

  if (options.failRatio > 0 && diff.ratio > options.failRatio) {
    process.exitCode = 1
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
