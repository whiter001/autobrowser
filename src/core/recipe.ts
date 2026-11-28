/**
 * 命名配方（recipe）的 spec 契约。
 *
 * 配方是用户自己保存、可重复执行的 async function body；它和 eval 的脚本同一套执行语义，
 * 因此这里的校验只负责「结构可存储、可定位页面、参数可解释」，不做脚本静态安全分析。
 */

/** 配方名同时是 `<homeDir>/recipes/<name>.json` 的文件名，只允许安全 slug。 */
export const RECIPE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const RECIPE_MAX_PARAMS = 50

/** 脚本体上限：防止一份配方把 home 目录当成代码仓库来用。 */
export const RECIPE_MAX_SCRIPT_BYTES = 256 * 1024

/** 读取 spec 文件的上限，避免误传超大文件后被整份读进内存。 */
export const RECIPE_MAX_SPEC_BYTES = 1024 * 1024

export const RECIPE_MIN_TIMEOUT_MS = 100
export const RECIPE_MAX_TIMEOUT_MS = 1_800_000

export interface RecipeParam {
  name: string
  description: string
  required: boolean
}

export interface RecipeSpec {
  name: string
  description?: string
  entryUrl: string
  params: RecipeParam[]
  script: string
  /** 由 verify 维护；新配方为 null。 */
  lastVerified: string | null
}

export interface RecipeMetadata {
  name: string
  description?: string
  entryUrl: string
  params: RecipeParam[]
  lastVerified: string | null
}

/**
 * 只接受带日期、时间与显式时区的 ISO 8601 时间。
 *
 * 光用 Date.parse 不够：它会把 '2026-01-01' 这类纯日期也当成合法时间，
 * 而配方需要一个能区分「何时验证过」的精确时间点。
 */
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isValidRecipeName(value: unknown): value is string {
  return typeof value === 'string' && RECIPE_NAME_PATTERN.test(value)
}

export function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false
  }
  return !Number.isNaN(Date.parse(value))
}

function normalizeParam(value: unknown, index: number): RecipeParam {
  if (!isPlainRecord(value)) {
    throw new Error(`recipe params[${index}] must be an object`)
  }
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name) {
    throw new Error(`recipe params[${index}].name is required`)
  }
  if (typeof value.description !== 'string') {
    throw new Error(`recipe params[${index}].description must be a string`)
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    throw new Error(`recipe params[${index}].required must be a boolean`)
  }
  return {
    name,
    description: value.description,
    required: value.required === true,
  }
}

/**
 * 校验并规范化 recipe spec。
 *
 * 所有非法输入一律抛普通 Error，CLI 层统一包装成 INVALID_RECIPE_SPEC；
 * 这里不写文件、不碰浏览器，方便单独测试。
 */
export function normalizeRecipeSpec(value: unknown): RecipeSpec {
  if (!isPlainRecord(value)) {
    throw new Error('recipe spec must be a JSON object')
  }

  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!isValidRecipeName(name)) {
    throw new Error(
      'recipe name must start with a lowercase letter or digit and contain only lowercase letters, digits, "_" or "-" (max 64 chars)',
    )
  }

  const entryUrl = typeof value.entryUrl === 'string' ? value.entryUrl.trim() : ''
  if (!entryUrl) {
    throw new Error('recipe entryUrl is required')
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(entryUrl)
  } catch {
    throw new Error('recipe entryUrl must be a valid absolute URL')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('recipe entryUrl must use http or https')
  }

  if (!Array.isArray(value.params)) {
    throw new Error('recipe params must be an array')
  }
  if (value.params.length > RECIPE_MAX_PARAMS) {
    throw new Error(`recipe has too many params (max ${RECIPE_MAX_PARAMS})`)
  }
  const params = value.params.map((param, index) => normalizeParam(param, index))
  const seen = new Set<string>()
  for (const param of params) {
    if (seen.has(param.name)) {
      throw new Error(`duplicate recipe param name: ${param.name}`)
    }
    seen.add(param.name)
  }

  if (typeof value.script !== 'string') {
    throw new Error('recipe script must be a string')
  }
  if (!value.script.trim()) {
    throw new Error('recipe script must not be empty')
  }
  if (Buffer.byteLength(value.script, 'utf8') > RECIPE_MAX_SCRIPT_BYTES) {
    throw new Error(`recipe script exceeds ${RECIPE_MAX_SCRIPT_BYTES} bytes`)
  }

  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error('recipe description must be a string')
  }
  const description = typeof value.description === 'string' ? value.description.trim() : ''

  let lastVerified: string | null = null
  if (value.lastVerified !== undefined && value.lastVerified !== null) {
    if (!isValidIsoTimestamp(value.lastVerified)) {
      throw new Error('recipe lastVerified must be an ISO 8601 timestamp with a timezone')
    }
    lastVerified = value.lastVerified
  }

  return {
    name,
    ...(description ? { description } : {}),
    entryUrl,
    params,
    script: value.script,
    lastVerified,
  }
}

/** list 只暴露元数据：脚本内容必须由调用方显式 show 才返回。 */
export function recipeMetadata(spec: RecipeSpec): RecipeMetadata {
  return {
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    entryUrl: spec.entryUrl,
    params: spec.params,
    lastVerified: spec.lastVerified,
  }
}
