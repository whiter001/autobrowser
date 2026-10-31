import { describe, expect, spyOn, test } from 'bun:test'
import { createExtensionControl } from '../extension/background/extension-control.js'

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0))
const extensionInfo = {
  extensionId: 'test-extension',
  version: '0.1.3',
  buildTime: '2026-10-31T00:00:00.000Z',
  commit: 'abcdef1',
  userAgent: 'test-browser',
}
const info = async () => extensionInfo

describe('extension control', () => {
  test('info awaits the injected result without scheduling a reload or reconnect', async () => {
    const control = createExtensionControl({
      info,
      reload: () => {
        throw new Error('unexpected reload')
      },
      reconnect: () => {
        throw new Error('unexpected reconnect')
      },
      schedule: () => {
        throw new Error('unexpected schedule')
      },
    })
    expect(await control.info()).toEqual(extensionInfo)
  })

  for (const action of ['reload', 'reconnect'] as const) {
    test(`${action} returns a small acknowledgement before the scheduled callback`, async () => {
      const events: string[] = []
      const scheduled: Array<{ callback: () => void; delayMs: number }> = []
      const control = createExtensionControl({
        info,
        reload: () => {
          events.push('reload')
        },
        reconnect: () => {
          events.push('reconnect')
        },
        schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
      })

      const result = control[action]()
      expect(result).toEqual(
        action === 'reload'
          ? { reloading: true, reconnectExpected: true }
          : { reconnecting: true, reconnectExpected: true },
      )
      events.push(JSON.stringify(result))
      expect(events).toHaveLength(1)
      expect(scheduled).toHaveLength(1)
      expect(scheduled[0].delayMs).toBe(50)
      scheduled[0].callback()
      await nextTurn()
      expect(events).toEqual([JSON.stringify(result), action])
    })

    for (const asyncFailure of [false, true]) {
      test(`${action} logs ${asyncFailure ? 'async rejection' : 'sync exception'} without rejecting the acknowledgement`, async () => {
        const failure = new Error('control failed')
        const callback = () => {
          if (asyncFailure) return Promise.reject(failure)
          throw failure
        }
        let run!: () => void
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
        try {
          const control = createExtensionControl({
            info,
            reload: callback,
            reconnect: callback,
            schedule: (scheduled) => {
              run = scheduled
            },
          })
          expect(control[action]()).toHaveProperty('reconnectExpected', true)
          expect(errorSpy).not.toHaveBeenCalled()
          expect(() => run()).not.toThrow()
          await nextTurn()
          expect(errorSpy).toHaveBeenCalledTimes(1)
          expect(errorSpy).toHaveBeenCalledWith(
            `failed to ${action} autobrowser extension`,
            failure,
          )
        } finally {
          errorSpy.mockRestore()
        }
      })
    }
  }

  test('uses a deferred timer by default', async () => {
    const calls: string[] = []
    const control = createExtensionControl({
      info,
      reload: () => {
        calls.push('reload')
      },
      reconnect: () => {},
    })
    expect(control.reload()).toEqual({ reloading: true, reconnectExpected: true })
    expect(calls).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls).toEqual(['reload'])
  })
})
