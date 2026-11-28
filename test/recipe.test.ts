import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { recipeCommandRegistry } from '../src/cli/commands/recipe.js'
import { createSession } from '../src/core/sessions.js'
import {
  isValidIsoTimestamp,
  isValidRecipeName,
  normalizeRecipeSpec,
  RECIPE_MAX_SCRIPT_BYTES,
} from '../src/core/recipe.js'
import type { CommandResponse } from '../src/cli/client.js'
import type { CommandContext } from '../src/cli/commands/types.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

// ---------- 通用工具 ----------

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-recipe-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

interface RequestCall {
  command: string
  args: Record<string, unknown>
}

interface ContextOptions {
  currentUrl?: string
  gotoError?: CommandResponse['error']
  evalError?: CommandResponse['error']
  /** 直接指定 eval 的 result，用于模拟扩展对原始值/对象的不同返回形态 */
  rawEvalResult?: () => unknown
}

/**
 * 在 Node 里真实执行配方脚本。
 *
 * 扩展把 script 当作 async function body 包一层后再执行，这里用 AsyncFunction 模拟同一语义，
 * 测试里的 value 因此来自脚本真实计算，而不是 mock 里写死的字符串。
 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>

async function executeScript(script: string, args: Record<string, unknown>): Promise<unknown> {
  return await new AsyncFunction('args', script)(args)
}

function createContext(
  homeDir: string,
  options: ContextOptions = {},
): { context: CommandContext; calls: RequestCall[]; written: unknown[] } {
  const calls: RequestCall[] = []
  const written: unknown[] = []
  let currentUrl = options.currentUrl ?? ''

  const context = {
    flags: { server: 'http://mock', engine: 'chromium' },
    homeDir,
    requestCommand: async (_baseUrl: string, command: string, args: object = {}) => {
      const record = args as Record<string, unknown>
      calls.push({ command, args: record })
      if (command === 'get' && record.attr === 'url') {
        return { ok: true, result: currentUrl }
      }
      if (command === 'goto') {
        if (options.gotoError) return { ok: false, error: options.gotoError }
        currentUrl = String(record.url)
        return { ok: true, result: { url: currentUrl } }
      }
      if (command === 'eval') {
        if (options.evalError) return { ok: false, error: options.evalError }
        if (options.rawEvalResult) {
          return { ok: true, result: options.rawEvalResult() }
        }
        const value = await executeScript(
          String(record.script),
          (record.args as Record<string, unknown>) ?? {},
        )
        return { ok: true, result: { value } }
      }
      return { ok: true, result: {} }
    },
    writeResult: (payload: unknown) => {
      written.push(payload)
    },
    writeHelp: () => 0,
  } as unknown as CommandContext

  return { context, calls, written }
}

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'demo',
    description: 'demo recipe',
    entryUrl: 'https://example.com/app',
    params: [{ name: 'q', description: 'query', required: true }],
    script: 'return args.q',
    lastVerified: null,
    ...overrides,
  }
}

async function writeSpecFile(
  directory: string,
  value: unknown,
  fileName = 'spec.json',
): Promise<string> {
  const filePath = path.join(directory, fileName)
  await writeFile(filePath, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  return filePath
}

function lastWritten(written: unknown[]): Record<string, unknown> {
  return written[written.length - 1] as Record<string, unknown>
}

function errorCodeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code
}

async function runRecipe(rest: string[], context: CommandContext): Promise<number | void> {
  return await recipeCommandRegistry.recipe(rest, context)
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<Error> {
  try {
    await promise
  } catch (error) {
    expect(errorCodeOf(error)).toBe(code)
    return error as Error
  }
  throw new Error(`expected failure with code ${code}`)
}

// ---------- spec 校验 ----------

describe('recipe spec normalization', () => {
  test('保留全字段并规范化可选值', () => {
    const normalized = normalizeRecipeSpec({
      name: 'my_recipe-1',
      description: '  A reusable recipe  ',
      entryUrl: 'https://example.com/app',
      params: [
        { name: 'q', description: 'query', required: true },
        { name: 'limit', description: '' },
      ],
      script: 'const q = args.q\nreturn { q }',
      lastVerified: '2026-01-02T03:04:05.000Z',
    })

    expect(normalized).toEqual({
      name: 'my_recipe-1',
      description: 'A reusable recipe',
      entryUrl: 'https://example.com/app',
      params: [
        { name: 'q', description: 'query', required: true },
        { name: 'limit', description: '', required: false },
      ],
      script: 'const q = args.q\nreturn { q }',
      lastVerified: '2026-01-02T03:04:05.000Z',
    })
  })

  test('省略 description 与 lastVerified 时给出稳定默认值', () => {
    const normalized = normalizeRecipeSpec({
      name: 'demo',
      entryUrl: 'http://localhost:8080/',
      params: [],
      script: 'return 1',
    })
    expect(normalized).toEqual({
      name: 'demo',
      entryUrl: 'http://localhost:8080/',
      params: [],
      script: 'return 1',
      lastVerified: null,
    })
    expect(normalized.description).toBeUndefined()
  })

  test('拒绝非法 name、URL、params、script 与 lastVerified', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['uppercase name', { name: 'Demo' }],
      ['leading dash', { name: '-demo' }],
      ['dot in name', { name: 'demo.v1' }],
      ['name too long', { name: 'a'.repeat(65) }],
      ['empty name', { name: '' }],
      ['relative url', { entryUrl: '/app' }],
      ['ftp url', { entryUrl: 'ftp://example.com/app' }],
      ['javascript url', { entryUrl: 'javascript:alert(1)' }],
      ['params not array', { params: {} }],
      [
        'too many params',
        {
          params: Array.from({ length: 51 }, (_, index) => ({
            name: `p${index}`,
            description: '',
          })),
        },
      ],
      [
        'duplicate params',
        {
          params: [
            { name: 'q', description: 'a' },
            { name: 'q', description: 'b' },
          ],
        },
      ],
      ['param missing description', { params: [{ name: 'q' }] }],
      ['param required not boolean', { params: [{ name: 'q', description: '', required: 'yes' }] }],
      ['empty script', { script: '   \n\t ' }],
      ['script not string', { script: 42 }],
      ['script too large', { script: 'x'.repeat(RECIPE_MAX_SCRIPT_BYTES + 1) }],
      ['lastVerified date only', { lastVerified: '2026-01-01' }],
      ['lastVerified invalid date', { lastVerified: '2026-13-01T00:00:00Z' }],
      ['lastVerified non-string', { lastVerified: 123 }],
      ['description not string', { description: 1 }],
    ]

    for (const [, overrides] of cases) {
      expect(() => normalizeRecipeSpec(spec(overrides))).toThrow()
    }
    expect(() => normalizeRecipeSpec([])).toThrow()
    expect(() => normalizeRecipeSpec('demo')).toThrow()
  })

  test('name 与 ISO 时间判定符合存储约束', () => {
    expect(isValidRecipeName('a')).toBe(true)
    expect(isValidRecipeName('a_b-c9')).toBe(true)
    expect(isValidRecipeName('a'.repeat(64))).toBe(true)
    expect(isValidRecipeName('A')).toBe(false)
    expect(isValidRecipeName('../evil')).toBe(false)
    expect(isValidRecipeName('a/b')).toBe(false)
    expect(isValidIsoTimestamp('2026-11-28T12:00:00Z')).toBe(true)
    expect(isValidIsoTimestamp('2026-11-28T12:00:00.123+08:00')).toBe(true)
    expect(isValidIsoTimestamp('2026-11-28')).toBe(false)
    expect(isValidIsoTimestamp('not-a-time')).toBe(false)
  })
})

// ---------- save / list / show ----------

describe('recipe save, list and show', () => {
  test('save 写真实文件，list 只回元数据，show 回完整脚本', async () => {
    await withTempDir(async (directory) => {
      const specPath = await writeSpecFile(directory, spec())
      const { context, written } = createContext(directory)

      expect(await runRecipe(['save', 'demo', specPath], context)).toBe(0)
      expect(lastWritten(written)).toMatchObject({
        ok: true,
        result: { name: 'demo', overwritten: false, lastVerified: null },
      })

      const storedPath = path.join(directory, 'recipes', 'demo.json')
      const stored = JSON.parse(await readFile(storedPath, 'utf8')) as Record<string, unknown>
      expect(stored).toMatchObject({
        name: 'demo',
        entryUrl: 'https://example.com/app',
        script: 'return args.q',
        lastVerified: null,
      })

      const listContext = createContext(directory)
      await runRecipe(['list'], listContext.context)
      const listPayload = lastWritten(listContext.written) as {
        result: { count: number; recipes: Array<Record<string, unknown>> }
      }
      expect(listPayload.result.count).toBe(1)
      expect(listPayload.result.recipes[0]).toMatchObject({
        name: 'demo',
        entryUrl: 'https://example.com/app',
      })
      expect('script' in listPayload.result.recipes[0]!).toBe(false)

      const showContext = createContext(directory)
      await runRecipe(['show', 'demo'], showContext.context)
      const showPayload = lastWritten(showContext.written) as {
        result: { recipe: Record<string, unknown> }
      }
      expect(showPayload.result.recipe.script).toBe('return args.q')
    })
  })

  test('目录与文件权限尽量收紧（POSIX）', async () => {
    if (process.platform === 'win32') return
    await withTempDir(async (directory) => {
      const specPath = await writeSpecFile(directory, spec())
      const { context } = createContext(directory)
      await runRecipe(['save', 'demo', specPath], context)

      expect((await stat(path.join(directory, 'recipes'))).mode & 0o777).toBe(0o700)
      expect((await stat(path.join(directory, 'recipes', 'demo.json'))).mode & 0o777).toBe(0o600)
    })
  })

  test('重复保存必须先 --force', async () => {
    await withTempDir(async (directory) => {
      const firstPath = await writeSpecFile(directory, spec({ script: 'return "v1"' }), 'v1.json')
      const { context, written } = createContext(directory)
      await runRecipe(['save', 'demo', firstPath], context)

      const secondPath = await writeSpecFile(directory, spec({ script: 'return "v2"' }), 'v2.json')
      await expectFailure(runRecipe(['save', 'demo', secondPath], context), 'RECIPE_ALREADY_EXISTS')
      const storedPath = path.join(directory, 'recipes', 'demo.json')
      expect(JSON.parse(await readFile(storedPath, 'utf8')).script).toBe('return "v1"')

      expect(await runRecipe(['save', 'demo', secondPath, '--force'], context)).toBe(0)
      expect(JSON.parse(await readFile(storedPath, 'utf8')).script).toBe('return "v2"')
      expect(lastWritten(written)).toMatchObject({ ok: true, result: { overwritten: true } })
    })
  })

  test('save name 必须与 spec.name 一致', async () => {
    await withTempDir(async (directory) => {
      const specPath = await writeSpecFile(directory, spec({ name: 'other' }))
      const { context } = createContext(directory)
      await expectFailure(runRecipe(['save', 'demo', specPath], context), 'INVALID_RECIPE_SPEC')
    })
  })

  test('spec 文件缺失、非 JSON、超大与非法规格都报 INVALID_RECIPE_SPEC', async () => {
    await withTempDir(async (directory) => {
      const { context } = createContext(directory)

      await expectFailure(
        runRecipe(['save', 'demo', path.join(directory, 'missing.json')], context),
        'INVALID_RECIPE_SPEC',
      )

      const brokenPath = await writeSpecFile(directory, '{"name": "demo",', 'broken.json')
      await expectFailure(runRecipe(['save', 'demo', brokenPath], context), 'INVALID_RECIPE_SPEC')

      const hugePath = path.join(directory, 'huge.json')
      await writeFile(hugePath, 'x'.repeat(1024 * 1024 + 1))
      await expectFailure(runRecipe(['save', 'demo', hugePath], context), 'INVALID_RECIPE_SPEC')

      const badTimePath = await writeSpecFile(
        directory,
        spec({ lastVerified: 'yesterday' }),
        'bad-time.json',
      )
      await expectFailure(runRecipe(['save', 'demo', badTimePath], context), 'INVALID_RECIPE_SPEC')
    })
  })

  test('非法 name 不会造成路径穿越', async () => {
    await withTempDir(async (directory) => {
      const specPath = await writeSpecFile(directory, spec({ name: 'demo' }))
      const { context } = createContext(directory)

      await expectFailure(
        runRecipe(['save', '../escape', specPath], context),
        'CLI_INVALID_ARGUMENT',
      )
      expect(await stat(path.join(directory, 'escape.json')).catch(() => null)).toBeNull()
      expect(
        await stat(path.join(directory, 'recipes', 'escape.json')).catch(() => null),
      ).toBeNull()
    })
  })

  test('损坏的已存配方在 list/show/run 时都报 INVALID_RECIPE_SPEC', async () => {
    await withTempDir(async (directory) => {
      const recipesDir = path.join(directory, 'recipes')
      await mkdir(recipesDir, { recursive: true })
      await writeFile(path.join(recipesDir, 'broken.json'), '{"name": "broken",')

      for (const rest of [['list'], ['show', 'broken'], ['run', 'broken']]) {
        const { context } = createContext(directory)
        await expectFailure(runRecipe(rest, context), 'INVALID_RECIPE_SPEC')
      }
    })
  })

  test('文件内 name 与文件名不一致视为损坏', async () => {
    await withTempDir(async (directory) => {
      const recipesDir = path.join(directory, 'recipes')
      await mkdir(recipesDir, { recursive: true })
      await writeFile(path.join(recipesDir, 'demo.json'), JSON.stringify(spec({ name: 'other' })))

      const { context } = createContext(directory)
      await expectFailure(runRecipe(['show', 'demo'], context), 'INVALID_RECIPE_SPEC')
    })
  })

  test('missing recipe 报 RECIPE_NOT_FOUND，空目录 list 返回 0 条', async () => {
    await withTempDir(async (directory) => {
      const listContext = createContext(directory)
      await runRecipe(['list'], listContext.context)
      expect(lastWritten(listContext.written)).toMatchObject({
        ok: true,
        result: { count: 0, recipes: [] },
      })

      const showContext = createContext(directory)
      const error = await expectFailure(
        runRecipe(['show', 'nope'], showContext.context),
        'RECIPE_NOT_FOUND',
      )
      expect((error as { suggestedAction?: string }).suggestedAction).toContain('recipe list')
    })
  })
})

// ---------- 参数 ----------

describe('recipe run arguments', () => {
  async function saveForRun(directory: string, specValue: Record<string, unknown>): Promise<void> {
    const specPath = await writeSpecFile(directory, specValue)
    const { context } = createContext(directory)
    await runRecipe(['save', String(specValue.name), specPath], context)
  }

  test('--arg 可重复，值总是字符串并真实注入脚本', async () => {
    await withTempDir(async (directory) => {
      await saveForRun(
        directory,
        spec({
          params: [
            { name: 'q', description: 'query', required: true },
            { name: 'n', description: 'count' },
          ],
          script: 'return { q: args.q, n: args.n, both: `${args.q}:${args.n}` }',
        }),
      )
      const { context, calls, written } = createContext(directory, {
        currentUrl: 'https://example.com/other',
      })
      await runRecipe(['run', 'demo', '--arg', 'q=hello', '--arg', 'n=42'], context)

      const evalCall = calls.find((call) => call.command === 'eval')!
      expect(evalCall.args.args).toEqual({ q: 'hello', n: '42' })
      expect(lastWritten(written)).toMatchObject({
        ok: true,
        result: { value: { q: 'hello', n: '42', both: 'hello:42' } },
      })
    })
  })

  test('--args-json 字符串原样、非字符串 JSON.stringify', async () => {
    await withTempDir(async (directory) => {
      await saveForRun(directory, spec({ params: [], script: 'return args' }))
      const { context, calls } = createContext(directory, {
        currentUrl: 'https://example.com/other',
      })
      await runRecipe(
        [
          'run',
          'demo',
          '--args-json',
          '{"text":"abc","num":42,"flag":true,"obj":{"a":1},"nil":null}',
        ],
        context,
      )
      const evalCall = calls.find((call) => call.command === 'eval')!
      expect(evalCall.args.args).toEqual({
        text: 'abc',
        num: '42',
        flag: 'true',
        obj: '{"a":1}',
        nil: 'null',
      })
    })
  })

  test('两种参数形式互斥，重复 key 与非法形式报用法错误', async () => {
    await withTempDir(async (directory) => {
      await saveForRun(directory, spec({ params: [] }))
      const { context } = createContext(directory)

      for (const rest of [
        ['run', 'demo', '--arg', 'a=1', '--args-json', '{"b":2}'],
        ['run', 'demo', '--args-json', '{"b":2}', '--arg', 'a=1'],
        ['run', 'demo', '--arg', 'a=1', '--arg', 'a=2'],
        ['run', 'demo', '--arg', 'no-equals'],
        ['run', 'demo', '--args-json', '[1,2]'],
        ['run', 'demo', '--args-json', 'not-json'],
        ['run', 'demo', '--timeout-ms', '99'],
        ['run', 'demo', '--timeout-ms', '1800001'],
        ['run', 'demo', '--timeout-ms', '100', '--timeout-ms', '200'],
        ['run', 'demo', 'stray'],
      ]) {
        await expectFailure(runRecipe(rest, context), 'CLI_INVALID_ARGUMENT')
      }
    })
  })

  test('required 缺失或为空字符串报 RECIPE_ARGUMENTS_INVALID', async () => {
    await withTempDir(async (directory) => {
      await saveForRun(
        directory,
        spec({ params: [{ name: 'q', description: 'query', required: true }] }),
      )
      const { context } = createContext(directory, { currentUrl: 'https://example.com/other' })

      const missing = await expectFailure(
        runRecipe(['run', 'demo'], context),
        'RECIPE_ARGUMENTS_INVALID',
      )
      expect(missing.message).toContain('q')

      await expectFailure(
        runRecipe(['run', 'demo', '--arg', 'q='], context),
        'RECIPE_ARGUMENTS_INVALID',
      )
    })
  })

  test('未声明参数不拒绝，但在 warnings 中说明', async () => {
    await withTempDir(async (directory) => {
      await saveForRun(directory, spec({ params: [], script: 'return args.extra' }))
      const { context, written } = createContext(directory, {
        currentUrl: 'https://example.com/other',
      })
      await runRecipe(['run', 'demo', '--arg', 'extra=kept'], context)

      const payload = lastWritten(written) as {
        result: { value: string; warnings: string[] }
      }
      expect(payload.result.value).toBe('kept')
      expect(payload.result.warnings.join(' ')).toContain('extra')
    })
  })
})

// ---------- 执行语义 ----------

describe('recipe run and verify execution', () => {
  async function saveDemo(
    directory: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const specPath = await writeSpecFile(
      directory,
      spec({ params: [], script: 'return args.q ?? "ok"', ...overrides }),
    )
    const { context } = createContext(directory)
    await runRecipe(['save', 'demo', specPath], context)
    return path.join(directory, 'recipes', 'demo.json')
  }

  test('同源复用页面状态，不调用 goto', async () => {
    await withTempDir(async (directory) => {
      await saveDemo(directory)
      const { context, calls } = createContext(directory, {
        currentUrl: 'https://example.com/other/path',
      })
      await runRecipe(['run', 'demo'], context)
      expect(calls.some((call) => call.command === 'goto')).toBe(false)
      expect(calls.some((call) => call.command === 'eval')).toBe(true)
    })
  })

  test('跨源时先用 goto 导航 entryUrl', async () => {
    await withTempDir(async (directory) => {
      await saveDemo(directory)
      const { context, calls } = createContext(directory, {
        currentUrl: 'https://other.example/page',
      })
      await runRecipe(['run', 'demo'], context)

      const gotoCall = calls.find((call) => call.command === 'goto')!
      expect(gotoCall.args).toEqual({ url: 'https://example.com/app' })
      expect(calls.findIndex((call) => call.command === 'goto')).toBeLessThan(
        calls.findIndex((call) => call.command === 'eval'),
      )
    })
  })

  test('run 返回配方元数据且不更新 lastVerified', async () => {
    await withTempDir(async (directory) => {
      const storedPath = await saveDemo(directory)
      const before = JSON.parse(await readFile(storedPath, 'utf8')) as Record<string, unknown>
      expect(before.lastVerified).toBeNull()

      const { context, written } = createContext(directory, {
        currentUrl: 'https://example.com/other',
      })
      await runRecipe(['run', 'demo'], context)

      expect(lastWritten(written)).toEqual({
        ok: true,
        result: {
          recipe: {
            name: 'demo',
            entryUrl: 'https://example.com/app',
            lastVerified: null,
          },
          value: 'ok',
          warnings: [],
        },
      })
      const after = JSON.parse(await readFile(storedPath, 'utf8')) as Record<string, unknown>
      expect(after.lastVerified).toBeNull()
    })
  })

  test('eval 返回原始值、null 或数组时按原样透传', async () => {
    await withTempDir(async (directory) => {
      await saveDemo(directory)
      const cases: unknown[] = ['plain text', 42, null, ['a', 'b'], false, { foo: 'bar' }]

      for (const raw of cases) {
        const { context, written } = createContext(directory, {
          currentUrl: 'https://example.com/other',
          rawEvalResult: () => raw,
        })
        await runRecipe(['run', 'demo'], context)
        const payload = lastWritten(written) as { result: { value: unknown } }
        expect(payload.result.value).toEqual(raw)
      }
    })
  })

  test('verify 对原始字符串同样按原样返回并固化验证时间', async () => {
    await withTempDir(async (directory) => {
      const storedPath = await saveDemo(directory)
      const { context, written } = createContext(directory, {
        currentUrl: 'https://example.com/other',
        rawEvalResult: () => 'verified text',
      })
      await runRecipe(['verify', 'demo'], context)

      const payload = lastWritten(written) as {
        result: { verified: boolean; value: unknown; recipe: { lastVerified: string } }
      }
      expect(payload.result).toMatchObject({ verified: true, value: 'verified text' })
      const stored = JSON.parse(await readFile(storedPath, 'utf8')) as Record<string, unknown>
      expect(stored.lastVerified).toBe(payload.result.recipe.lastVerified)
    })
  })

  test('verify 成功后才写入当前 ISO 时间', async () => {
    await withTempDir(async (directory) => {
      const storedPath = await saveDemo(directory)
      const { context, written } = createContext(directory, {
        currentUrl: 'https://example.com/other',
      })
      await runRecipe(['verify', 'demo'], context)

      const payload = lastWritten(written) as {
        result: { verified: boolean; recipe: { lastVerified: string } }
      }
      expect(payload.result.verified).toBe(true)
      expect(isValidIsoTimestamp(payload.result.recipe.lastVerified)).toBe(true)

      const stored = JSON.parse(await readFile(storedPath, 'utf8')) as Record<string, unknown>
      expect(stored.lastVerified).toBe(payload.result.recipe.lastVerified)
    })
  })

  test('verify 失败保留错误码与 recipe 上下文且不写时间', async () => {
    await withTempDir(async (directory) => {
      const storedPath = await saveDemo(directory)
      const { context, written } = createContext(directory, {
        currentUrl: 'https://example.com/other',
        evalError: {
          message: 'script exploded',
          code: 'PAGE_EVALUATION_EXCEPTION',
          suggestedAction: 'Fix the page script.',
          details: { line: 3 },
        },
      })
      expect(await runRecipe(['verify', 'demo'], context)).toBe(1)

      const payload = lastWritten(written) as {
        ok: boolean
        error: {
          code: string
          message: string
          details: Record<string, unknown>
          suggestedAction: string
        }
      }
      expect(payload.ok).toBe(false)
      expect(payload.error.code).toBe('PAGE_EVALUATION_EXCEPTION')
      expect(payload.error.message).toBe('script exploded')
      expect(payload.error.details).toMatchObject({
        line: 3,
        recipe: { name: 'demo', entryUrl: 'https://example.com/app' },
      })
      expect(payload.error.suggestedAction).toContain('recipe verify demo')
      expect(payload.error.suggestedAction).toContain('lastVerified was not changed')

      const stored = JSON.parse(await readFile(storedPath, 'utf8')) as Record<string, unknown>
      expect(stored.lastVerified).toBeNull()
    })
  })

  test('导航失败保留 NAVIGATION_FAILED 且不执行脚本', async () => {
    await withTempDir(async (directory) => {
      await saveDemo(directory)
      const { context, calls, written } = createContext(directory, {
        currentUrl: 'https://other.example/page',
        gotoError: {
          message: 'navigation failed',
          code: 'NAVIGATION_FAILED',
          suggestedAction: 'Re-navigate.',
        },
      })
      expect(await runRecipe(['run', 'demo'], context)).toBe(1)

      const payload = lastWritten(written) as {
        error: { code: string; details: Record<string, unknown> }
      }
      expect(payload.error.code).toBe('NAVIGATION_FAILED')
      expect(payload.error.details.recipe).toMatchObject({ name: 'demo' })
      expect(calls.some((call) => call.command === 'eval')).toBe(false)
    })
  })

  test('timeoutMs 透传给 eval', async () => {
    await withTempDir(async (directory) => {
      await saveDemo(directory)
      const { context, calls } = createContext(directory, {
        currentUrl: 'https://example.com/other',
      })
      await runRecipe(['run', 'demo', '--timeout-ms', '2500'], context)
      expect(calls.find((call) => call.command === 'eval')!.args.timeoutMs).toBe(2500)
    })
  })
})

// ---------- CLI 端到端 ----------

function jsonResponse(payload: unknown): {
  ok: boolean
  json(): Promise<unknown>
  text(): Promise<string>
} {
  return {
    ok: true,
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
  }
}

const GLOBAL_ARGS = ['--json', '--server', 'http://127.0.0.1:3000']

describe('recipe CLI', () => {
  test('CLI save → list → show 走真实文件', async () => {
    await withTempDir(async (directory) => {
      const specPath = await writeSpecFile(directory, spec())

      const save = await runCli([...GLOBAL_ARGS, 'recipe', 'save', 'demo', specPath], undefined, {
        homeDir: directory,
      })
      expect(save.exitCode).toBe(0)
      expect(JSON.parse(save.stdout)).toMatchObject({
        ok: true,
        result: { name: 'demo', overwritten: false },
      })

      const list = await runCli([...GLOBAL_ARGS, 'recipe', 'list'], undefined, {
        homeDir: directory,
      })
      const listPayload = JSON.parse(list.stdout) as {
        result: { count: number; recipes: Array<Record<string, unknown>> }
      }
      expect(listPayload.result.count).toBe(1)
      expect(listPayload.result.recipes[0]!.script).toBeUndefined()

      const show = await runCli([...GLOBAL_ARGS, 'recipe', 'show', 'demo'], undefined, {
        homeDir: directory,
      })
      expect(JSON.parse(show.stdout)).toMatchObject({
        ok: true,
        result: { recipe: { name: 'demo', script: 'return args.q' } },
      })
    })
  })

  test('CLI run 通过 mock relay 完成 get → eval 全流程', async () => {
    await withTempDir(async (directory) => {
      const specPath = await writeSpecFile(
        directory,
        spec({ script: 'return args.q.toUpperCase()' }),
      )
      await runCli([...GLOBAL_ARGS, 'recipe', 'save', 'demo', specPath], undefined, {
        homeDir: directory,
      })

      const requests: Array<{ command?: string; args?: Record<string, unknown> }> = []
      const fetchImpl = async (_url: string, init: { body?: string }) => {
        const body = JSON.parse(String(init.body)) as {
          command?: string
          args?: Record<string, unknown>
        }
        requests.push(body)
        if (body.command === 'get') {
          return jsonResponse({ ok: true, result: 'https://example.com/current' })
        }
        if (body.command === 'eval') {
          const value = await executeScript(
            String(body.args!.script),
            body.args!.args as Record<string, unknown>,
          )
          return jsonResponse({ ok: true, result: { value } })
        }
        return jsonResponse({ ok: true, result: {} })
      }

      const result = await runCli(
        [...GLOBAL_ARGS, 'recipe', 'run', 'demo', '--arg', 'q=hello'],
        undefined,
        { homeDir: directory, fetchImpl },
      )

      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls.map((call) => call.body?.command)).toEqual(['get', 'eval'])
      expect(result.fetchCalls[1]!.body?.args).toMatchObject({
        script: 'return args.q.toUpperCase()',
        args: { q: 'hello' },
      })
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        result: { value: 'HELLO', recipe: { name: 'demo', lastVerified: null } },
      })
      // 同源复用：CLI 全流程里也没有 goto。
      expect(requests.some((request) => request.command === 'goto')).toBe(false)
    })
  })

  test('CLI 用法错误与领域错误保持统一 JSON 契约', async () => {
    await withTempDir(async (directory) => {
      const unknown = await runCli([...GLOBAL_ARGS, 'recipe', 'nope'], undefined, {
        homeDir: directory,
      })
      expect(unknown.exitCode).toBe(1)
      const unknownPayload = cliErrorPayload(unknown.stdout)
      expect(unknownPayload.error.code).toBe('CLI_INVALID_ARGUMENT')
      expect(unknownPayload.error.suggestedAction).toContain('autobrowser help')

      const specPath = await writeSpecFile(directory, spec({ name: 'other' }), 'mismatch.json')
      const mismatch = await runCli(
        [...GLOBAL_ARGS, 'recipe', 'save', 'demo', specPath],
        undefined,
        { homeDir: directory },
      )
      expect(mismatch.exitCode).toBe(1)
      expect(cliErrorPayload(mismatch.stdout).error.code).toBe('INVALID_RECIPE_SPEC')
    })
  })

  test('CLI required 缺失返回 RECIPE_ARGUMENTS_INVALID 与修复建议', async () => {
    await withTempDir(async (directory) => {
      const specPath = await writeSpecFile(directory, spec())
      await runCli([...GLOBAL_ARGS, 'recipe', 'save', 'demo', specPath], undefined, {
        homeDir: directory,
      })

      const result = await runCli([...GLOBAL_ARGS, 'recipe', 'run', 'demo'], undefined, {
        homeDir: directory,
      })
      expect(result.exitCode).toBe(1)
      const payload = cliErrorPayload(result.stdout)
      expect(payload.error.code).toBe('RECIPE_ARGUMENTS_INVALID')
      expect(payload.error.suggestedAction).toContain('--arg')
      expect(payload.error.details).toMatchObject({ recipe: 'demo', missing: ['q'] })
    })
  })

  test('命名 session 的 recipe 与默认 home 隔离', async () => {
    await withTempDir(async (directory) => {
      const baseSpec = path.join(directory, 'base.json')
      await writeFile(baseSpec, JSON.stringify(spec({ name: 'base-only' })))
      await runCli([...GLOBAL_ARGS, 'recipe', 'save', 'base-only', baseSpec], undefined, {
        homeDir: directory,
      })

      const session = await createSession(directory, 'beta', {
        relayPort: 59311,
        ipcPort: 59312,
        portInUse: async () => false,
      })
      const sessionSpec = path.join(directory, 'session.json')
      await writeFile(sessionSpec, JSON.stringify(spec({ name: 'session-only' })))
      await runCli([...GLOBAL_ARGS, 'recipe', 'save', 'session-only', sessionSpec], undefined, {
        homeDir: session.homeDir,
      })

      const defaultList = await runCli([...GLOBAL_ARGS, 'recipe', 'list'], undefined, {
        homeDir: directory,
      })
      const defaultPayload = JSON.parse(defaultList.stdout) as {
        result: { recipes: Array<{ name: string }> }
      }
      expect(defaultPayload.result.recipes.map((recipe) => recipe.name)).toEqual(['base-only'])

      const sessionList = await runCli(
        [...GLOBAL_ARGS, '--session', 'beta', 'recipe', 'list'],
        undefined,
        { homeDir: directory },
      )
      const sessionPayload = JSON.parse(sessionList.stdout) as {
        result: { recipes: Array<{ name: string }> }
      }
      expect(sessionPayload.result.recipes.map((recipe) => recipe.name)).toEqual(['session-only'])
    })
  })
})
