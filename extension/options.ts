import {
  CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  DEFAULT_RELAY_PORT,
  RELAY_PORT_STORAGE_KEY,
  STORAGE_KEY,
  formatDiagnostics,
  normalizeRelayPort,
  type DiagnosticsState,
  type StatusResponse,
} from './shared.js'

interface StorageResult {
  [key: string]: unknown
}

async function loadDiagnostics(): Promise<void> {
  const diagnosticsEl = document.getElementById('diagnostics')
  if (!diagnosticsEl) {
    return
  }

  let status: DiagnosticsState | StatusResponse | null = null

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
      status = stored as DiagnosticsState
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
