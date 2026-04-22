import { describe, expect, test } from 'bun:test'

interface MockElement {
  textContent: string
  href?: string
  addEventListener: (type: string, listener: () => void) => void
}

function defineGlobalValue(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  })
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('extension connect page', () => {
  test('closes the connect tab after the relay reports a connected socket', async () => {
    const originalGlobals = {
      chrome: globalThis.chrome,
      document: globalThis.document,
      history: globalThis.history,
      location: globalThis.location,
      clearInterval: globalThis.clearInterval,
      setInterval: globalThis.setInterval,
      window: globalThis.window,
    }

    const sendMessageResponses = [
      {
        ok: true,
        connected: false,
        connectionStatus: 'connecting',
      },
      {
        ok: true,
        connected: true,
        connectionStatus: 'connected',
      },
    ]

    const sendMessageCalls: unknown[] = []
    const removeCalls: number[] = []
    const clearIntervalCalls: number[] = []
    const closeCalls: number[] = []
    const intervalCallbacks: Array<() => void> = []

    const elements: Record<string, MockElement> = {
      token: {
        textContent: '',
        addEventListener: () => {},
      },
      'relay-url': {
        textContent: '',
        addEventListener: () => {},
      },
      'ipc-url': {
        textContent: '',
        addEventListener: () => {},
      },
      'status-text': {
        textContent: '',
        addEventListener: () => {},
      },
      diagnostics: {
        textContent: '暂无诊断信息',
        addEventListener: () => {},
      },
      refresh: {
        textContent: '',
        addEventListener: () => {},
      },
      'status-link': {
        textContent: '',
        href: '#',
        addEventListener: () => {},
      },
    }

    const mockWindow = {
      close: () => {
        closeCalls.push(Date.now())
      },
      setInterval: (callback: () => void, _delay?: number) => {
        intervalCallbacks.push(callback)
        return intervalCallbacks.length
      },
    }

    const mockDocument = {
      getElementById: (id: string) => elements[id] || null,
    }

    const mockHistory = {
      replaceState: () => {},
    }

    const mockLocation = {
      href: 'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=test-token&relayPort=57978&ipcPort=57979',
      pathname: '/connect.html',
    }

    const mockChrome = {
      runtime: {
        lastError: undefined,
        sendMessage: async (message: unknown) => {
          sendMessageCalls.push(message)
          const nextResponse = sendMessageResponses.shift()
          if (!nextResponse) {
            throw new Error('unexpected extra status request')
          }
          return nextResponse
        },
      },
      storage: {
        local: {
          set: async () => {},
          get: async () => ({}),
        },
      },
      tabs: {
        getCurrent: (callback: (tab?: { id?: number }) => void) => {
          callback({ id: 123 })
        },
        remove: (tabId: number, callback?: () => void) => {
          removeCalls.push(tabId)
          callback?.()
        },
      },
    }

    defineGlobalValue('chrome', mockChrome)
    defineGlobalValue('document', mockDocument)
    defineGlobalValue('history', mockHistory)
    defineGlobalValue('location', mockLocation)
    defineGlobalValue('clearInterval', (timerId: number) => {
      clearIntervalCalls.push(timerId)
    })
    defineGlobalValue('setInterval', mockWindow.setInterval)
    defineGlobalValue('window', mockWindow)

    try {
      await import(`../extension/connect.js?test=${Date.now()}`)

      await flushMicrotasks()

      expect(elements['status-text'].textContent).toBe('waiting for extension')
      expect(intervalCallbacks).toHaveLength(1)
      expect(removeCalls).toHaveLength(0)
      expect(closeCalls).toHaveLength(0)

      intervalCallbacks[0]()
      await flushMicrotasks()

      expect(elements['status-text'].textContent).toBe('extension connected')
      expect(removeCalls).toEqual([123])
      expect(closeCalls).toHaveLength(0)
      expect(clearIntervalCalls).toEqual([1])
      expect(sendMessageCalls).toHaveLength(2)
    } finally {
      defineGlobalValue('chrome', originalGlobals.chrome)
      defineGlobalValue('document', originalGlobals.document)
      defineGlobalValue('history', originalGlobals.history)
      defineGlobalValue('location', originalGlobals.location)
      defineGlobalValue('clearInterval', originalGlobals.clearInterval)
      defineGlobalValue('setInterval', originalGlobals.setInterval)
      defineGlobalValue('window', originalGlobals.window)
    }
  })
})
