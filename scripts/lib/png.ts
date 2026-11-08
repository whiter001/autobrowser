import { deflateSync, inflateSync } from 'node:zlib'

/** 解码后的像素缓冲，固定为 4 通道 RGBA，行优先存储。 */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// 通道数按 PNG 色彩类型排列：灰度 / 真彩 / 调色板 / 灰度+透明 / 真彩+透明。
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * 读取 PNG。仅支持 8 位位深：色彩类型 0/2/3/4/6 都能解，调色板走 PLTE + tRNS 展开。
 * 隔行扫描（Adam7）不常见，直接报错避免给出错误的像素。
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('不是合法的 PNG：文件签名不匹配')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  const idat: Uint8Array[] = []

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    )
    const dataStart = offset + 8
    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8]!
      colorType = bytes[dataStart + 9]!
      interlace = bytes[dataStart + 12]!
    } else if (type === 'PLTE') {
      palette = bytes.slice(dataStart, dataStart + length)
    } else if (type === 'tRNS') {
      transparency = bytes.slice(dataStart, dataStart + length)
    } else if (type === 'IDAT') {
      idat.push(bytes.slice(dataStart, dataStart + length))
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }

  if (width <= 0 || height <= 0) throw new Error('PNG 缺少有效的 IHDR 尺寸信息')
  if (bitDepth !== 8) throw new Error(`暂只支持 8 位位深的 PNG，当前是 ${bitDepth} 位`)
  if (interlace !== 0) throw new Error('暂不支持隔行扫描（Adam7）的 PNG')
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  if (channels === undefined) throw new Error(`未知的 PNG 色彩类型：${colorType}`)
  if (colorType === 3 && palette === null) throw new Error('调色板 PNG 缺少 PLTE 段')

  const raw = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))))
  const stride = width * channels
  const pixels = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)
  let current = new Uint8Array(stride)
  let source = 0

  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]!
    source += 1
    for (let i = 0; i < stride; i += 1) {
      const value = raw[source + i]!
      const left = i >= channels ? current[i - channels]! : 0
      const up = previous[i]!
      const upLeft = i >= channels ? previous[i - channels]! : 0
      let restored = value
      if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + ((left + up) >> 1)
      else if (filter === 4) restored = value + paeth(left, up, upLeft)
      else if (filter !== 0) throw new Error(`未知的 PNG 行过滤器：${filter}`)
      current[i] = restored & 0xff
    }
    source += stride

    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4
      const sourceIndex = x * channels
      if (colorType === 0) {
        const gray = current[sourceIndex]!
        pixels[target] = gray
        pixels[target + 1] = gray
        pixels[target + 2] = gray
        pixels[target + 3] = 255
      } else if (colorType === 2) {
        pixels[target] = current[sourceIndex]!
        pixels[target + 1] = current[sourceIndex + 1]!
        pixels[target + 2] = current[sourceIndex + 2]!
        pixels[target + 3] = 255
      } else if (colorType === 3) {
        const index = current[sourceIndex]!
        pixels[target] = palette![index * 3]!
        pixels[target + 1] = palette![index * 3 + 1]!
        pixels[target + 2] = palette![index * 3 + 2]!
        pixels[target + 3] =
          transparency && index < transparency.length ? transparency[index]! : 255
      } else if (colorType === 4) {
        const gray = current[sourceIndex]!
        pixels[target] = gray
        pixels[target + 1] = gray
        pixels[target + 2] = gray
        pixels[target + 3] = current[sourceIndex + 1]!
      } else {
        pixels[target] = current[sourceIndex]!
        pixels[target + 1] = current[sourceIndex + 1]!
        pixels[target + 2] = current[sourceIndex + 2]!
        pixels[target + 3] = current[sourceIndex + 3]!
      }
    }

    const swap = previous
    previous = current
    current = swap
  }

  return { width, height, data: pixels }
}

/** 编码为 8 位 RGBA PNG。逐行使用 None 过滤器，依赖 zlib 压缩，产物只用于人工查看。 */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1)
  }

  const chunks: Uint8Array[] = []
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 色彩类型：真彩 + Alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  chunks.push(buildChunk('IHDR', ihdr))
  chunks.push(buildChunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))))
  chunks.push(buildChunk('IEND', new Uint8Array(0)))
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), ...chunks.map((c) => Buffer.from(c))])
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  for (let i = 0; i < 4; i += 1) crcInput[i] = chunk[4 + i]!
  crcInput.set(data, 4)
  view.setUint32(8 + data.length, crc32(crcInput))
  return chunk
}
