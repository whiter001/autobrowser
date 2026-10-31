// 此模块同时由扩展和 relay 使用，不能引入 Node/Bun 专属 API。
/** 单文件与并发预留共用的字节上限 */
export const MAX_FILE_UPLOAD_BYTES = 512 * 1024 * 1024
/** 扩展侧单次 HTTP 上传的分段大小 */
export const FILE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
/** 超过该大小的下载改走流式上传：扩展按块读取，不把整个文件留在内存里 */
export const FILE_UPLOAD_STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024
/** 传输无进展的判定时长 */
export const FILE_UPLOAD_IDLE_TIMEOUT_MS = 15_000
export const FILE_TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
export const FILE_SHA256_PATTERN = /^[a-f0-9]{64}$/
/** 空文件没有合法的字节区间，约定 bytes 0-0/0 表示"零字节确认" */
export const EMPTY_FILE_CONTENT_RANGE = 'bytes 0-0/0'
/** 分段摘要头：relay 校验通过后才确认这段字节的偏移 */
export const FILE_UPLOAD_CHUNK_SHA256_HEADER = 'x-file-chunk-sha256'
/** 最后一段的标记头 */
export const FILE_UPLOAD_COMPLETE_HEADER = 'x-file-complete'

/** 生成 Content-Range 头；零字节文件走专门的确认形式 */
export function fileContentRange(offset: number, totalBytes: number): string {
  if (totalBytes === 0) return EMPTY_FILE_CONTENT_RANGE
  const end = Math.min(offset + FILE_UPLOAD_CHUNK_BYTES, totalBytes) - 1
  return `bytes ${offset}-${end}/${totalBytes}`
}

/**
 * 生成指定长度的 Content-Range。断点续传时只覆盖当前保留块的剩余部分，
 * 长度由调用方决定而不是固定分段大小。
 */
export function fileByteRange(offset: number, length: number, totalBytes: number): string {
  if (length <= 0) return EMPTY_FILE_CONTENT_RANGE
  return `bytes ${offset}-${offset + length - 1}/${totalBytes}`
}
