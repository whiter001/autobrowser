/**
 * extract 的 spec 校验、页面脚本与结果解析。
 *
 * 页面脚本是一段固定源码：用户提供的 selector/attr 只通过 eval 的 args 注入，
 * 全程不拼接进脚本文本，因此 spec 里的任何内容都不会变成可执行代码。
 * 脚本只读取 DOM，不点击、不提交、不发请求。
 */

export const EXTRACT_MAX_LIMIT = 10_000

/** --dry-run 未显式给 --limit 时只扫描前 5 个 item。 */
export const EXTRACT_DEFAULT_DRY_RUN_LIMIT = 5

/** 质量报告里 errors 的上限；超出部分只累加 totalErrorCount。 */
export const EXTRACT_MAX_ERRORS = 20

export const EXTRACT_FIELD_TYPES = ['text', 'string', 'number', 'boolean', 'url', 'html'] as const

export type ExtractFieldType = (typeof EXTRACT_FIELD_TYPES)[number]

export interface ExtractFieldSpec {
  /** 省略时直接在 item 根元素上取值。 */
  selector?: string
  /** 存在时读取该属性，而不是 innerText/textContent。 */
  attr?: string
  type: ExtractFieldType
  required: boolean
}

export interface ExtractSpec {
  itemSelector: string
  fields: Record<string, ExtractFieldSpec>
  limit?: number
}

export interface ExtractFieldError {
  /** 0 起始的行号，对应 item 在匹配结果中的位置。 */
  rowIndex: number
  field: string
  code: 'FIELD_REQUIRED_MISSING' | 'FIELD_TYPE_INVALID'
  message: string
}

export interface ExtractPageResult {
  matchedCount: number
  scannedCount: number
  invalidCount: number
  items: Record<string, unknown>[]
  missingFields: Record<string, number>
  errors: ExtractFieldError[]
  totalErrorCount: number
}

export interface ExtractQuality {
  matchedCount: number
  scannedCount: number
  itemCount: number
  invalidCount: number
  missingFields: Record<string, number>
  errors: ExtractFieldError[]
  totalErrorCount: number
  errorsTruncated: boolean
}

const FIELD_KEYS = new Set(['selector', 'attr', 'type', 'required'])
const SPEC_KEYS = new Set(['itemSelector', 'fields', 'limit'])
const FORBIDDEN_FIELD_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isExtractFieldType(value: unknown): value is ExtractFieldType {
  return typeof value === 'string' && EXTRACT_FIELD_TYPES.some((candidate) => candidate === value)
}

function readRequiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeField(name: string, value: unknown): ExtractFieldSpec {
  if (!name.trim()) throw new Error('extract spec field names must be non-empty strings')
  if (FORBIDDEN_FIELD_NAMES.has(name)) {
    throw new Error(`extract spec field name "${name}" is not allowed`)
  }
  if (!isRecord(value)) throw new Error(`extract spec field "${name}" must be an object`)
  for (const key of Object.keys(value)) {
    if (!FIELD_KEYS.has(key)) {
      throw new Error(`unsupported option "${key}" in extract spec field "${name}"`)
    }
  }

  const selector =
    value.selector === undefined
      ? undefined
      : readRequiredText(value.selector, `extract spec field "${name}" selector`)
  const attr =
    value.attr === undefined
      ? undefined
      : readRequiredText(value.attr, `extract spec field "${name}" attr`)

  const type = value.type === undefined ? 'text' : value.type
  if (!isExtractFieldType(type)) {
    throw new Error(
      `extract spec field "${name}" type must be one of ${EXTRACT_FIELD_TYPES.join(', ')}`,
    )
  }

  const required = value.required === undefined ? false : value.required
  if (typeof required !== 'boolean') {
    throw new Error(`extract spec field "${name}" required must be a boolean`)
  }

  return {
    ...(selector !== undefined ? { selector } : {}),
    ...(attr !== undefined ? { attr } : {}),
    type,
    required,
  }
}

/**
 * 校验并规范化 extract spec：补齐 type/required 默认值，剔除选择器两端空白。
 * 这里只做形状校验，CSS 选择器是否合法要到页面里执行时才能确定。
 */
export function normalizeExtractSpec(value: unknown): ExtractSpec {
  if (!isRecord(value)) throw new Error('extract spec must be a JSON object')
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.has(key)) throw new Error(`unsupported extract spec field: ${key}`)
  }

  const itemSelector = readRequiredText(value.itemSelector, 'extract spec itemSelector')
  if (!isRecord(value.fields)) throw new Error('extract spec fields must be an object')
  const names = Object.keys(value.fields)
  if (names.length === 0) throw new Error('extract spec fields must contain at least one field')

  const fields: Record<string, ExtractFieldSpec> = {}
  for (const name of names) {
    fields[name] = normalizeField(name, value.fields[name])
  }

  let limit: number | undefined
  if (value.limit !== undefined) {
    if (
      typeof value.limit !== 'number' ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > EXTRACT_MAX_LIMIT
    ) {
      throw new Error(`extract spec limit must be an integer between 1 and ${EXTRACT_MAX_LIMIT}`)
    }
    limit = value.limit
  }

  return { itemSelector, fields, ...(limit !== undefined ? { limit } : {}) }
}

/**
 * 计算实际扫描上限。
 *
 * --dry-run 会推翻 spec 里的 limit（默认只取 5 条），但显式 --limit 优先级最高：
 * 试跑和正式跑可以复用同一份 spec，临时改条数不必改文件。
 */
export function resolveExtractLimit(options: {
  specLimit?: number
  cliLimit?: number
  dryRun: boolean
}): number {
  if (options.cliLimit !== undefined) return options.cliLimit
  if (options.dryRun) return EXTRACT_DEFAULT_DRY_RUN_LIMIT
  return options.specLimit ?? EXTRACT_MAX_LIMIT
}

/**
 * 页面内执行的固定脚本。
 *
 * 约定：脚本通过局部变量 args 读取 { spec }，返回与 ExtractPageResult 同形的对象。
 * 缺失的字段一律写 null（可选字段也计 missingFields），但只有 required 字段缺失或
 * 类型非法才会让整行作废；errors 有界，totalErrorCount 保留真实总数。
 */
export const EXTRACT_PAGE_SCRIPT = `(() => {
  const spec = args.spec;
  const fieldNames = Object.keys(spec.fields);
  const maxErrors = ${EXTRACT_MAX_ERRORS};
  const missingFields = {};
  const errors = [];
  let totalErrorCount = 0;
  const recordError = (rowIndex, field, code, message) => {
    totalErrorCount += 1;
    if (errors.length < maxErrors) errors.push({ rowIndex, field, code, message });
  };
  const assertSelector = (selector, label) => {
    try {
      document.querySelector(selector);
    } catch (error) {
      throw new Error(label + ' is not a valid CSS selector: ' + selector);
    }
  };
  assertSelector(spec.itemSelector, 'itemSelector');
  for (const name of fieldNames) {
    missingFields[name] = 0;
    const fieldSelector = spec.fields[name].selector;
    if (fieldSelector) assertSelector(fieldSelector, 'fields.' + name + '.selector');
  }
  const nodes = document.querySelectorAll(spec.itemSelector);
  const matchedCount = nodes.length;
  const scannedCount = Math.min(matchedCount, spec.limit);
  const items = [];
  let invalidCount = 0;
  const convert = (value, type) => {
    if (type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return { ok: false, message: 'expected a number' };
      return { ok: true, value: parsed };
    }
    if (type === 'boolean') {
      const lower = value.toLowerCase();
      if (lower === 'true' || lower === '1') return { ok: true, value: true };
      if (lower === 'false' || lower === '0') return { ok: true, value: false };
      return { ok: false, message: 'expected true, false, 1 or 0' };
    }
    if (type === 'url') {
      try {
        return { ok: true, value: new URL(value, document.baseURI).href };
      } catch (error) {
        return { ok: false, message: 'expected an absolute or relative URL' };
      }
    }
    return { ok: true, value };
  };
  for (let rowIndex = 0; rowIndex < scannedCount; rowIndex += 1) {
    const root = nodes[rowIndex];
    const row = {};
    let invalid = false;
    for (const name of fieldNames) {
      const field = spec.fields[name];
      const node = field.selector ? root.querySelector(field.selector) : root;
      let raw = null;
      if (node) {
        if (field.attr) {
          const attributeValue = node.getAttribute(field.attr);
          raw = typeof attributeValue === 'string' ? attributeValue.trim() : null;
        } else if (field.type === 'html') {
          raw = typeof node.outerHTML === 'string' ? node.outerHTML : null;
        } else {
          const inner = typeof node.innerText === 'string' ? node.innerText : '';
          const fallback = typeof node.textContent === 'string' ? node.textContent : '';
          raw = (inner.trim() || fallback).trim();
        }
      }
      if (raw === null || raw === '') {
        missingFields[name] += 1;
        row[name] = null;
        if (field.required) {
          invalid = true;
          recordError(rowIndex, name, 'FIELD_REQUIRED_MISSING', 'required field is missing or empty');
        }
        continue;
      }
      if (field.type === 'html' && !field.attr) {
        row[name] = raw;
        continue;
      }
      const converted = convert(raw, field.type);
      if (!converted.ok) {
        row[name] = null;
        recordError(rowIndex, name, 'FIELD_TYPE_INVALID', converted.message);
        if (field.required) invalid = true;
        continue;
      }
      row[name] = converted.value;
    }
    if (invalid) invalidCount += 1;
    else items.push(row);
  }
  return {
    matchedCount,
    scannedCount,
    invalidCount,
    items,
    missingFields,
    errors,
    totalErrorCount,
  };
})()`

function readCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`eval result ${label} must be a non-negative integer`)
  }
  return value
}

/**
 * 校验 eval 返回的结构。
 *
 * eval 的结果来自扩展，形状不受本地类型约束；这里失败就意味着协议层出了问题，
 * 必须报错而不是把半成品当成空结果（空结果会静默产生误导性的质量报告）。
 */
export function parseExtractResult(value: unknown): ExtractPageResult {
  if (!isRecord(value)) throw new Error('eval returned no structured extract result')
  if (!Array.isArray(value.items)) throw new Error('eval result is missing items')
  const items: Record<string, unknown>[] = []
  for (const item of value.items) {
    if (!isRecord(item)) throw new Error('eval result items must be objects')
    items.push(item)
  }

  if (!isRecord(value.missingFields)) throw new Error('eval result is missing missingFields')
  const missingFields: Record<string, number> = {}
  for (const [name, count] of Object.entries(value.missingFields)) {
    missingFields[name] = readCount(count, `missingFields.${name}`)
  }

  if (!Array.isArray(value.errors)) throw new Error('eval result is missing errors')
  const errors: ExtractFieldError[] = value.errors.map((error, index) => {
    if (
      !isRecord(error) ||
      typeof error.rowIndex !== 'number' ||
      typeof error.field !== 'string' ||
      (error.code !== 'FIELD_REQUIRED_MISSING' && error.code !== 'FIELD_TYPE_INVALID') ||
      typeof error.message !== 'string'
    ) {
      throw new Error(`eval result errors[${index}] is malformed`)
    }
    return {
      rowIndex: error.rowIndex,
      field: error.field,
      code: error.code,
      message: error.message,
    }
  })

  return {
    matchedCount: readCount(value.matchedCount, 'matchedCount'),
    scannedCount: readCount(value.scannedCount, 'scannedCount'),
    invalidCount: readCount(value.invalidCount, 'invalidCount'),
    items,
    missingFields,
    errors,
    totalErrorCount: readCount(value.totalErrorCount, 'totalErrorCount'),
  }
}

/** 把页面统计与本地 items 合成对外质量报告；items 永远放在报告之外，避免混入 meta。 */
export function buildExtractQuality(result: ExtractPageResult): ExtractQuality {
  return {
    matchedCount: result.matchedCount,
    scannedCount: result.scannedCount,
    itemCount: result.items.length,
    invalidCount: result.invalidCount,
    missingFields: result.missingFields,
    errors: result.errors,
    totalErrorCount: result.totalErrorCount,
    errorsTruncated: result.totalErrorCount > result.errors.length,
  }
}
