import { describe, expect, test } from 'bun:test'
import { MAX_PAGE_SIZE, paginateList } from '../extension/background/pagination.js'

describe('paginateList', () => {
  const items = Array.from({ length: 7 }, (_, index) => `item-${index + 1}`)

  test('paginates the first page by default', () => {
    const { items: page, pagination } = paginateList(items)

    expect(page).toHaveLength(7)
    expect(pagination).toEqual({
      currentPage: 0,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: 7,
      invalidPage: false,
    })
  })

  test('splits into pages by pageSize and reports hasNextPage', () => {
    const first = paginateList(items, 0, 3)
    expect(first.items).toEqual(['item-1', 'item-2', 'item-3'])
    expect(first.pagination).toEqual({
      currentPage: 0,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: 3,
      invalidPage: false,
    })

    const last = paginateList(items, 2, 3)
    expect(last.items).toEqual(['item-7'])
    expect(last.pagination).toMatchObject({
      currentPage: 2,
      totalPages: 3,
      hasNextPage: false,
      hasPreviousPage: true,
      startIndex: 6,
      endIndex: 7,
      invalidPage: false,
    })
  })

  test('falls back to the first page with invalidPage when pageIdx is out of range', () => {
    const { items: page, pagination } = paginateList(items, 5, 3)

    expect(page).toEqual(['item-1', 'item-2', 'item-3'])
    expect(pagination).toEqual({
      currentPage: 0,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: 3,
      invalidPage: true,
    })
  })

  test('clamps pageSize to the 200 cap and ignores malformed inputs', () => {
    const big = Array.from({ length: 250 }, (_, index) => index)

    const capped = paginateList(big, 0, 10_000)
    expect(capped.items).toHaveLength(MAX_PAGE_SIZE)
    expect(capped.pagination.totalPages).toBe(2)

    const negative = paginateList(big, 0, -5)
    expect(negative.items).toHaveLength(1)

    const empty = paginateList([], 3, 50)
    expect(empty.items).toEqual([])
    expect(empty.pagination).toEqual({
      currentPage: 0,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: 0,
      invalidPage: true,
    })
  })
})
