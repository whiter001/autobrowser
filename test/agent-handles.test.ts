import { describe, expect, test } from 'bun:test'
import {
  AGENT_FRAME_REF_ATTRIBUTE,
  formatAgentFrameRef,
  formatAgentTabHandle,
  getAgentFrameRefPageEpoch,
  isAgentFrameRef,
  isStaleAgentFrameRef,
  isAgentTabHandle,
  parseAgentFrameRef,
  parseAgentFrameRefInfo,
  parseAgentTabHandle,
  resolveAgentFrameSelector,
} from '../src/core/agent-handles.js'
import { createExtensionState } from '../extension/background/state.js'
import {
  clearRemovedTabHandle,
  getOrCreateTabHandle,
  resolveTabHandle,
  resolveTabInput,
} from '../extension/background/targeting.js'

describe('agent tab and frame handles', () => {
  test('formats and parses stable tab handles', () => {
    expect(formatAgentTabHandle(1)).toBe('t1')
    expect(parseAgentTabHandle(' t12 ')).toBe('t12')
    expect(isAgentTabHandle('t7')).toBe(true)
    expect(isAgentTabHandle('7')).toBe(false)
  })

  test('formats and parses stable frame refs', () => {
    expect(formatAgentFrameRef(1)).toBe('@f1')
    expect(formatAgentFrameRef(3, 12)).toBe('@f3#p12')
    expect(parseAgentFrameRef(' @f9 ')).toBe('f9')
    expect(parseAgentFrameRef('@f9#p5')).toBe('f9')
    expect(parseAgentFrameRefInfo('@f9#p5')).toEqual({ ref: 'f9', pageEpoch: 5 })
    expect(getAgentFrameRefPageEpoch('@f9#p5')).toBe(5)
    expect(isAgentFrameRef('@f2')).toBe(true)
    expect(isAgentFrameRef('@e2')).toBe(false)
  })

  test('resolves frame refs to DOM selectors', () => {
    expect(resolveAgentFrameSelector('@f3')).toBe(`[${AGENT_FRAME_REF_ATTRIBUTE}="f3"]`)
    expect(resolveAgentFrameSelector('@f3#p8')).toBe(`[${AGENT_FRAME_REF_ATTRIBUTE}="f3"]`)
    expect(resolveAgentFrameSelector('@e5')).toBe('[data-autobrowser-ref="e5"]')
    expect(resolveAgentFrameSelector('iframe.payment')).toBe('iframe.payment')
  })

  test('detects stale frame refs when page epochs diverge', () => {
    expect(isStaleAgentFrameRef('@f4', 10)).toBe(false)
    expect(isStaleAgentFrameRef('@f4#p10', 10)).toBe(false)
    expect(isStaleAgentFrameRef('@f4#p10', 11)).toBe(true)
  })
})

describe('stable tab handles across extension state instances', () => {
  test('derives handles from chrome tabId regardless of registration order', () => {
    const firstState = createExtensionState(1234)
    const secondState = createExtensionState(1234)

    // 两个 state 实例模拟 SW 重启前后：tabs.query 枚举顺序不同，handle 必须一致
    expect(getOrCreateTabHandle(firstState, 13)).toBe('t13')
    expect(getOrCreateTabHandle(firstState, 12)).toBe('t12')

    expect(getOrCreateTabHandle(secondState, 12)).toBe('t12')
    expect(getOrCreateTabHandle(secondState, 13)).toBe('t13')
  })

  test('keeps the same handle after the service worker loses its memory maps', () => {
    const beforeRestart = createExtensionState(1234)
    const handleBeforeRestart = getOrCreateTabHandle(beforeRestart, 12)
    expect(handleBeforeRestart).toBe('t12')
    expect(resolveTabHandle(beforeRestart, 't12')).toBe(12)

    const afterRestart = createExtensionState(1234)
    expect(getOrCreateTabHandle(afterRestart, 12)).toBe(handleBeforeRestart)
    expect(resolveTabHandle(afterRestart, 't12')).toBe(12)
  })

  test('cleared handles of closed tabs never silently hit another tab', () => {
    const state = createExtensionState(1234)
    expect(getOrCreateTabHandle(state, 12)).toBe('t12')
    expect(getOrCreateTabHandle(state, 42)).toBe('t42')

    clearRemovedTabHandle(state, 12)

    expect(state.targeting.tabHandles.has(12)).toBe(false)
    expect(state.targeting.tabIdsByHandle.has('t12')).toBe(false)
    expect(resolveTabHandle(state, 't12')).toBeNull()
    // 数字兜底也不能把 t12 误判成 tabId
    expect(resolveTabInput(state, 't12')).toBeNull()

    // 新登记的 tab 不会复用旧 handle
    expect(getOrCreateTabHandle(state, 13)).toBe('t13')
    expect(resolveTabHandle(state, 't12')).toBeNull()

    // 同一 tabId 再次登记（例如会话恢复）仍得到同一 handle
    expect(getOrCreateTabHandle(state, 12)).toBe('t12')
    expect(resolveTabHandle(state, 't12')).toBe(12)
  })
})
