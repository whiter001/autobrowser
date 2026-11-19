import type { ErrorWithCode } from './types.js'

/** eval 分页缺省值：只在显式传 offset/limit 时启用，缺省 limit 足够覆盖常见整页正文。 */
export const DEFAULT_EVAL_PAGE_LIMIT = 10_000

export interface EvalPaginationRequest {
  offset?: number
  limit?: number
}

export interface EvalPaginationMeta {
  kind: 'text' | 'array'
  offset: number
  limit: number
  total: number
  nextOffset: number | null
  truncated: boolean
}

export interface PaginatedEvalResult {
  value: unknown
  pagination: EvalPaginationMeta
}

export function isEvalPaginationRequested(request: EvalPaginationRequest | undefined): boolean {
  return request?.offset !== undefined || request?.limit !== undefined
}

function createPaginationTypeError(value: unknown, offset: number, limit: number): Error {
  const error = new Error(
    'eval --offset/--limit only support string or array results; return a string or array to paginate',
  ) as ErrorWithCode
  error.code = 'INVALID_COMMAND_ARGS'
  error.details = {
    field: 'offset/limit',
    resultType: value === null ? 'null' : typeof value,
    offset,
    limit,
  }
  error.suggestedAction =
    'Return a string or array from the script (for example JSON.stringify or Array.from) and paginate that, or drop --offset/--limit to get the raw value.'
  return error
}

/**
 * 对 eval 结果做只读分页。
 *
 * 字符串按 Unicode code point 切片（Array.from 而不是 slice/下标），避免把 emoji 之类的
 * 代理对切成两半；数组按元素切片。未指定分页参数时原样返回，保持旧结果完全兼容。
 */
export function paginateEvalResult(
  value: unknown,
  request: EvalPaginationRequest | undefined,
): unknown {
  if (!isEvalPaginationRequested(request)) {
    return value
  }

  const offset = request?.offset ?? 0
  const limit = request?.limit ?? DEFAULT_EVAL_PAGE_LIMIT

  let kind: EvalPaginationMeta['kind']
  let items: unknown[]
  if (typeof value === 'string') {
    kind = 'text'
    items = Array.from(value)
  } else if (Array.isArray(value)) {
    kind = 'array'
    items = value
  } else {
    throw createPaginationTypeError(value, offset, limit)
  }

  const total = items.length
  const page = items.slice(offset, offset + limit)
  const nextOffset = offset + limit < total ? offset + limit : null

  return {
    value: kind === 'text' ? (page as string[]).join('') : page,
    pagination: {
      kind,
      offset,
      limit,
      total,
      nextOffset,
      truncated: nextOffset !== null,
    },
  } satisfies PaginatedEvalResult
}
