import { describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectCommandRegistry } from '../src/cli/commands/collect.js'
import {
  FEED_SIGNATURE_EVAL_SCRIPT,
  feedSignatureWaitExpression,
} from '../src/cli/commands/collect.js'
import { readJsonPath } from '../src/core/collect.js'
import type { CommandResponse } from '../src/cli/client.js'
import type { CommandContext } from '../src/cli/commands/types.js'

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-collect-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function createContext(
  handler: (command: string, args: Record<string, unknown>) => unknown,
  written: CommandResponse[],
): CommandContext {
  return {
    flags: { server: 'http://mock', engine: 'chromium' },
    requestCommand: async (_baseUrl: string, command: string, args: object = {}) => {
      const result = handler(command, args as Record<string, unknown>)
      if (result instanceof Error) {
        return {
          ok: false,
          error: { message: result.message, code: (result as { code?: string }).code },
        }
      }
      return { ok: true, result }
    },
    writeResult: (payload: CommandResponse) => {
      written.push(payload as CommandResponse)
    },
  } as unknown as CommandContext
}

/** 造一个假的可见卡片节点，用于在 Node 里直接跑页面侧签名脚本。 */
function fakeCard(text: string, href: string) {
  return {
    innerText: text,
    textContent: text,
    href: `https://example.com/${href}`,
    getAttribute: () => '',
    shadowRoot: null,
    getBoundingClientRect: () => ({ width: 100, height: 50, top: 0, left: 0 }),
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      },
    },
  }
}

/** 在假的 document 上执行签名脚本，返回签名字符串。 */
function runSignatureEval(selector: string): string | null {
  const run = new Function('args', `return ${FEED_SIGNATURE_EVAL_SCRIPT}`) as (args: {
    selector: string
  }) => { signature: string | null }
  return run({ selector }).signature
}

/** 在假的 document 上执行等待条件，返回是否判定为"列表已变化"。 */
function runSignatureWait(selector: string, baseline: string): boolean {
  const run = new Function(
    `return (${feedSignatureWaitExpression(selector, baseline)})`,
  ) as () => boolean
  return run()
}

function networkSpec(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'cards',
    mode: 'network',
    startUrl: 'https://example.com/page/1',
    output: 'cards.jsonl',
    network: { urlPattern: '/api/cards', itemsPath: 'data.items' },
    ...extra,
  }
}

/** 只回一条固定数据的 network mock，用于验证恢复路径不依赖浏览器。 */
function networkContext(
  written: CommandResponse[],
  items: Record<string, unknown>[],
  options: { next?: string } = {},
): CommandContext {
  let currentUrl = ''
  return createContext((command, args) => {
    if (command === 'goto') {
      currentUrl = String(args.url)
      return { url: currentUrl }
    }
    if (command === 'network' && args.action === 'requests')
      return { requests: [{ id: 'request-1' }] }
    if (command === 'network' && args.action === 'request') {
      return {
        request: {
          responseBody: JSON.stringify({
            data: { items, ...(options.next ? { next: options.next } : {}) },
          }),
        },
      }
    }
    throw new Error(`unexpected ${command}`)
  }, written)
}

describe('collect orchestration', () => {
  test('readJsonPath traverses objects and arrays', () => {
    expect(readJsonPath({ data: { items: [{ id: 1 }] } }, 'data.items.0.id')).toBe(1)
    expect(readJsonPath({ data: null }, 'data.items')).toBeUndefined()
  })

  test('feed run writes structured JSONL and completed resume is a no-op', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'feed.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({ name: 'cards', mode: 'feed', output: 'cards.jsonl', feed: { limit: 2 } }),
      )
      const written: CommandResponse[] = []
      let feedCalls = 0
      const context = createContext((command) => {
        if (command === 'goto') return { url: 'https://example.com' }
        if (command === 'feed') {
          feedCalls += 1
          return {
            pageEpoch: 3,
            items: [{ author: 'Ada', text: 'hello', url: null }],
          }
        }
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(0)
      const output = await readFile(path.join(directory, 'cards.jsonl'), 'utf8')
      const item = JSON.parse(output.trim())
      expect(item).toMatchObject({
        author: 'Ada',
        _meta: { task: 'cards', mode: 'feed', page: 1, pageEpoch: 3 },
      })
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
      expect(checkpoint).toMatchObject({
        version: 2,
        status: 'completed',
        nextPage: 2,
        itemCount: 1,
      })
      // v2 checkpoint 不再保存条目数组
      expect(checkpoint.items).toBeUndefined()

      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      expect(feedCalls).toBe(1)
      expect(written.at(-1)).toMatchObject({ ok: true, result: { itemCount: 1 } })
    })
  })

  test('network mode follows response cursors and decodes base64 bodies', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'network.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          name: 'api',
          mode: 'network',
          startUrl: 'https://example.com/page/1',
          output: 'api.jsonl',
          maxPages: 3,
          network: { urlPattern: '/api/cards', itemsPath: 'data.items', nextPath: 'data.next' },
        }),
      )
      const written: CommandResponse[] = []
      let currentUrl = ''
      const context = createContext((command, args) => {
        if (command === 'goto') {
          currentUrl = String(args.url)
          return { url: currentUrl }
        }
        if (command === 'network' && args.action === 'requests') {
          return { requests: [{ id: 'request-1' }] }
        }
        if (command === 'network' && args.action === 'request') {
          const body = currentUrl.endsWith('/page/1')
            ? { data: { items: [{ id: 1 }], next: '/page/2' } }
            : { data: { items: [{ id: 2 }], next: null } }
          return {
            request: {
              responseBody: currentUrl.endsWith('/page/1')
                ? JSON.stringify(body)
                : Buffer.from(JSON.stringify(body)).toString('base64'),
              responseBodyBase64: !currentUrl.endsWith('/page/1'),
              pageEpoch: 4,
            },
          }
        }
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(0)
      const lines = (await readFile(path.join(directory, 'api.jsonl'), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)._meta).toMatchObject({ page: 1, requestId: 'request-1' })
      expect(JSON.parse(lines[1]!)._meta).toMatchObject({ page: 2, pageEpoch: 4 })
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        version: 2,
        status: 'completed',
        nextPage: 3,
        itemCount: 2,
      })
      expect(written.at(-1)).toMatchObject({ ok: true, result: { itemCount: 2, pageCount: 2 } })
    })
  })

  test('failed network run saves context and resume continues without duplicate items', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'resume.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          name: 'resume',
          mode: 'network',
          startUrl: 'https://example.com/page/1',
          output: 'resume.jsonl',
          network: { urlPattern: '/api/cards', itemsPath: 'data.items' },
        }),
      )
      const written: CommandResponse[] = []
      let available = false
      const context = createContext((command, args) => {
        if (command === 'goto') return { url: args.url }
        if (command === 'network' && args.action === 'requests') {
          return { requests: available ? [{ id: 'request-1' }] : [] }
        }
        if (command === 'network' && args.action === 'request') {
          return { request: { responseBody: JSON.stringify({ data: { items: [{ id: 1 }] } }) } }
        }
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(1)
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        version: 2,
        status: 'failed',
        nextPage: 1,
        itemCount: 0,
      })
      available = true
      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
      expect(checkpoint).toMatchObject({ version: 2, status: 'completed', itemCount: 1 })
      expect(checkpoint.items).toBeUndefined()
      expect(checkpoint.failures).toHaveLength(1)
      const output = (await readFile(path.join(directory, 'resume.jsonl'), 'utf8')).trim()
      expect(output.split('\n')).toHaveLength(1)
    })
  })

  test('multi page collect only appends to the output and resume does not duplicate items', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'pages.json')
      const outputPath = path.join(directory, 'pages.jsonl')
      await writeFile(
        checkpointPath,
        JSON.stringify(
          networkSpec({
            output: 'pages.jsonl',
            maxPages: 3,
            network: {
              urlPattern: '/api/cards',
              itemsPath: 'data.items',
              nextPath: 'data.next',
            },
          }),
        ),
      )
      const written: CommandResponse[] = []
      let currentUrl = ''
      let secondPageAvailable = false
      const context = createContext((command, args) => {
        if (command === 'goto') {
          currentUrl = String(args.url)
          return { url: currentUrl }
        }
        if (command === 'network' && args.action === 'requests') {
          if (currentUrl.endsWith('/page/2') && !secondPageAvailable) return { requests: [] }
          return { requests: [{ id: 'request-1' }] }
        }
        if (command === 'network' && args.action === 'request') {
          const id = currentUrl.endsWith('/page/1') ? 1 : currentUrl.endsWith('/page/2') ? 2 : 3
          const next = id === 1 ? '/page/2' : id === 2 ? '/page/3' : null
          return {
            request: {
              responseBody: JSON.stringify({ data: { items: [{ id }], next } }),
            },
          }
        }
        throw new Error(`unexpected ${command}`)
      }, written)

      // 第二页失败：输出里已经有第一页的条目
      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(1)
      const afterFirstPage = await readFile(outputPath, 'utf8')
      expect(afterFirstPage.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        status: 'failed',
        nextPage: 2,
        itemCount: 1,
      })

      secondPageAvailable = true
      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      const finalOutput = await readFile(outputPath, 'utf8')
      // 只追加：第一页的字节原样保留在文件头部
      expect(finalOutput.startsWith(afterFirstPage)).toBe(true)
      const lines = finalOutput.trim().split('\n')
      expect(lines).toHaveLength(3)
      expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2, 3])
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        version: 2,
        status: 'completed',
        itemCount: 3,
        nextPage: 4,
      })
    })
  })

  test('the feed signature helper detects a synchronous list replacement', () => {
    const scope = globalThis as { document?: unknown }
    const originalDocument = scope.document
    let cards: unknown[] = [fakeCard('alpha', 'a'), fakeCard('beta', 'b')]
    scope.document = {
      querySelectorAll: (selector: string) => (selector === '.card' ? cards : []),
    }
    try {
      const baseline = runSignatureEval('.card')
      expect(baseline).toContain('alpha')
      expect(baseline).toContain('beta')

      // 列表没变时等待条件不成立
      expect(runSignatureWait('.card', baseline as string)).toBe(false)

      // 同步替换整张列表：等待条件立刻成立
      cards = [fakeCard('delta', 'd')]
      expect(runSignatureWait('.card', baseline as string)).toBe(true)

      // 隐藏节点不参与签名
      cards = [
        {
          ...fakeCard('hidden', 'h'),
          getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        },
      ]
      expect(runSignatureEval('.card')).toBeNull()
    } finally {
      scope.document = originalDocument
    }
  })

  test('feed pagination captures a list signature before the click and waits for a change', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'paging.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          name: 'paging',
          mode: 'feed',
          startUrl: 'https://example.com/page/1',
          output: 'paging.jsonl',
          maxPages: 2,
          feed: { selector: '.card', nextSelector: '.next' },
        }),
      )
      const written: CommandResponse[] = []
      const calls: Array<{ command: string; args: Record<string, unknown> }> = []
      const baseline = '3:alpha~a~0~0~100~50|beta~b~0~0~100~50'
      let signature = baseline
      let currentUrl = 'https://example.com/page/1'
      const context = createContext((command, args) => {
        calls.push({ command, args })
        if (command === 'goto') {
          currentUrl = String(args.url)
          return { url: currentUrl }
        }
        if (command === 'feed') {
          return currentUrl.endsWith('/page/2')
            ? { items: [{ author: 'Delta', text: 'fresh' }] }
            : { items: [{ author: 'Alpha', text: 'old' }] }
        }
        if (command === 'eval') return { signature }
        if (command === 'click') {
          // 同步替换整张列表：click 返回时签名已经变了
          signature = '1:delta~fresh~0~0~100~50'
          currentUrl = 'https://example.com/page/2'
          return { ok: true }
        }
        if (command === 'wait') {
          // 等待条件必须内嵌点击前的基线签名，且当前签名已经不同
          if (args.type !== 'fn') throw new Error('feed pagination must wait with type fn')
          const expression = String(args.fn)
          if (!expression.includes(JSON.stringify(baseline))) {
            throw new Error('wait fn does not carry the pre-click baseline signature')
          }
          if (signature === baseline) throw new Error('signature did not change after the click')
          return { waited: true, condition: 'fn' }
        }
        if (command === 'get') return currentUrl
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(0)

      const order = calls.map((call) => call.command)
      expect(order.indexOf('feed')).toBeGreaterThanOrEqual(0)
      // 点击前读基线，点击后等待变化
      expect(order.indexOf('eval')).toBeGreaterThan(order.indexOf('feed'))
      expect(order.indexOf('eval')).toBeLessThan(order.indexOf('click'))
      expect(order.indexOf('click')).toBeLessThan(order.indexOf('wait'))

      const evalCall = calls.find((call) => call.command === 'eval')!
      expect((evalCall.args.args as { selector?: string } | undefined)?.selector).toBe('.card')
      const waitCall = calls.find((call) => call.command === 'wait')!
      expect(waitCall.args.type).toBe('fn')
      expect(waitCall.args.state).toBeUndefined()
      expect(waitCall.args.timeout).toBe(30000)
      // 不再使用 wait new
      expect(calls.some((call) => call.command === 'wait' && call.args.state === 'new')).toBe(false)

      const output = (await readFile(path.join(directory, 'paging.jsonl'), 'utf8'))
        .trim()
        .split('\n')
      expect(output).toHaveLength(2)
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        version: 2,
        status: 'completed',
        itemCount: 2,
        nextPage: 3,
      })
    })
  })

  test('a feed list signature that cannot be read fails the page instead of advancing', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'nosig.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          name: 'nosig',
          mode: 'feed',
          startUrl: 'https://example.com/page/1',
          output: 'nosig.jsonl',
          maxPages: 2,
          feed: { selector: '.card', nextSelector: '.next' },
        }),
      )
      const written: CommandResponse[] = []
      const context = createContext((command, args) => {
        if (command === 'goto') return { url: args.url }
        if (command === 'feed') return { items: [{ author: 'Alpha', text: 'old' }] }
        // 没有任何可见卡片：签名读不到
        if (command === 'eval') return { signature: null }
        if (command === 'click') throw new Error('click must not run without a baseline signature')
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(1)
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
      expect(checkpoint).toMatchObject({ status: 'failed', nextPage: 1 })
      expect(checkpoint.failures[0]).toMatchObject({
        code: 'COLLECT_FEED_SIGNATURE_UNAVAILABLE',
      })
    })
  })

  test('resume re-grabs a page whose items were already appended and skips duplicates', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'crash.json')
      const outputPath = path.join(directory, 'crash.jsonl')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          name: 'crash',
          mode: 'feed',
          startUrl: 'https://example.com/page/1',
          output: 'crash.jsonl',
          maxPages: 2,
          feed: { nextSelector: '.next' },
        }),
      )
      const written: CommandResponse[] = []
      let currentUrl = 'https://example.com/page/1'
      let clickCalls = 0
      let signature = '1:ada~hello~0~0~100~50'
      const context = createContext((command, args) => {
        if (command === 'goto') {
          currentUrl = String(args.url)
          return { url: currentUrl }
        }
        if (command === 'feed') {
          return currentUrl.endsWith('/page/2')
            ? { items: [{ author: 'Bob', text: 'second' }] }
            : { items: [{ author: 'Ada', text: 'hello' }] }
        }
        if (command === 'eval') return { signature }
        if (command === 'click') {
          clickCalls += 1
          // 第一次翻页失败：条目已经落盘，但 checkpoint 还没推进
          if (clickCalls === 1) throw new Error('click failed')
          currentUrl = 'https://example.com/page/2'
          signature = '1:bob~second~0~0~100~50'
          return { ok: true }
        }
        if (command === 'wait') return { ok: true }
        if (command === 'get') return currentUrl
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(1)
      const afterCrash = await readFile(outputPath, 'utf8')
      expect(afterCrash.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        version: 2,
        status: 'failed',
        nextPage: 1,
        itemCount: 1,
      })

      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      const finalOutput = await readFile(outputPath, 'utf8')
      expect(finalOutput.startsWith(afterCrash)).toBe(true)
      const lines = finalOutput.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines.map((line) => JSON.parse(line).author)).toEqual(['Ada', 'Bob'])
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        version: 2,
        status: 'completed',
        itemCount: 2,
        nextPage: 3,
      })
    })
  })

  test('a version 1 checkpoint is migrated once and keeps its items', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'legacy.json')
      const outputPath = path.join(directory, 'legacy.jsonl')
      const legacyItem = {
        id: 1,
        title: 'old',
        _meta: {
          task: 'legacy',
          mode: 'network',
          page: 1,
          sourceUrl: 'https://example.com/page/1',
        },
      }
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 1,
          spec: {
            name: 'legacy',
            mode: 'network',
            startUrl: 'https://example.com/page/2',
            output: 'legacy.jsonl',
            network: { urlPattern: '/api/cards', itemsPath: 'data.items' },
          },
          status: 'failed',
          nextUrl: 'https://example.com/page/2',
          nextPage: 2,
          items: [legacyItem],
          failures: [
            {
              at: '2026-01-01T00:00:00.000Z',
              page: 2,
              sourceUrl: 'https://example.com/page/2',
              message: 'boom',
              code: 'NETWORK_DATA_NOT_FOUND',
            },
          ],
        }),
      )
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 2 }])

      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
      expect(checkpoint.version).toBe(2)
      expect(checkpoint.items).toBeUndefined()
      expect(checkpoint.itemCount).toBe(2)
      expect(checkpoint.nextPage).toBe(3)
      // v1 的失败记录必须保留
      expect(checkpoint.failures).toHaveLength(1)
      expect(checkpoint.failures[0]).toMatchObject({ message: 'boom' })
      expect(String(checkpoint.warnings)).toContain('version 1')

      const lines = (await readFile(outputPath, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      // 迁移保留了旧条目的 _meta
      expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, _meta: { page: 1, task: 'legacy' } })
      expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2 })
    })
  })

  test('a completed version 1 checkpoint stays a no-op and reports its item count', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'legacy-done.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 1,
          spec: {
            name: 'legacy',
            mode: 'network',
            output: 'legacy-done.jsonl',
            network: { urlPattern: '/api/cards', itemsPath: 'data.items' },
          },
          status: 'completed',
          nextUrl: '',
          nextPage: 3,
          items: [{ id: 1 }, { id: 2 }],
          failures: [],
        }),
      )
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 3 }])

      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      expect(written.at(-1)).toMatchObject({
        ok: true,
        result: { itemCount: 2, status: 'completed' },
      })
    })
  })

  test('an incomplete trailing record is dropped with a warning and the valid prefix is kept', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'broken.json')
      const outputPath = path.join(directory, 'broken.jsonl')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 2,
          spec: networkSpec({ output: 'broken.jsonl' }),
          status: 'running',
          nextUrl: 'https://example.com/page/1',
          nextPage: 1,
          itemCount: 1,
          failures: [],
        }),
      )
      await writeFile(
        outputPath,
        `${JSON.stringify({ id: 1, _meta: { task: 'cards', mode: 'network', page: 1 } })}\n{"id": 2, "ti`,
      )
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 3 }])

      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      const output = await readFile(outputPath, 'utf8')
      const lines = output.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1 })
      expect(JSON.parse(lines[1]!)).toMatchObject({ id: 3 })
      expect(output).not.toContain('"ti"')

      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
      expect(checkpoint.itemCount).toBe(2)
      expect(String(checkpoint.warnings)).toContain('incomplete trailing JSONL record')
      expect(written.at(-1)).toMatchObject({ ok: true, result: { itemCount: 2 } })
      const warnings =
        (written.at(-1) as { result?: { warnings?: string[] } }).result?.warnings ?? []
      expect(warnings.join(' ')).toContain('incomplete trailing JSONL record')
    })
  })

  test('a valid record without a trailing newline is not glued to the next append', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'nonl.json')
      const outputPath = path.join(directory, 'nonl.jsonl')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 2,
          spec: networkSpec({ output: 'nonl.jsonl' }),
          status: 'running',
          nextUrl: 'https://example.com/page/1',
          nextPage: 1,
          itemCount: 1,
          failures: [],
        }),
      )
      await writeFile(
        outputPath,
        JSON.stringify({ id: 1, _meta: { task: 'cards', mode: 'network', page: 1 } }),
      )
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 2 }])

      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      const output = await readFile(outputPath, 'utf8')
      const lines = output.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1 })
      expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2 })
    })
  })

  test('a malformed record in the middle fails clearly and does not advance the checkpoint', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'corrupt.json')
      const outputPath = path.join(directory, 'corrupt.jsonl')
      const checkpointText = JSON.stringify({
        version: 2,
        spec: networkSpec({ output: 'corrupt.jsonl' }),
        status: 'running',
        nextUrl: 'https://example.com/page/1',
        nextPage: 1,
        itemCount: 1,
        failures: [],
      })
      await writeFile(checkpointPath, checkpointText)
      await writeFile(
        outputPath,
        `${JSON.stringify({ id: 1 })}\n{"id": 2\n${JSON.stringify({ id: 3 })}\n`,
      )
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 4 }])

      await expect(
        collectCommandRegistry.collect!(['resume', checkpointPath], context),
      ).rejects.toMatchObject({ code: 'COLLECT_OUTPUT_CORRUPT' })
      // checkpoint 没有被推进
      expect(await readFile(checkpointPath, 'utf8')).toBe(checkpointText)
      expect(written).toHaveLength(0)
    })
  })

  test('a missing output is reported when the checkpoint already holds items', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'missing.json')
      const checkpointText = JSON.stringify({
        version: 2,
        spec: networkSpec(),
        status: 'running',
        nextUrl: 'https://example.com/page/1',
        nextPage: 2,
        itemCount: 3,
        failures: [],
      })
      await writeFile(checkpointPath, checkpointText)
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 9 }])

      await expect(
        collectCommandRegistry.collect!(['resume', checkpointPath], context),
      ).rejects.toMatchObject({ code: 'COLLECT_OUTPUT_MISSING' })
      expect(await readFile(checkpointPath, 'utf8')).toBe(checkpointText)
    })
  })

  test('a version 2 checkpoint without a usable itemCount is rejected', async () => {
    const invalidCounts: Array<Record<string, unknown>> = [
      {},
      { itemCount: -1 },
      { itemCount: 1.5 },
      { itemCount: '3' },
      { itemCount: null },
    ]
    for (const override of invalidCounts) {
      await withTempDir(async (directory) => {
        const checkpointPath = path.join(directory, 'bad-count.json')
        const outputPath = path.join(directory, 'cards.jsonl')
        const checkpointText = JSON.stringify({
          version: 2,
          spec: networkSpec(),
          status: 'running',
          nextUrl: 'https://example.com/page/1',
          nextPage: 1,
          failures: [],
          ...override,
        })
        await writeFile(checkpointPath, checkpointText)
        const written: CommandResponse[] = []
        const context = networkContext(written, [{ id: 1 }])

        await expect(
          collectCommandRegistry.collect!(['resume', checkpointPath], context),
        ).rejects.toMatchObject({ code: 'INVALID_COLLECT_CHECKPOINT' })
        // 不写 checkpoint，也不创建输出文件
        expect(await readFile(checkpointPath, 'utf8')).toBe(checkpointText)
        expect(await fileExists(outputPath)).toBe(false)
        expect(written).toHaveLength(0)
      })
    }
  })

  test('an output shorter than the checkpoint is reported instead of shrinking the baseline', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'short.json')
      const outputPath = path.join(directory, 'short.jsonl')
      const checkpointText = JSON.stringify({
        version: 2,
        spec: networkSpec({ output: 'short.jsonl' }),
        status: 'running',
        nextUrl: 'https://example.com/page/1',
        nextPage: 3,
        itemCount: 3,
        failures: [],
      })
      const outputText = `${JSON.stringify({ id: 1 })}\n`
      await writeFile(checkpointPath, checkpointText)
      await writeFile(outputPath, outputText)
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 4 }])

      await expect(
        collectCommandRegistry.collect!(['resume', checkpointPath], context),
      ).rejects.toMatchObject({ code: 'COLLECT_OUTPUT_TRUNCATED' })
      // checkpoint 与输出都保持原样
      expect(await readFile(checkpointPath, 'utf8')).toBe(checkpointText)
      expect(await readFile(outputPath, 'utf8')).toBe(outputText)
      expect(written).toHaveLength(0)
    })
  })

  test('a short output is not truncated even when it ends with an incomplete record', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'short-fragment.json')
      const outputPath = path.join(directory, 'short-fragment.jsonl')
      const checkpointText = JSON.stringify({
        version: 2,
        spec: networkSpec({ output: 'short-fragment.jsonl' }),
        status: 'running',
        nextUrl: 'https://example.com/page/1',
        nextPage: 3,
        itemCount: 3,
        failures: [],
      })
      const outputText = `${JSON.stringify({ id: 1 })}\n{"id": 2, "ti`
      await writeFile(checkpointPath, checkpointText)
      await writeFile(outputPath, outputText)
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 4 }])

      await expect(
        collectCommandRegistry.collect!(['resume', checkpointPath], context),
      ).rejects.toMatchObject({ code: 'COLLECT_OUTPUT_TRUNCATED' })
      // 末尾残片不能先被截掉
      expect(await readFile(outputPath, 'utf8')).toBe(outputText)
      expect(await readFile(checkpointPath, 'utf8')).toBe(checkpointText)
      expect(written).toHaveLength(0)
    })
  })

  test('a missing output is recreated when the checkpoint has no items yet', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'empty.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 2,
          spec: networkSpec(),
          status: 'running',
          nextUrl: 'https://example.com/page/1',
          nextPage: 1,
          itemCount: 0,
          failures: [],
        }),
      )
      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 1 }])

      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      const output = await readFile(path.join(directory, 'cards.jsonl'), 'utf8')
      expect(output.trim().split('\n')).toHaveLength(1)
    })
  })

  test('a large output is resumed by scanning it instead of rewriting it', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'large.json')
      const outputPath = path.join(directory, 'large.jsonl')
      const recordCount = 20_000
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 2,
          spec: networkSpec({ output: 'large.jsonl' }),
          status: 'running',
          nextUrl: 'https://example.com/page/1',
          nextPage: 2,
          itemCount: recordCount,
          failures: [],
        }),
      )
      // 分批写入，避免测试自己先构造一个巨大的字符串
      let batch = ''
      for (let index = 0; index < recordCount; index += 1) {
        batch += `${JSON.stringify({ id: index, title: `item-${index}` })}\n`
        if (batch.length > 64_000) {
          await appendFile(outputPath, batch, 'utf8')
          batch = ''
        }
      }
      if (batch) await appendFile(outputPath, batch, 'utf8')
      const firstLine = (await readFile(outputPath, 'utf8')).split('\n')[0]!

      const written: CommandResponse[] = []
      const context = networkContext(written, [{ id: 'new' }])
      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)

      // 恢复走的是流式扫描：文件不会被整体重写，已有条目原样保留
      const output = await readFile(outputPath, 'utf8')
      expect(output.split('\n')[0]).toBe(firstLine)
      expect(output.trim().split('\n')).toHaveLength(recordCount + 1)
      // checkpoint 不会随输出规模膨胀
      const checkpointText = await readFile(checkpointPath, 'utf8')
      expect(checkpointText.length).toBeLessThan(1024)
      expect(JSON.parse(checkpointText)).toMatchObject({ itemCount: recordCount + 1 })
    })
  })
})
