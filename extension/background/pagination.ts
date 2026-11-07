/** console/errors/network requests 等列表共用的分页状态。 */
interface PaginationState {
  currentPage: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
  startIndex: number
  endIndex: number
  /** pageIdx 越界（>= totalPages）时回退第一页并置 true */
  invalidPage: boolean
  nextCursor?: string
}

interface PaginatedList<T> {
  items: T[]
  pagination: PaginationState
}

interface CursorPaginationOptions<T> {
  cursor?: string
  limit?: number
  defaultLimit?: number
  maxLimit?: number
  /** 过滤条件与排序的指纹输入，防止把 cursor 用到另一项查询。 */
  queryKey?: unknown
  /** 返回稳定记录键；默认键包含位置和内容，适用于只追加的日志列表。 */
  getKey?: (item: T, index: number) => string
}

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100
const LEGACY_MAX_PAGE_SIZE = 200

function clampPageIndex(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function clampPageSize(
  value: unknown,
  fallback = DEFAULT_PAGE_SIZE,
  maximum = MAX_PAGE_SIZE,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(value)))
}

function fingerprint(value: unknown): string {
  const input = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16777619)
  }
  return (hash >>> 0).toString(36)
}

function paginationError(code: 'INVALID_CURSOR' | 'STALE_CURSOR', message: string): Error {
  return Object.assign(new Error(message), {
    code,
    suggestedAction:
      'Restart the list query without cursor, then continue with the returned nextCursor.',
  })
}

function encodeCursor(queryKey: unknown, key: string): string {
  return btoa(JSON.stringify({ v: 1, q: fingerprint(queryKey), k: key }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '')
}

function decodeCursor(cursor: string, queryKey: unknown): string {
  try {
    const normalized = cursor.replaceAll('-', '+').replaceAll('_', '/')
    const decoded = JSON.parse(atob(normalized)) as { v?: number; q?: string; k?: string }
    if (decoded.v !== 1 || typeof decoded.k !== 'string' || !decoded.k) throw new Error('shape')
    if (decoded.q !== fingerprint(queryKey)) {
      throw paginationError('INVALID_CURSOR', 'cursor belongs to a different list query')
    }
    return decoded.k
  } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_CURSOR') throw error
    throw paginationError('INVALID_CURSOR', 'invalid cursor')
  }
}

/** 页码参数保持兼容；传 options 后额外提供稳定 cursor，列表变化时不会按裸 offset 续页。 */
export function paginateList<T>(
  items: T[],
  pageIdx?: number,
  pageSize?: number,
  options?: CursorPaginationOptions<T>,
): PaginatedList<T> {
  const requestedPage = clampPageIndex(pageIdx)
  const size = clampPageSize(
    options?.limit ?? pageSize,
    options?.defaultLimit ?? DEFAULT_PAGE_SIZE,
    options
      ? options.limit !== undefined
        ? (options.maxLimit ?? MAX_PAGE_SIZE)
        : LEGACY_MAX_PAGE_SIZE
      : LEGACY_MAX_PAGE_SIZE,
  )
  let startIndex = requestedPage * size
  let invalidPage = false

  if (options?.cursor) {
    if (requestedPage !== 0) {
      throw paginationError('INVALID_CURSOR', 'cursor cannot be combined with pageIdx')
    }
    const key = decodeCursor(options.cursor, options.queryKey)
    const getKey = options.getKey ?? ((item: T, index: number) => `${index}:${fingerprint(item)}`)
    const previousIndex = items.findIndex((item, index) => getKey(item, index) === key)
    if (previousIndex < 0) {
      throw paginationError(
        'STALE_CURSOR',
        'cursor target is no longer present in the filtered list',
      )
    }
    startIndex = previousIndex + 1
  }

  const totalPages = items.length === 0 ? 1 : Math.ceil(items.length / size)
  if (!options?.cursor && requestedPage >= totalPages) {
    invalidPage = true
    startIndex = 0
  }
  const currentPage = Math.floor(startIndex / size)
  const endIndex = Math.min(startIndex + size, items.length)
  const pageItems = items.slice(startIndex, endIndex)
  const pagination: PaginationState = {
    currentPage,
    totalPages,
    hasNextPage: endIndex < items.length,
    hasPreviousPage: startIndex > 0,
    startIndex,
    endIndex,
    invalidPage,
  }

  if (options && endIndex < items.length && pageItems.length > 0) {
    const getKey = options.getKey ?? ((item: T, index: number) => `${index}:${fingerprint(item)}`)
    pagination.nextCursor = encodeCursor(
      options.queryKey,
      getKey(pageItems[pageItems.length - 1], endIndex - 1),
    )
  }

  return { items: pageItems, pagination }
}
