import { describe, expect, test } from 'bun:test'
import {
  clearRemovedTabId,
  isInternalBrowserPage,
  pickFallbackTab,
  pickLastNonActiveTab,
} from '../src/core/tab-selection.js'

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
  test('treats browser-internal pages as unusable fallback targets', () => {
    expect(isInternalBrowserPage('chrome-extension://abc/options.html')).toBe(true)
    expect(isInternalBrowserPage('chrome://extensions')).toBe(true)
    expect(isInternalBrowserPage('edge://settings')).toBe(true)
    expect(isInternalBrowserPage('devtools://devtools/bundled/inspector.html')).toBe(true)
    expect(isInternalBrowserPage('about:blank')).toBe(true)
    expect(isInternalBrowserPage('  CHROME-EXTENSION://ABC/x  ')).toBe(true)
    expect(isInternalBrowserPage('https://example.com')).toBe(false)
    expect(isInternalBrowserPage('')).toBe(false)
    expect(isInternalBrowserPage(undefined)).toBe(false)
  })

  test('skips extension pages when picking the implicit target', () => {
    const tabs = [
      { id: 1, active: true, url: 'chrome-extension://abc/connect.html' },
      { id: 2, active: false, url: 'https://example.com/a' },
      { id: 3, active: false, url: 'chrome-extension://abc/options.html' },
    ]

    // 现象：未指定 tab 时曾选中扩展管理页；现在应落在真正的业务页上
    expect(pickFallbackTab(tabs)?.id).toBe(2)
  })

  test('returns null when only internal pages are open', () => {
    const tabs = [
      { id: 1, active: true, url: 'chrome://newtab' },
      { id: 2, active: false, url: 'about:blank' },
    ]

    // 宁可不选，也不要悄悄把命令打到浏览器自身页面上
    expect(pickFallbackTab(tabs)).toBeNull()
  })
})
