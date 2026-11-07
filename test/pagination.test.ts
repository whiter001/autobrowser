import { describe, expect, test } from 'bun:test'
import { MAX_PAGE_SIZE, paginateList } from '../extension/background/pagination.js'

function expectCursorError(run: () => unknown, code: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ code })
}

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

  test('clamps legacy pageSize to the 200 cap and ignores malformed inputs', () => {
    const big = Array.from({ length: 250 }, (_, index) => index)

    const capped = paginateList(big, 0, 10_000)
    expect(capped.items).toHaveLength(200)
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

  test('uses a 20-item default for cursor-enabled lists and caps limit at 100', () => {
    const big = Array.from({ length: 250 }, (_, index) => ({ id: index + 1 }))
    const first = paginateList(big, 0, undefined, { getKey: (item) => String(item.id) })
    expect(first.items).toHaveLength(20)
    expect(first.pagination.nextCursor).toBeString()

    const capped = paginateList(big, 0, undefined, {
      limit: 1000,
      getKey: (item) => String(item.id),
    })
    expect(capped.items).toHaveLength(MAX_PAGE_SIZE)

    const tabs = paginateList(big, 0, undefined, {
      defaultLimit: 50,
      getKey: (item) => String(item.id),
    })
    expect(tabs.items).toHaveLength(50)
  })

  test('continues after the same record even when earlier items are inserted', () => {
    const initial = Array.from({ length: 25 }, (_, index) => ({ id: index + 1 }))
    const options = {
      limit: 10,
      queryKey: { type: 'xhr' },
      getKey: (item: { id: number }) => String(item.id),
    }
    const first = paginateList(initial, 0, undefined, options)
    const withInserted = [{ id: 0 }, ...initial]
    const second = paginateList(withInserted, 0, undefined, {
      ...options,
      cursor: first.pagination.nextCursor,
    })

    expect(second.items.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 11),
    )
  })

  test('rejects invalid, cross-query and stale cursors explicitly', () => {
    const records = [{ id: 'a' }, { id: 'b' }]
    const options = { limit: 1, queryKey: 'one', getKey: (item: { id: string }) => item.id }
    const first = paginateList(records, 0, undefined, options)

    expectCursorError(
      () => paginateList(records, 0, undefined, { ...options, cursor: 'not-a-cursor' }),
      'INVALID_CURSOR',
    )
    expectCursorError(
      () =>
        paginateList(records, 0, undefined, {
          ...options,
          queryKey: 'two',
          cursor: first.pagination.nextCursor,
        }),
      'INVALID_CURSOR',
    )
    expectCursorError(
      () =>
        paginateList([{ id: 'b' }], 0, undefined, {
          ...options,
          cursor: first.pagination.nextCursor,
        }),
      'STALE_CURSOR',
    )
  })
})
