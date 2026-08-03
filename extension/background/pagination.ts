/** console/errors/network requests 列表的分页状态，语义对齐 chrome-devtools-mcp */
export interface PaginationState {
  currentPage: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
  startIndex: number
  endIndex: number
  /** pageIdx 越界（>= totalPages）时回退第一页并置 true */
  invalidPage: boolean
}

export interface PaginatedList<T> {
  items: T[]
  pagination: PaginationState
}

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

function clampPageIndex(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function clampPageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PAGE_SIZE
  }
  // 非法/越界 pageSize 收敛到 [1, 200]，避免除零与超量返回
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(value)))
}

/** 过滤/折叠之后的纯分页：越界 pageIdx 不抛错，回退到第一页并在 pagination 里标记 */
export function paginateList<T>(items: T[], pageIdx?: number, pageSize?: number): PaginatedList<T> {
  const requestedPage = clampPageIndex(pageIdx)
  const size = clampPageSize(pageSize)
  const totalPages = items.length === 0 ? 1 : Math.ceil(items.length / size)
  const invalidPage = requestedPage >= totalPages
  const currentPage = invalidPage ? 0 : requestedPage
  const startIndex = currentPage * size
  const endIndex = Math.min(startIndex + size, items.length)

  return {
    items: items.slice(startIndex, endIndex),
    pagination: {
      currentPage,
      totalPages,
      hasNextPage: endIndex < items.length,
      hasPreviousPage: currentPage > 0,
      startIndex,
      endIndex,
      invalidPage,
    },
  }
}
