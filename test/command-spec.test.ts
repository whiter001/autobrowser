import { describe, expect, test } from 'bun:test'
import {
  COMMAND_SPECS,
  commandSupportsFrameTarget,
  commandSupportsTabTarget,
  getCommandSpec,
} from '../src/core/command-spec.js'

describe('command specs', () => {
  test('exposes target capabilities for page commands', () => {
    expect(commandSupportsTabTarget('click')).toBe(true)
    expect(commandSupportsFrameTarget('click')).toBe(true)
    expect(commandSupportsTabTarget('frame')).toBe(true)
    expect(commandSupportsFrameTarget('frame')).toBe(false)
  })

  test('does not apply ambient page targets to tab management commands', () => {
    expect(getCommandSpec('tab.new')).toBeUndefined()
    expect(commandSupportsTabTarget('tab.select')).toBe(false)
    expect(commandSupportsFrameTarget('tab.close')).toBe(false)
  })

  test('keeps command names unique', () => {
    const names = COMMAND_SPECS.map((spec) => spec.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
