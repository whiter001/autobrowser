const SERVER_PORT = 47978;
const STORAGE_KEY = "autobrowserToken";

const state = {
  socket: null,
  reconnectTimer: null,
  attachedTabs: new Set(),
  shouldReconnect: true,
  token: "",
};

function promisifyChrome(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(result);
    });
  });
}

async function getToken() {
  const result = await promisifyChrome(chrome.storage.local.get, STORAGE_KEY);
  return result?.[STORAGE_KEY] || "";
}

async function saveToken(token) {
  await promisifyChrome(chrome.storage.local.set, { [STORAGE_KEY]: token.trim() });
  state.token = token.trim();
  reconnect();
}

async function loadActiveTab(tabId) {
  if (typeof tabId === "number") {
    return await promisifyChrome(chrome.tabs.get, tabId);
  }

  const tabs = await promisifyChrome(chrome.tabs.query, { active: true, currentWindow: true });
  return tabs[0] || null;
}

async function ensureDebuggerAttached(tabId) {
  if (state.attachedTabs.has(tabId)) {
    return;
  }

  try {
    await promisifyChrome(chrome.debugger.attach, { tabId }, "1.3");
    state.attachedTabs.add(tabId);
  } catch (error) {
    if (!String(error.message || "").includes("already attached")) {
      throw error;
    }
    state.attachedTabs.add(tabId);
  }
}

async function detachDebugger(tabId) {
  if (!state.attachedTabs.has(tabId)) {
    return;
  }

  try {
    await promisifyChrome(chrome.debugger.detach, { tabId });
  } catch {
    // Ignore detach errors for tabs that are already gone.
  }

  state.attachedTabs.delete(tabId);
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  await ensureDebuggerAttached(tabId);
  return await promisifyChrome(chrome.debugger.sendCommand, { tabId }, method, params);
}

async function listTabs() {
  const tabs = await promisifyChrome(chrome.tabs.query, {});
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    status: tab.status || "",
    windowId: tab.windowId,
  }));
}

async function getTargetTab(tabId) {
  const tab = await loadActiveTab(tabId);
  if (!tab || typeof tab.id !== "number") {
    throw new Error("no active tab available");
  }

  return tab;
}

function unwrapEvaluationResult(result) {
  if (!result) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value;
  }

  return result.description || null;
}

async function evaluateScript(tabId, script) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, "Runtime.evaluate", {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });

  return unwrapEvaluationResult(result.result);
}

async function navigateTo(tabId, url) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, "Page.enable", {});
  await sendDebuggerCommand(tab.id, "Page.navigate", { url });
  return { tabId: tab.id, url };
}

async function captureScreenshot(tabId) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, "Page.enable", {});
  const result = await sendDebuggerCommand(tab.id, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });

  return {
    tabId: tab.id,
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${result.data}`,
  };
}

async function snapshotTab(tabId) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, "Runtime.evaluate", {
    expression: `(() => {
      const toNodeSummary = (node) => ({
        tag: node.tagName,
        text: (node.innerText || node.textContent || "").trim().slice(0, 120),
        id: node.id || null,
        className: typeof node.className === "string" ? node.className : null,
      });

      return {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        text: (document.body?.innerText || "").slice(0, 5000),
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 20).map(toNodeSummary),
        buttons: Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")).slice(0, 20).map(toNodeSummary),
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  return unwrapEvaluationResult(result.result);
}

async function clickSelector(tabId, selector) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, "Runtime.evaluate", {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) {
        return { found: false };
      }

      node.click();
      return { found: true, selector: ${JSON.stringify(selector)} };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  return unwrapEvaluationResult(result.result);
}

async function fillSelector(tabId, selector, value) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, "Runtime.evaluate", {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) {
        return { found: false };
      }

      if (!("value" in node)) {
        return { found: false, reason: "element does not accept value" };
      }

      node.focus();
      node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true, selector: ${JSON.stringify(selector)} };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  return unwrapEvaluationResult(result.result);
}

async function handleCommand(message) {
  const { command, args = {} } = message;
  const tabId = args.tabId || undefined;

  switch (command) {
    case "status":
      return {
        connected: true,
        tabs: await listTabs(),
      };
    case "tab.list":
      return { tabs: await listTabs() };
    case "tab.new":
      return {
        tab: await promisifyChrome(chrome.tabs.create, { url: args.url || "about:blank" }),
      };
    case "goto":
    case "open":
      return await navigateTo(tabId, args.url || "about:blank");
    case "eval":
      return await evaluateScript(tabId, args.script || "document.title");
    case "snapshot":
      return await snapshotTab(tabId);
    case "screenshot":
      return await captureScreenshot(tabId);
    case "click":
      return await clickSelector(tabId, args.selector || "");
    case "fill":
      return await fillSelector(tabId, args.selector || "", args.value || "");
    default:
      throw new Error(`unsupported command: ${command}`);
  }
}

async function connect() {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    return;
  }

  state.token = state.token || (await getToken());
  if (!state.token) {
    return;
  }

  const socket = new WebSocket(
    `ws://127.0.0.1:${SERVER_PORT}/ws?token=${encodeURIComponent(state.token)}&extensionId=${encodeURIComponent(chrome.runtime.id)}`,
  );

  state.socket = socket;

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "extension.hello",
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
      }),
    );
  });

  socket.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      socket.send(
        JSON.stringify({
          type: "response",
          id: null,
          ok: false,
          error: { message: "invalid JSON from server" },
        }),
      );
      return;
    }

    if (message?.type !== "command") {
      return;
    }

    try {
      const result = await handleCommand(message);
      socket.send(
        JSON.stringify({
          type: "response",
          id: message.id,
          ok: true,
          result,
        }),
      );
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "response",
          id: message.id,
          ok: false,
          error: {
            message: error.message,
            code: error.code || "EXTENSION_COMMAND_ERROR",
          },
        }),
      );
    }

    try {
      const tabs = await listTabs();
      socket.send(
        JSON.stringify({
          type: "state",
          tabs,
          activeTabId: tabs.find((tab) => tab.active)?.id || null,
        }),
      );
    } catch {
      // ignore state update failures
    }
  });

  socket.addEventListener("close", () => {
    state.socket = null;
    if (state.shouldReconnect) {
      reconnect();
    }
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      // ignore
    }
  });

  try {
    const tabs = await listTabs();
    socket.send(
      JSON.stringify({
        type: "state",
        tabs,
        activeTabId: tabs.find((tab) => tab.active)?.id || null,
      }),
    );
  } catch {
    // ignore state update failures
  }
}

async function reconnect() {
  if (!state.shouldReconnect) {
    return;
  }

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
  }

  state.reconnectTimer = setTimeout(async () => {
    if (!state.socket || state.socket.readyState === WebSocket.CLOSED) {
      await connect();
    }
  }, 1000);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  connect().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "autobrowser.setToken") {
    saveToken(String(message.token || "")).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  }

  if (message?.type === "autobrowser.getStatus") {
    sendResponse({
      ok: true,
      connected: Boolean(state.socket && state.socket.readyState === WebSocket.OPEN),
      token: state.token || "",
    });
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detachDebugger(tabId).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }

  state.token = String(changes[STORAGE_KEY].newValue || "");
  connect().catch(() => {});
});

getToken()
  .then((token) => {
    state.token = token;
    return connect();
  })
  .catch(() => {});
