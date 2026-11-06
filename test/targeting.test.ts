import { describe, expect, test } from 'bun:test'
import { createExtensionState } from '../extension/background/state.js'
import {
  assertFreshElementRef,
  assertFreshFrameRef,
  clearRemovedPageEpoch,
  clearRemovedTabHandle,
  clearSelectedFrame,
  createStaleTabHandleError,
  getOrCreateTabHandle,
  getPageEpoch,
  invalidatePageRefs,
  rememberTargetTab,
  resolveEffectiveFrameSelector,
  resolveTabHandle,
  resolveTabInput,
  toTabSummary,
  withFrameSelectorOptions,
} from '../extension/background/targeting.js'
import type { ErrorWithCode } from '../extension/background/types.js'

function captureError(run: () => void): ErrorWithCode {
  try {
    run()
  } catch (error) {
    return error as ErrorWithCode
  }
  throw new Error('expected the call to throw')
}

describe('tab targeting', () => {
  test('rememberTargetTab keeps a numeric target and clears it otherwise', () => {
    const state = createExtensionState(1234)

    rememberTargetTab(state, 7)
    expect(state.targeting.targetTabId).toBe(7)

    // 显式清空与"没给 tab"都必须落成 null，否则下一条命令会沿用旧目标
    rememberTargetTab(state, null)
    expect(state.targeting.targetTabId).toBeNull()

    rememberTargetTab(state, 9)
    rememberTargetTab(state, undefined)
    expect(state.targeting.targetTabId).toBeNull()
  })

  test('toTabSummary keeps the same handle and normalizes missing fields', () => {
    const state = createExtensionState(1234)

    const summary = toTabSummary(state, {
      id: 7,
      title: 'Example',
      url: 'https://example.com',
      active: true,
      pinned: false,
      status: 'complete',
      windowId: 3,
    })

    expect(summary).toEqual({
      id: 7,
      handle: 't7',
      title: 'Example',
      url: 'https://example.com',
      active: true,
      pinned: false,
      status: 'complete',
      windowId: 3,
    })
    // 同一标签多次摘要必须给同一个 handle，否则 agent 的引用会漂移
    expect(toTabSummary(state, { id: 7 }).handle).toBe('t7')

    const anonymous = toTabSummary(state, {})
    expect(anonymous.id).toBeNull()
    expect(anonymous.handle).toBeNull()
    expect(anonymous.title).toBe('')
    expect(anonymous.url).toBe('')
    expect(anonymous.windowId).toBeNull()
  })

  test('clearRemovedTabHandle drops both directions and ignores unknown tabs', () => {
    const state = createExtensionState(1234)
    expect(getOrCreateTabHandle(state, 12)).toBe('t12')

    clearRemovedTabHandle(state, 12)
    expect(state.targeting.tabHandles.has(12)).toBe(false)
    expect(state.targeting.tabIdsByHandle.has('t12')).toBe(false)

    // 未登记过的标签不产生任何副作用
    clearRemovedTabHandle(state, 99)
    expect(state.targeting.tabHandles.size).toBe(0)
  })

  test('resolveTabHandle prefers the mapping but derives it when the maps are empty', () => {
    const state = createExtensionState(1234)
    getOrCreateTabHandle(state, 12)

    expect(resolveTabHandle(state, 't12')).toBe(12)
    expect(resolveTabHandle(state, ' T12 ')).toBe(12)

    // SW 重启：映射清空，句柄本身仍能反推出 tabId（存在性交给 tabsGet）
    const restarted = createExtensionState(1234)
    expect(restarted.targeting.tabIdsByHandle.size).toBe(0)
    expect(resolveTabHandle(restarted, 't12')).toBe(12)

    // 非法或非句柄输入一律 null，避免把 '#main' / 't0' 当成标签
    expect(resolveTabHandle(state, 't0')).toBeNull()
    expect(resolveTabHandle(state, '#main')).toBeNull()
    expect(resolveTabHandle(state, 'tab12')).toBeNull()
    expect(resolveTabHandle(state, '@f12')).toBeNull()
    expect(resolveTabHandle(state, null)).toBeNull()
    expect(resolveTabHandle(state, undefined)).toBeNull()
  })

  test('resolveTabInput covers numbers, handles and numeric strings', () => {
    const state = createExtensionState(1234)

    expect(resolveTabInput(state, 7)).toBe(7)
    expect(resolveTabInput(state, 't7')).toBe(7)
    expect(resolveTabInput(state, '  t7  ')).toBe(7)
    // 纯数字字符串按 tabId 处理，与句柄解析互不干扰
    expect(resolveTabInput(state, '7')).toBe(7)

    expect(resolveTabInput(state, '0')).toBeNull()
    expect(resolveTabInput(state, '-3')).toBeNull()
    expect(resolveTabInput(state, '1.5')).toBeNull()
    expect(resolveTabInput(state, '')).toBeNull()
    expect(resolveTabInput(state, 'main')).toBeNull()
    expect(resolveTabInput(state, null)).toBeNull()
    expect(resolveTabInput(state, undefined)).toBeNull()
  })

  test('createStaleTabHandleError carries the code and the next step', () => {
    const error = createStaleTabHandleError('t99')

    expect(error.code).toBe('STALE_TAB_HANDLE')
    expect(error.message).toContain('t99')
    expect(error.suggestedAction).toContain('tab list')
  })
})

describe('page epoch', () => {
  test('getPageEpoch initializes at 1 and repairs non-positive values', () => {
    const state = createExtensionState(1234)

    expect(getPageEpoch(state, 1)).toBe(1)
    expect(getPageEpoch(state, 1)).toBe(1)

    // 持久化/外部写入的脏值不能让代次停摆
    state.targeting.pageEpochs.set(2, 0)
    expect(getPageEpoch(state, 2)).toBe(1)
  })

  test('invalidatePageRefs bumps the epoch and drops the selected frame', () => {
    const state = createExtensionState(1234)
    state.targeting.selectedFrames.set(1, 'iframe.pay')

    expect(invalidatePageRefs(state, 1)).toBe(2)
    expect(state.targeting.selectedFrames.has(1)).toBe(false)
    expect(getPageEpoch(state, 1)).toBe(2)

    // 连续导航继续累加，旧引用不会重新变"新"
    expect(invalidatePageRefs(state, 1)).toBe(3)
  })

  test('clearSelectedFrame only touches the given tab', () => {
    const state = createExtensionState(1234)
    state.targeting.selectedFrames.set(1, '#a')
    state.targeting.selectedFrames.set(2, '#b')

    clearSelectedFrame(state, 1)

    expect(state.targeting.selectedFrames.has(1)).toBe(false)
    expect(state.targeting.selectedFrames.get(2)).toBe('#b')
  })

  test('clearRemovedPageEpoch forgets the tab so it restarts from 1', () => {
    const state = createExtensionState(1234)
    invalidatePageRefs(state, 5)
    expect(getPageEpoch(state, 5)).toBe(2)

    clearRemovedPageEpoch(state, 5)

    expect(state.targeting.pageEpochs.has(5)).toBe(false)
    expect(getPageEpoch(state, 5)).toBe(1)
  })
})

describe('stale ref assertions', () => {
  test('assertFreshElementRef only rejects refs carrying a different epoch', () => {
    const state = createExtensionState(1234)
    getPageEpoch(state, 1)

    // 普通选择器与不带代次的旧协议引用一律放行
    expect(() => assertFreshElementRef(state, 1, '#main')).not.toThrow()
    expect(() => assertFreshElementRef(state, 1, '@e5')).not.toThrow()
    expect(() => assertFreshElementRef(state, 1, null)).not.toThrow()
    expect(() => assertFreshElementRef(state, 1, '@e5#p1')).not.toThrow()

    const error = captureError(() => assertFreshElementRef(state, 1, '@e5#p0'))
    expect(error.code).toBe('STALE_ELEMENT_REF')
    expect(error.ref).toBe('@e5#p0')
    expect(error.expectedPageEpoch).toBe(0)
    expect(error.currentPageEpoch).toBe(1)
    expect(error.suggestedAction).toContain('snapshot')
  })

  test('assertFreshFrameRef reports frame and element staleness separately', () => {
    const state = createExtensionState(1234)
    invalidatePageRefs(state, 1)
    invalidatePageRefs(state, 1)
    expect(getPageEpoch(state, 1)).toBe(3)

    expect(() => assertFreshFrameRef(state, 1, '@f2#p3')).not.toThrow()

    const frameError = captureError(() => assertFreshFrameRef(state, 1, '@f2#p1'))
    expect(frameError.code).toBe('STALE_FRAME_REF')
    expect(frameError.expectedPageEpoch).toBe(1)
    expect(frameError.currentPageEpoch).toBe(3)

    // 元素引用走同一条断言入口，错误码按 ref 类型区分
    const elementError = captureError(() => assertFreshFrameRef(state, 1, '@e2#p1'))
    expect(elementError.code).toBe('STALE_ELEMENT_REF')
  })
})

describe('frame selector resolution', () => {
  test('explicit selector wins and top/main/default mean the main frame', () => {
    const state = createExtensionState(1234)
    state.targeting.selectedFrames.set(1, '#selected')

    expect(resolveEffectiveFrameSelector(state, { id: 1 }, '  #explicit  ')).toBe('#explicit')
    expect(resolveEffectiveFrameSelector(state, { id: 1 }, 'top')).toBeNull()
    expect(resolveEffectiveFrameSelector(state, { id: 1 }, 'MAIN')).toBeNull()
    expect(resolveEffectiveFrameSelector(state, { id: 1 }, 'default')).toBeNull()

    // 显式空值不回退成"没有 frame"，而是沿用该标签已选定的 frame
    expect(resolveEffectiveFrameSelector(state, { id: 1 }, '   ')).toBe('#selected')
    expect(resolveEffectiveFrameSelector(state, { id: 1 }, null)).toBe('#selected')
  })

  test('resolveEffectiveFrameSelector falls back to nothing for unknown tabs', () => {
    const state = createExtensionState(1234)

    expect(resolveEffectiveFrameSelector(state, { id: 9 }, null)).toBeNull()
    expect(resolveEffectiveFrameSelector(state, {}, '#explicit')).toBe('#explicit')
    expect(resolveEffectiveFrameSelector(state, {}, null)).toBeNull()
  })

  test('withFrameSelectorOptions keeps the original options when the selector is empty', () => {
    const options = { timeoutMs: 2000 }

    // 空值不能覆盖已有配置：必须原样返回同一个对象
    expect(withFrameSelectorOptions(undefined, options)).toBe(options)
    expect(withFrameSelectorOptions(null, options)).toBe(options)
    expect(withFrameSelectorOptions('   ', options)).toBe(options)

    expect(withFrameSelectorOptions('  #pay  ', options)).toEqual({
      timeoutMs: 2000,
      frameSelector: '#pay',
    })
    // 不修改传入对象
    expect(options).toEqual({ timeoutMs: 2000 })
    expect(withFrameSelectorOptions('#pay')).toEqual({ frameSelector: '#pay' })
  })
})
