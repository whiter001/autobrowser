import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPageObserveDomain } from '../extension/background/page-observe.js'
import {
  collectPdfViewerText,
  detectDocumentChange,
  extensionRelativePath,
  resolvePdfSourceUrl,
  type PdfBrowserApi,
  type PdfCollectOptions,
  type PdfFrameInfo,
  type PdfInjectionResult,
  type PdfScriptInjection,
} from '../extension/background/page-observe-pdf.js'
import { runCli } from './command-line-test-utils.js'

interface FakeViewerOptions {
  /** 每页的文本行；每行会作为带换行的文本项返回。 */
  pages?: string[][]
  numPages?: number
  passwordRequired?: boolean
  failWith?: Error
}

/** 轻量假 PDF 文档：只实现取文本真正用到的 getPage/getTextContent。 */
function createFakeViewer(options: FakeViewerOptions = {}) {
  const pages = options.pages ?? []
  return {
    pdfPasswordRequired: options.passwordRequired === true,
    pdfDocument: options.passwordRequired
      ? null
      : {
          numPages: options.numPages ?? pages.length,
          getPage: async (pageNumber: number) => {
            if (options.failWith) throw options.failWith
            const items = (pages[pageNumber - 1] ?? []).map((str) => ({ str, hasEOL: true }))
            return { getTextContent: async () => ({ items }) }
          },
        },
  }
}

interface FakePdfLibOptions extends FakeViewerOptions {
  /** getDocument 的 promise 直接拒绝，用来模拟 PasswordException。 */
  rejectWith?: Error
}

function createFakePdfLib(options: FakePdfLibOptions = {}) {
  const viewer = createFakeViewer(options)
  const workerOptions = { workerSrc: '' }
  const documents: Array<Record<string, unknown>> = []
  let destroyed = 0
  const lib = {
    GlobalWorkerOptions: workerOptions,
    getDocument: (params: Record<string, unknown>) => {
      documents.push(params)
      return {
        promise: options.rejectWith
          ? Promise.reject(options.rejectWith)
          : Promise.resolve({
              ...viewer.pdfDocument,
              destroy: async () => {
                destroyed += 1
              },
            }),
        destroy: async () => {
          destroyed += 1
        },
      }
    },
  }
  return { lib, workerOptions, documents, destroyed: () => destroyed }
}

type GlobalOverrides = {
  viewer?: unknown
  pdfjsLib?: unknown
  fetch?: unknown
}

async function withGlobals<TValue>(
  overrides: GlobalOverrides,
  run: () => Promise<TValue>,
): Promise<TValue> {
  const scope = globalThis as unknown as Record<string, unknown>
  const keys = ['PDFViewerApplication', 'pdfjsLib', 'fetch'] as const
  const previous = keys.map((key) => scope[key])
  if ('viewer' in overrides) scope.PDFViewerApplication = overrides.viewer
  else delete scope.PDFViewerApplication
  if ('pdfjsLib' in overrides) scope.pdfjsLib = overrides.pdfjsLib
  else delete scope.pdfjsLib
  if ('fetch' in overrides) scope.fetch = overrides.fetch
  try {
    return await run()
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete scope[key]
      else scope[key] = previous[index]
    })
  }
}

function pdfBytes(text = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'): Uint8Array {
  return new TextEncoder().encode(text)
}

function chunkedResponse(
  chunks: Uint8Array[],
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, {
    status: options.status ?? 200,
    headers: options.headers,
  })
}

const baseCollectOptions: PdfCollectOptions = {
  maxPages: 100,
  maxChars: 10_000,
  initTimeoutMs: 0,
  maxDurationMs: 10_000,
}

const sourceOptions = {
  url: 'https://example.com/doc.pdf',
  workerUrl: 'chrome-extension://testid/vendor/pdfjs/pdf.worker.min.js',
  maxBytes: 20 * 1024 * 1024,
}

describe('PDF 文本抽取（MAIN world 函数）', () => {
  test('逐页抽取文本并保留 [page N/M] 标记', async () => {
    const result = await withGlobals(
      { viewer: createFakeViewer({ pages: [['Hello'], ['World']] }) },
      () => collectPdfViewerText(baseCollectOptions),
    )

    expect(result.status).toBe('ok')
    expect(result.pages).toBe(2)
    expect(result.pagesRead).toBe(2)
    expect(result.text).toBe('[page 1/2]\nHello\n[page 2/2]\nWorld\n')
  })

  test('没有文本层时报告 no_text 而不是假装读完', async () => {
    const result = await withGlobals({ viewer: createFakeViewer({ pages: [[], []] }) }, () =>
      collectPdfViewerText(baseCollectOptions),
    )

    expect(result.status).toBe('no_text')
    expect(result.text).toBe('')
    expect(result.pagesRead).toBe(2)
  })

  test('密码保护时报告 password', async () => {
    const result = await withGlobals({ viewer: createFakeViewer({ passwordRequired: true }) }, () =>
      collectPdfViewerText(baseCollectOptions),
    )

    expect(result.status).toBe('password')
    expect(result.reason).toContain('password')
  })

  test('取页时抛出 PasswordException 同样报告 password', async () => {
    const failure = new Error('password required')
    failure.name = 'PasswordException'
    const result = await withGlobals(
      { viewer: createFakeViewer({ failWith: failure, numPages: 1 }) },
      () => collectPdfViewerText(baseCollectOptions),
    )

    expect(result.status).toBe('password')
  })

  test('文档未就绪时报告 loading', async () => {
    const result = await withGlobals({ viewer: { pdfDocument: null } }, () =>
      collectPdfViewerText(baseCollectOptions),
    )

    expect(result.status).toBe('loading')
  })

  test('页数超过硬上限时报告 too_large', async () => {
    const result = await withGlobals(
      { viewer: createFakeViewer({ numPages: 900, pages: [] }) },
      () => collectPdfViewerText(baseCollectOptions),
    )

    expect(result.status).toBe('too_large')
    expect(result.pages).toBe(900)
  })

  test('视图器不可达时报告 unavailable', async () => {
    const result = await withGlobals({ viewer: undefined }, () =>
      collectPdfViewerText(baseCollectOptions),
    )

    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('PDFViewerApplication')
  })

  test('文本超过捕获上限时截断并标记 truncated', async () => {
    const result = await withGlobals(
      { viewer: createFakeViewer({ pages: [['0123456789'], ['abcdefghij']] }) },
      () => collectPdfViewerText({ ...baseCollectOptions, maxChars: 25 }),
    )

    expect(result.status).toBe('ok')
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(25)
  })
})

describe('原始 PDF 字节回退（MAIN world 函数）', () => {
  test('按登录态 fetch 原始字节并逐页抽取', async () => {
    const fake = createFakePdfLib({ pages: [['Hello'], ['World']] })
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const result = await withGlobals(
      {
        viewer: undefined,
        pdfjsLib: fake.lib,
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ url, init })
          return chunkedResponse([pdfBytes()])
        },
      },
      () =>
        collectPdfViewerText({
          ...baseCollectOptions,
          source: sourceOptions,
        }),
    )

    expect(result.status).toBe('ok')
    expect(result.text).toBe('[page 1/2]\nHello\n[page 2/2]\nWorld\n')
    expect(requests[0]?.url).toBe(sourceOptions.url)
    expect(requests[0]?.init?.credentials).toBe('include')
    expect(fake.workerOptions.workerSrc).toBe(sourceOptions.workerUrl)
    expect(fake.documents[0]?.isEvalSupported).toBe(false)
    expect(fake.destroyed()).toBeGreaterThan(0)
  })

  test('无文本层时走同一套 no_text 语义', async () => {
    const fake = createFakePdfLib({ pages: [[], []] })
    const result = await withGlobals(
      { viewer: undefined, pdfjsLib: fake.lib, fetch: async () => chunkedResponse([pdfBytes()]) },
      () => collectPdfViewerText({ ...baseCollectOptions, source: sourceOptions }),
    )

    expect(result.status).toBe('no_text')
    expect(result.pagesRead).toBe(2)
  })

  test('非 200 响应返回 unavailable 且不进入 pdf.js', async () => {
    const fake = createFakePdfLib({ pages: [['never']] })
    const result = await withGlobals(
      {
        viewer: undefined,
        pdfjsLib: fake.lib,
        fetch: async () => chunkedResponse([pdfBytes()], { status: 403 }),
      },
      () => collectPdfViewerText({ ...baseCollectOptions, source: sourceOptions }),
    )

    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('HTTP 403')
    expect(fake.documents.length).toBe(0)
  })

  test('响应不是 PDF 时返回 unavailable', async () => {
    const fake = createFakePdfLib({ pages: [['never']] })
    const result = await withGlobals(
      {
        viewer: undefined,
        pdfjsLib: fake.lib,
        fetch: async () =>
          chunkedResponse([new TextEncoder().encode('<html>login required</html>')]),
      },
      () => collectPdfViewerText({ ...baseCollectOptions, source: sourceOptions }),
    )

    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('%PDF-')
    expect(fake.documents.length).toBe(0)
  })

  test('content-length 超过 20MiB 上限时返回 too_large', async () => {
    const fake = createFakePdfLib({ pages: [['never']] })
    const result = await withGlobals(
      {
        viewer: undefined,
        pdfjsLib: fake.lib,
        fetch: async () =>
          chunkedResponse([pdfBytes()], {
            headers: { 'content-length': String(21 * 1024 * 1024) },
          }),
      },
      () =>
        collectPdfViewerText({
          ...baseCollectOptions,
          source: { ...sourceOptions, maxBytes: 1024 },
        }),
    )

    expect(result.status).toBe('too_large')
    expect(fake.documents.length).toBe(0)
  })

  test('content-length 缺失但实际读取超限时同样返回 too_large', async () => {
    const fake = createFakePdfLib({ pages: [['never']] })
    const result = await withGlobals(
      {
        viewer: undefined,
        pdfjsLib: fake.lib,
        fetch: async () =>
          chunkedResponse([pdfBytes(), new Uint8Array(64).fill(0x20), new Uint8Array(64)]),
      },
      () =>
        collectPdfViewerText({
          ...baseCollectOptions,
          source: { ...sourceOptions, maxBytes: 48 },
        }),
    )

    expect(result.status).toBe('too_large')
    expect(result.reason).toContain('stream')
    expect(fake.documents.length).toBe(0)
  })

  test('PasswordException 映射为 password 而不是解析失败', async () => {
    const failure = new Error('No password given')
    failure.name = 'PasswordException'
    const fake = createFakePdfLib({ rejectWith: failure })
    const result = await withGlobals(
      { viewer: undefined, pdfjsLib: fake.lib, fetch: async () => chunkedResponse([pdfBytes()]) },
      () => collectPdfViewerText({ ...baseCollectOptions, source: sourceOptions }),
    )

    expect(result.status).toBe('password')
  })

  test('下载超过 deadline 时中止并标记 timedOut', async () => {
    const fake = createFakePdfLib({ pages: [['never']] })
    const result = await withGlobals(
      {
        viewer: undefined,
        pdfjsLib: fake.lib,
        fetch: (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
      },
      () =>
        collectPdfViewerText({
          ...baseCollectOptions,
          maxDurationMs: 20,
          source: sourceOptions,
        }),
    )

    expect(result.status).toBe('unavailable')
    expect(result.timedOut).toBe(true)
  })

  test('缺少注入的 pdf.js 时返回 unavailable', async () => {
    const result = await withGlobals(
      { viewer: undefined, pdfjsLib: undefined, fetch: async () => chunkedResponse([pdfBytes()]) },
      () => collectPdfViewerText({ ...baseCollectOptions, source: sourceOptions }),
    )

    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('pdf.js')
  })

  test('函数序列化后仍自包含（模拟 executeScript 注入）', async () => {
    const source = collectPdfViewerText.toString()
    const reloaded = new Function(`return (${source})`)() as typeof collectPdfViewerText

    const viewerResult = await withGlobals(
      { viewer: createFakeViewer({ pages: [['Serialized']] }) },
      () => reloaded(baseCollectOptions),
    )
    expect(viewerResult.status).toBe('ok')
    expect(viewerResult.text).toContain('Serialized')

    const fake = createFakePdfLib({ pages: [['Bytes']] })
    const bytesResult = await withGlobals(
      { viewer: undefined, pdfjsLib: fake.lib, fetch: async () => chunkedResponse([pdfBytes()]) },
      () => reloaded({ ...baseCollectOptions, source: sourceOptions }),
    )
    expect(bytesResult.status).toBe('ok')
    expect(bytesResult.text).toContain('Bytes')
  })
})

describe('PDF 来源 URL 解析', () => {
  test('顶层 HTTP(S) 直接使用', () => {
    expect(resolvePdfSourceUrl('https://example.com/a.pdf').url).toBe('https://example.com/a.pdf')
  })

  test('Chrome 视图器的 file= 参数按 URL 解码', () => {
    const viewerUrl =
      'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=https%3A%2F%2Fexample.com%2Fdoc%20a.pdf'
    expect(resolvePdfSourceUrl(viewerUrl).url).toBe('https://example.com/doc a.pdf')
  })

  test('非 HTTP(S) 明确不可用', () => {
    expect(resolvePdfSourceUrl('file:///C:/secret.pdf').url).toBeNull()
    expect(resolvePdfSourceUrl('blob:https://example.com/id').reason).toContain('HTTP(S)')
    expect(resolvePdfSourceUrl('').reason).toContain('unknown')
  })

  test('getURL 结果转回扩展相对路径', () => {
    expect(extensionRelativePath('chrome-extension://abc/vendor/pdfjs/pdf.min.js')).toBe(
      'vendor/pdfjs/pdf.min.js',
    )
    expect(extensionRelativePath('vendor/pdfjs/pdf.min.js')).toBe('vendor/pdfjs/pdf.min.js')
  })
})

interface PdfHarnessOptions {
  viewer?: unknown
  frames?: PdfFrameInfo[]
  frameSrc?: string | null
  tabUrl?: string
  executeError?: Error
  filesError?: Error
  /** 读取完成后替换 frame 列表，用来模拟读取期间文档身份变化。 */
  framesAfter?: PdfFrameInfo[]
  pdfjsLib?: unknown
  fetchImpl?: unknown
}

async function executeFakeScript<TArgs extends unknown[], TResult>(
  injection: PdfScriptInjection<TArgs, TResult>,
  options: PdfHarnessOptions,
  record: (injection: PdfScriptInjection<TArgs, TResult>) => void,
): Promise<PdfInjectionResult<TResult>[]> {
  record(injection)
  if (options.executeError) throw options.executeError
  const result = await withGlobals(
    {
      viewer: options.viewer,
      pdfjsLib: options.pdfjsLib,
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    },
    async () => await injection.func(...injection.args),
  )
  return [{ frameId: 0, result }]
}

function createPdfHarness(options: PdfHarnessOptions = {}) {
  const state = {
    targeting: {
      selectedFrames: new Map<number, string>(),
      pageEpochs: new Map<number, number>(),
    },
    session: { dialogs: new Map<number, unknown>() },
  }
  const injections: Array<{
    target: Record<string, unknown>
    world: string
    args: unknown[]
  }> = []
  const fileInjections: Array<{ target: Record<string, unknown>; files: string[] }> = []
  let executed = 0
  let frameLookups = 0

  const browser: PdfBrowserApi = {
    executeScript: async (injection) => {
      injections.push({
        target: injection.target as unknown as Record<string, unknown>,
        world: injection.world,
        args: injection.args,
      })
      executed += 1
      return await executeFakeScript(injection, options, () => {})
    },
    executeScriptFiles: async (injection) => {
      fileInjections.push({
        target: injection.target as unknown as Record<string, unknown>,
        files: injection.files,
      })
      if (options.filesError) throw options.filesError
    },
    // 第一次查 frame 列表用于定位注入目标，之后的查询代表“读取期间”的状态。
    getAllFrames: async () => {
      frameLookups += 1
      if (frameLookups > 1 && options.framesAfter) return options.framesAfter
      return options.frames ?? []
    },
    getExtensionUrl: (relativePath) => `chrome-extension://testid/${relativePath}`,
  }

  const domain = createPageObserveDomain({
    state: state as never,
    getTargetTab: async (tabId: unknown) =>
      ({
        id: typeof tabId === 'number' ? tabId : 1,
        url: options.tabUrl ?? 'https://example.com/doc.pdf',
        title: 'doc',
        active: true,
      }) as never,
    resolveElementSelectorForTab: async () => {
      throw new Error('unused')
    },
    resolveFrameTarget: async () =>
      ({
        tab: { id: 1 },
        frameId: 'frame-1',
        selector: '#pdf-frame',
        src: options.frameSrc === undefined ? 'https://example.com/doc.pdf' : options.frameSrc,
        pageEpoch: 1,
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      }) as never,
    evaluateInTabContext: async () =>
      ({
        tab: { id: 1 },
        response: { result: {} },
        value: {
          contentType: 'application/pdf',
          url: 'https://example.com/doc.pdf',
          hasPdfEmbed: true,
          hidden: false,
        },
      }) as never,
    sendDebuggerCommand: async () => undefined as never,
    pdfBrowser: browser,
  } as never)

  return {
    domain,
    injections,
    fileInjections,
    state,
    executions: () => executed,
  }
}

const viewerFrame = (overrides: Partial<PdfFrameInfo> = {}): PdfFrameInfo => ({
  frameId: 0,
  parentFrameId: -1,
  url: 'https://example.com/doc.pdf',
  documentId: 'doc-top',
  ...overrides,
})

describe('read_page 的 PDF 读取', () => {
  test('识别 PDF 页面并返回分页文本', async () => {
    const { domain } = createPdfHarness({
      viewer: createFakeViewer({ pages: [['Hello'], ['World']] }),
    })

    const result = await domain.readPage(1, {}, null)

    expect(result.strategy).toBe('pdf')
    expect(result.pdfStatus).toBe('ok')
    expect(result.pages).toBe(2)
    expect(result.pagesRead).toBe(2)
    expect(result.complete).toBe(true)
    expect(result.stopReason).toBe('complete')
    expect(result.text).toContain('[page 1/2]')
    expect(result.text).toContain('[page 2/2]')
  })

  test('PDF 文本同样按 max-chars 分片并可用 cursor 续读', async () => {
    const { domain, executions } = createPdfHarness({
      viewer: createFakeViewer({ pages: [['0123456789'], ['abcdefghij']] }),
    })

    const first = await domain.readPage(1, { maxChars: 20 }, null)
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).toBeTruthy()
    expect(first.text.length).toBe(20)

    const second = await domain.readPage(1, { cursor: first.nextCursor, maxChars: 100 }, null)
    expect(first.text + second.text).toBe('[page 1/2]\n0123456789\n[page 2/2]\nabcdefghij\n')
    expect(second.totalChars).toBe(first.totalChars)
    expect(second.truncated).toBe(false)
    expect(second.nextCursor).toBeUndefined()
    // 续读只回放缓存，不会再次注入脚本。
    expect(executions()).toBe(1)
  })

  test('无文本层时给出 OCR 提示而不是自动 OCR', async () => {
    const { domain } = createPdfHarness({ viewer: createFakeViewer({ pages: [[]] }) })

    const result = await domain.readPage(1, {}, null)

    expect(result.pdfStatus).toBe('no_text')
    expect(result.complete).toBe(false)
    expect(result.note).toContain('OCR')
  })

  test('密码保护时不能返回 complete', async () => {
    const { domain } = createPdfHarness({ viewer: createFakeViewer({ passwordRequired: true }) })

    const result = await domain.readPage(1, {}, null)

    expect(result.pdfStatus).toBe('password')
    expect(result.complete).toBe(false)
    expect(result.text).toBe('')
  })

  test('未加载完成时报告 loading', async () => {
    const { domain } = createPdfHarness({ viewer: { pdfDocument: null } })

    const result = await domain.readPage(1, { timeoutMs: 1000 }, null)

    expect(result.pdfStatus).toBe('loading')
    expect(result.complete).toBe(false)
  })

  test('视图器不可达时优先回退到原始字节解析', async () => {
    const fake = createFakePdfLib({ pages: [['Fallback text']] })
    const fetches: string[] = []
    const { domain, injections, fileInjections } = createPdfHarness({
      viewer: undefined,
      frames: [viewerFrame()],
      pdfjsLib: fake.lib,
      fetchImpl: async (url: string) => {
        fetches.push(url)
        return chunkedResponse([pdfBytes()])
      },
    })

    const result = await domain.readPage(1, {}, null)

    expect(result.strategy).toBe('pdf')
    expect(result.pdfStatus).toBe('ok')
    expect(result.text).toContain('Fallback text')
    expect(result.complete).toBe(true)
    // 第一次只探视图器，第二次带 source 走字节回退。
    expect(injections.length).toBe(2)
    const viewerProbe = injections[0]?.args[0] as { source?: unknown } | undefined
    const bytesProbe = injections[1]?.args[0] as { source?: { url: string } } | undefined
    expect(viewerProbe?.source).toBeUndefined()
    expect(bytesProbe?.source?.url).toBe('https://example.com/doc.pdf')
    expect(fileInjections[0]?.files).toEqual([
      'chrome-extension://testid/vendor/pdfjs/pdf.min.js',
      'chrome-extension://testid/vendor/pdfjs/pdf.worker.min.js',
    ])
    expect(fetches).toEqual(['https://example.com/doc.pdf'])
  })

  test('视图器 frame 的 file= 参数解码后再下载', async () => {
    const fake = createFakePdfLib({ pages: [['Decoded']] })
    const fetches: string[] = []
    const { domain, injections } = createPdfHarness({
      viewer: undefined,
      frames: [
        viewerFrame({
          frameId: 7,
          parentFrameId: 0,
          url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=https%3A%2F%2Fexample.com%2Fdoc%20a.pdf',
          documentId: 'doc-viewer',
        }),
      ],
      pdfjsLib: fake.lib,
      fetchImpl: async (url: string) => {
        fetches.push(url)
        return chunkedResponse([pdfBytes()])
      },
    })

    const result = await domain.readPage(1, {}, null)

    expect(result.text).toContain('Decoded')
    expect(fetches).toEqual(['https://example.com/doc a.pdf'])
    expect(injections[1]?.target).toEqual({ tabId: 1, documentIds: ['doc-viewer'] })
  })

  test('非 HTTP(S) 的 PDF 不做字节回退并给出明确原因', async () => {
    const { domain, injections, fileInjections } = createPdfHarness({
      viewer: undefined,
      frames: [viewerFrame({ url: 'file:///C:/secret.pdf' })],
    })

    const result = await domain.readPage(1, {}, null)

    expect(result.pdfStatus).toBe('unavailable')
    expect(result.complete).toBe(false)
    expect(result.note).toContain('HTTP(S)')
    expect(fileInjections.length).toBe(0)
    expect(injections.length).toBe(1)
  })

  test('字节下载失败时保持 unavailable 并带 reason，不能 complete', async () => {
    const fake = createFakePdfLib({ pages: [['never']] })
    const { domain } = createPdfHarness({
      viewer: undefined,
      frames: [viewerFrame()],
      pdfjsLib: fake.lib,
      fetchImpl: async () => chunkedResponse([pdfBytes()], { status: 500 }),
    })

    const result = await domain.readPage(1, {}, null)

    expect(result.pdfStatus).toBe('unavailable')
    expect(result.note).toContain('HTTP 500')
    expect(result.complete).toBe(false)
    expect(result.text).toBe('')
  })

  test('背景回退对超过 20MiB 的 PDF 返回 too_large', async () => {
    const fake = createFakePdfLib({ pages: [['never']] })
    const { domain } = createPdfHarness({
      viewer: undefined,
      frames: [viewerFrame()],
      pdfjsLib: fake.lib,
      fetchImpl: async () =>
        chunkedResponse([pdfBytes()], {
          headers: { 'content-length': String(20 * 1024 * 1024 + 1) },
        }),
    })

    const result = await domain.readPage(1, {}, null)

    expect(result.pdfStatus).toBe('too_large')
    expect(result.complete).toBe(false)
    expect(fake.documents.length).toBe(0)
  })

  test('pdf.js 注入失败时返回 unavailable，不伪装成已读', async () => {
    const { domain } = createPdfHarness({
      viewer: undefined,
      frames: [viewerFrame()],
      filesError: new Error('cannot inject into this frame'),
    })

    const result = await domain.readPage(1, {}, null)

    expect(result.pdfStatus).toBe('unavailable')
    expect(result.note).toContain('failed to inject pdf.js')
    expect(result.complete).toBe(false)
  })

  test('视图器本身不可访问时仍报 PDF_UNAVAILABLE 错误', async () => {
    const { domain } = createPdfHarness({ executeError: new Error('cannot access contents') })

    await expect(domain.readPage(1, {}, null)).rejects.toMatchObject({
      code: 'PDF_UNAVAILABLE',
    })
  })

  test('frame 里的 PDF 通过 documentId 唯一定位', async () => {
    const { domain, injections } = createPdfHarness({
      viewer: createFakeViewer({ pages: [['Frame text']] }),
      frames: [
        {
          frameId: 0,
          parentFrameId: -1,
          url: 'https://example.com/page',
          documentId: 'doc-top',
        },
        {
          frameId: 7,
          parentFrameId: 0,
          url: 'https://example.com/doc.pdf',
          documentId: 'doc-frame',
        },
      ],
    })

    const result = await domain.readPage(1, {}, '#pdf-frame')

    expect(result.strategy).toBe('pdf')
    expect(result.text).toContain('Frame text')
    expect(injections[0]?.target).toEqual({ tabId: 1, documentIds: ['doc-frame'] })
    expect(injections[0]?.world).toBe('MAIN')
  })

  test('同名 URL 出现在多个 frame 时报 AMBIGUOUS_FRAME，不猜', async () => {
    const { domain } = createPdfHarness({
      viewer: createFakeViewer({ pages: [['Frame text']] }),
      frames: [
        {
          frameId: 7,
          parentFrameId: 0,
          url: 'https://example.com/doc.pdf',
          documentId: 'doc-a',
        },
        {
          frameId: 8,
          parentFrameId: 0,
          url: 'https://example.com/doc.pdf',
          documentId: 'doc-b',
        },
      ],
    })

    await expect(domain.readPage(1, {}, '#pdf-frame')).rejects.toMatchObject({
      code: 'AMBIGUOUS_FRAME',
    })
  })

  test('读取期间文档身份变化按 documentChanged 处理', async () => {
    const { domain } = createPdfHarness({
      viewer: createFakeViewer({ pages: [['Frame text']] }),
      frames: [
        {
          frameId: 7,
          parentFrameId: 0,
          url: 'https://example.com/doc.pdf',
          documentId: 'doc-frame',
        },
      ],
      // 读取完成后再查 frame 列表时，原来的 documentId 已经不在了：PDF 被换掉。
      framesAfter: [
        {
          frameId: 7,
          parentFrameId: 0,
          url: 'https://example.com/other.pdf',
          documentId: 'doc-other',
        },
      ],
    })

    const result = await domain.readPage(1, {}, '#pdf-frame')

    expect(result.documentStatus).toBe('changed')
    expect(result.complete).toBe(false)
    expect(result.stopReason).toBe('documentChanged')
  })

  test('frame 列表为空时不能断言文档发生了变化', () => {
    // webNavigation 没给出任何 frame 时属于“信息缺失”，不是“文档被换掉”。
    expect(
      detectDocumentChange(
        [],
        { tabId: 1, documentIds: ['doc-frame'] },
        'https://example.com/a.pdf',
      ),
    ).toBe(false)
    expect(detectDocumentChange([], { tabId: 1, frameIds: [0] }, 'https://example.com/a.pdf')).toBe(
      false,
    )
  })
})

describe('read_page 的 PDF 落盘', () => {
  test('--output 把 PDF 正文写入文件', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-read-pdf-'))
    const outputPath = path.join(directory, 'doc.txt')
    const capturedText = '[page 1/2]\nHello\n'

    const result = await runCli(['read_page', '--output', outputPath], {
      ok: true,
      result: {
        text: '[page 1/2]\nHe',
        capturedText,
        chars: 16,
        totalChars: capturedText.length,
        complete: true,
        truncated: false,
        stopReason: 'complete',
        screens: 0,
        scrollHeight: 0,
        backgroundTab: false,
        strategy: 'pdf',
        pdfStatus: 'ok',
        pages: 2,
        pagesRead: 2,
        url: 'https://example.com/doc.pdf',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(await readFile(outputPath, 'utf8')).toBe(capturedText)
    const payload = JSON.parse(result.stdout) as { result: Record<string, unknown> }
    expect(payload.result.pdfStatus).toBe('ok')
    expect(payload.result.pages).toBe(2)
    expect(payload.result.output).toEqual({
      path: outputPath,
      bytes: Buffer.byteLength(capturedText, 'utf8'),
    })
  })
})
