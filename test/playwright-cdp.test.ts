import { describe, expect, test } from 'bun:test'
import { createPlaywrightCdpBridge } from '../extension/background/playwright-cdp.js'

function responsePayloads(sent: string[]): any[] {
  return sent.map((message) => JSON.parse(message))
}

describe('Playwright CDP extension bridge', () => {
  test('scopes commands and events to the exclusive tab and restores routes on stop', async () => {
    const sent: string[] = []
    const socket = {
      readyState: WebSocket.OPEN,
      send(message: string) {
        sent.push(message)
      },
    } as unknown as WebSocket
    const attached: number[] = []
    const commands: unknown[] = []
    let refreshes = 0
    const bridge = createPlaywrightCdpBridge({
      getSocket: () => socket,
      ensureDebuggerAttached: async (tabId) => {
        attached.push(tabId)
      },
      sendDebuggerSessionCommand: async (target, method, params) => {
        commands.push([target, method, params])
        return { answer: 42 }
      },
      refreshInterceptors: async () => {
        refreshes += 1
      },
    })

    await bridge.handleMessage(socket, {
      type: 'cdp.control',
      id: 'start',
      runId: 'run-1',
      action: 'start',
      tabId: 7,
    })
    await bridge.handleMessage(socket, {
      type: 'cdp.command',
      id: 'command',
      runId: 'run-1',
      method: 'chrome.debugger.sendCommand',
      params: [{ tabId: 7, sessionId: 'child' }, 'Runtime.evaluate', { expression: '6 * 7' }],
    })
    bridge.handleDebuggerEvent({ tabId: 7 }, 'Runtime.consoleAPICalled', { type: 'log' })
    bridge.handleDebuggerEvent({ tabId: 8 }, 'Runtime.consoleAPICalled', { type: 'ignored' })

    expect(attached).toEqual([7])
    expect(commands).toEqual([
      [{ tabId: 7 }, 'Runtime.disable', {}],
      [{ tabId: 7 }, 'Fetch.disable', {}],
      [{ tabId: 7, sessionId: 'child' }, 'Runtime.evaluate', { expression: '6 * 7' }],
    ])
    expect(responsePayloads(sent)).toContainEqual({
      type: 'cdp.event',
      runId: 'run-1',
      method: 'chrome.debugger.onEvent',
      params: [{ tabId: 7 }, 'Runtime.consoleAPICalled', { type: 'log' }],
    })
    expect(responsePayloads(sent).filter((message) => message.type === 'cdp.event')).toHaveLength(1)

    await bridge.handleMessage(socket, {
      type: 'cdp.control',
      id: 'stop',
      runId: 'run-1',
      action: 'stop',
    })
    expect(refreshes).toBe(1)
    expect(responsePayloads(sent).at(-1)).toMatchObject({
      type: 'cdp.response',
      id: 'stop',
      ok: true,
      result: { stopped: true },
    })
  })

  test('rejects crossing the run tab boundary', async () => {
    const sent: string[] = []
    const socket = {
      readyState: WebSocket.OPEN,
      send(message: string) {
        sent.push(message)
      },
    } as unknown as WebSocket
    const bridge = createPlaywrightCdpBridge({
      getSocket: () => socket,
      ensureDebuggerAttached: async () => {},
      sendDebuggerSessionCommand: async () => ({}),
      refreshInterceptors: async () => {},
    })
    await bridge.handleMessage(socket, {
      type: 'cdp.control',
      id: 'start',
      runId: 'run-1',
      action: 'start',
      tabId: 7,
    })
    await bridge.handleMessage(socket, {
      type: 'cdp.command',
      id: 'cross',
      runId: 'run-1',
      method: 'chrome.debugger.sendCommand',
      params: [{ tabId: 8 }, 'Runtime.evaluate', {}],
    })
    expect(responsePayloads(sent).at(-1)).toMatchObject({
      type: 'cdp.response',
      id: 'cross',
      ok: false,
      error: 'CDP command crossed the exclusive tab boundary',
    })
  })
})
