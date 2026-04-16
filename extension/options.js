const STORAGE_KEY = 'autobrowserToken';
const RELAY_PORT_STORAGE_KEY = 'autobrowserRelayPort';
const DEFAULT_RELAY_PORT = 47978;

function normalizeRelayPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_RELAY_PORT;
}

async function loadSettings() {
  const result = await chrome.storage.local.get([STORAGE_KEY, RELAY_PORT_STORAGE_KEY]);
  document.getElementById('token').value = result[STORAGE_KEY] || '';
  document.getElementById('relay-port').value = String(
    normalizeRelayPort(result[RELAY_PORT_STORAGE_KEY]),
  );
}

async function saveSettings() {
  const token = document.getElementById('token').value.trim();
  const relayPortRaw = document.getElementById('relay-port').value.trim();
  const relayPort = normalizeRelayPort(relayPortRaw || DEFAULT_RELAY_PORT);

  if (relayPortRaw && String(relayPort) !== relayPortRaw) {
    document.getElementById('status').textContent = 'Relay 端口必须是正整数';
    return;
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: token,
    [RELAY_PORT_STORAGE_KEY]: relayPort,
  });
  document.getElementById('status').textContent = token
    ? `已保存，扩展会自动重连到 127.0.0.1:${relayPort}`
    : `已清空 token，扩展仍会尝试连接 127.0.0.1:${relayPort}`;
}

document.getElementById('save').addEventListener('click', () => {
  saveSettings().catch((error) => {
    document.getElementById('status').textContent = error.message;
  });
});

loadSettings().catch((error) => {
  document.getElementById('status').textContent = error.message;
});
