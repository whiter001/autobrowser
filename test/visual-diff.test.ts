import { describe, expect, test } from 'bun:test'
import {
  collectDiffRegions,
  compositeOverWhite,
  diffImages,
  renderDiffImage,
  scaleImage,
} from '../scripts/lib/image.js'
import { decodePng, encodePng } from '../scripts/lib/png.js'

function solid(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0]
    data[i + 1] = rgba[1]
    data[i + 2] = rgba[2]
    data[i + 3] = rgba[3]
  }
  return { width, height, data }
}

describe('png 编解码', () => {
  test('编码后再解码能还原像素', () => {
    const source = solid(4, 3, [12, 34, 56, 255])
    const decoded = decodePng(encodePng(source))
    expect(decoded.width).toBe(4)
    expect(decoded.height).toBe(3)
    expect(Array.from(decoded.data.subarray(0, 8))).toEqual([12, 34, 56, 255, 12, 34, 56, 255])
  })

  test('非 PNG 内容报错', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/PNG/)
  })
})

describe('缩放', () => {
  test('按比例缩放到目标尺寸', () => {
    const scaled = scaleImage(solid(1440, 900, [255, 255, 255, 255]), 1152, 720)
    expect(scaled.width).toBe(1152)
    expect(scaled.height).toBe(720)
  })

  test('纯色缩放后颜色不变', () => {
    const scaled = scaleImage(solid(100, 100, [10, 20, 30, 255]), 80, 80)
    expect(Array.from(scaled.data.subarray(0, 4))).toEqual([10, 20, 30, 255])
  })
})

describe('像素对比', () => {
  test('容差内的色差不算差异', () => {
    const baseline = solid(2, 1, [100, 100, 100, 255])
    const candidate = solid(2, 1, [105, 100, 100, 255])
    const diff = diffImages(baseline, candidate, 8)
    expect(diff.diffPixels).toBe(0)
    expect(diff.maxDelta).toBe(5)
  })

  test('超出容差的像素被标记', () => {
    const baseline = solid(2, 1, [100, 100, 100, 255])
    const candidate = solid(2, 1, [100, 100, 100, 255])
    candidate.data[4] = 200
    const diff = diffImages(baseline, candidate, 8)
    expect(diff.diffPixels).toBe(1)
    expect(diff.ratio).toBe(0.5)
  })

  test('透明像素合成到白底后不产生假差异', () => {
    const baseline = compositeOverWhite(solid(1, 1, [0, 0, 0, 0]))
    const candidate = solid(1, 1, [255, 255, 255, 255])
    expect(diffImages(baseline, candidate, 8).diffPixels).toBe(0)
  })

  test('高度不一致时只比较重叠区域', () => {
    const baseline = solid(4, 10, [0, 0, 0, 255])
    const candidate = solid(4, 6, [0, 0, 0, 255])
    const diff = diffImages(baseline, candidate, 8)
    expect(diff.comparedHeight).toBe(6)
    expect(diff.totalPixels).toBe(24)
  })
})

describe('差异热区', () => {
  test('按差异率排序并返回坐标', () => {
    const baseline = solid(10, 10, [0, 0, 0, 255])
    const candidate = solid(10, 10, [0, 0, 0, 255])
    for (let i = 0; i < 5; i += 1) candidate.data[(5 * 10 + 5) * 4 + i * 4] = 255
    const diff = diffImages(baseline, candidate, 8)
    const regions = collectDiffRegions(diff, 5, 3)
    expect(regions.length).toBeGreaterThan(0)
    expect(regions[0]!.x).toBe(5)
    expect(regions[0]!.y).toBe(5)
    expect(regions[0]!.ratio).toBeCloseTo(0.2)
  })

  test('无差异时没有热区', () => {
    const image = solid(10, 10, [0, 0, 0, 255])
    expect(collectDiffRegions(diffImages(image, image, 8), 5, 3)).toHaveLength(0)
  })
})

describe('差异图', () => {
  test('差异像素标红，非差异保持灰度', () => {
    const baseline = solid(2, 1, [0, 0, 0, 255])
    const candidate = solid(2, 1, [0, 0, 0, 255])
    candidate.data[0] = 255
    const diff = diffImages(baseline, candidate, 8)
    const rendered = renderDiffImage(baseline, diff)
    expect(Array.from(rendered.data.subarray(0, 4))).toEqual([220, 30, 30, 255])
    expect(Array.from(rendered.data.subarray(4, 8))).toEqual([0, 0, 0, 255])
  })
})
