const DEFAULT_SERVER_PORT = 47978;
const STORAGE_KEY = 'autobrowserToken';
const RELAY_PORT_STORAGE_KEY = 'autobrowserRelayPort';

const state = {
  socket: null,
  reconnectTimer: null,
  attachedTabs: new Set(),
  shouldReconnect: true,
  token: '',
  relayPort: DEFAULT_SERVER_PORT,
  consoleMessages: [],
  pageErrors: [],
};

function normalizeRelayPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_SERVER_PORT;
}

function setupDebuggerEventListeners() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === 'Console.messageAdded') {
      state.consoleMessages.push({
        type: params.message.type,
        text: params.message.text,
        timestamp: Date.now(),
      });
      if (state.consoleMessages.length > 500) {
        state.consoleMessages = state.consoleMessages.slice(-500);
      }
    }
    if (method === 'Page.exceptionThrown') {
      state.pageErrors.push({
        error: params.exceptionDetails.exception?.description || params.exceptionDetails.text,
        url: params.exceptionDetails.url,
        line: params.exceptionDetails.lineNumber,
        column: params.exceptionDetails.columnNumber,
        timestamp: Date.now(),
      });
      if (state.pageErrors.length > 100) {
        state.pageErrors = state.pageErrors.slice(-100);
      }
    }
  });
}

function promisifyChrome(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(
      ...args,
      (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(result);
      },
    );
  });
}

async function getToken() {
  const result = await promisifyChrome(chrome.storage.local.get, STORAGE_KEY);
  return result?.[STORAGE_KEY] || '';
}

async function getRelayPort() {
  const result = await promisifyChrome(chrome.storage.local.get, RELAY_PORT_STORAGE_KEY);
  return normalizeRelayPort(result?.[RELAY_PORT_STORAGE_KEY]);
}

async function saveToken(token) {
  await promisifyChrome(chrome.storage.local.set, {
    [STORAGE_KEY]: token.trim(),
  });
  state.token = token.trim();
  requestReconnect();
}

function requestReconnect() {
  if (state.socket && state.socket.readyState < WebSocket.CLOSING) {
    try {
      state.socket.close();
      return;
    } catch {
      // Ignore close errors and fall through to scheduling a reconnect.
    }
  }

  reconnect();
}

async function loadActiveTab(tabId) {
  if (typeof tabId === 'number') {
    return await promisifyChrome(chrome.tabs.get, tabId);
  }

  const tabs = await promisifyChrome(chrome.tabs.query, {
    active: true,
    currentWindow: true,
  });
  return tabs[0] || null;
}

async function ensureDebuggerAttached(tabId) {
  if (state.attachedTabs.has(tabId)) {
    return;
  }

  try {
    await promisifyChrome(chrome.debugger.attach, { tabId }, '1.3');
    state.attachedTabs.add(tabId);
  } catch (error) {
    if (!String(error.message || '').includes('already attached')) {
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
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    status: tab.status || '',
    windowId: tab.windowId,
  }));
}

async function getTargetTab(tabId) {
  const tab = await loadActiveTab(tabId);
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('no active tab available');
  }

  return tab;
}

function unwrapEvaluationResult(result) {
  if (!result) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(result, 'value')) {
    return result.value;
  }

  return result.description || null;
}

async function evaluateScript(tabId, script) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });

  return unwrapEvaluationResult(result.result);
}

async function navigateTo(tabId, url) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Page.enable', {});
  await sendDebuggerCommand(tab.id, 'Page.navigate', { url });
  return { tabId: tab.id, url };
}

async function clickSelector(tabId, selector) {
  const tab = await getTargetTab(tabId);
  const jsResult = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.scrollIntoView({ block: 'center', inline: 'center' });
      node.click();
      return { found: true, selector: ${JSON.stringify(selector)} };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const result = unwrapEvaluationResult(jsResult.result);
  if (result?.found) {
    return result;
  }

  const box = await getElementBox(tabId, selector);
  if (!box) {
    throw new Error(`element not found: ${selector}`);
  }

  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });

  return { found: true, selector };
}

async function captureScreenshot(tabId) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Page.enable', {});
  const result = await sendDebuggerCommand(tab.id, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });

  return {
    tabId: tab.id,
    mimeType: 'image/png',
    dataUrl: `data:image/png;base64,${result.data}`,
  };
}

async function snapshotTab(tabId) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
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

// 解析组合键，返回 { key, modifiers }
function parseKeyboardKey(key) {
  const modifiers = { shift: false, ctrl: false, alt: false, meta: false };
  let remaining = key;

  // 解析前缀修饰键
  if (remaining.includes('Control+')) {
    modifiers.ctrl = true;
    remaining = remaining.replace('Control+', '');
  }
  if (remaining.includes('Shift+')) {
    modifiers.shift = true;
    remaining = remaining.replace('Shift+', '');
  }
  if (remaining.includes('Alt+')) {
    modifiers.alt = true;
    remaining = remaining.replace('Alt+', '');
  }
  if (remaining.includes('Meta+')) {
    modifiers.meta = true;
    remaining = remaining.replace('Meta+', '');
  }

  // 计算 modifiers 位掩码
  let mask = 0;
  if (modifiers.ctrl) mask |= 2;
  if (modifiers.shift) mask |= 4;
  if (modifiers.alt) mask |= 1;
  if (modifiers.meta) mask |= 8;

  return { key: remaining, modifiers: mask };
}

async function getElementBox(tabId, selector) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return unwrapEvaluationResult(result.result);
}

async function hoverElement(tabId, selector) {
  const box = await getElementBox(tabId, selector);
  if (!box) {
    throw new Error(`element not found: ${selector}`);
  }

  const tab = await getTargetTab(tabId);

  // 先尝试 JS 方式
  const jsResult = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const win = node.ownerDocument.defaultView;
      const opts = { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y };
      node.dispatchEvent(new PointerEvent('pointerover', opts));
      node.dispatchEvent(new MouseEvent('mouseover', opts));
      node.dispatchEvent(new PointerEvent('pointerenter', opts));
      node.dispatchEvent(new MouseEvent('mouseenter', opts));
      node.dispatchEvent(new MouseEvent('mousemove', opts));
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  if (unwrapEvaluationResult(jsResult.result)) {
    return { found: true, selector };
  }

  // Fallback: Input.dispatchMouseEvent
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y,
    button: 'none',
    clickCount: 0,
  });

  return { found: true, selector };
}

async function pressKey(tabId, key) {
  const { key: keyName, modifiers } = parseKeyboardKey(key);
  const tab = await getTargetTab(tabId);

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyName,
    code: keyName,
    modifiers,
  });

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    code: keyName,
    modifiers,
  });

  return { key, pressed: true };
}

async function focusElement(tabId, selector) {
  const tab = await getTargetTab(tabId);

  // 先尝试 DOM.focus
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.focus();
      return { found: true, focused: document.activeElement === node };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const res = unwrapEvaluationResult(result.result);
  if (res?.found) {
    return res;
  }

  throw new Error(`element not found: ${selector}`);
}

async function selectOption(tabId, selector, value) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.focus();
      node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, value: node.value };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const res = unwrapEvaluationResult(result.result);
  if (res?.found) {
    return res;
  }
  throw new Error(`element not found: ${selector}`);
}

async function checkElement(tabId, selector, checked) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.focus();
      node.checked = ${checked};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, checked: node.checked };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const res = unwrapEvaluationResult(result.result);
  if (res?.found) {
    return res;
  }
  throw new Error(`element not found: ${selector}`);
}

async function scrollElement(tabId, selector, deltaX = 0, deltaY = 100) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      ${
        selector
          ? `
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.scrollIntoView({ block: 'center', inline: 'center' });
      `
          : ''
      }
      window.scrollBy(${deltaX}, ${deltaY});
      return { found: true, scrolled: true };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  return unwrapEvaluationResult(result.result) || { found: true, scrolled: true };
}

async function dragElement(tabId, startSelector, endSelector) {
  const startBox = await getElementBox(tabId, startSelector);
  if (!startBox) {
    throw new Error(`start element not found: ${startSelector}`);
  }

  let endBox;
  if (endSelector) {
    endBox = await getElementBox(tabId, endSelector);
    if (!endBox) {
      throw new Error(`end element not found: ${endSelector}`);
    }
  } else {
    endBox = { x: startBox.x, y: startBox.y + 100 };
  }

  const tab = await getTargetTab(tabId);

  // mousePressed
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startBox.x,
    y: startBox.y,
    button: 'left',
    clickCount: 1,
  });

  // mouseMoved - 分 10 步平滑移动
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = startBox.x + (endBox.x - startBox.x) * (i / steps);
    const y = startBox.y + (endBox.y - startBox.y) * (i / steps);
    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  // mouseReleased
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endBox.x,
    y: endBox.y,
    button: 'left',
    clickCount: 1,
  });

  return { found: true, dragged: true };
}

async function uploadFiles(tabId, selector, filePaths) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return Boolean(node && node.tagName === 'INPUT' && node.type === 'file');
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  if (!unwrapEvaluationResult(result.result)) {
    throw new Error(`file input not found: ${selector}`);
  }

  await sendDebuggerCommand(tab.id, 'DOM.enable', {});
  const documentNode = await sendDebuggerCommand(tab.id, 'DOM.getDocument', {});
  const node = await sendDebuggerCommand(tab.id, 'DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!node.nodeId) {
    throw new Error(`file input not found: ${selector}`);
  }

  await sendDebuggerCommand(tab.id, 'DOM.setFileInputFiles', {
    files: filePaths,
    nodeId: node.nodeId,
  });

  return { found: true, files: filePaths };
}

async function navigateBack(tabId) {
  const tab = await getTargetTab(tabId);
  // 获取导航历史
  const history = await sendDebuggerCommand(tab.id, 'Page.getNavigationHistory');
  const entries = history.entries || [];
  const currentIndex = history.currentIndex;

  if (currentIndex > 0) {
    const targetIndex = currentIndex - 1;
    const targetEntry = entries[targetIndex];
    if (targetEntry) {
      await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
        entryId: targetEntry.id,
      });
      return { navigated: true, back: true };
    }
  }
  return { navigated: false, reason: 'no back history' };
}

async function navigateForward(tabId) {
  const tab = await getTargetTab(tabId);
  const history = await sendDebuggerCommand(tab.id, 'Page.getNavigationHistory');
  const entries = history.entries || [];
  const currentIndex = history.currentIndex;

  if (currentIndex < entries.length - 1) {
    const targetIndex = currentIndex + 1;
    const targetEntry = entries[targetIndex];
    if (targetEntry) {
      await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
        entryId: targetEntry.id,
      });
      return { navigated: true, forward: true };
    }
  }
  return { navigated: false, reason: 'no forward history' };
}

async function reloadPage(tabId) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Page.reload', {});
  return { reloaded: true };
}

async function createWindow() {
  const window = await promisifyChrome(chrome.windows.create, {
    url: 'about:blank',
    focused: true,
  });
  return { windowId: window.id, tabId: window.tabs?.[0]?.id };
}

async function switchToFrame(tabId, selector) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      if (node.tagName !== 'IFRAME') {
        // 尝试在 iframe 中查找
        const iframe = node.querySelector('iframe');
        if (!iframe) return { found: false, reason: 'not an iframe or does not contain one' };
        return { found: true, isIframe: true, src: iframe.src };
      }
      return { found: true, isIframe: true, src: node.src };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const res = unwrapEvaluationResult(result.result);
  if (!res?.found) {
    throw new Error(`frame not found: ${selector}`);
  }
  return { found: true, frame: res };
}

async function checkIsState(tabId, selector, stateType) {
  const tab = await getTargetTab(tabId);
  const checkJs = {
    visible: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    })()`,
    enabled: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node && !node.disabled;
    })()`,
    checked: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node && node.checked === true;
    })()`,
    disabled: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node && node.disabled === true;
    })()`,
    focused: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node && node === node.ownerDocument.activeElement;
    })()`,
  };

  const js = checkJs[stateType];
  if (!js) {
    throw new Error(`unknown state type: ${stateType}`);
  }

  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: js,
    awaitPromise: true,
    returnByValue: true,
  });

  return {
    found: true,
    state: stateType,
    value: unwrapEvaluationResult(result.result),
  };
}

async function getAttribute(tabId, selector, attrName) {
  const tab = await getTargetTab(tabId);

  if (attrName === 'text') {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        return node ? node.textContent : null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return { found: true, value: unwrapEvaluationResult(result.result) };
  }

  if (attrName === 'html') {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        return node ? node.innerHTML : null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return { found: true, value: unwrapEvaluationResult(result.result) };
  }

  if (attrName === 'value') {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        return node ? node.value : null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return { found: true, value: unwrapEvaluationResult(result.result) };
  }

  if (attrName === 'title') {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: 'document.title',
      awaitPromise: true,
      returnByValue: true,
    });
    return { found: true, value: unwrapEvaluationResult(result.result) };
  }

  if (attrName === 'url') {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: 'window.location.href',
      awaitPromise: true,
      returnByValue: true,
    });
    return { found: true, value: unwrapEvaluationResult(result.result) };
  }

  if (attrName === 'count') {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        return document.querySelectorAll(${JSON.stringify(selector)}).length;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return { found: true, value: unwrapEvaluationResult(result.result) };
  }

  if (attrName === 'box') {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return { found: true, value: unwrapEvaluationResult(result.result) };
  }

  // 其他属性
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node ? node.getAttribute(${JSON.stringify(attrName)}) : null;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return { found: true, value: unwrapEvaluationResult(result.result) };
}

async function waitFor(tabId, condition, timeout = 30000) {
  const tab = await getTargetTab(tabId);
  const startTime = Date.now();

  if (condition === 'load') {
    // 等待页面加载
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('wait load timeout'));
      }, timeout);

      chrome.debugger.onEvent.addListener(function listener(source, method, _params) {
        if (source.tabId === tab.id && method === 'Page.loadEventFired') {
          clearTimeout(timeoutId);
          chrome.debugger.onEvent.removeListener(listener);
          resolve({ waited: true, condition: 'load' });
        }
      });

      // 启用 Page domain
      sendDebuggerCommand(tab.id, 'Page.enable', {}).catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  if (condition === 'networkidle') {
    // 等待网络空闲
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('wait networkidle timeout'));
      }, timeout);

      chrome.debugger.onEvent.addListener(function listener(source, method, params) {
        if (
          source.tabId === tab.id &&
          method === 'Page.lifecycleEvent' &&
          params.name === 'networkidle'
        ) {
          clearTimeout(timeoutId);
          chrome.debugger.onEvent.removeListener(listener);
          resolve({ waited: true, condition: 'networkidle' });
        }
      });

      sendDebuggerCommand(tab.id, 'Page.enable', {}).catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  // 轮询方式等待 selector
  while (Date.now() - startTime < timeout) {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(condition)});
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });

    if (unwrapEvaluationResult(result.result) === true) {
      return { waited: true, condition: 'selector', selector: condition };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`wait selector timeout: ${condition}`);
}

async function waitForUrl(tabId, urlPattern, timeout = 30000) {
  const tab = await getTargetTab(tabId);
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: 'window.location.href',
      awaitPromise: true,
      returnByValue: true,
    });

    const currentUrl = unwrapEvaluationResult(result.result) || '';
    if (currentUrl.includes(urlPattern) || new RegExp(urlPattern).test(currentUrl)) {
      return {
        waited: true,
        condition: 'url',
        url: currentUrl,
        pattern: urlPattern,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`wait url timeout: ${urlPattern}`);
}

async function waitForText(tabId, text, timeout = 30000) {
  const tab = await getTargetTab(tabId);
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: "document.body ? document.body.innerText : ''",
      awaitPromise: true,
      returnByValue: true,
    });

    const pageText = (unwrapEvaluationResult(result.result) || '').toLowerCase();
    if (pageText.includes(text.toLowerCase())) {
      return { waited: true, condition: 'text', text };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`wait text timeout: ${text}`);
}

async function waitWithTimeout(tabId, ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { waited: true, condition: 'time', ms };
}

async function handleWait(tabId, args) {
  const timeout = args.timeout || 30000;

  if (args.type === 'time' || args.ms) {
    return await waitWithTimeout(tabId, args.ms || args.timeout || 30000);
  }

  if (args.type === 'selector' || args.selector) {
    return await waitFor(tabId, args.selector, timeout);
  }

  if (args.type === 'url' || args.url) {
    return await waitForUrl(tabId, args.url, timeout);
  }

  if (args.type === 'text' || args.text) {
    return await waitForText(tabId, args.text, timeout);
  }

  if (args.type === 'load') {
    return await waitFor(tabId, 'load', timeout);
  }

  if (args.type === 'networkidle') {
    return await waitFor(tabId, 'networkidle', timeout);
  }

  throw new Error(`unsupported wait type: ${args.type}`);
}

// Cookies commands
async function cookiesGet(tabId) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Network.getCookies', {});
  return { cookies: result.cookies || [] };
}

async function cookiesSet(tabId, name, value, domain) {
  const tab = await getTargetTab(tabId);
  const cookie = { name, value };
  if (domain) {
    cookie.domain = domain;
  }
  await sendDebuggerCommand(tab.id, 'Network.setCookie', cookie);
  return { set: true, name, value, domain };
}

async function cookiesClear(tabId) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Network.clearBrowserCookies', {});
  return { cleared: true };
}

// Storage commands
async function storageGet(tabId, key) {
  const tab = await getTargetTab(tabId);
  if (!key) {
    // 获取所有 localStorage
    const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          items[k] = localStorage.getItem(k);
        }
        return items;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return { storage: unwrapEvaluationResult(result.result) || {} };
  }

  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `localStorage.getItem(${JSON.stringify(key)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  return { key, value: unwrapEvaluationResult(result.result) };
}

async function storageSet(tabId, key, value) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  return { key, value, set: true };
}

async function storageClear(tabId) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: 'localStorage.clear()',
    awaitPromise: true,
    returnByValue: true,
  });
  return { cleared: true };
}

// Set commands
async function setViewport(tabId, width, height, deviceScaleFactor = 1, mobile = false) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Emulation.setDeviceMetricsOverride', {
    width: Number(width),
    height: Number(height),
    deviceScaleFactor: Number(deviceScaleFactor),
    mobile,
  });
  return { viewport: { width, height, deviceScaleFactor, mobile } };
}

async function setOffline(tabId, enabled) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Network.emulateNetworkConditions', {
    offline: enabled,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  return { offline: enabled };
}

async function setHeaders(tabId, headers) {
  const tab = await getTargetTab(tabId);
  const normalizedHeaders = Array.isArray(headers)
    ? Object.fromEntries(
        headers
          .filter((header) => header?.name)
          .map((header) => [String(header.name), String(header.value ?? '')]),
      )
    : Object.fromEntries(
        Object.entries(headers && typeof headers === 'object' ? headers : {}).map(
          ([name, value]) => [String(name), String(value ?? '')],
        ),
      );
  await sendDebuggerCommand(tab.id, 'Network.enable', {});
  await sendDebuggerCommand(tab.id, 'Network.setExtraHTTPHeaders', {
    headers: normalizedHeaders,
  });
  return { headers: normalizedHeaders };
}

async function setGeo(tabId, latitude, longitude, accuracy = 1) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Emulation.setGeolocationOverride', {
    latitude: Number(latitude),
    longitude: Number(longitude),
    accuracy: Number(accuracy),
  });
  return { geo: { latitude, longitude, accuracy } };
}

async function setMedia(tabId, media) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Emulation.setEmulatedMedia', {
    features: media ? [{ name: 'prefers-color-scheme', value: media }] : [],
  });
  return { media };
}

async function generatePdf(tabId) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.5,
    paperHeight: 11,
  });
  return {
    tabId: tab.id,
    mimeType: 'application/pdf',
    dataUrl: `data:application/pdf;base64,${result.data}`,
  };
}

async function clipboardRead(tabId) {
  const tab = await getTargetTab(tabId);
  // 首先请求剪贴板权限
  try {
    await sendDebuggerCommand(tab.id, 'Browser.setPermission', {
      permission: { name: 'clipboardReadWrite' },
      setting: 'granted',
    });
  } catch {
    // ignore permission errors
  }

  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      return navigator.clipboard.readText().catch(() => '');
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return { text: unwrapEvaluationResult(result.result) || '' };
}

async function clipboardWrite(tabId, text) {
  const tab = await getTargetTab(tabId);
  try {
    await sendDebuggerCommand(tab.id, 'Browser.setPermission', {
      permission: { name: 'clipboardReadWrite' },
      setting: 'granted',
    });
  } catch {
    // ignore permission errors
  }

  await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `navigator.clipboard.writeText(${JSON.stringify(text)}).catch(() => {})`,
    awaitPromise: true,
    returnByValue: true,
  });
  return { written: true, text };
}

async function saveState(tabId, name) {
  const tab = await getTargetTab(tabId);
  const cookiesResult = await sendDebuggerCommand(tab.id, 'Network.getCookies', {});
  const storageResult = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        items[k] = localStorage.getItem(k);
      }
      return items;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  return {
    name,
    cookies: cookiesResult.cookies || [],
    storage: unwrapEvaluationResult(storageResult.result) || {},
    saved: true,
  };
}

async function loadState(tabId, stateData) {
  const tab = await getTargetTab(tabId);

  // 恢复 cookies
  if (stateData.cookies && stateData.cookies.length > 0) {
    for (const cookie of stateData.cookies) {
      await sendDebuggerCommand(tab.id, 'Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
      });
    }
  }

  // 恢复 storage
  if (stateData.storage) {
    for (const [key, value] of Object.entries(stateData.storage)) {
      await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
        expression: `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
        awaitPromise: true,
        returnByValue: true,
      });
    }
  }

  return { loaded: true, name: stateData.name };
}

async function handleDialog(tabId, accept, promptText) {
  const tab = await getTargetTab(tabId);
  await sendDebuggerCommand(tab.id, 'Page.enable', {});

  try {
    await sendDebuggerCommand(tab.id, 'Page.handleJavaScriptDialog', {
      accept,
      promptText: accept ? promptText || '' : undefined,
    });
    return { handled: true, accepted: accept };
  } catch (error) {
    if (
      String(error.message || '')
        .toLowerCase()
        .includes('no dialog')
    ) {
      return { handled: false, reason: 'no dialog opened' };
    }

    throw error;
  }
}

async function fillSelector(tabId, selector, value) {
  const tab = await getTargetTab(tabId);
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
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
    case 'status':
      return {
        connected: true,
        tabs: await listTabs(),
      };
    case 'tab.list':
      return { tabs: await listTabs() };
    case 'tab.new':
      return {
        tab: await promisifyChrome(chrome.tabs.create, {
          url: args.url || 'about:blank',
        }),
      };
    case 'goto':
    case 'open':
      return await navigateTo(tabId, args.url || 'about:blank');
    case 'eval':
      return await evaluateScript(tabId, args.script || 'document.title');
    case 'snapshot':
      return await snapshotTab(tabId);
    case 'screenshot':
      return await captureScreenshot(tabId);
    case 'click':
      return await clickSelector(tabId, args.selector || '');
    case 'fill':
      return await fillSelector(tabId, args.selector || '', args.value || '');
    case 'hover':
      return await hoverElement(tabId, args.selector || '');
    case 'press':
      return await pressKey(tabId, args.key || '');
    case 'focus':
      return await focusElement(tabId, args.selector || '');
    case 'select':
      return await selectOption(tabId, args.selector || '', args.value || '');
    case 'check':
      return await checkElement(tabId, args.selector || '', true);
    case 'uncheck':
      return await checkElement(tabId, args.selector || '', false);
    case 'scroll':
      return await scrollElement(
        tabId,
        args.selector || null,
        args.deltaX || 0,
        args.deltaY || 100,
      );
    case 'drag':
      return await dragElement(tabId, args.start || '', args.end || '');
    case 'upload':
      return await uploadFiles(tabId, args.selector || '', args.files || []);
    case 'back':
      return await navigateBack(tabId);
    case 'forward':
      return await navigateForward(tabId);
    case 'reload':
      return await reloadPage(tabId);
    case 'window':
      if (args.action === 'new') {
        return await createWindow();
      }
      throw new Error(`unsupported window action: ${args.action}`);
    case 'frame':
      return await switchToFrame(tabId, args.selector || '');
    case 'is':
      return await checkIsState(tabId, args.selector || '', args.state || 'visible');
    case 'get':
      return await getAttribute(tabId, args.selector || '', args.attr || 'text');
    case 'dialog':
      return await handleDialog(tabId, args.accept !== false, args.promptText);
    case 'wait':
      return await handleWait(tabId, args);
    case 'cookies':
      if (args.action === 'get') {
        return await cookiesGet(tabId);
      }
      if (args.action === 'set') {
        return await cookiesSet(tabId, args.name || '', args.value || '', args.domain);
      }
      if (args.action === 'clear') {
        return await cookiesClear(tabId);
      }
      throw new Error(`unsupported cookies action: ${args.action}`);
    case 'storage':
      if (args.action === 'get') {
        return await storageGet(tabId, args.key);
      }
      if (args.action === 'set') {
        return await storageSet(tabId, args.key || '', args.value || '');
      }
      if (args.action === 'clear') {
        return await storageClear(tabId);
      }
      throw new Error(`unsupported storage action: ${args.action}`);
    case 'console':
      return { messages: state.consoleMessages };
    case 'errors':
      return { errors: state.pageErrors };
    case 'set':
      if (args.type === 'viewport') {
        return await setViewport(
          tabId,
          args.width,
          args.height,
          args.deviceScaleFactor,
          args.mobile,
        );
      }
      if (args.type === 'offline') {
        return await setOffline(tabId, args.enabled !== false);
      }
      if (args.type === 'headers') {
        return await setHeaders(tabId, args.headers);
      }
      if (args.type === 'geo') {
        return await setGeo(tabId, args.latitude, args.longitude, args.accuracy);
      }
      if (args.type === 'media') {
        return await setMedia(tabId, args.media);
      }
      throw new Error(`unsupported set type: ${args.type}`);
    case 'pdf':
      return await generatePdf(tabId);
    case 'clipboard':
      if (args.action === 'read') {
        return await clipboardRead(tabId);
      }
      if (args.action === 'write') {
        return await clipboardWrite(tabId, args.text || '');
      }
      throw new Error(`unsupported clipboard action: ${args.action}`);
    case 'state':
      if (args.action === 'save') {
        return await saveState(tabId, args.name || 'default');
      }
      if (args.action === 'load') {
        return await loadState(tabId, args.data || {});
      }
      throw new Error(`unsupported state action: ${args.action}`);
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
    `ws://127.0.0.1:${state.relayPort}/ws?token=${encodeURIComponent(state.token)}&extensionId=${encodeURIComponent(chrome.runtime.id)}`,
  );

  state.socket = socket;

  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        type: 'extension.hello',
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
      }),
    );
  });

  socket.addEventListener('message', async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      socket.send(
        JSON.stringify({
          type: 'response',
          id: null,
          ok: false,
          error: { message: 'invalid JSON from server' },
        }),
      );
      return;
    }

    if (message?.type !== 'command') {
      return;
    }

    try {
      const result = await handleCommand(message);
      socket.send(
        JSON.stringify({
          type: 'response',
          id: message.id,
          ok: true,
          result,
        }),
      );
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: 'response',
          id: message.id,
          ok: false,
          error: {
            message: error.message,
            code: error.code || 'EXTENSION_COMMAND_ERROR',
          },
        }),
      );
    }

    try {
      const tabs = await listTabs();
      socket.send(
        JSON.stringify({
          type: 'state',
          tabs,
          activeTabId: tabs.find((tab) => tab.active)?.id || null,
        }),
      );
    } catch {
      // ignore state update failures
    }
  });

  socket.addEventListener('close', () => {
    state.socket = null;
    if (state.shouldReconnect) {
      reconnect();
    }
  });

  socket.addEventListener('error', () => {
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
        type: 'state',
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
  if (message?.type === 'autobrowser.setToken') {
    saveToken(String(message.token || '')).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  }

  if (message?.type === 'autobrowser.getStatus') {
    sendResponse({
      ok: true,
      connected: Boolean(state.socket && state.socket.readyState === WebSocket.OPEN),
      token: state.token || '',
      relayPort: state.relayPort,
    });
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detachDebugger(tabId).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  let needsReconnect = false;

  if (changes[STORAGE_KEY]) {
    state.token = String(changes[STORAGE_KEY].newValue || '');
    needsReconnect = true;
  }

  if (changes[RELAY_PORT_STORAGE_KEY]) {
    state.relayPort = normalizeRelayPort(changes[RELAY_PORT_STORAGE_KEY].newValue);
    needsReconnect = true;
  }

  if (needsReconnect) {
    requestReconnect();
  }
});

Promise.all([getToken(), getRelayPort()])
  .then(([token, relayPort]) => {
    state.token = token;
    state.relayPort = relayPort;
    setupDebuggerEventListeners();
    return connect();
  })
  .catch(() => {});
