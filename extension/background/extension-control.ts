import type { DiagnosticsState } from '../shared.js'

export interface ExtensionInfo {
  extensionId: string
  version: string
  buildTime: string | null
  commit: string | null
  userAgent: string
  /** 连接诊断快照，含 keepalive alarm 统计；旧构建可能为 null */
  diagnostics?: DiagnosticsState | null
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

/**
 * 创建扩展自身的控制能力：版本信息、重载与重连。
 */
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
