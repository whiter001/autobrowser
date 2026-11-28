import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs'

/**
 * pdf.js 的 fake worker 会优先读取 globalThis.pdfjsWorker。
 *
 * 扩展页与内建 PDF 视图器属于不同的 chrome-extension:// origin，
 * 页面里无法用我们的 worker URL 直接 new Worker；把 worker 代码注入 MAIN world
 * 后，pdf.js 在主线程完成解析，不依赖页面 CSP 放行 worker。
 */
;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = { WorkerMessageHandler }
