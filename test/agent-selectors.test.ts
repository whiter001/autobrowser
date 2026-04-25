import { describe, expect, test } from 'bun:test'
import {
  AGENT_ELEMENT_REF_ATTRIBUTE,
  formatAgentElementRef,
  getAgentElementRefPageEpoch,
  isAgentElementRef,
  isStaleAgentElementRef,
  parseAgentElementRef,
  parseAgentElementRefInfo,
  resolveAgentSelector,
} from '../src/core/agent-selectors.js'

describe('agent selector refs', () => {
  test('formats and parses element refs with optional page epochs', () => {
    expect(formatAgentElementRef(1)).toBe('@e1')
    expect(formatAgentElementRef(4, 17)).toBe('@e4#p17')
    expect(parseAgentElementRefInfo('@e4#p17')).toEqual({
      ref: 'e4',
      pageEpoch: 17,
    })
    expect(getAgentElementRefPageEpoch('@e4#p17')).toBe(17)
  })

  test('parses element refs emitted by snapshot', () => {
    expect(parseAgentElementRef('@e1')).toBe('e1')
    expect(parseAgentElementRef('@e1#p7')).toBe('e1')
    expect(parseAgentElementRef('  @e42  ')).toBe('e42')
    expect(parseAgentElementRef('#submit')).toBeNull()
  })

  test('detects valid element refs', () => {
    expect(isAgentElementRef('@e7')).toBe(true)
    expect(isAgentElementRef('@x7')).toBe(false)
    expect(isAgentElementRef('button')).toBe(false)
  })

  test('resolves element refs to DOM selectors', () => {
    expect(resolveAgentSelector('@e9')).toBe(`[${AGENT_ELEMENT_REF_ATTRIBUTE}="e9"]`)
    expect(resolveAgentSelector('@e9#p3')).toBe(`[${AGENT_ELEMENT_REF_ATTRIBUTE}="e9"]`)
    expect(resolveAgentSelector('button.primary')).toBe('button.primary')
  })

  test('detects stale element refs when page epochs diverge', () => {
    expect(isStaleAgentElementRef('@e3', 8)).toBe(false)
    expect(isStaleAgentElementRef('@e3#p8', 8)).toBe(false)
    expect(isStaleAgentElementRef('@e3#p8', 9)).toBe(true)
  })
})
