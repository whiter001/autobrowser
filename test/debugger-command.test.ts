import { describe, expect, test } from 'bun:test'
import { createDebuggerCommandSender } from '../extension/background/debugger-command.js'

describe('debugger command deadlines', () => {
  test('fails a hung input command before the relay deadline', async () => {
    const recovered: number[] = []
    const { sendDebuggerCommand } = createDebuggerCommandSender({
      ensureDebuggerAttached: async () => {},
      sendRawDebuggerCommand: async () => await new Promise(() => {}),
      timeoutMs: 20,
      recoverDebugger: async (tabId) => {
        recovered.push(tabId)
      },
    })

    await expect(
      sendDebuggerCommand(1, 'Input.dispatchMouseEvent', { type: 'mouseMoved' }),
    ).rejects.toMatchObject({
      code: 'CDP_DEADLINE_EXCEEDED',
      suggestedAction: expect.stringContaining('do not blindly replay'),
    })
    expect(recovered).toEqual([1])
  })

  test('keeps Runtime.evaluate under the page evaluator budget', async () => {
    const { sendDebuggerCommand } = createDebuggerCommandSender({
      ensureDebuggerAttached: async () => {},
      sendRawDebuggerCommand: async <TResult = unknown>() => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { result: { value: 42 } } as TResult
      },
      timeoutMs: 10,
    })

    await expect(sendDebuggerCommand(1, 'Runtime.evaluate')).resolves.toEqual({
      result: { value: 42 },
    })
  })
})
