import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildExtractQuality,
  EXTRACT_MAX_ERRORS,
  EXTRACT_MAX_LIMIT,
  EXTRACT_PAGE_SCRIPT,
  normalizeExtractSpec,
  parseExtractResult,
  resolveExtractLimit,
  type ExtractPageResult,
} from '../src/core/extract.js'
import { HELP_ROOT } from '../src/cli/help.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

// ---------- 假 DOM：用于在 Node 里真实执行页面脚本 ----------

interface FakeNodeInit {
  tag: string
  id?: string
  classes?: string[]
  attrs?: Record<string, string>
  text?: string
  html?: string
  children?: FakeElement[]
}

type CompoundPart =
  | { kind: 'class'; name: string }
  | { kind: 'id'; name: string }
  | { kind: 'attr'; name: string; operator: string; value?: string }

/**
 * 浏览器对非法选择器抛 SyntaxError 类型的 DOMException。
 * 替身必须照做：否则生产代码里"选择器非法"的分支在测试里永远走不到。
 */
class InvalidSelectorError extends Error {
  constructor(selector: string) {
    super(
      `Failed to execute 'querySelectorAll' on 'Document': '${selector}' is not a valid selector.`,
    )
    this.name = 'SyntaxError'
  }
}

/**
 * 选择器语法合法但超出替身支持的子集。
 * 与"非法"分开报，避免把替身的能力边界误报成用户写错了选择器。
 */
class UnsupportedSelectorError extends Error {
  constructor(selector: string) {
    super(`unsupported test selector: ${selector}`)
  }
}

/** 属性选择器体：标识符，或标识符 + 运算符 + 值（值可带引号）。 */
const ATTRIBUTE_BODY = /^[-_a-zA-Z][-\w]*(?:\s*[~^|$*]?=\s*(?:"[^"]*"|'[^']*'|[-_a-zA-Z][-\w]*))?$/

/** 找到属性选择器的结束 ']'，跳过引号内的 ']'；没有配对的 ']' 返回 -1。 */
function findAttributeEnd(selector: string, start: number): number {
  let quote: string | null = null
  for (let index = start + 1; index < selector.length; index += 1) {
    const char = selector[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ']') return index
    // 属性选择器内部不允许再出现 '['
    if (char === '[') return -1
  }
  return -1
}

/**
 * 只判断"一定非法"的选择器：括号不配对、属性体写坏。
 * 合法但不支持的写法留给解析器报 UnsupportedSelectorError。
 */
function assertValidSelector(selector: string): void {
  const trimmed = selector.trim()
  if (!trimmed) throw new InvalidSelectorError(selector)
  let index = 0
  while (index < trimmed.length) {
    const char = trimmed[index]
    if (char === '[') {
      const close = findAttributeEnd(trimmed, index)
      if (close === -1) throw new InvalidSelectorError(selector)
      if (!ATTRIBUTE_BODY.test(trimmed.slice(index + 1, close))) {
        throw new InvalidSelectorError(selector)
      }
      index = close + 1
      continue
    }
    if (char === ']') throw new InvalidSelectorError(selector)
    index += 1
  }
}

/** 极简 CSS 复合选择器解析，够测试用；合法但不支持的写法抛 UnsupportedSelectorError。 */
function parseCompound(compound: string): { tag?: string; parts: CompoundPart[] } {
  let rest = compound
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/)
  const tag = tagMatch ? tagMatch[0].toLowerCase() : undefined
  if (tagMatch) rest = rest.slice(tagMatch[0].length)

  const parts: CompoundPart[] = []
  while (rest) {
    const classMatch = rest.match(/^\.([\w-]+)/)
    if (classMatch) {
      parts.push({ kind: 'class', name: classMatch[1] })
      rest = rest.slice(classMatch[0].length)
      continue
    }
    const idMatch = rest.match(/^#([\w-]+)/)
    if (idMatch) {
      parts.push({ kind: 'id', name: idMatch[1] })
      rest = rest.slice(idMatch[0].length)
      continue
    }
    const attrMatch = rest.match(/^\[([-\w]+)(?:([~^|$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([-\w]+)))?\]/)
    if (attrMatch) {
      const value = attrMatch[3] ?? attrMatch[4] ?? attrMatch[5]
      parts.push({
        kind: 'attr',
        name: attrMatch[1],
        operator: attrMatch[2] ?? '=',
        ...(value === undefined ? {} : { value }),
      })
      rest = rest.slice(attrMatch[0].length)
      continue
    }
    throw new UnsupportedSelectorError(compound)
  }
  return { tag, parts }
}

function parseSelector(selector: string): string[] {
  assertValidSelector(selector)
  const parts = selector.trim().split(/\s+/)
  for (const part of parts) parseCompound(part)
  return parts
}

function matchesCompound(element: FakeElement, compound: string): boolean {
  const parsed = parseCompound(compound)
  if (parsed.tag && element.tag !== parsed.tag) return false
  for (const part of parsed.parts) {
    if (part.kind === 'class' && !element.classes.has(part.name)) return false
    if (part.kind === 'id' && element.id !== part.name) return false
    if (part.kind === 'attr') {
      if (!(part.name in element.attributes)) return false
      if (part.value === undefined) continue
      const actual = element.attributes[part.name]
      if (part.operator === '=') {
        if (actual !== part.value) return false
      } else if (part.operator === '~=') {
        if (!actual.split(/\s+/).includes(part.value)) return false
      } else if (part.operator === '^=') {
        if (!actual.startsWith(part.value)) return false
      } else if (part.operator === '$=') {
        if (!actual.endsWith(part.value)) return false
      } else if (!actual.includes(part.value)) return false
    }
  }
  return true
}

function matchesChain(element: FakeElement, parts: string[]): boolean {
  if (!matchesCompound(element, parts[parts.length - 1])) return false
  let ancestor = element.parent
  let index = parts.length - 2
  while (index >= 0 && ancestor) {
    if (matchesCompound(ancestor, parts[index])) index -= 1
    ancestor = ancestor.parent
  }
  return index < 0
}

class FakeElement {
  readonly tag: string
  readonly id: string
  readonly classes: Set<string>
  readonly attributes: Record<string, string>
  readonly children: FakeElement[] = []
  parent: FakeElement | null = null
  private readonly ownText: string
  private readonly htmlOverride: string | undefined

  constructor(init: FakeNodeInit) {
    this.tag = init.tag
    this.id = init.id ?? ''
    this.classes = new Set(init.classes ?? [])
    this.attributes = init.attrs ? { ...init.attrs } : {}
    this.ownText = init.text ?? ''
    this.htmlOverride = init.html
    for (const child of init.children ?? []) {
      child.parent = this
      this.children.push(child)
    }
  }

  get innerText(): string {
    return this.ownText
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }

  get outerHTML(): string {
    return this.htmlOverride ?? `<${this.tag}>${this.textContent}</${this.tag}>`
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = parseSelector(selector)
    const result: FakeElement[] = []
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (matchesChain(child, parts)) result.push(child)
        visit(child)
      }
    }
    visit(this)
    return result
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

class FakeDocument {
  readonly baseURI = 'https://example.com/base/'
  readonly nodes: FakeElement[] = []

  querySelectorAll(selector: string): FakeElement[] {
    const parts = parseSelector(selector)
    const result: FakeElement[] = []
    const visit = (node: FakeElement): void => {
      if (matchesChain(node, parts)) result.push(node)
      for (const child of node.children) visit(child)
    }
    for (const node of this.nodes) visit(node)
    return result
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

function el(init: FakeNodeInit): FakeElement {
  return new FakeElement(init)
}

/** 用假 DOM 真实执行 EXTRACT_PAGE_SCRIPT；脚本只依赖 args 与 document。 */
function runPageScript(spec: unknown, document: FakeDocument): ExtractPageResult {
  const run = new Function('args', 'document', `return ${EXTRACT_PAGE_SCRIPT}`)
  return run({ spec }, document) as ExtractPageResult
}

function sampleDocument(): FakeDocument {
  const document = new FakeDocument()
  document.nodes.push(
    el({
      tag: 'li',
      classes: ['item'],
      children: [
        el({ tag: 'span', classes: ['name'], text: ' Widget A ' }),
        el({ tag: 'a', classes: ['more'], attrs: { href: '/buy/a' }, text: 'buy' }),
        el({ tag: 'span', classes: ['price'], text: '19.5' }),
        el({ tag: 'span', classes: ['stock'], text: 'true' }),
        el({ tag: 'div', classes: ['desc'], html: '<div class="desc"><b>bold</b></div>' }),
        el({ tag: 'span', classes: ['label'], attrs: { 'data-label': 'A' } }),
      ],
    }),
    el({
      tag: 'li',
      classes: ['item'],
      children: [
        el({ tag: 'span', classes: ['name'], text: 'Widget B' }),
        el({ tag: 'a', classes: ['more'], attrs: { href: '' }, text: 'buy' }),
        el({ tag: 'span', classes: ['stock'], text: 'maybe' }),
        el({ tag: 'div', classes: ['desc'], html: '<div class="desc">plain</div>' }),
        el({ tag: 'span', classes: ['label'], attrs: { 'data-label': 'B' } }),
      ],
    }),
    el({
      tag: 'li',
      classes: ['item'],
      children: [
        el({ tag: 'a', classes: ['more'], attrs: { href: 'https://other.example/x' } }),
        el({ tag: 'span', classes: ['price'], text: 'abc' }),
        el({ tag: 'span', classes: ['stock'], text: '0' }),
        el({ tag: 'div', classes: ['desc'], html: '<div class="desc">third</div>' }),
        el({ tag: 'span', classes: ['label'], attrs: { 'data-label': 'C' } }),
      ],
    }),
  )
  return document
}

const SAMPLE_SPEC = {
  itemSelector: 'li.item',
  fields: {
    name: { selector: '.name', required: true },
    href: { selector: 'a.more', attr: 'href', type: 'url' },
    price: { selector: '.price', type: 'number' },
    stock: { selector: '.stock', type: 'boolean' },
    html: { selector: '.desc', type: 'html' },
    label: { selector: '.label', attr: 'data-label' },
  },
}

// ---------- spec 校验 ----------

describe('normalizeExtractSpec', () => {
  test('补齐 type/required 默认值并去掉选择器两端空白', () => {
    const spec = normalizeExtractSpec({
      itemSelector: '  article  ',
      fields: {
        title: { selector: '  h2  ' },
        link: { selector: 'a', attr: ' href ', type: 'url', required: true },
      },
    })

    expect(spec.itemSelector).toBe('article')
    expect(spec.fields.title).toEqual({ selector: 'h2', type: 'text', required: false })
    expect(spec.fields.link).toEqual({
      selector: 'a',
      attr: 'href',
      type: 'url',
      required: true,
    })
    expect(spec.limit).toBeUndefined()
  })

  test('接受合法 limit', () => {
    expect(normalizeExtractSpec({ itemSelector: 'li', fields: { a: {} }, limit: 10 }).limit).toBe(
      10,
    )
    expect(
      normalizeExtractSpec({ itemSelector: 'li', fields: { a: {} }, limit: EXTRACT_MAX_LIMIT })
        .limit,
    ).toBe(EXTRACT_MAX_LIMIT)
  })

  const invalidSpecs: Array<[string, unknown]> = [
    ['非对象', []],
    ['null', null],
    ['未知顶层字段', { itemSelector: 'li', fields: { a: {} }, extra: 1 }],
    ['缺 itemSelector', { fields: { a: {} } }],
    ['空 itemSelector', { itemSelector: '   ', fields: { a: {} } }],
    ['非字符串 itemSelector', { itemSelector: 1, fields: { a: {} } }],
    ['缺 fields', { itemSelector: 'li' }],
    ['fields 是数组', { itemSelector: 'li', fields: [] }],
    ['fields 为空', { itemSelector: 'li', fields: {} }],
    ['字段名空白', { itemSelector: 'li', fields: { '  ': {} } }],
    ['字段非对象', { itemSelector: 'li', fields: { a: 'text' } }],
    ['未知字段选项', { itemSelector: 'li', fields: { a: { selectr: '.x' } } }],
    ['空 selector', { itemSelector: 'li', fields: { a: { selector: ' ' } } }],
    ['非字符串 selector', { itemSelector: 'li', fields: { a: { selector: 1 } } }],
    ['空 attr', { itemSelector: 'li', fields: { a: { attr: '' } } }],
    ['未知 type', { itemSelector: 'li', fields: { a: { type: 'date' } } }],
    ['required 非布尔', { itemSelector: 'li', fields: { a: { required: 'yes' } } }],
    ['limit 为 0', { itemSelector: 'li', fields: { a: {} }, limit: 0 }],
    ['limit 超上限', { itemSelector: 'li', fields: { a: {} }, limit: EXTRACT_MAX_LIMIT + 1 }],
    ['limit 非整数', { itemSelector: 'li', fields: { a: {} }, limit: 1.5 }],
    ['limit 为字符串', { itemSelector: 'li', fields: { a: {} }, limit: '3' }],
  ]

  for (const [label, value] of invalidSpecs) {
    test(`拒绝非法 spec：${label}`, () => {
      expect(() => normalizeExtractSpec(value)).toThrow()
    })
  }

  for (const name of ['__proto__', 'prototype', 'constructor']) {
    test(`拒绝特殊字段名 ${name}`, () => {
      const raw = `{"itemSelector":"li","fields":{"${name}":{}}}`
      expect(() => normalizeExtractSpec(JSON.parse(raw))).toThrow(/not allowed/)
    })
  }
})

// ---------- 条数上限 ----------

describe('resolveExtractLimit', () => {
  test('dry-run 默认 5 条并覆盖 spec 上限', () => {
    expect(resolveExtractLimit({ dryRun: true })).toBe(5)
    expect(resolveExtractLimit({ specLimit: 500, dryRun: true })).toBe(5)
  })

  test('显式 --limit 优先级最高', () => {
    expect(resolveExtractLimit({ specLimit: 500, cliLimit: 20, dryRun: true })).toBe(20)
    expect(resolveExtractLimit({ specLimit: 500, cliLimit: 20, dryRun: false })).toBe(20)
  })

  test('普通模式使用 spec limit，未给时取最大上限', () => {
    expect(resolveExtractLimit({ specLimit: 50, dryRun: false })).toBe(50)
    expect(resolveExtractLimit({ dryRun: false })).toBe(EXTRACT_MAX_LIMIT)
  })
})

// ---------- 页面脚本行为 ----------

describe('extract 页面脚本', () => {
  test('脚本源码是固定的，不包含用户选择器', () => {
    expect(EXTRACT_PAGE_SCRIPT).toContain('document.querySelectorAll')
    expect(EXTRACT_PAGE_SCRIPT).toContain('args.spec')
    expect(EXTRACT_PAGE_SCRIPT).not.toContain('li.item')
    expect(EXTRACT_PAGE_SCRIPT).not.toContain('MARKER-123')
  })

  test('text/attr/url/number/boolean/html 与 required 统计', () => {
    const spec = normalizeExtractSpec(SAMPLE_SPEC)
    const result = runPageScript({ ...spec, limit: 10 }, sampleDocument())
    const quality = buildExtractQuality(result)

    expect(result.matchedCount).toBe(3)
    expect(result.scannedCount).toBe(3)
    expect(result.invalidCount).toBe(1)
    expect(quality.itemCount).toBe(2)
    expect(quality.errorsTruncated).toBe(false)

    expect(result.items[0]).toEqual({
      name: 'Widget A',
      href: 'https://example.com/buy/a',
      price: 19.5,
      stock: true,
      html: '<div class="desc"><b>bold</b></div>',
      label: 'A',
    })
    expect(result.items[1]).toEqual({
      name: 'Widget B',
      href: null,
      price: null,
      stock: null,
      html: '<div class="desc">plain</div>',
      label: 'B',
    })

    // rowIndex=1 那行缺 price、href 为空：都是可选字段，写 null 后这行仍然有效。
    // 只有 rowIndex=2 那行作废，原因是 required 的 name 缺失；price 类型非法但 price 可选，不影响该行。
    expect(result.missingFields).toEqual({
      name: 1,
      href: 1,
      price: 1,
      stock: 0,
      html: 0,
      label: 0,
    })
    expect(result.totalErrorCount).toBe(3)
    expect(result.errors.map((error) => `${error.rowIndex}:${error.field}:${error.code}`)).toEqual([
      '1:stock:FIELD_TYPE_INVALID',
      '2:name:FIELD_REQUIRED_MISSING',
      '2:price:FIELD_TYPE_INVALID',
    ])
  })

  test('required 字段缺失或类型非法都会让整行作废', () => {
    const document = sampleDocument()
    const spec = normalizeExtractSpec({
      itemSelector: 'li.item',
      fields: {
        name: { selector: '.name', required: true },
        price: { selector: '.price', type: 'number', required: true },
      },
    })
    const result = runPageScript({ ...spec, limit: 10 }, document)

    // rowIndex=1 那行缺 required 的 price；rowIndex=2 那行缺 required 的 name，且 price 是 "abc"。
    // 两行都因 required 字段缺失/非法被剔除。
    expect(result.matchedCount).toBe(3)
    expect(result.invalidCount).toBe(2)
    expect(result.items).toEqual([{ name: 'Widget A', price: 19.5 }])
    expect(result.missingFields).toEqual({ name: 1, price: 1 })
    expect(result.errors.map((error) => `${error.rowIndex}:${error.field}:${error.code}`)).toEqual([
      '1:price:FIELD_REQUIRED_MISSING',
      '2:name:FIELD_REQUIRED_MISSING',
      '2:price:FIELD_TYPE_INVALID',
    ])
  })

  test('limit 只限制扫描行数，matchedCount 仍是完整匹配数', () => {
    const spec = normalizeExtractSpec(SAMPLE_SPEC)
    const result = runPageScript({ ...spec, limit: 2 }, sampleDocument())

    expect(result.matchedCount).toBe(3)
    expect(result.scannedCount).toBe(2)
    expect(result.invalidCount).toBe(0)
    expect(result.items).toHaveLength(2)
  })

  test('空匹配返回空 items 和零统计', () => {
    const document = new FakeDocument()
    const spec = normalizeExtractSpec({ itemSelector: 'li', fields: { name: { required: true } } })
    const result = runPageScript({ ...spec, limit: 5 }, document)

    expect(result).toMatchObject({
      matchedCount: 0,
      scannedCount: 0,
      invalidCount: 0,
      items: [],
      totalErrorCount: 0,
    })
    expect(buildExtractQuality(result).errorsTruncated).toBe(false)
  })

  test('errors 有界，totalErrorCount 保留真实数量', () => {
    const document = new FakeDocument()
    for (let index = 0; index < 30; index += 1) {
      document.nodes.push(
        el({
          tag: 'li',
          classes: ['item'],
          children: [el({ tag: 'span', classes: ['other'], text: String(index) })],
        }),
      )
    }

    const spec = normalizeExtractSpec({
      itemSelector: 'li.item',
      fields: { name: { selector: '.name', required: true } },
    })
    const result = runPageScript({ ...spec, limit: 30 }, document)
    const quality = buildExtractQuality(result)

    expect(result.matchedCount).toBe(30)
    expect(result.invalidCount).toBe(30)
    expect(result.totalErrorCount).toBe(30)
    expect(result.errors).toHaveLength(EXTRACT_MAX_ERRORS)
    expect(quality.errorsTruncated).toBe(true)
    expect(quality.itemCount).toBe(0)
  })

  test('非法 CSS 选择器会以可读错误失败', () => {
    const spec = normalizeExtractSpec({ itemSelector: 'li[[', fields: { name: {} } })
    expect(() => runPageScript({ ...spec, limit: 5 }, new FakeDocument())).toThrow(
      /itemSelector is not a valid CSS selector/,
    )
  })

  test('测试替身像浏览器一样对非法选择器抛错', () => {
    const document = new FakeDocument()
    for (const selector of ['li[[', 'li[', 'li]', 'li[]']) {
      expect(() => document.querySelectorAll(selector)).toThrow(/is not a valid selector/)
    }
    // 合法但替身不支持的写法要和"非法"区分开，否则能力边界会被误报成用户写错选择器。
    expect(() => document.querySelectorAll('li > span')).toThrow(UnsupportedSelectorError)
  })
})

describe('parseExtractResult', () => {
  test('校验并透传合法结果', () => {
    const parsed = parseExtractResult({
      matchedCount: 2,
      scannedCount: 2,
      invalidCount: 0,
      items: [{ name: 'A' }, { name: 'B' }],
      missingFields: { name: 0 },
      errors: [],
      totalErrorCount: 0,
    })
    expect(parsed.items).toHaveLength(2)
    expect(parsed.matchedCount).toBe(2)
  })

  const malformed: Array<[string, unknown]> = [
    ['非对象', 'oops'],
    ['缺 items', { matchedCount: 0 }],
    ['items 非数组', { matchedCount: 0, items: {} }],
    ['items 含非对象', { matchedCount: 1, scannedCount: 1, invalidCount: 0, items: [1] }],
    [
      '缺 missingFields',
      {
        matchedCount: 0,
        scannedCount: 0,
        invalidCount: 0,
        items: [],
        errors: [],
        totalErrorCount: 0,
      },
    ],
    [
      '缺 errors',
      {
        matchedCount: 0,
        scannedCount: 0,
        invalidCount: 0,
        items: [],
        missingFields: {},
        totalErrorCount: 0,
      },
    ],
    [
      'error 形状错误',
      {
        matchedCount: 0,
        scannedCount: 0,
        invalidCount: 0,
        items: [],
        missingFields: {},
        errors: [{ rowIndex: 0, field: 'a', code: 'NOPE', message: 'x' }],
        totalErrorCount: 1,
      },
    ],
    [
      '计数为负',
      {
        matchedCount: -1,
        scannedCount: 0,
        invalidCount: 0,
        items: [],
        missingFields: {},
        errors: [],
        totalErrorCount: 0,
      },
    ],
  ]

  for (const [label, value] of malformed) {
    test(`拒绝畸形结果：${label}`, () => {
      expect(() => parseExtractResult(value)).toThrow()
    })
  }
})

// ---------- CLI ----------

const SERVER_ARGS = ['--json', '--server', 'http://127.0.0.1:3000']

function evalPayload(result: Record<string, unknown>): unknown {
  return { ok: true, result }
}

const SAMPLE_RESULT = {
  matchedCount: 2,
  scannedCount: 2,
  invalidCount: 0,
  items: [
    { name: 'A', price: 1 },
    { name: 'B', price: null },
  ],
  missingFields: { name: 0, price: 1 },
  errors: [],
  totalErrorCount: 0,
}

interface InjectedField {
  selector?: string
  attr?: string
  type: string
  required: boolean
}

interface InjectedSpec {
  itemSelector: string
  fields: Record<string, InjectedField>
  limit: number
}

/** 从 CLI 发出的 eval 请求里取出 args.args.spec，缺失时直接让测试失败。 */
function injectedSpec(
  call: { body: { args?: Record<string, unknown> } | null } | undefined,
): InjectedSpec {
  const evalArgs = call?.body?.args
  if (!evalArgs) throw new Error('test request is missing eval arguments')
  const extra = evalArgs.args as { spec?: InjectedSpec } | undefined
  if (!extra?.spec) throw new Error('test request is missing the injected extract spec')
  return extra.spec
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-extract-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeSpec(dir: string, value: unknown): Promise<string> {
  const specPath = path.join(dir, 'spec.json')
  await writeFile(specPath, JSON.stringify(value), 'utf8')
  return specPath
}

describe('extract CLI', () => {
  test('无 --output 时返回 items 与 quality，并强制 eval detailed', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, SAMPLE_SPEC)
      const result = await runCli([...SERVER_ARGS, 'extract', specPath], evalPayload(SAMPLE_RESULT))

      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls).toHaveLength(1)
      const body = result.fetchCalls[0].body
      expect(body?.command).toBe('eval')
      expect(body?.args?.script).toBe(EXTRACT_PAGE_SCRIPT)
      expect(body?.args?.responseFormat).toBe('detailed')

      const specArg = injectedSpec(result.fetchCalls[0])
      expect(specArg.itemSelector).toBe('li.item')
      expect(specArg.limit).toBe(EXTRACT_MAX_LIMIT)
      expect(specArg.fields.name).toEqual({ selector: '.name', type: 'text', required: true })

      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        result: { items: unknown[]; quality: Record<string, unknown> }
      }
      expect(payload.ok).toBe(true)
      expect(payload.result.items).toEqual(SAMPLE_RESULT.items)
      expect(payload.result.quality).toMatchObject({
        matchedCount: 2,
        itemCount: 2,
        invalidCount: 0,
        missingFields: { name: 0, price: 1 },
        totalErrorCount: 0,
        errorsTruncated: false,
      })
    })
  })

  test('用户 selector 只经 args 注入，不会拼进脚本', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, {
        itemSelector: 'li[data-marker="MARKER-123"]',
        fields: { name: {} },
      })
      const result = await runCli([...SERVER_ARGS, 'extract', specPath], evalPayload(SAMPLE_RESULT))

      expect(result.exitCode).toBe(0)
      const evalArgs = result.fetchCalls[0]?.body?.args
      if (!evalArgs) throw new Error('test request is missing eval arguments')
      expect(String(evalArgs.script)).not.toContain('MARKER-123')
      expect(injectedSpec(result.fetchCalls[0]).itemSelector).toContain('MARKER-123')
    })
  })

  test('--output 只写有效 items 的 JSONL，stdout 只返回摘要', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, SAMPLE_SPEC)
      const outputPath = path.join(dir, 'out', 'items.jsonl')
      const relativeOutput = path.relative(process.cwd(), outputPath)

      const result = await runCli(
        [...SERVER_ARGS, 'extract', specPath, '--output', relativeOutput],
        evalPayload(SAMPLE_RESULT),
      )

      expect(result.exitCode).toBe(0)
      const lines = (await readFile(outputPath, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0])).toEqual({ name: 'A', price: 1 })
      expect(JSON.parse(lines[1])).toEqual({ name: 'B', price: null })

      const payload = JSON.parse(result.stdout) as {
        result: { path: string; itemCount: number; quality: { itemCount: number }; items?: unknown }
      }
      expect(payload.result.path).toBe(path.resolve(outputPath))
      expect(payload.result.itemCount).toBe(2)
      expect(payload.result.quality.itemCount).toBe(2)
      expect(payload.result.items).toBeUndefined()
    })
  })

  test('dry-run 默认 5 条，显式 --limit 覆盖', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, SAMPLE_SPEC)

      const dryRun = await runCli(
        [...SERVER_ARGS, 'extract', specPath, '--dry-run'],
        evalPayload(SAMPLE_RESULT),
      )
      expect(dryRun.exitCode).toBe(0)
      expect(injectedSpec(dryRun.fetchCalls[0]).limit).toBe(5)

      const limited = await runCli(
        [...SERVER_ARGS, 'extract', specPath, '--dry-run', '--limit', '2'],
        evalPayload(SAMPLE_RESULT),
      )
      expect(limited.exitCode).toBe(0)
      expect(injectedSpec(limited.fetchCalls[0]).limit).toBe(2)
    })
  })

  test('dry-run 与 --output 互斥，且不发起请求', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, SAMPLE_SPEC)
      const result = await runCli([
        ...SERVER_ARGS,
        'extract',
        specPath,
        '--dry-run',
        '--output',
        'out.jsonl',
      ])

      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(cliErrorPayload(result.stdout).error.code).toBe('CLI_INVALID_ARGUMENT')
    })
  })

  test('参数错误走统一 JSON 错误契约', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, SAMPLE_SPEC)
      const cases: Array<[string, string[]]> = [
        ['缺 spec', ['extract']],
        ['多余位置参数', ['extract', specPath, 'extra.json']],
        ['未知选项', ['extract', specPath, '--wat']],
        ['limit 为 0', ['extract', specPath, '--limit', '0']],
        ['limit 超上限', ['extract', specPath, '--limit', '10001']],
        ['limit 非整数', ['extract', specPath, '--limit', '2.5']],
        ['output 缺值', ['extract', specPath, '--output']],
      ]

      for (const [label, argv] of cases) {
        const result = await runCli([...SERVER_ARGS, ...argv])
        expect({ label, exit: result.exitCode }).toEqual({ label, exit: 1 })
        expect({ label, calls: result.fetchCalls.length }).toEqual({ label, calls: 0 })
        expect({ label, code: cliErrorPayload(result.stdout).error.code }).toEqual({
          label,
          code: 'CLI_INVALID_ARGUMENT',
        })
      }
    })
  })

  test('非法 spec 与非法 JSON 返回 INVALID_EXTRACT_SPEC', async () => {
    await withTempDir(async (dir) => {
      const badSpec = await writeSpec(dir, { itemSelector: 'li', fields: {} })
      const badJson = path.join(dir, 'bad.json')
      await writeFile(badJson, '{not json', 'utf8')
      const protoSpec = path.join(dir, 'proto.json')
      await writeFile(protoSpec, '{"itemSelector":"li","fields":{"__proto__":{}}}', 'utf8')

      for (const specPath of [badSpec, badJson, protoSpec]) {
        const result = await runCli([...SERVER_ARGS, 'extract', specPath])
        expect(result.exitCode).toBe(1)
        expect(result.fetchCalls).toHaveLength(0)
        expect(cliErrorPayload(result.stdout).error.code).toBe('INVALID_EXTRACT_SPEC')
      }
    })
  })

  test('空匹配是成功结果', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, { itemSelector: 'li', fields: { name: {} } })
      const result = await runCli(
        [...SERVER_ARGS, 'extract', specPath],
        evalPayload({
          matchedCount: 0,
          scannedCount: 0,
          invalidCount: 0,
          items: [],
          missingFields: { name: 0 },
          errors: [],
          totalErrorCount: 0,
        }),
      )

      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; result: { items: unknown[] } }
      expect(payload.ok).toBe(true)
      expect(payload.result.items).toEqual([])
    })
  })

  test('eval 失败时转发错误并非零退出', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, SAMPLE_SPEC)
      const result = await runCli([...SERVER_ARGS, 'extract', specPath], {
        ok: false,
        error: { code: 'EVAL_SCRIPT_FAILED', message: 'page exploded' },
      })

      expect(result.exitCode).toBe(1)
      const payload = cliErrorPayload(result.stdout)
      expect(payload.error.code).toBe('EVAL_SCRIPT_FAILED')
      expect(payload.error.message).toBe('page exploded')
    })
  })

  test('eval 返回畸形结果时非零退出', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, SAMPLE_SPEC)
      const result = await runCli([...SERVER_ARGS, 'extract', specPath], evalPayload({}))

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout).ok).toBe(false)
    })
  })

  test('输出写失败返回非零', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, SAMPLE_SPEC)
      const blocker = path.join(dir, 'blocked')
      await writeFile(blocker, 'not a directory', 'utf8')

      const result = await runCli(
        [...SERVER_ARGS, 'extract', specPath, '--output', path.join(blocker, 'items.jsonl')],
        evalPayload(SAMPLE_RESULT),
      )

      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout).ok).toBe(false)
    })
  })

  test('quality 带 errorsTruncated 证明错误被截断', async () => {
    await withTempDir(async (dir) => {
      const specPath = await writeSpec(dir, { itemSelector: 'li', fields: { name: {} } })
      const errors = Array.from({ length: EXTRACT_MAX_ERRORS }, (_value, index) => ({
        rowIndex: index,
        field: 'name',
        code: 'FIELD_TYPE_INVALID' as const,
        message: 'expected something',
      }))
      const result = await runCli(
        [...SERVER_ARGS, 'extract', specPath],
        evalPayload({
          matchedCount: 25,
          scannedCount: 25,
          invalidCount: 25,
          items: [],
          missingFields: { name: 0 },
          errors,
          totalErrorCount: 25,
        }),
      )

      expect(result.exitCode).toBe(0)
      const quality = JSON.parse(result.stdout).result.quality as {
        errors: unknown[]
        totalErrorCount: number
        errorsTruncated: boolean
      }
      expect(quality.errors).toHaveLength(EXTRACT_MAX_ERRORS)
      expect(quality.totalErrorCount).toBe(25)
      expect(quality.errorsTruncated).toBe(true)
    })
  })
})

// ---------- 帮助与注册 ----------

describe('extract 帮助', () => {
  test('顶层帮助树包含 extract 且列出关键选项', () => {
    const node = (HELP_ROOT.children ?? []).find((child) => child.name === 'extract')
    expect(node).toBeDefined()
    expect(node?.usage).toContain('--dry-run')
    expect(node?.usage).toContain('--output')
    expect(node?.usage).toContain('--limit')
  })
})
