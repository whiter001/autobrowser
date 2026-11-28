/** build:chrome 产出的 pdf.js 资产位置；扩展与构建脚本共用，避免两边路径漂移。 */
export const PDFJS_VENDOR_DIR = 'vendor/pdfjs'

/** 主线程版 pdf.js（IIFE，暴露 globalThis.pdfjsLib）。 */
export const PDFJS_LIB_FILENAME = 'pdf.min.js'

/** worker 脚本；同时用于 GlobalWorkerOptions.workerSrc 与主线程 fake worker 兜底。 */
export const PDFJS_WORKER_FILENAME = 'pdf.worker.min.js'

/**
 * 原始 PDF 字节的下载上限。
 *
 * 读 PDF 只需要文本层，但仍必须给下载一个硬上限：大文件会把命令预算和
 * 扩展内存一起拖垮，而 read_page 的目标不是当下载器。
 */
export const READ_PAGE_PDF_MAX_BYTES = 20 * 1024 * 1024
