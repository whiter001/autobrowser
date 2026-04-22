import {
  CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  DEFAULT_RELAY_PORT,
  DEFAULT_IPC_PORT,
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

const AUTO_CLOSE_POLL_INTERVAL_MS = 500

let autoCloseTimer: number | null = null
let autoCloseRequested = false
let autoCloseEnabled = false

function stopAutoClosePolling(): void {
  if (autoCloseTimer !== null) {
    clearInterval(autoCloseTimer)
    autoCloseTimer = null
  }
}

function closeConnectPage(): void {
  if (autoCloseRequested || !autoCloseEnabled) {
    return
  }

  autoCloseRequested = true
  stopAutoClosePolling()

  const closeWithWindow = () => {
    try {
      window.close()
    } catch {
      // Ignore: some Chromium contexts refuse script-initiated closes.
    }
  }

  try {
    chrome.tabs.getCurrent((tab) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        console.warn('failed to read current tab before closing connect page', lastError.message)
        closeWithWindow()
        return
      }

      if (!tab?.id) {
        closeWithWindow()
        return
      }

      chrome.tabs.remove(tab.id, () => {
        const removeError = chrome.runtime.lastError
        if (removeError) {
          console.warn('failed to close connect page', removeError.message)
          closeWithWindow()
        }
      })
    })
  } catch (error) {
    console.warn('failed to close connect page', error)
    closeWithWindow()
  }
}

function getConnectParams(): { token: string; relayPort: number; ipcPort: number } {
  const url = new URL(globalThis.location.href)
  const token = url.searchParams.get('token') || ''
  const relayPort = normalizeRelayPort(url.searchParams.get('relayPort') || DEFAULT_RELAY_PORT)
  const ipcPort = normalizeRelayPort(url.searchParams.get('ipcPort') || DEFAULT_IPC_PORT)
  return { token, relayPort, ipcPort }
}

async function saveConnectionSettings(token: string, relayPort: number): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY]: token,
    [RELAY_PORT_STORAGE_KEY]: relayPort,
  })
}

async function loadDiagnostics(): Promise<void> {
  const diagnosticsEl = document.getElementById('diagnostics')
  const statusTextEl = document.getElementById('status-text')
  if (!diagnosticsEl || !statusTextEl) {
    return
  }

  try {
    const response = (await chrome.runtime.sendMessage({ type: 'autobrowser.getStatus' })) as
      | StatusResponse
      | undefined
    if (response?.ok) {
      diagnosticsEl.textContent = formatDiagnostics(response)
      statusTextEl.textContent = response.connected
        ? 'extension connected'
        : 'waiting for extension'

      if (response.connected) {
        closeConnectPage()
      }
      return
    }
  } catch (error) {
    console.warn('failed to load live connection status', error)
  }

  const result = (await chrome.storage.local.get([
    CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  ])) as StorageResult
  const stored = result[CONNECTION_DIAGNOSTICS_STORAGE_KEY]
  if (stored && typeof stored === 'object') {
    diagnosticsEl.textContent = formatDiagnostics(stored as DiagnosticsState)
    statusTextEl.textContent = 'waiting for extension'
    return
  }

  diagnosticsEl.textContent = '暂无诊断信息'
  statusTextEl.textContent = 'waiting for extension'
}

async function connect(): Promise<void> {
  const tokenEl = document.getElementById('token')
  const relayUrlEl = document.getElementById('relay-url')
  const ipcUrlEl = document.getElementById('ipc-url')
  const statusLinkEl = document.getElementById('status-link') as HTMLAnchorElement | null
  const statusTextEl = document.getElementById('status-text')
  const { token, relayPort, ipcPort } = getConnectParams()

  autoCloseEnabled = Boolean(token)

  if (tokenEl) {
    tokenEl.textContent = token || 'missing token'
  }
  if (relayUrlEl) {
    relayUrlEl.textContent = `ws://127.0.0.1:${relayPort}/ws`
  }
  if (ipcUrlEl) {
    ipcUrlEl.textContent = `http://127.0.0.1:${ipcPort}`
  }
  if (statusLinkEl) {
    statusLinkEl.href = `http://127.0.0.1:${ipcPort}/status`
  }

  if (token) {
    await saveConnectionSettings(token, relayPort)
    if (statusTextEl) {
      statusTextEl.textContent = `saved token for relay port ${relayPort}`
    }
    history.replaceState(null, '', location.pathname)
  } else if (statusTextEl) {
    statusTextEl.textContent = 'missing token'
  }

  await loadDiagnostics()

  if (autoCloseEnabled && !autoCloseRequested) {
    stopAutoClosePolling()
    autoCloseTimer = window.setInterval(() => {
      loadDiagnostics().catch((error: Error) => {
        const diagnosticsEl = document.getElementById('diagnostics')
        if (diagnosticsEl) {
          diagnosticsEl.textContent = error.message
        }
      })
    }, AUTO_CLOSE_POLL_INTERVAL_MS)
  }
}

const refreshButton = document.getElementById('refresh')
if (refreshButton) {
  refreshButton.addEventListener('click', () => {
    loadDiagnostics().catch((error: Error) => {
      const diagnosticsEl = document.getElementById('diagnostics')
      if (diagnosticsEl) {
        diagnosticsEl.textContent = error.message
      }
    })
  })
}

connect().catch((error: Error) => {
  const statusTextEl = document.getElementById('status-text')
  const diagnosticsEl = document.getElementById('diagnostics')
  if (statusTextEl) {
    statusTextEl.textContent = error.message
  }
  if (diagnosticsEl) {
    diagnosticsEl.textContent = error.message
  }
})
