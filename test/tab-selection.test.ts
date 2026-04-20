import { describe, expect, test } from 'bun:test'
import { clearRemovedTabId, pickLastNonActiveTab } from '../src/core/tab-selection.js'

describe('tab selection', () => {
  test('prefers the last non-active tab in current window order', () => {
    const tabs = [
      { id: 1, active: true },
      { id: 2, active: false },
      { id: 3, active: false },
    ]

    expect(pickLastNonActiveTab(tabs)).toBe(tabs[2])
  })

  test('falls back to the last tab when every tab is active', () => {
    const tabs = [
      { id: 1, active: true },
      { id: 2, active: true },
    ]

    expect(pickLastNonActiveTab(tabs)).toBe(tabs[1])
  })

  test('returns null when there are no tabs', () => {
    expect(pickLastNonActiveTab([])).toBeNull()
  })

  test('clears a removed target tab id', () => {
    expect(clearRemovedTabId(22, 22)).toBeNull()
    expect(clearRemovedTabId(22, 11)).toBe(22)
    expect(clearRemovedTabId(null, 11)).toBeNull()
  })
})
