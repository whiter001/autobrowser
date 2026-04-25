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
