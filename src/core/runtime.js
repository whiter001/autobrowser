import {
  createId,
  createToken,
  DEFAULT_REQUEST_TIMEOUT_MS,
  getHomeDir,
  getStatePath,
  getTokenPath,
  readJsonFile,
  writeJsonFile,
} from './protocol.js';

function rejectPendingRequests(pendingRequests, message) {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    pendingRequests.delete(id);
  }
}

function createDefaultSnapshot() {
  return {
    extension: null,
    tabs: [],
    activeTabId: null,
    lastCommand: null,
    lastError: null,
  };
}

export async function createRuntime(options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const relayPort = options.relayPort || 47978;
  const ipcPort = options.ipcPort || 47979;
  const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;

  const persistedState = await readJsonFile(getStatePath(homeDir), null);
  const persistedToken =
    options.token ||
    persistedState?.token ||
    (await readJsonFile(getTokenPath(homeDir), null))?.token;

  // pendingRequests 用来把 CLI 发出的命令和 extension 的异步响应一一对应起来。
  const pendingRequests = new Map();
  const snapshot = createDefaultSnapshot();
  const runtime = {
    homeDir,
    relayPort,
    ipcPort,
    requestTimeoutMs,
    token: persistedToken || createToken(),
    startedAt: new Date().toISOString(),
    snapshot,
    extensionSocket: null,
    extensionId: null,
  };

  // 只恢复少量稳定的状态，避免把过期的 tab 列表或连接态写回运行时。
  if (persistedState?.snapshot && typeof persistedState.snapshot === 'object') {
    snapshot.lastCommand = persistedState.snapshot.lastCommand ?? null;
    snapshot.lastError = persistedState.snapshot.lastError ?? null;
  }

  async function persist() {
    // token 和运行态写入磁盘，这样 connect 页面和扩展重启后仍能继续使用同一把 token。
    await writeJsonFile(getStatePath(homeDir), {
      token: runtime.token,
      relayPort,
      ipcPort,
      startedAt: runtime.startedAt,
      snapshot,
    });
    await writeJsonFile(getTokenPath(homeDir), { token: runtime.token });
  }

  await persist();

  function setError(message) {
    snapshot.lastError = {
      message,
      at: new Date().toISOString(),
    };
  }

  function setLastCommand(command, args) {
    snapshot.lastCommand = {
      command,
      args,
      at: new Date().toISOString(),
    };
  }

  function setTabs(tabs = []) {
    snapshot.tabs = Array.isArray(tabs) ? tabs : [];
    snapshot.activeTabId = snapshot.tabs.find((tab) => tab.active)?.id || null;
  }

  function attachExtension(socket, meta = {}) {
    runtime.extensionSocket = socket;
    runtime.extensionId = meta.extensionId || null;
    snapshot.extension = {
      extensionId: runtime.extensionId,
      connectedAt: new Date().toISOString(),
      userAgent: meta.userAgent || null,
    };
  }

  function detachExtension() {
    runtime.extensionSocket = null;
    runtime.extensionId = null;
    snapshot.extension = null;
    rejectPendingRequests(pendingRequests, 'extension disconnected');
  }

  function handleExtensionMessage(rawMessage) {
    let message;
    try {
      message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
    } catch {
      setError('received invalid JSON from extension');
      return;
    }

    if (message?.type === 'state') {
      if (Array.isArray(message.tabs)) {
        setTabs(message.tabs);
      }

      if (message.activeTabId !== undefined) {
        snapshot.activeTabId = message.activeTabId;
      }

      return;
    }

    if (message?.type !== 'response' || typeof message.id !== 'string') {
      return;
    }

    const pending = pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(message.id);

    if (message.ok === false) {
      const error = new Error(message.error?.message || 'extension command failed');
      error.code = message.error?.code || 'EXTENSION_ERROR';
      error.details = message.error?.details || null;
      pending.reject(error);
      return;
    }

    pending.resolve(message.result);
  }

  async function dispatchCommand(command, args = {}) {
    // 通过 websocket 发给 extension，再等待同一个 id 的 response 回来。
    setLastCommand(command, args);

    if (!runtime.extensionSocket || runtime.extensionSocket.readyState !== WebSocket.OPEN) {
      throw new Error('no extension is connected');
    }

    const id = createId('cmd');
    const payload = {
      type: 'command',
      id,
      command,
      args,
      requestedAt: new Date().toISOString(),
    };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`command timed out: ${command}`));
      }, requestTimeoutMs);

      pendingRequests.set(id, { resolve, reject, timer });
      runtime.extensionSocket.send(JSON.stringify(payload));
    });
  }

  async function exportSnapshot() {
    const state = {
      token: runtime.token,
      relayPort,
      ipcPort,
      startedAt: runtime.startedAt,
      snapshot,
    };
    await writeJsonFile(getStatePath(homeDir), state);
    return state;
  }

  return {
    runtime,
    persist,
    exportSnapshot,
    setError,
    setLastCommand,
    setTabs,
    attachExtension,
    detachExtension,
    handleExtensionMessage,
    dispatchCommand,
    snapshot: () => ({
      token: runtime.token,
      relayPort,
      ipcPort,
      startedAt: runtime.startedAt,
      snapshot,
      extensionConnected: Boolean(runtime.extensionSocket),
    }),
  };
}
