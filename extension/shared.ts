export const STORAGE_KEY = 'autobrowserToken'
export const RELAY_PORT_STORAGE_KEY = 'autobrowserRelayPort'
export const CONNECTION_DIAGNOSTICS_STORAGE_KEY = 'autobrowserConnectionDiagnostics'
export const DEFAULT_RELAY_PORT = 47978
export const DEFAULT_IPC_PORT = 47979

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'missing-token'
  | 'error'

export interface ConnectionErrorInfo {
  message: string
  at: string
  code?: string
}

export interface SocketCloseInfo {
  code: number
  reason: string
  wasClean: boolean
  at: string
}

export interface CommandErrorInfo {
  command: string
  message: string
  at: string
  code?: string
}

export interface DiagnosticsState {
  status: ConnectionStatus
  connectionError: ConnectionErrorInfo | null
  lastSocketClose: SocketCloseInfo | null
  lastCommandError: CommandErrorInfo | null
  updatedAt: string
}

export interface StatusResponse {
  ok: boolean
  connected?: boolean
  connectionStatus?: string
  connectionError?: ConnectionErrorInfo | null
  lastSocketClose?: SocketCloseInfo | null
  lastCommandError?: CommandErrorInfo | null
  token?: string
  relayPort?: number
}

export function normalizeRelayPort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_RELAY_PORT
}

export function formatDiagnostics(status: DiagnosticsState | StatusResponse | null): string {
  if (!status) {
    return '暂无诊断信息'
  }

  const lines: string[] = []
  if ('ok' in status) {
    lines.push(
      `连接状态: ${status.connectionStatus || (status.connected ? 'connected' : 'disconnected')}`,
    )
  } else {
    lines.push(`连接状态: ${status.status}`)
  }

  const connectionError = status.connectionError
  if (connectionError) {
    lines.push(
      `连接错误: ${connectionError.message}${connectionError.code ? ` (${connectionError.code})` : ''} @ ${connectionError.at}`,
    )
  }

  const lastSocketClose = status.lastSocketClose
  if (lastSocketClose) {
    lines.push(
      `最后一次断开: code=${lastSocketClose.code}, clean=${lastSocketClose.wasClean ? 'yes' : 'no'}, reason=${lastSocketClose.reason || '(empty)'} @ ${lastSocketClose.at}`,
    )
  }

  const lastCommandError = status.lastCommandError
  if (lastCommandError) {
    lines.push(
      `命令错误: ${lastCommandError.command} -> ${lastCommandError.message}${lastCommandError.code ? ` (${lastCommandError.code})` : ''} @ ${lastCommandError.at}`,
    )
  }

  if ('updatedAt' in status) {
    lines.push(`更新时间: ${status.updatedAt}`)
  }

  return lines.join('\n')
}
