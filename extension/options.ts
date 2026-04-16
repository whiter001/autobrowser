const STORAGE_KEY = 'autobrowserToken';
const RELAY_PORT_STORAGE_KEY = 'autobrowserRelayPort';
const DEFAULT_RELAY_PORT = 47978;

function normalizeRelayPort(value: string | number | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_RELAY_PORT;
}

interface StorageResult {
  [key: string]: string | number | undefined;
}

async function loadSettings(): Promise<void> {
  const result = (await chrome.storage.local.get([
    STORAGE_KEY,
    RELAY_PORT_STORAGE_KEY,
  ])) as StorageResult;

  const tokenInput = document.getElementById('token') as HTMLInputElement | null;
  const portInput = document.getElementById('relay-port') as HTMLInputElement | null;

  if (tokenInput) {
    tokenInput.value = String(result[STORAGE_KEY] || '');
  }
  if (portInput) {
    portInput.value = String(normalizeRelayPort(result[RELAY_PORT_STORAGE_KEY]));
  }
}

async function saveSettings(): Promise<void> {
  const tokenInput = document.getElementById('token') as HTMLInputElement | null;
  const portInput = document.getElementById('relay-port') as HTMLInputElement | null;
  const statusEl = document.getElementById('status');

  if (!tokenInput || !portInput || !statusEl) {
    return;
  }

  const token = tokenInput.value.trim();
  const relayPortRaw = portInput.value.trim();
  const relayPort = normalizeRelayPort(relayPortRaw || DEFAULT_RELAY_PORT);

  if (relayPortRaw && String(relayPort) !== relayPortRaw) {
    statusEl.textContent = 'Relay 端口必须是正整数';
    return;
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: token,
    [RELAY_PORT_STORAGE_KEY]: relayPort,
  });

  statusEl.textContent = token
    ? `已保存，扩展会自动重连到 127.0.0.1:${relayPort}`
    : `已清空 token，扩展仍会尝试连接 127.0.0.1:${relayPort}`;
}

const saveButton = document.getElementById('save');
if (saveButton) {
  saveButton.addEventListener('click', () => {
    saveSettings().catch((error: Error) => {
      const statusEl = document.getElementById('status');
      if (statusEl) {
        statusEl.textContent = error.message;
      }
    });
  });
}

loadSettings().catch((error: Error) => {
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = error.message;
  }
});
