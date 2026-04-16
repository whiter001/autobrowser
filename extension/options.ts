const STORAGE_KEY = 'autobrowserToken'
const RELAY_PORT_STORAGE_KEY = 'autobrowserRelayPort'
const CONNECTION_DIAGNOSTICS_STORAGE_KEY = 'autobrowserConnectionDiagnostics'
const DEFAULT_RELAY_PORT = 47978

function normalizeRelayPort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_RELAY_PORT
}

interface StorageResult {
  [key: string]: unknown
}

interface ConnectionErrorInfo {
  message: string
  at: string
  code?: string
}

interface SocketCloseInfo {
  code: number
  reason: string
  wasClean: boolean
  at: string
}

interface CommandErrorInfo {
  command: string
  message: string
  at: string
  code?: string
}

interface DiagnosticsState {
  status: string
  connectionError: ConnectionErrorInfo | null
  lastSocketClose: SocketCloseInfo | null
  lastCommandError: CommandErrorInfo | null
  updatedAt: string
}

interface StoredDiagnostics extends DiagnosticsState {}

interface StatusResponse {
  ok: boolean
  connected?: boolean
  connectionStatus?: string
  connectionError?: ConnectionErrorInfo | null
  lastSocketClose?: SocketCloseInfo | null
  lastCommandError?: CommandErrorInfo | null
  token?: string
  relayPort?: number
}

function formatDiagnostics(status: StoredDiagnostics | StatusResponse | null): string {
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

async function loadDiagnostics(): Promise<void> {
  const diagnosticsEl = document.getElementById('diagnostics')
  if (!diagnosticsEl) {
    return
  }

  let status: StoredDiagnostics | StatusResponse | null = null

  try {
    const response = (await chrome.runtime.sendMessage({ type: 'autobrowser.getStatus' })) as
      | StatusResponse
      | undefined
    if (response?.ok) {
      status = response
    }
  } catch (error) {
    console.warn('failed to load live plugin diagnostics', error)
  }

  if (!status) {
    const result = (await chrome.storage.local.get([
      CONNECTION_DIAGNOSTICS_STORAGE_KEY,
    ])) as StorageResult
    const stored = result[CONNECTION_DIAGNOSTICS_STORAGE_KEY]
    if (stored && typeof stored === 'object') {
      status = stored as StoredDiagnostics
    }
  }

  diagnosticsEl.textContent = formatDiagnostics(status)
}

async function loadSettings(): Promise<void> {
  const result = (await chrome.storage.local.get([
    STORAGE_KEY,
    RELAY_PORT_STORAGE_KEY,
  ])) as StorageResult

  const tokenInput = document.getElementById('token') as HTMLInputElement | null
  const portInput = document.getElementById('relay-port') as HTMLInputElement | null

  if (tokenInput) {
    tokenInput.value = String(result[STORAGE_KEY] || '')
  }
  if (portInput) {
    portInput.value = String(normalizeRelayPort(result[RELAY_PORT_STORAGE_KEY]))
  }
}

async function saveSettings(): Promise<void> {
  const tokenInput = document.getElementById('token') as HTMLInputElement | null
  const portInput = document.getElementById('relay-port') as HTMLInputElement | null
  const statusEl = document.getElementById('status')

  if (!tokenInput || !portInput || !statusEl) {
    return
  }

  const token = tokenInput.value.trim()
  const relayPortRaw = portInput.value.trim()
  const relayPort = normalizeRelayPort(relayPortRaw || DEFAULT_RELAY_PORT)

  if (relayPortRaw && String(relayPort) !== relayPortRaw) {
    statusEl.textContent = 'Relay 端口必须是正整数'
    return
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: token,
    [RELAY_PORT_STORAGE_KEY]: relayPort,
  })

  statusEl.textContent = token
    ? `已保存，扩展会自动重连到 127.0.0.1:${relayPort}`
    : `已清空 token，扩展仍会尝试连接 127.0.0.1:${relayPort}`

  await loadDiagnostics()
}

const saveButton = document.getElementById('save')
if (saveButton) {
  saveButton.addEventListener('click', () => {
    saveSettings().catch((error: Error) => {
      const statusEl = document.getElementById('status')
      if (statusEl) {
        statusEl.textContent = error.message
      }
    })
  })
}

loadSettings().catch((error: Error) => {
  const statusEl = document.getElementById('status')
  if (statusEl) {
    statusEl.textContent = error.message
  }
})

loadDiagnostics().catch((error: Error) => {
  const diagnosticsEl = document.getElementById('diagnostics')
  if (diagnosticsEl) {
    diagnosticsEl.textContent = error.message
  }
})

setInterval(() => {
  loadDiagnostics().catch((error: Error) => {
    const diagnosticsEl = document.getElementById('diagnostics')
    if (diagnosticsEl) {
      diagnosticsEl.textContent = error.message
    }
  })
}, 3000)
