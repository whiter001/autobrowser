import { describe, expect, test } from 'bun:test'
import { createPageInputDomain } from '../extension/background/page-input.js'
import { createExtensionState } from '../extension/background/state.js'

function createPressHarness(options: { failKeyDown?: boolean; failKeyUp?: boolean } = {}) {
  const calls: Array<{ method: string; type?: string }> = []

  const pageInput = createPageInputDomain({
    state: createExtensionState(9222),
    getTargetTab: async () => ({ id: 1, url: 'https://example.com' }) as never,
    resolveElementSelectorForTab: async () => {
      throw new Error('unused in pressKey tests')
    },
    resolveFrameTarget: async () => {
      throw new Error('unused in pressKey tests')
    },
    getFrameExecutionContext: async () => {
      throw new Error('unused in pressKey tests')
    },
    evaluateInTabContext: async () => {
      throw new Error('unused in pressKey tests')
    },
    sendDebuggerCommand: async (_tabId, method, params) => {
      const type = (params as { type?: string } | undefined)?.type
      calls.push({ method, type })
      if (method === 'Input.dispatchKeyEvent' && type === 'keyDown' && options.failKeyDown) {
        throw new Error('keyDown failed')
      }
      if (method === 'Input.dispatchKeyEvent' && type === 'keyUp' && options.failKeyUp) {
        throw new Error('keyUp failed')
      }
      return undefined as never
    },
  })

  return { pageInput, calls }
}

describe('pressKey keyUp fallback', () => {
  test('attempts keyUp in finally even when keyDown fails, and keeps the keyDown error', async () => {
    const { pageInput, calls } = createPressHarness({ failKeyDown: true, failKeyUp: true })

    await expect(pageInput.pressKey(1, 'Enter')).rejects.toThrow('keyDown failed')
    // keyUp 在 finally 里仍然被尝试，且它的失败没有掩盖原始 keyDown 错误
    expect(calls.map((call) => call.type)).toEqual(['keyDown', 'keyUp'])
  })

  test('surfaces the keyUp failure when keyDown succeeded', async () => {
    const { pageInput, calls } = createPressHarness({ failKeyUp: true })

    await expect(pageInput.pressKey(1, 'Enter')).rejects.toThrow('keyUp failed')
    expect(calls.map((call) => call.type)).toEqual(['keyDown', 'keyUp'])
  })

  test('returns pressed when both events succeed', async () => {
    const { pageInput, calls } = createPressHarness()

    await expect(pageInput.pressKey(1, 'Enter')).resolves.toEqual({ key: 'Enter', pressed: true })
    expect(calls.map((call) => call.type)).toEqual(['keyDown', 'keyUp'])
  })
})
