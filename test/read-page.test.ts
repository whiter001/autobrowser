import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPageObserveDomain } from '../extension/background/page-observe.js'
import {
  scanPageText,
  type ReadPageScanEnvironment,
} from '../extension/background/page-observe-read-page.js'
import { parseReadPageArgs } from '../src/cli/commands/read-page.js'
import { sliceReadPageText } from '../src/core/read-page.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

interface FakePageOptions {
  lines?: string[]
  /** full: 整篇都在 DOM 里；virtual: 只渲染视口附近的行（虚拟列表）。 */
  mode?: 'full' | 'virtual'
  linesPerScreen?: number
  hidden?: boolean
  frozen?: boolean
  url?: string
  contentType?: string
  growOnRead?: number
  /** 滚动期间最多长高几次；用完就不再增长，页面才会稳定下来。 */
  growOnReadTimes?: number
  growOnSleep?: number
  /** 只有滚到底时才继续长高（模拟到底后仍在加载的无限流）。 */
  growOnSleepAtBottom?: number
  /** 底部最多长高几次；用来区分“有限懒加载”与“真正无限流”。 */
  growAtBottomTimes?: number
}

/**
 * 轻量假页面：只实现扫描算法真正用到的 DOM 能力。
 *
 * 重点是行为真实：滚动会改变可见行、虚拟列表会随滚动换行、
 * 页面可以无限长高、URL 可以在扫描途中改变。
 */
class FakePage {
  lines: string[]
  mode: 'full' | 'virtual'
  linesPerScreen: number
  lineHeight = 20
  scrollTop = 0
  hidden: boolean
  frozen: boolean
  url: string
  contentType: string
  growOnRead: number
  growOnReadTimes: number
  growOnSleep: number
  growOnSleepAtBottom: number
  growAtBottomTimes: number
  bottomGrowths = 0
  readGrowths = 0
  screenReads = 0
  scrollCalls = 0
  sleeps = 0
  onRead: (() => void) | null = null

  constructor(options: FakePageOptions = {}) {
    this.lines = options.lines ? [...options.lines] : []
    this.mode = options.mode ?? 'full'
    this.linesPerScreen = options.linesPerScreen ?? 5
    this.hidden = options.hidden ?? false
    this.frozen = options.frozen ?? false
    this.url = options.url ?? 'https://example.com/article'
    this.contentType = options.contentType ?? 'text/html'
    this.growOnRead = options.growOnRead ?? 0
    this.growOnReadTimes = options.growOnReadTimes ?? Number.POSITIVE_INFINITY
    this.growOnSleep = options.growOnSleep ?? 0
    this.growOnSleepAtBottom = options.growOnSleepAtBottom ?? 0
    this.growAtBottomTimes = options.growAtBottomTimes ?? Number.POSITIVE_INFINITY
  }

  get innerHeight(): number {
    return this.linesPerScreen * this.lineHeight
  }

  get scrollHeight(): number {
    return Math.max(this.innerHeight, this.lines.length * this.lineHeight)
  }

  private grow(count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.lines.push(`feed row ${this.lines.length + 1}`)
    }
  }

  visibleText(): string {
    this.screenReads += 1
    this.onRead?.()
    if (this.readGrowths < this.growOnReadTimes) {
      this.readGrowths += 1
      this.grow(this.growOnRead)
    }
    if (this.mode === 'full') return this.lines.join('\n')
    const start = Math.floor(this.scrollTop / this.lineHeight)
    return this.lines.slice(start, start + this.linesPerScreen).join('\n')
  }

  /** 每次等待后的钩子；测试用它模拟“等待期间发生导航”。 */
  onSleepHook: ((ms: number) => void) | null = null

  /**
   * 只有“到底后长时间等待”才继续长高：扫描器在底部的等待是 200ms，
   * 普通滚动后的稳定等待是 120ms，两者必须区分开。
   */
  onSleep = (ms: number): void => {
    this.sleeps += 1
    this.grow(this.growOnSleep)
    const atBottom = this.scrollTop + this.innerHeight >= this.scrollHeight - 2
    if (atBottom && ms >= 200 && this.bottomGrowths < this.growAtBottomTimes) {
      this.bottomGrowths += 1
      this.grow(this.growOnSleepAtBottom)
    }
    this.onSleepHook?.(ms)
  }

  scrollTo(_x: number, y: number): void {
    this.scrollCalls += 1
    if (this.frozen) return
    this.scrollTop = Math.min(Math.max(0, y), Math.max(0, this.scrollHeight - this.innerHeight))
  }

  document = (): any => {
    const visibleText = (): string => this.visibleText()
    const scrollHeight = (): number => this.scrollHeight
    const clientHeight = (): number => this.innerHeight
    const getScrollTop = (): number => this.scrollTop
    const setScrollTop = (value: number): void => {
      this.scrollTop = value
    }
    const contentType = (): string => this.contentType
    const hidden = (): boolean => this.hidden
    return {
      get contentType() {
        return contentType()
      },
      get hidden() {
        return hidden()
      },
      get visibilityState() {
        return hidden() ? 'hidden' : 'visible'
      },
      get body() {
        return {
          get innerText() {
            return visibleText()
          },
        }
      },
      documentElement: {
        get innerText() {
          return visibleText()
        },
        get scrollHeight() {
          return scrollHeight()
        },
        get clientHeight() {
          return clientHeight()
        },
      },
      scrollingElement: {
        get scrollHeight() {
          return scrollHeight()
        },
        get clientHeight() {
          return clientHeight()
        },
        get scrollTop() {
          return getScrollTop()
        },
        set scrollTop(value: number) {
          setScrollTop(value)
        },
      },
      querySelectorAll: () => [],
      querySelector: () => null,
    }
  }

  window = (): any => {
    const clientHeight = (): number => this.innerHeight
    const getScrollTop = (): number => this.scrollTop
    const scrollTo = (x: number, y: number): void => this.scrollTo(x, y)
    return {
      get innerHeight() {
        return clientHeight()
      },
      get scrollY() {
        return getScrollTop()
      },
      scrollTo,
      getComputedStyle: () => ({
        overflowY: 'visible',
        display: 'block',
        visibility: 'visible',
        opacity: '1',
      }),
    }
  }
}

async function runInPage(expression: string, page: FakePage): Promise<unknown> {
  const factory = new Function(
    'document',
    'window',
    'location',
    'setTimeout',
    `return ${expression}`,
  ) as (...args: unknown[]) => unknown
  const result = factory(
    page.document(),
    page.window(),
    {
      get href() {
        return page.url
      },
    },
    (callback: () => void, ms?: number) => {
      page.onSleep(ms ?? 0)
      callback()
      return 0
    },
  )
  return await result
}

function createReadPageHarness(page: FakePage) {
  const state = {
    targeting: {
      selectedFrames: new Map<number, string>(),
      pageEpochs: new Map<number, number>(),
    },
    session: { dialogs: new Map<number, unknown>() },
  }
  const domain = createPageObserveDomain({
    state: state as never,
    getTargetTab: async (tabId: unknown) =>
      ({
        id: typeof tabId === 'number' ? tabId : 1,
        url: page.url,
        title: 'fake page',
        active: true,
      }) as never,
    resolveElementSelectorForTab: async () => {
      throw new Error('unused')
    },
    resolveFrameTarget: async () => {
      throw new Error('unused')
    },
    evaluateInTabContext: async (_tabId: unknown, expression: string) => {
      const value = await runInPage(expression, page)
      return { tab: { id: 1 }, response: { result: {} }, value } as never
    },
    sendDebuggerCommand: async () => undefined as never,
  } as never)
  return { domain, state }
}

function createScanEnvironment(page: FakePage, options?: { clockStepMs?: number }) {
  const state = { clock: 0 }
  const step = options?.clockStepMs ?? 0
  const env: ReadPageScanEnvironment = {
    document: page.document(),
    window: page.window(),
    location: {
      get href() {
        return page.url
      },
    },
    now: () => state.clock,
    sleep: async (ms: number) => {
      page.onSleep(ms)
      state.clock += step
    },
  }
  return { env, state }
}

const SCAN_OPTIONS = {
  maxScreens: 60,
  timeoutMs: 25_000,
  captureLimit: 4_000_000,
  stepRatio: 0.85,
  settleMs: 1,
}

describe('read_page DOM 扫描', () => {
  test('长文按 max-chars 分片返回，cursor 续读拼回全文', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
    const page = new FakePage({ lines })
    const { domain } = createReadPageHarness(page)
    const full = lines.join('\n')

    const first = await domain.readPage(1, { maxChars: 60 }, null)
    expect(first.strategy).toBe('dom')
    expect(first.complete).toBe(true)
    expect(first.stopReason).toBe('complete')
    expect(first.totalChars).toBe(full.length)
    expect(first.chars).toBe(60)
    expect(first.text).toBe(full.slice(0, 60))
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).toBeTruthy()

    const second = await domain.readPage(1, { cursor: first.nextCursor, maxChars: 60 }, null)
    expect(second.text).toBe(full.slice(60, 120))

    const third = await domain.readPage(1, { cursor: second.nextCursor, maxChars: 60_000 }, null)
    expect(third.text).toBe(full.slice(120))
    expect(third.truncated).toBe(false)
    expect(third.nextCursor).toBeUndefined()
    expect(third.complete).toBe(true)
  })

  test('续读只回放捕获缓存，不会重新滚动扫描', async () => {
    const page = new FakePage({ lines: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`) })
    const { domain } = createReadPageHarness(page)

    const first = await domain.readPage(1, { maxChars: 60 }, null)
    const readsAfterScan = page.screenReads
    const scrollsAfterScan = page.scrollCalls

    await domain.readPage(1, { cursor: first.nextCursor, maxChars: 60 }, null)

    expect(page.screenReads).toBe(readsAfterScan)
    expect(page.scrollCalls).toBe(scrollsAfterScan)
  })

  test('切片不会切断 UTF-16 代理对', async () => {
    const text = 'a😀b'
    expect(sliceReadPageText(text, 0, 2)).toBe('a')
    expect(sliceReadPageText(text, 0, 3)).toBe('a😀')

    const page = new FakePage({ lines: ['😀😀😀😀', 'tail'] })
    const { domain } = createReadPageHarness(page)
    const result = await domain.readPage(1, { maxChars: 3 }, null)
    const last = result.text.charCodeAt(result.text.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    expect(result.text).toBe('😀')
  })

  test('maxChars 连一个完整码点都放不下时明确报错，不返回空分片', async () => {
    // 代理对需要两个 UTF-16 单元：maxChars=1 无法交付任何完整字符。
    const page = new FakePage({ lines: ['😀abc'] })
    const { domain } = createReadPageHarness(page)

    await expect(domain.readPage(1, { maxChars: 1 }, null)).rejects.toMatchObject({
      code: 'INVALID_COMMAND_ARGS',
    })
  })

  test('BMP 字符在 maxChars=1 时正常分片', async () => {
    const page = new FakePage({ lines: ['abc'] })
    const { domain } = createReadPageHarness(page)

    const result = await domain.readPage(1, { maxChars: 1 }, null)

    expect(result.text).toBe('a')
    expect(result.chars).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.nextCursor).toBeTruthy()
  })

  test('maxScreens 生效时明确报告未读完', async () => {
    const page = new FakePage({ lines: Array.from({ length: 200 }, (_, i) => `line ${i + 1}`) })
    const { domain } = createReadPageHarness(page)

    const result = await domain.readPage(1, { maxScreens: 2, maxChars: 100 }, null)

    expect(result.complete).toBe(false)
    expect(result.stopReason).toBe('maxScreens')
    expect(result.screens).toBe(2)
    // 已捕获的部分仍然可以续读，只是 complete 保持 false。
    expect(result.nextCursor).toBeTruthy()
    expect(result.truncated).toBe(true)
  })

  test('页内预算耗尽时报告 budgetExhausted 而不是超时', async () => {
    const page = new FakePage({ lines: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`) })
    const { env, state } = createScanEnvironment(page, { clockStepMs: 1000 })

    const result = await scanPageText(env, { ...SCAN_OPTIONS, timeoutMs: 2500 })

    expect(result.stopReason).toBe('budgetExhausted')
    expect(result.complete).toBe(false)
    expect(state.clock).toBeGreaterThanOrEqual(2500)
  })

  test('滚动过程中长高但到底后不再增长时按完成处理', async () => {
    // 正常的长文在滚动时会边滚边加载内容；这不等于无限流。
    const page = new FakePage({
      lines: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`),
      mode: 'virtual',
      linesPerScreen: 5,
      growOnRead: 1,
      growOnReadTimes: 2,
    })
    const { env } = createScanEnvironment(page)

    const result = await scanPageText(env, SCAN_OPTIONS)

    expect(result.stopReason).toBe('complete')
    expect(result.complete).toBe(true)
  })

  test('有限的懒加载长文会读到最后并标记 complete', async () => {
    // 到底后还会长高两次：这是有限懒加载，不该被当成无限流。
    const page = new FakePage({
      lines: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`),
      mode: 'virtual',
      linesPerScreen: 5,
      growOnSleepAtBottom: 1,
      growAtBottomTimes: 2,
    })
    const { env } = createScanEnvironment(page)

    const result = await scanPageText(env, SCAN_OPTIONS)

    expect(result.stopReason).toBe('complete')
    expect(result.complete).toBe(true)
    // 懒加载追加的行也必须进入捕获结果。
    expect(result.text.split('\n').length).toBe(12)
    expect(result.text.endsWith('feed row 12')).toBe(true)
  })

  test('到底后连续长高的信息流判定为 endlessFeed', async () => {
    const page = new FakePage({
      lines: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`),
      linesPerScreen: 5,
      growOnSleepAtBottom: 1,
    })
    const { env } = createScanEnvironment(page)

    const result = await scanPageText(env, SCAN_OPTIONS)

    expect(result.stopReason).toBe('endlessFeed')
    expect(result.complete).toBe(false)
  })

  test('原滚动位置在中部时仍从页首开始读取，并在结束后恢复原位置', async () => {
    const page = new FakePage({
      lines: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`),
      mode: 'virtual',
      linesPerScreen: 5,
    })
    page.scrollTop = 320
    const { env } = createScanEnvironment(page)

    const result = await scanPageText(env, SCAN_OPTIONS)

    // 从页首开始：不能因为原位置在中部就漏掉前文却宣称读完。
    expect(result.text.startsWith('line 1')).toBe(true)
    expect(result.text.split('\n')[0]).toBe('line 1')
    expect(result.complete).toBe(true)
    // 读完恢复原滚动位置。
    expect(page.scrollTop).toBe(320)
  })

  test('等待期间发生导航时不混入新页面文本，也不滚动新页面', async () => {
    const page = new FakePage({
      lines: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`),
      mode: 'virtual',
      linesPerScreen: 5,
    })
    page.onSleepHook = (ms: number) => {
      if (ms < 200) return
      // 第二次到底等待时导航到新页面：新页面有自己的滚动位置和正文。
      page.url = 'https://example.com/next'
      page.lines = ['NEW PAGE CONTENT']
      page.scrollTop = 1234
    }
    const { env } = createScanEnvironment(page)

    const result = await scanPageText(env, SCAN_OPTIONS)

    expect(result.stopReason).toBe('documentChanged')
    expect(result.complete).toBe(false)
    expect(result.text).not.toContain('NEW PAGE CONTENT')
    // 页面已经换掉：不能再去滚动或恢复新页面的位置。
    expect(page.scrollTop).toBe(1234)
  })

  test('扫描期间 location 改变时报告 documentChanged 且不可续读', async () => {
    const page = new FakePage({ lines: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`) })
    page.onRead = () => {
      page.url = 'https://example.com/other'
    }
    const { domain } = createReadPageHarness(page)

    const result = await domain.readPage(1, {}, null)

    expect(result.stopReason).toBe('documentChanged')
    expect(result.complete).toBe(false)
    expect(result.documentStatus).toBe('changed')
    expect(result.nextCursor).toBeUndefined()
  })

  test('后台标签页滚不动时报告 renderFrozen', async () => {
    const page = new FakePage({
      lines: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`),
      hidden: true,
      frozen: true,
    })
    const { env } = createScanEnvironment(page)

    const result = await scanPageText(env, SCAN_OPTIONS)

    expect(result.stopReason).toBe('renderFrozen')
    expect(result.backgroundTab).toBe(true)
    expect(result.complete).toBe(false)
  })

  test('滚动卡住时报告 stalled', async () => {
    const page = new FakePage({
      lines: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`),
      frozen: true,
    })
    const { env } = createScanEnvironment(page)

    const result = await scanPageText(env, SCAN_OPTIONS)

    expect(result.stopReason).toBe('stalled')
    expect(result.backgroundTab).toBe(false)
  })

  test('扫描结束后恢复原来的滚动位置', async () => {
    const page = new FakePage({ lines: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`) })
    const { env } = createScanEnvironment(page)
    page.scrollTop = 320

    await scanPageText(env, SCAN_OPTIONS)

    expect(page.scrollTop).toBe(320)
  })

  test('虚拟列表的重复行只去掉滚动重叠部分，正文里的合法重复行保留', async () => {
    const virtualPage = new FakePage({
      lines: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'],
      mode: 'virtual',
      linesPerScreen: 3,
    })
    const { env } = createScanEnvironment(virtualPage)
    const virtualResult = await scanPageText(env, SCAN_OPTIONS)
    expect(virtualResult.text.split('\n')).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
    expect(virtualResult.complete).toBe(true)

    const repeatedPage = new FakePage({ lines: ['dup', 'dup', 'dup'] })
    const repeated = createScanEnvironment(repeatedPage)
    const repeatedResult = await scanPageText(repeated.env, SCAN_OPTIONS)
    expect(repeatedResult.text.split('\n')).toEqual(['dup', 'dup', 'dup'])
  })

  test('空页面报告 noText，不会把空文本当成读完', async () => {
    const page = new FakePage({ lines: [] })
    const { env } = createScanEnvironment(page)

    const result = await scanPageText(env, SCAN_OPTIONS)

    expect(result.stopReason).toBe('noText')
    expect(result.complete).toBe(false)
    expect(result.text).toBe('')
  })
})

describe('read_page 观察缓存与游标', () => {
  test('cursor 跨标签页失效并给出机器可读错误码', async () => {
    const page = new FakePage({ lines: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`) })
    const { domain } = createReadPageHarness(page)

    const first = await domain.readPage(1, { maxChars: 60 }, null)
    await expect(domain.readPage(2, { cursor: first.nextCursor }, null)).rejects.toMatchObject({
      code: 'STALE_READ_CURSOR',
    })
  })

  test('cursor 在页面代次变化后失效', async () => {
    const page = new FakePage({ lines: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`) })
    const { domain, state } = createReadPageHarness(page)

    const first = await domain.readPage(1, { maxChars: 60 }, null)
    state.targeting.pageEpochs.set(1, 2)

    await expect(domain.readPage(1, { cursor: first.nextCursor }, null)).rejects.toMatchObject({
      code: 'STALE_READ_CURSOR',
    })
  })

  test('cursor 在页面 URL 变化后失效', async () => {
    const page = new FakePage({ lines: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`) })
    const { domain } = createReadPageHarness(page)

    const first = await domain.readPage(1, { maxChars: 60 }, null)
    page.url = 'https://example.com/changed'

    await expect(domain.readPage(1, { cursor: first.nextCursor }, null)).rejects.toMatchObject({
      code: 'STALE_READ_CURSOR',
    })
  })

  test('未知 cursor 报告 STALE_READ_CURSOR', async () => {
    const page = new FakePage({ lines: ['hello'] })
    const { domain } = createReadPageHarness(page)

    await expect(
      domain.readPage(1, { cursor: 'rp_not_a_real_cursor' }, null),
    ).rejects.toMatchObject({
      code: 'STALE_READ_CURSOR',
    })
  })

  test('观察缓存有份数上限，超出的旧捕获被淘汰', async () => {
    const page = new FakePage({ lines: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`) })
    const { domain } = createReadPageHarness(page)

    const first = await domain.readPage(1, { maxChars: 60 }, null)
    // 缓存最多 8 份；再多扫几次就会把最早那份挤出去。
    for (let index = 0; index < 8; index += 1) {
      await domain.readPage(1, { maxChars: 60 }, null)
    }

    await expect(domain.readPage(1, { cursor: first.nextCursor }, null)).rejects.toMatchObject({
      code: 'STALE_READ_CURSOR',
    })
  })

  test('cursor 不暴露页面敏感参数', async () => {
    const page = new FakePage({
      lines: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`),
      url: 'https://example.com/private?token=secret',
    })
    const { domain } = createReadPageHarness(page)

    const first = await domain.readPage(1, { maxChars: 60 }, null)

    expect(first.nextCursor).toMatch(/^rp_[a-z0-9]+$/)
    expect(first.nextCursor).not.toContain('secret')
    expect(first.nextCursor).not.toContain('example.com')
  })
})

describe('read_page CLI 参数', () => {
  test('接受完整的合法参数组合', () => {
    const options = parseReadPageArgs([
      '--cursor',
      'rp_abc',
      '--max-chars',
      '1000',
      '--output',
      './out.txt',
    ])
    expect(options).toEqual({
      cursor: 'rp_abc',
      maxChars: 1000,
      outputPath: './out.txt',
    })
  })

  test('cursor 不能与 max-screens 或 timeout-ms 组合', () => {
    expect(() => parseReadPageArgs(['--cursor', 'rp_abc', '--max-screens', '10'])).toThrow(
      /--cursor cannot be combined with --max-screens/,
    )
    expect(() => parseReadPageArgs(['--cursor', 'rp_abc', '--timeout-ms', '1000'])).toThrow(
      /--cursor cannot be combined with --timeout-ms/,
    )
  })

  test('超出范围的数值被拒绝', () => {
    expect(() => parseReadPageArgs(['--max-chars', '0'])).toThrow(/--max-chars/)
    expect(() => parseReadPageArgs(['--max-chars', '60001'])).toThrow(/--max-chars/)
    expect(() => parseReadPageArgs(['--max-screens', '0'])).toThrow(/--max-screens/)
    expect(() => parseReadPageArgs(['--max-screens', '61'])).toThrow(/--max-screens/)
    expect(() => parseReadPageArgs(['--timeout-ms', '99'])).toThrow(/--timeout-ms/)
    expect(() => parseReadPageArgs(['--timeout-ms', '120001'])).toThrow(/--timeout-ms/)
    expect(() => parseReadPageArgs(['--max-chars', '1.5'])).toThrow(/--max-chars/)
  })

  test('未知选项与多余位置参数被拒绝', () => {
    expect(() => parseReadPageArgs(['--nope'])).toThrow(/unsupported read_page option/)
    expect(() => parseReadPageArgs(['extra'])).toThrow(/unexpected extra argument/)
  })
})

describe('read_page CLI 输出', () => {
  test('--output 落盘完整捕获文本，stdout 只回 path 与 bytes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-read-page-'))
    const outputPath = path.join(directory, 'page.txt')
    const capturedText = '完整正文\n第二行'

    const result = await runCli(['read_page', '--output', outputPath], {
      ok: true,
      result: {
        text: '完整正文',
        capturedText,
        chars: 4,
        totalChars: capturedText.length,
        complete: true,
        truncated: false,
        stopReason: 'complete',
        screens: 2,
        scrollHeight: 1200,
        backgroundTab: false,
        strategy: 'dom',
        url: 'https://example.com/article',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(await readFile(outputPath, 'utf8')).toBe(capturedText)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: Record<string, unknown>
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.text).toBeUndefined()
    expect(payload.result.capturedText).toBeUndefined()
    expect(payload.result.output).toEqual({
      path: outputPath,
      bytes: Buffer.byteLength(capturedText, 'utf8'),
    })
    // 读取元数据必须保留
    expect(payload.result.complete).toBe(true)
    expect(payload.result.stopReason).toBe('complete')
    expect(payload.result.screens).toBe(2)
    expect(payload.result.capturedChars).toBe(capturedText.length)
  })

  test('--output 不改写完整性与截断语义', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-read-page-'))
    const outputPath = path.join(directory, 'page.txt')
    const capturedText = '只读到一部分'

    const result = await runCli(['read_page', '--output', outputPath], {
      ok: true,
      result: {
        text: '只读到',
        capturedText,
        chars: 3,
        totalChars: capturedText.length,
        complete: false,
        truncated: true,
        stopReason: 'maxScreens',
        screens: 2,
        scrollHeight: 1200,
        backgroundTab: false,
        strategy: 'dom',
        url: 'https://example.com/article',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(await readFile(outputPath, 'utf8')).toBe(capturedText)
    const payload = JSON.parse(result.stdout) as { result: Record<string, unknown> }
    // 写了文件不等于读完了：完整性与截断语义必须原样保留。
    expect(payload.result.complete).toBe(false)
    expect(payload.result.truncated).toBe(true)
    expect(payload.result.stopReason).toBe('maxScreens')
    expect(payload.result.chars).toBe(3)
    expect(payload.result.capturedChars).toBe(capturedText.length)
  })

  test('--output 与 --cursor 可以同时使用', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-read-page-'))
    const outputPath = path.join(directory, 'page.txt')

    const result = await runCli(['read_page', '--cursor', 'rp_abc', '--output', outputPath], {
      ok: true,
      result: {
        text: 'first',
        capturedText: 'first second',
        chars: 5,
        totalChars: 12,
        complete: false,
        truncated: true,
        stopReason: 'maxScreens',
        screens: 3,
        scrollHeight: 900,
        backgroundTab: false,
        strategy: 'dom',
        url: 'https://example.com/article',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(await readFile(outputPath, 'utf8')).toBe('first second')
    const body = result.fetchCalls.at(-1)?.body
    expect(body?.args?.cursor).toBe('rp_abc')
    expect(body?.args?.includeCapturedText).toBe(true)
  })

  test('扩展没有回传捕获文本时给出明确错误而不是写空文件', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-read-page-'))
    const outputPath = path.join(directory, 'page.txt')

    const result = await runCli(['read_page', '--output', outputPath], {
      ok: true,
      result: { text: 'body', complete: true },
    })

    expect(result.exitCode).toBe(1)
    const payload = cliErrorPayload(result.stdout)
    expect(payload.error.code).toBe('CLI_ERROR')
    expect(payload.error.suggestedAction).toContain('extension')
  })
})

describe('read_page 命令接入', () => {
  test('命令目录把 read_page 标记为可指定 tab 与 frame 的命令', async () => {
    const { COMMAND_CATALOG, commandSupportsFrameTarget, commandSupportsTabTarget } =
      await import('../src/core/command-catalog.js')
    expect(COMMAND_CATALOG.some((entry) => entry.name === 'read_page')).toBe(true)
    expect(commandSupportsTabTarget('read_page')).toBe(true)
    expect(commandSupportsFrameTarget('read_page')).toBe(true)
  })

  test('命令注册表能加载 read_page 的实现', async () => {
    const { COMMAND_LOADERS } = await import('../src/cli/commands/index.js')
    const handler = await COMMAND_LOADERS.read_page!()
    expect(typeof handler).toBe('function')
  })

  test('协议侧拒绝越界参数与互斥组合', async () => {
    const { validateCommandArgs } = await import('../src/core/command-spec.js')
    expect(() => validateCommandArgs('read_page', { maxChars: 0 })).toThrow()
    expect(() => validateCommandArgs('read_page', { maxChars: 60001 })).toThrow()
    expect(() => validateCommandArgs('read_page', { maxScreens: 61 })).toThrow()
    expect(() => validateCommandArgs('read_page', { timeoutMs: 99 })).toThrow()
    expect(() => validateCommandArgs('read_page', { cursor: 'rp_x', maxScreens: 10 })).toThrow()
    expect(() => validateCommandArgs('read_page', { cursor: 'rp_x', timeoutMs: 1000 })).toThrow()
    expect(() => validateCommandArgs('read_page', { maxChars: 60000 })).not.toThrow()
  })

  test('read_page 的显式 timeoutMs 计入 relay 请求预算', async () => {
    const { getCommandRequestBudgetMs } = await import('../src/core/command-budget.js')
    expect(getCommandRequestBudgetMs('read_page', { timeoutMs: 60_000 })).toBe(65_000)
    expect(getCommandRequestBudgetMs('read_page', {})).toBe(30_000)
  })

  test('batch 步骤里的 read_page 同样受协议校验约束', async () => {
    const { validateCommandArgs } = await import('../src/core/command-spec.js')
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'read_page', args: { cursor: 'rp_x', maxScreens: 3 } }],
      }),
    ).toThrow()
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'read_page', args: { maxChars: 100 } }],
      }),
    ).not.toThrow()
  })

  test('read_page 属于只读观察命令，可在只读工作区运行', async () => {
    const { isWorkspaceReadonlyCommand } = await import('../src/core/workspaces.js')
    expect(isWorkspaceReadonlyCommand('read_page', {})).toBe(true)
  })

  test('WebDriver 引擎明确拒绝 read_page，不模拟成功', async () => {
    const { createWebDriverCommandHandler } = await import('../src/cli/webdriver.js')
    const { mkdtemp } = await import('node:fs/promises')
    const home = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-read-page-wd-'))
    const handler = createWebDriverCommandHandler({
      engine: 'firefox',
      driverUrl: 'http://127.0.0.1:4723',
      homeDir: home,
      fetchImpl: (async () => {
        throw new Error('the driver must not be contacted for an unsupported command')
      }) as unknown as typeof fetch,
    })

    const response = await handler('read_page', {})
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_CAPABILITY_UNSUPPORTED', details: { engine: 'firefox' } },
    })
  })
})
