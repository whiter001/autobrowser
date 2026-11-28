import {
  READ_PAGE_AMBIGUOUS_FRAME_CODE,
  READ_PAGE_PDF_INIT_TIMEOUT_MS,
  READ_PAGE_PDF_UNAVAILABLE_CODE,
  type ReadPagePdfStatus,
} from '../../src/core/read-page.js'
import {
  PDFJS_LIB_FILENAME,
  PDFJS_VENDOR_DIR,
  PDFJS_WORKER_FILENAME,
  READ_PAGE_PDF_MAX_BYTES,
} from '../../src/core/pdfjs-assets.js'

/** PDF 视图器在页面里暴露的最小接口；只用到取文本必需的部分。 */
export interface PdfViewerLike {
  pdfDocument?: PdfDocumentLike | null
  pdfPasswordRequired?: boolean
  pdfPendingPrompts?: unknown[]
  _passwordPrompted?: boolean
}

export interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items?: PdfTextItem[] }>
}

export interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

export interface PdfViewerCollectResult {
  status: ReadPagePdfStatus
  pages: number
  pagesRead: number
  text: string
  truncated?: boolean
  /** 命中命令总预算而提前停止。 */
  timedOut?: boolean
  reason?: string
}

/** 原始字节回退的来源；只在视图器不可达时由后台补齐。 */
export interface PdfBytesSource {
  /** 原始 PDF 的 HTTP(S) URL（从 tab/frame URL 或视图器的 file= 参数解出）。 */
  url: string
  /** chrome.runtime.getURL 给出的 worker 地址。 */
  workerUrl: string
  maxBytes: number
}

export interface PdfCollectOptions {
  maxPages: number
  maxChars: number
  initTimeoutMs: number
  maxDurationMs: number
  /** 提供后，视图器不可达时在页面里下载原始字节并用注入的 pdf.js 解析。 */
  source?: PdfBytesSource
}

interface PdfJsLibraryLike {
  GlobalWorkerOptions?: { workerSrc?: string }
  getDocument(params: Record<string, unknown>): {
    promise: Promise<PdfDocumentLike>
    destroy?: () => Promise<void>
  }
}

/**
 * 在 PDF 页面（MAIN world）里逐页抽取文本。
 *
 * 必须自包含：chrome.scripting.executeScript 只注入函数本身，
 * 引用模块作用域会在页面里变成 undefined。视图器路径与原始字节路径
 * 共用同一个逐页循环，避免两份实现漂移。
 */
export async function collectPdfViewerText(
  options: PdfCollectOptions,
): Promise<PdfViewerCollectResult> {
  const scope = globalThis as unknown as {
    PDFViewerApplication?: PdfViewerLike
    pdfjsLib?: PdfJsLibraryLike
  }
  const viewer = scope.PDFViewerApplication
  const startedAt = Date.now()
  // executeScript 只注入函数本体，模块作用域不可见：默认值一律写字面量。
  const maxPages =
    typeof options?.maxPages === 'number' && options.maxPages > 0 ? options.maxPages : 5_000
  const maxChars =
    typeof options?.maxChars === 'number' && options.maxChars > 0 ? options.maxChars : 4_000_000
  const initTimeoutMs =
    typeof options?.initTimeoutMs === 'number' && options.initTimeoutMs >= 0
      ? options.initTimeoutMs
      : 4_000
  const maxDurationMs =
    typeof options?.maxDurationMs === 'number' && Number.isFinite(options.maxDurationMs)
      ? Math.max(0, options.maxDurationMs)
      : Number.POSITIVE_INFINITY
  const source = options?.source

  const unavailable = (reason: string): PdfViewerCollectResult => ({
    status: 'unavailable',
    pages: 0,
    pagesRead: 0,
    text: '',
    reason,
  })
  const viewerUnreachable = (): PdfViewerCollectResult =>
    unavailable('PDFViewerApplication is not reachable in this frame')
  const isPasswordError = (error: unknown): boolean => {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    return /password/i.test(`${name} ${message}`)
  }

  let pdfDocument: PdfDocumentLike | null = null
  let loadingTask: ReturnType<PdfJsLibraryLike['getDocument']> | undefined

  if (viewer) {
    const isPasswordRequired = (): boolean =>
      viewer.pdfPasswordRequired === true ||
      viewer._passwordPrompted === true ||
      (Array.isArray(viewer.pdfPendingPrompts) && viewer.pdfPendingPrompts.length > 0)

    // 密码保护的 PDF 不会产出 pdfDocument，先判定可以省掉整个初始化等待。
    if (isPasswordRequired()) {
      return {
        status: 'password',
        pages: 0,
        pagesRead: 0,
        text: '',
        reason: 'the PDF is password protected',
      }
    }

    // 视图器已挂载但文档还没就绪时，最多等 initTimeoutMs；超时就按 loading 返回，
    // 不能让一次读取无限期挂住命令预算。
    const initDeadline = startedAt + Math.min(initTimeoutMs, maxDurationMs)
    while (!viewer.pdfDocument && Date.now() < initDeadline) {
      if (isPasswordRequired()) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    if (!viewer.pdfDocument) {
      const passwordRequired = isPasswordRequired()
      return {
        status: passwordRequired ? 'password' : 'loading',
        pages: 0,
        pagesRead: 0,
        text: '',
        reason: passwordRequired
          ? 'the PDF is password protected'
          : 'the PDF document was not ready before the deadline',
      }
    }
    pdfDocument = viewer.pdfDocument
  } else if (source) {
    const library = scope.pdfjsLib
    if (!library || typeof library.getDocument !== 'function') {
      return unavailable('pdf.js was not injected into this frame')
    }
    if (library.GlobalWorkerOptions && source.workerUrl) {
      library.GlobalWorkerOptions.workerSrc = source.workerUrl
    }

    const maxBytes =
      typeof source.maxBytes === 'number' && source.maxBytes > 0
        ? source.maxBytes
        : 20 * 1024 * 1024
    const deadlineAt = startedAt + maxDurationMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(
      () => {
        timedOut = true
        controller.abort()
      },
      Math.max(1, maxDurationMs),
    )

    let bytes: Uint8Array
    try {
      const response = await fetch(source.url, {
        credentials: 'include',
        signal: controller.signal,
        redirect: 'follow',
      })
      // 只接受完整的 200：206/重定向页都可能不是完整 PDF。
      if (response.status !== 200) {
        return unavailable(`the PDF download returned HTTP ${response.status}`)
      }
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        return {
          status: 'too_large',
          pages: 0,
          pagesRead: 0,
          text: '',
          reason: `the PDF is larger than the ${maxBytes} byte download limit`,
        }
      }
      if (!response.body) return unavailable('the PDF response has no body')

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        const chunk = next.value
        if (!chunk) continue
        total += chunk.byteLength
        if (total > maxBytes) {
          try {
            await reader.cancel()
          } catch {
            // 取消失败不改变超限结论。
          }
          return {
            status: 'too_large',
            pages: 0,
            pagesRead: 0,
            text: '',
            reason: `the PDF stream exceeded the ${maxBytes} byte download limit`,
          }
        }
        chunks.push(chunk)
      }

      if (total === 0) return unavailable('the PDF response was empty')
      bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const probe = new TextDecoder('latin1').decode(
        bytes.subarray(0, Math.min(1024, bytes.length)),
      )
      if (!probe.includes('%PDF-')) {
        return unavailable('the response is not a PDF file (missing the %PDF- header)')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        return {
          ...unavailable('the PDF download did not finish before the deadline'),
          timedOut: true,
        }
      }
      return unavailable(`failed to download the PDF: ${message}`)
    } finally {
      clearTimeout(timer)
    }

    try {
      loadingTask = library.getDocument({
        data: bytes,
        // 不执行 PDF 内嵌的 JavaScript/字体求值；只取文本层。
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        verbosity: 0,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return unavailable(`failed to open the PDF: ${message}`)
    }

    let parseTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const remaining = Math.max(0, deadlineAt - Date.now())
      const parseTimeout = new Promise<never>((_resolve, reject) => {
        parseTimer = setTimeout(
          () => reject(new Error('the PDF parser did not finish before the deadline')),
          remaining,
        )
      })
      pdfDocument = await Promise.race([loadingTask.promise, parseTimeout])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await loadingTask.destroy?.()
      } catch {
        // 清理失败不覆盖真正的解析错误。
      }
      if (isPasswordError(error)) {
        return {
          status: 'password',
          pages: 0,
          pagesRead: 0,
          text: '',
          reason: 'the PDF is password protected',
        }
      }
      if (/deadline/i.test(message)) {
        return { ...unavailable(message), timedOut: true }
      }
      return unavailable(`failed to parse the PDF: ${message}`)
    } finally {
      if (parseTimer) clearTimeout(parseTimer)
    }
  } else {
    return viewerUnreachable()
  }

  const document = pdfDocument
  try {
    const totalPages = Number(document.numPages) || 0
    if (totalPages > maxPages) {
      return {
        status: 'too_large',
        pages: totalPages,
        pagesRead: 0,
        text: '',
        reason: `the PDF has ${totalPages} pages, above the ${maxPages} page limit`,
      }
    }

    const chunks: string[] = []
    let pagesRead = 0
    let hasText = false
    let truncated = false
    let timedOut = false
    let length = 0

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      // 命令总预算到期就带着已读到的部分返回，避免大 PDF 把命令拖到 relay 超时。
      if (Date.now() - startedAt >= maxDurationMs) {
        timedOut = true
        break
      }
      let page: PdfPageLike
      try {
        page = await document.getPage(pageNumber)
      } catch (error) {
        if (isPasswordError(error)) {
          return {
            status: 'password',
            pages: totalPages,
            pagesRead,
            text: chunks.join(''),
            reason: 'the PDF is password protected',
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          status: 'unavailable',
          pages: totalPages,
          pagesRead,
          text: chunks.join(''),
          reason: `failed to read page ${pageNumber}: ${message}`,
        }
      }

      let content: { items?: PdfTextItem[] }
      try {
        content = await page.getTextContent()
      } catch (error) {
        if (isPasswordError(error)) {
          return {
            status: 'password',
            pages: totalPages,
            pagesRead,
            text: chunks.join(''),
            reason: 'the PDF is password protected',
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          status: 'unavailable',
          pages: totalPages,
          pagesRead,
          text: chunks.join(''),
          reason: `failed to read the text layer of page ${pageNumber}: ${message}`,
        }
      }

      let pageText = ''
      const items = Array.isArray(content?.items) ? content.items : []
      for (const item of items) {
        const value = typeof item?.str === 'string' ? item.str : ''
        if (!value) continue
        pageText += value
        if (item?.hasEOL) pageText += '\n'
      }

      pagesRead += 1
      if (pageText.trim()) hasText = true

      // 页码标记让读者知道每段文字来自哪一页；分页续读时也能对齐。
      const block = `[page ${pageNumber}/${totalPages}]\n${pageText}${pageText.endsWith('\n') || !pageText ? '' : '\n'}`
      chunks.push(block)
      length += block.length
      if (length > maxChars) {
        truncated = true
        break
      }
    }

    let text = chunks.join('')
    if (timedOut) {
      return {
        status: 'ok',
        pages: totalPages,
        pagesRead,
        text,
        truncated: true,
        timedOut: true,
        reason: 'the PDF read hit the command budget before all pages were read',
      }
    }
    if (truncated) {
      // 截断不能切开代理对，否则落盘后会出现半个字符。
      if (text.length > maxChars) {
        text = text.slice(0, maxChars)
        const last = text.charCodeAt(text.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, text.length - 1)
      }
      return {
        status: 'ok',
        pages: totalPages,
        pagesRead,
        text,
        truncated: true,
        reason: 'the extracted PDF text exceeded the capture limit',
      }
    }

    if (!hasText) {
      return {
        status: 'no_text',
        pages: totalPages,
        pagesRead,
        text: '',
        reason: 'the PDF has no text layer',
      }
    }

    return { status: 'ok', pages: totalPages, pagesRead, text }
  } finally {
    // 只有原始字节路径会创建 loadingTask；视图器的文档由页面自己管理。
    if (loadingTask) {
      try {
        const destroy = (document as unknown as { destroy?: () => Promise<void> }).destroy
        if (typeof destroy === 'function') await destroy.call(document)
      } catch {
        // 文档已读出的文本不受销毁失败影响。
      }
      try {
        await loadingTask.destroy?.()
      } catch {
        // 同上。
      }
    }
  }
}

/** 注入脚本的目标：frameIds 与 documentIds 互斥，documentId 才能唯一定位 frame。 */
export interface PdfInjectionTarget {
  tabId: number
  frameIds?: number[]
  documentIds?: string[]
  allFrames?: boolean
}

export interface PdfInjectionResult<TResult = unknown> {
  frameId: number
  result: TResult | undefined
}

export interface PdfFrameInfo {
  frameId: number
  parentFrameId: number
  url: string
  documentId: string
}

export interface PdfScriptInjection<TArgs extends unknown[], TResult> {
  target: PdfInjectionTarget
  world: 'MAIN'
  func: (...args: TArgs) => TResult | Promise<TResult>
  args: TArgs
}

export interface PdfFileInjection {
  target: PdfInjectionTarget
  world: 'MAIN'
  files: string[]
}

/**
 * 浏览器 API 封装：抽出接口后测试可以注入假实现，
 * 不必依赖真实的 chrome.scripting / chrome.webNavigation。
 */
export interface PdfBrowserApi {
  executeScript<TArgs extends unknown[], TResult>(
    injection: PdfScriptInjection<TArgs, TResult>,
  ): Promise<PdfInjectionResult<TResult>[]>
  executeScriptFiles(injection: PdfFileInjection): Promise<unknown>
  getAllFrames(details: { tabId: number }): Promise<PdfFrameInfo[]>
  /** 扩展内资源的绝对 URL；pdf.js 与 worker 都由扩展包提供。 */
  getExtensionUrl(relativePath: string): string
}

/** chrome.runtime.getURL 的结果转回 executeScript 需要的扩展相对路径。 */
export function extensionRelativePath(url: string): string {
  const prefix = 'chrome-extension://'
  if (!url.startsWith(prefix)) return url
  const slash = url.indexOf('/', prefix.length)
  return slash >= 0 ? url.slice(slash + 1) : ''
}

/** 生产环境的 Chrome API 适配。 */
export function createDefaultPdfBrowserApi(): PdfBrowserApi {
  return {
    executeScript: async <TArgs extends unknown[], TResult>(
      injection: PdfScriptInjection<TArgs, TResult>,
    ): Promise<PdfInjectionResult<TResult>[]> => {
      const results = await chrome.scripting.executeScript(
        injection as unknown as chrome.scripting.ScriptInjection<TArgs, TResult>,
      )
      return (results ?? []) as unknown as PdfInjectionResult<TResult>[]
    },
    executeScriptFiles: async (injection) => {
      await chrome.scripting.executeScript({
        target: injection.target,
        world: injection.world,
        files: injection.files.map(extensionRelativePath),
      } as unknown as chrome.scripting.ScriptInjection<[], unknown>)
    },
    getAllFrames: async (details) => {
      const frames = await chrome.webNavigation.getAllFrames(details)
      return (frames ?? []) as unknown as PdfFrameInfo[]
    },
    getExtensionUrl: (relativePath) => chrome.runtime.getURL(relativePath),
  }
}

/** Chrome 内置 PDF 视图器的 frame：URL 形如 chrome-extension://<id>/index.html?file=... */
function isPdfViewerFrame(url: string): boolean {
  return /^chrome-extension:\/\/[^/]+\/index\.html\?file=/i.test(String(url || ''))
}

export interface PdfSourceResolution {
  url: string | null
  reason?: string
}

/**
 * 从 frame URL 解析可下载的原始 PDF 地址。
 *
 * 顶层原生 PDF 的 frame URL 就是 PDF 本身；命中 Chrome 视图器时，
 * 真正的文件地址在 ?file= 里（需要 URL 解码）。只有 HTTP(S) 能回退，
 * 其他协议明确不可用，避免把本地文件或 blob 当成可下载资源。
 */
export function resolvePdfSourceUrl(frameUrl: string): PdfSourceResolution {
  const value = String(frameUrl || '').trim()
  if (!value) return { url: null, reason: 'the PDF URL is unknown for this frame' }
  if (/^https?:\/\//i.test(value)) return { url: value }

  if (/^chrome-extension:\/\//i.test(value)) {
    let file: string | null = null
    try {
      file = new URL(value).searchParams.get('file')
    } catch {
      file = null
    }
    if (!file) return { url: null, reason: 'the PDF viewer URL has no file parameter' }
    if (/^https?:\/\//i.test(file)) return { url: file }
    return {
      url: null,
      reason:
        'the PDF viewer points at a non-HTTP(S) resource; autobrowser only downloads PDFs over HTTP(S)',
    }
  }

  let protocol = ''
  try {
    protocol = new URL(value).protocol
  } catch {
    protocol = ''
  }
  return {
    url: null,
    reason: `autobrowser can only download raw PDF bytes over HTTP(S), not ${protocol || 'this URL'}`,
  }
}

export interface PdfReadRequest {
  tabId: number
  /** 目标 frame 的选择器；为空表示顶层 frame。 */
  frameSelector: string | null
  /** 目标 frame 的 src（由 resolveFrameTarget 解析得到）。 */
  frameSrc: string | null
  /** 标签页 URL；frame 列表缺项时作为顶层 PDF 地址的兜底。 */
  tabUrl?: string
  /** 剩余预算（毫秒）。 */
  remainingMs: number
  maxPages: number
  captureLimit: number
}

export interface PdfReadOutcome {
  status: ReadPagePdfStatus
  text: string
  pages: number
  pagesRead: number
  truncated: boolean
  /** 命中命令总预算而提前停止。 */
  timedOut: boolean
  reason?: string
  /** 读取期间文档身份发生变化（URL 或 documentId 变了）。 */
  documentChanged: boolean
}

export interface PdfFeatureDependencies {
  browser: PdfBrowserApi
}

/**
 * 创建 PDF 读取域：优先走 PDF 视图器；顶层原生 PDF 取不到视图器时，
 * 回退为「原始字节 + 注入的 pdf.js」。
 */
export function createPdfFeature({ browser }: PdfFeatureDependencies) {
  async function listFrames(tabId: number): Promise<PdfFrameInfo[]> {
    try {
      return await browser.getAllFrames({ tabId })
    } catch {
      return []
    }
  }

  /**
   * 解析注入目标。
   *
   * 顶层优先用 frameId 0；frame 里必须靠 URL 找到唯一的 documentId，
   * 同名 URL 出现在多个 frame 时无法判定，直接报 AMBIGUOUS_FRAME 而不是猜一个。
   */
  async function resolveInjectionTarget(
    request: PdfReadRequest,
  ): Promise<{ target: PdfInjectionTarget; frameUrl: string }> {
    const frames = await listFrames(request.tabId)

    if (request.frameSelector) {
      const src = request.frameSrc ?? ''
      const matches = frames.filter((frame) => frame.url === src)
      if (matches.length > 1) {
        const error = new Error(
          `cannot locate the PDF frame: ${matches.length} frames share the URL ${src}`,
        ) as Error & { code?: string; suggestedAction?: string; details?: unknown }
        error.code = READ_PAGE_AMBIGUOUS_FRAME_CODE
        error.details = { url: src, frameIds: matches.map((frame) => frame.frameId) }
        error.suggestedAction =
          'Point --frame at a unique frame (or use the top-level PDF), then run read_page again; autobrowser will not guess between same-URL frames.'
        throw error
      }
      if (matches.length === 1) {
        return {
          target: { tabId: request.tabId, documentIds: [matches[0]!.documentId] },
          frameUrl: matches[0]!.url,
        }
      }
      // frame 的 src 没有直接命中时，Chrome 内置 PDF 视图器仍可能承载着这份 PDF。
      const viewerFrames = frames.filter((frame) => isPdfViewerFrame(frame.url))
      if (viewerFrames.length === 1) {
        return {
          target: { tabId: request.tabId, documentIds: [viewerFrames[0]!.documentId] },
          frameUrl: viewerFrames[0]!.url,
        }
      }
      const error = new Error(
        `cannot locate the PDF frame for ${src || '(unknown src)'}: no matching frame in the tab`,
      ) as Error & { code?: string; suggestedAction?: string; details?: unknown }
      error.code = READ_PAGE_PDF_UNAVAILABLE_CODE
      error.details = { url: src || null }
      error.suggestedAction =
        'Open the PDF in a top-level tab, or point --frame at the frame that shows the PDF, then run read_page again.'
      throw error
    }

    // 顶层：先找 Chrome 的 PDF 视图器 frame；找不到就用 frameId 0。
    // Chrome 158 的原生 PDF 顶层页面只有顶层 frame，PDFViewerApplication 不在 MAIN world，
    // 这时 frameUrl 就是 PDF 本身，交给原始字节回退。
    const viewerFrames = frames.filter((frame) => isPdfViewerFrame(frame.url))
    if (viewerFrames.length === 1) {
      return {
        target: { tabId: request.tabId, documentIds: [viewerFrames[0]!.documentId] },
        frameUrl: viewerFrames[0]!.url,
      }
    }
    const topFrame = frames.find((frame) => frame.frameId === 0)
    return {
      target: { tabId: request.tabId, frameIds: [0] },
      frameUrl: topFrame?.url || request.tabUrl || '',
    }
  }

  function outcomeOf(collected: PdfViewerCollectResult, documentChanged: boolean): PdfReadOutcome {
    return {
      status: collected.status,
      text: collected.text ?? '',
      pages: collected.pages ?? 0,
      pagesRead: collected.pagesRead ?? 0,
      truncated: collected.truncated === true,
      timedOut: collected.timedOut === true,
      ...(collected.reason ? { reason: collected.reason } : {}),
      documentChanged,
    }
  }

  /**
   * 原始字节回退。
   *
   * 先注入 pdf.js 主库与 worker，再用同一套逐页抽取函数执行。任何一步失败
   * 都返回 unavailable（带 reason），不能退回 DOM 把视图器外壳当成 PDF 正文。
   */
  async function readRawPdfBytes(
    target: PdfInjectionTarget,
    frameUrl: string,
    collectOptions: PdfCollectOptions,
  ): Promise<PdfViewerCollectResult> {
    const resolution = resolvePdfSourceUrl(frameUrl)
    if (!resolution.url) {
      return {
        status: 'unavailable',
        pages: 0,
        pagesRead: 0,
        text: '',
        reason: resolution.reason,
      }
    }

    const files = [PDFJS_LIB_FILENAME, PDFJS_WORKER_FILENAME].map((name) =>
      browser.getExtensionUrl(`${PDFJS_VENDOR_DIR}/${name}`),
    )
    const workerUrl = browser.getExtensionUrl(`${PDFJS_VENDOR_DIR}/${PDFJS_WORKER_FILENAME}`)

    try {
      await browser.executeScriptFiles({ target, world: 'MAIN', files })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 'unavailable',
        pages: 0,
        pagesRead: 0,
        text: '',
        reason: `failed to inject pdf.js into the PDF frame: ${message}`,
      }
    }

    try {
      const results = await browser.executeScript({
        target,
        world: 'MAIN',
        func: collectPdfViewerText,
        args: [
          {
            ...collectOptions,
            source: {
              url: resolution.url,
              workerUrl,
              maxBytes: READ_PAGE_PDF_MAX_BYTES,
            },
          },
        ],
      })
      const collected = results.find((entry) => Boolean(entry.result?.status))?.result
      if (collected) return collected
      return {
        status: 'unavailable',
        pages: 0,
        pagesRead: 0,
        text: '',
        reason: 'the PDF parser returned no result',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 'unavailable',
        pages: 0,
        pagesRead: 0,
        text: '',
        reason: `failed to parse the PDF bytes: ${message}`,
      }
    }
  }

  async function readPdf(request: PdfReadRequest): Promise<PdfReadOutcome> {
    const { target, frameUrl } = await resolveInjectionTarget(request)
    const initTimeoutMs = Math.max(
      0,
      Math.min(READ_PAGE_PDF_INIT_TIMEOUT_MS, Math.max(0, request.remainingMs - 500)),
    )
    const args: PdfCollectOptions = {
      maxPages: request.maxPages,
      maxChars: request.captureLimit,
      initTimeoutMs,
      maxDurationMs: Math.max(0, request.remainingMs),
    }

    let results: PdfInjectionResult<PdfViewerCollectResult>[]
    try {
      results = await browser.executeScript({
        target,
        world: 'MAIN',
        func: collectPdfViewerText,
        args: [args],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = new Error(`failed to reach the PDF viewer: ${message}`) as Error & {
        code?: string
        suggestedAction?: string
        details?: unknown
      }
      failure.code = READ_PAGE_PDF_UNAVAILABLE_CODE
      failure.details = { tabId: request.tabId }
      failure.suggestedAction =
        'Open the PDF directly in a top-level tab and run read_page again; autobrowser will not fall back to reading the viewer DOM as if it were the PDF.'
      throw failure
    }

    let collected = results
      .map((entry) => entry.result)
      .find((entry): entry is PdfViewerCollectResult => Boolean(entry?.status))

    // 视图器不可达（顶层原生 PDF 的典型情况）时改用原始字节解析。
    // 其他 unavailable（例如中途读页失败）保留原错误，不重复下载。
    const viewerUnreachable =
      !collected ||
      (collected.status === 'unavailable' &&
        /PDFViewerApplication is not reachable/i.test(collected.reason ?? ''))
    if (viewerUnreachable) {
      collected = await readRawPdfBytes(target, frameUrl, args)
    }
    if (!collected) {
      collected = {
        status: 'unavailable',
        pages: 0,
        pagesRead: 0,
        text: '',
        reason: 'the PDF viewer returned no result',
      }
    }

    const framesAfter = await listFrames(request.tabId)
    const documentChanged = detectDocumentChange(framesAfter, target, frameUrl)

    return outcomeOf(collected, documentChanged)
  }

  return { readPdf }
}

/**
 * 判断读取期间文档身份是否变化：目标 documentId 不在了，或顶层 frame 的 URL 变了。
 *
 * frame 列表为空说明 webNavigation 没给出任何信息（不是「文档被换掉」），
 * 这种情况下不能断言发生了变化。
 */
export function detectDocumentChange(
  frames: PdfFrameInfo[],
  target: PdfInjectionTarget,
  previousUrl: string,
): boolean {
  if (frames.length === 0) return false
  if (target.documentIds && target.documentIds.length > 0) {
    return !frames.some((frame) => target.documentIds!.includes(frame.documentId))
  }
  const topFrame = frames.find((frame) => frame.frameId === 0)
  if (!topFrame) return true
  return previousUrl ? topFrame.url !== previousUrl : false
}
