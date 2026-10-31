export interface ExtensionInfo {
  extensionId: string
  version: string
  buildTime: string | null
  commit: string | null
  userAgent: string
}

interface ExtensionControlDependencies {
  info: () => Promise<ExtensionInfo>
  reload: () => void | Promise<void>
  reconnect: () => void | Promise<void>
  schedule?: (callback: () => void, delayMs: number) => unknown
}

export interface ExtensionControlDomain {
  info: () => Promise<ExtensionInfo>
  reload: () => { reloading: true; reconnectExpected: true }
  reconnect: () => { reconnecting: true; reconnectExpected: true }
}

export function createExtensionControl({
  info,
  reload,
  reconnect,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
}: ExtensionControlDependencies): ExtensionControlDomain {
  function defer(action: string, callback: () => void | Promise<void>): void {
    // 先让普通小 JSON 回执通过现有响应通道发送，再断开连接或重载扩展。
    schedule(() => {
      void Promise.resolve()
        .then(callback)
        .catch((error) => {
          console.error(`failed to ${action} autobrowser extension`, error)
        })
    }, 50)
  }

  return {
    async info() {
      return await info()
    },
    reload() {
      defer('reload', reload)
      return { reloading: true, reconnectExpected: true }
    },
    reconnect() {
      defer('reconnect', reconnect)
      return { reconnecting: true, reconnectExpected: true }
    },
  }
}
