import type { RgbaImage } from './png.js'

/**
 * 双线性缩放。设计稿缩放系数一般不为整数（例如 1440 → 1152 即 0.8），
 * 双线性与浏览器的 GPU 缩放滤波最接近，能把重采样噪声压到容差阈值以下。
 */
export function scaleImage(image: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
  const width = Math.max(1, Math.round(targetWidth))
  const height = Math.max(1, Math.round(targetHeight))
  const data = new Uint8Array(width * height * 4)
  const scaleX = image.width / width
  const scaleY = image.height / height

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5))
    const y0 = Math.floor(sourceY)
    const y1 = Math.min(image.height - 1, y0 + 1)
    const weightY = sourceY - y0
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5))
      const x0 = Math.floor(sourceX)
      const x1 = Math.min(image.width - 1, x0 + 1)
      const weightX = sourceX - x0
      const target = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = image.data[(y0 * image.width + x0) * 4 + channel]!
        const topRight = image.data[(y0 * image.width + x1) * 4 + channel]!
        const bottomLeft = image.data[(y1 * image.width + x0) * 4 + channel]!
        const bottomRight = image.data[(y1 * image.width + x1) * 4 + channel]!
        const top = topLeft + (topRight - topLeft) * weightX
        const bottom = bottomLeft + (bottomRight - bottomLeft) * weightX
        data[target + channel] = Math.round(top + (bottom - top) * weightY)
      }
    }
  }
  return { width, height, data }
}

/** 把带 alpha 的像素合成到白底，避免透明区域在对比时被算成巨大差异。 */
export function compositeOverWhite(image: RgbaImage): RgbaImage {
  const data = new Uint8Array(image.data.length)
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3]! / 255
    data[i] = Math.round(image.data[i]! * alpha + 255 * (1 - alpha))
    data[i + 1] = Math.round(image.data[i + 1]! * alpha + 255 * (1 - alpha))
    data[i + 2] = Math.round(image.data[i + 2]! * alpha + 255 * (1 - alpha))
    data[i + 3] = 255
  }
  return { width: image.width, height: image.height, data }
}

/** 单个像素的差异判定结果。 */
export interface DiffResult {
  /** 差异像素数量。 */
  diffPixels: number
  /** 参与比较的像素总数。 */
  totalPixels: number
  /** 差异像素占比，0~1。 */
  ratio: number
  /** 出现过的最大单通道色差。 */
  maxDelta: number
  /** 逐像素差异掩码，1 表示该像素超出容差。 */
  mask: Uint8Array
  /** 实际参与比较的区域宽高（高度可能被裁剪）。 */
  comparedWidth: number
  comparedHeight: number
}

/** 比较两张图。宽高不一致时按左上角对齐，只比较重叠区域。 */
export function diffImages(
  baseline: RgbaImage,
  candidate: RgbaImage,
  tolerance: number,
): DiffResult {
  const width = Math.min(baseline.width, candidate.width)
  const height = Math.min(baseline.height, candidate.height)
  const mask = new Uint8Array(width * height)
  let diffPixels = 0
  let maxDelta = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const delta = Math.max(
        Math.abs(baseline.data[index]! - candidate.data[index]!),
        Math.abs(baseline.data[index + 1]! - candidate.data[index + 1]!),
        Math.abs(baseline.data[index + 2]! - candidate.data[index + 2]!),
      )
      if (delta > maxDelta) maxDelta = delta
      if (delta > tolerance) {
        mask[y * width + x] = 1
        diffPixels += 1
      }
    }
  }

  const totalPixels = width * height
  return {
    diffPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    maxDelta,
    mask,
    comparedWidth: width,
    comparedHeight: height,
  }
}

/** 差异热区：把比较区域切成网格，统计每格差异率，用于快速定位对不上的组件。 */
export interface DiffRegion {
  x: number
  y: number
  width: number
  height: number
  diffPixels: number
  ratio: number
}

export function collectDiffRegions(
  diff: DiffResult,
  cellSize: number,
  limit: number,
): DiffRegion[] {
  const cell = Math.max(1, Math.round(cellSize))
  const regions: DiffRegion[] = []
  for (let y = 0; y < diff.comparedHeight; y += cell) {
    for (let x = 0; x < diff.comparedWidth; x += cell) {
      const width = Math.min(cell, diff.comparedWidth - x)
      const height = Math.min(cell, diff.comparedHeight - y)
      let count = 0
      for (let row = y; row < y + height; row += 1) {
        for (let column = x; column < x + width; column += 1) {
          if (diff.mask[row * diff.comparedWidth + column] === 1) count += 1
        }
      }
      if (count === 0) continue
      regions.push({ x, y, width, height, diffPixels: count, ratio: count / (width * height) })
    }
  }
  regions.sort((a, b) => b.ratio - a.ratio || b.diffPixels - a.diffPixels)
  return regions.slice(0, limit)
}

/**
 * 生成差异图：底图是设计稿的灰度版本，差异像素用红色叠加。
 * 目的是让人一眼看出差异集中在哪，而不是逐像素读报告。
 */
export function renderDiffImage(baseline: RgbaImage, diff: DiffResult): RgbaImage {
  const { comparedWidth: width, comparedHeight: height, mask } = diff
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const sourceIndex = (y * baseline.width + x) * 4
      const gray = Math.round(
        baseline.data[sourceIndex]! * 0.299 +
          baseline.data[sourceIndex + 1]! * 0.587 +
          baseline.data[sourceIndex + 2]! * 0.114,
      )
      const isDiff = mask[y * width + x] === 1
      data[index] = isDiff ? 220 : gray
      data[index + 1] = isDiff ? 30 : gray
      data[index + 2] = isDiff ? 30 : gray
      data[index + 3] = 255
    }
  }
  return { width, height, data }
}
