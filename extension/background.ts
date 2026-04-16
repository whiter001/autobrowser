import {
  CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  DEFAULT_RELAY_PORT,
  RELAY_PORT_STORAGE_KEY,
  STORAGE_KEY,
  normalizeRelayPort,
  type CommandErrorInfo,
  type ConnectionErrorInfo,
  type ConnectionStatus,
  type DiagnosticsState,
  type SocketCloseInfo,
} from './shared.js'

const DEFAULT_SERVER_PORT = DEFAULT_RELAY_PORT
const SAVED_STATES_STORAGE_KEY = 'autobrowserSavedStates'
const FRAME_WORLD_NAME = 'autobrowser-frame'

interface ErrorWithCode extends Error {
  code?: string
}

const state = {
  socket: null,
  reconnectTimer: null,
  connecting: false,
  suppressCloseError: false,
  attachedTabs: new Set(),
  selectedFrames: new Map(),
  network: {
    routes: [],
    requests: [],
    requestMap: new Map(),
    harRecording: false,
    harStartedAt: null,
  },
  shouldReconnect: true,
  token: '',
  relayPort: DEFAULT_SERVER_PORT,
  consoleMessages: [],
  pageErrors: [],
  connectionStatus: 'idle' as ConnectionStatus,
  connectionError: null as ConnectionErrorInfo | null,
  lastSocketClose: null as SocketCloseInfo | null,
  lastCommandError: null as CommandErrorInfo | null,
}

function createNetworkRouteId(): string {
  return `route_${crypto.randomUUID().replaceAll('-', '')}`
}

function createNetworkRequestKey(tabId: number | null, requestId: string): string {
  return `${tabId === null ? 'global' : tabId}:${requestId}`
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  if (!headers || typeof headers !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [String(name), String(value ?? '')]),
  )
}

function normalizeHeaderPairs(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function stringifyNetworkBody(body: unknown): { text: string; base64Encoded: boolean } {
  const text = `${JSON.stringify(body, null, 2)}\n`
  return { text, base64Encoded: false }
}

function matchesNetworkRoute(pattern: string, url: string): boolean {
  const normalizedPattern = String(pattern || '').trim()
  if (!normalizedPattern) {
    return false
  }

  if (normalizedPattern === '*') {
    return true
  }

  return String(url || '').includes(normalizedPattern)
}

function findMatchingNetworkRoute(url: string): { id: string; pattern: string; abort: boolean; body?: unknown } | null {
  return state.network.routes.find((route) => matchesNetworkRoute(route.pattern, url)) || null
}

function upsertNetworkRequest(record: Record<string, unknown>): Record<string, unknown> {
  const key = String(record.id || '')
  if (!key) {
    return record
  }

  const existing = state.network.requestMap.get(key) || { id: key }
  const merged = { ...existing, ...record }
  state.network.requestMap.set(key, merged)

  const index = state.network.requests.findIndex((item) => item.id === key)
  if (index >= 0) {
    state.network.requests[index] = merged
  } else {
    state.network.requests.push(merged)
  }

  if (state.network.requests.length > 1000) {
    const removed = state.network.requests.splice(0, state.network.requests.length - 1000)
    for (const item of removed) {
      if (item && typeof item.id === 'string') {
        state.network.requestMap.delete(item.id)
      }
    }
  }

  return merged
}

function getNetworkRequestById(requestId: string): Record<string, unknown> | null {
  if (!requestId) {
    return null
  }

  const exact = state.network.requestMap.get(requestId)
  if (exact) {
    return exact
  }

  return state.network.requests.find(
    (item) => item?.requestId === requestId || item?.id === requestId,
  ) || null
}

function summarizeNetworkRequest(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: record.id,
    requestId: record.requestId,
    tabId: record.tabId,
    url: record.url,
    method: record.method,
    resourceType: record.resourceType,
    status: record.status ?? null,
    statusText: record.statusText ?? null,
    routeId: record.routeId ?? null,
    routeAction: record.routeAction ?? null,
    finishedAt: record.finishedAt ?? null,
    startedAt: record.startedAt ?? null,
    durationMs: record.durationMs ?? null,
    errorText: record.errorText ?? null,
  }
}

function buildHar(entries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    log: {
      version: '1.2',
      creator: {
        name: 'autobrowser',
        version: '0.1.0',
      },
      entries,
    },
  }
}

function buildHarEntry(record: Record<string, unknown>): Record<string, unknown> {
  const requestHeaders = normalizeHeaderPairs(
    normalizeHeaders(record.requestHeaders as Record<string, unknown> | undefined),
  )
  const responseHeaders = normalizeHeaderPairs(
    normalizeHeaders(record.responseHeaders as Record<string, unknown> | undefined),
  )
  const responseBody = typeof record.responseBody === 'string' ? record.responseBody : ''
  const responseBodyBase64 = Boolean(record.responseBodyBase64)
  const responseMimeType = String(record.responseMimeType || 'application/octet-stream')
  const bodySize = responseBodyBase64
    ? Math.max(0, Math.floor(responseBody.length * 0.75))
    : new TextEncoder().encode(responseBody).length

  return {
    startedDateTime: record.startedAt,
    time: typeof record.durationMs === 'number' ? record.durationMs : 0,
    request: {
      method: record.method || 'GET',
      url: record.url || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: requestHeaders,
      queryString: [],
      headersSize: -1,
      bodySize: typeof record.postData === 'string' ? new TextEncoder().encode(record.postData).length : 0,
      postData: typeof record.postData === 'string'
        ? {
            mimeType: 'application/json',
            text: record.postData,
          }
        : undefined,
    },
    response: {
      status: Number(record.status || 0),
      statusText: String(record.statusText || ''),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: responseHeaders,
      content: {
        size: bodySize,
        mimeType: responseMimeType,
        text: responseBody,
        encoding: responseBodyBase64 ? 'base64' : undefined,
      },
      redirectURL: '',
      headersSize: -1,
      bodySize,
    },
    cache: {},
    timings: {
      send: 0,
      wait: typeof record.waitMs === 'number' ? record.waitMs : 0,
      receive: typeof record.receiveMs === 'number' ? record.receiveMs : 0,
    },
    pageref: record.tabId === null || record.tabId === undefined ? undefined : `tab-${record.tabId}`,
  }
}

async function refreshNetworkInterceptors(): Promise<void> {
  await Promise.allSettled(
    Array.from(state.attachedTabs).map(async (tabId) => {
      if (state.network.routes.length === 0) {
        await sendRawDebuggerCommand(tabId, 'Fetch.disable', {})
        return
      }

      await sendRawDebuggerCommand(tabId, 'Fetch.enable', {
        patterns: [{ urlPattern: '*' }],
        handleAuthRequests: false,
      })
    }),
  )
}

async function handleNetworkRequestPaused(tabId: number, params: any): Promise<void> {
  const request = params?.request || {}
  const requestId = String(params?.requestId || '')
  if (!requestId) {
    return
  }

  try {
    const route = findMatchingNetworkRoute(String(request.url || ''))
    const key = createNetworkRequestKey(tabId, requestId)
    const record = upsertNetworkRequest({
      id: key,
      requestId,
      tabId,
      url: String(request.url || ''),
      method: String(request.method || 'GET'),
      resourceType: String(params?.resourceType || params?.requestStage || ''),
      requestHeaders: normalizeHeaders(request.headers),
      postData: typeof request.postData === 'string' ? request.postData : null,
      startedAt: new Date().toISOString(),
      requestWillBeSentAt: typeof params?.timestamp === 'number' ? params.timestamp : null,
      routeId: route?.id || null,
      routeAction: route?.abort ? 'abort' : route?.body !== undefined ? 'mock' : 'continue',
    })

    if (route?.abort) {
      try {
        await sendRawDebuggerCommand(tabId, 'Fetch.failRequest', {
          requestId,
          errorReason: 'Failed',
        })
        return
      } catch (error) {
        console.error('failed to abort network request', error)
        await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', { requestId })
        return
      }
    }

    if (route && route.body !== undefined) {
      const body = stringifyNetworkBody(route.body)
      try {
        await sendRawDebuggerCommand(tabId, 'Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responsePhrase: 'OK',
          responseHeaders: [
            { name: 'content-type', value: 'application/json; charset=utf-8' },
          ],
          body: encodeBase64(body.text),
        })
        upsertNetworkRequest({
          ...record,
          responseBody: body.text,
          responseBodyBase64: false,
          responseMimeType: 'application/json; charset=utf-8',
          status: 200,
          statusText: 'OK',
          finishedAt: new Date().toISOString(),
          durationMs: 0,
        })
        return
      } catch (error) {
        console.error('failed to fulfill network request', error)
        await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', { requestId })
        return
      }
    }

    await sendRawDebuggerCommand(tabId, 'Fetch.continueRequest', { requestId })
  } catch (error) {
    console.error('failed to process paused network request', error)
  }
}

async function finalizeNetworkRequestBody(tabId: number, requestId: string): Promise<void> {
  const key = createNetworkRequestKey(tabId, requestId)
  const record = getNetworkRequestById(key)
  if (!record) {
    return
  }

  try {
    const result = await sendRawDebuggerCommand(tabId, 'Network.getResponseBody', { requestId })
    const responseBody = String(result?.body || '')
    const bodyRecord = upsertNetworkRequest({
      ...record,
      responseBody,
      responseBodyBase64: Boolean(result?.base64Encoded),
    })

    if (!bodyRecord.responseMimeType) {
      bodyRecord.responseMimeType = 'application/octet-stream'
    }
  } catch {
    // Best effort only.
  }
}

async function handleNetworkEvent(source: any, method: string, params: any): Promise<void> {
  const tabId = typeof source?.tabId === 'number' ? source.tabId : null
  if (tabId === null) {
    return
  }

  if (method === 'Network.requestWillBeSent') {
    const requestId = String(params?.requestId || '')
    if (!requestId) {
      return
    }

    upsertNetworkRequest({
      id: createNetworkRequestKey(tabId, requestId),
      requestId,
      tabId,
      url: String(params?.request?.url || ''),
      method: String(params?.request?.method || 'GET'),
      resourceType: String(params?.type || ''),
      requestHeaders: normalizeHeaders(params?.request?.headers),
      postData: typeof params?.request?.postData === 'string' ? params.request.postData : null,
      startedAt: new Date().toISOString(),
      requestWillBeSentAt: typeof params?.timestamp === 'number' ? params.timestamp : null,
      wallTime: typeof params?.wallTime === 'number' ? params.wallTime : null,
      documentUrl: String(params?.documentURL || ''),
    })
    return
  }

  if (method === 'Network.responseReceived') {
    const requestId = String(params?.requestId || '')
    if (!requestId) {
      return
    }

    upsertNetworkRequest({
      id: createNetworkRequestKey(tabId, requestId),
      requestId,
      tabId,
      status: Number(params?.response?.status || 0),
      statusText: String(params?.response?.statusText || ''),
      responseHeaders: normalizeHeaders(params?.response?.headers),
      responseMimeType: String(params?.response?.mimeType || 'application/octet-stream'),
      responseReceivedAt: typeof params?.timestamp === 'number' ? params.timestamp : null,
    })
    return
  }

  if (method === 'Network.loadingFinished') {
    const requestId = String(params?.requestId || '')
    if (!requestId) {
      return
    }

    const key = createNetworkRequestKey(tabId, requestId)
    const record = getNetworkRequestById(key)
    const finishedAt = new Date().toISOString()
    const requestWillBeSentAt = typeof record?.requestWillBeSentAt === 'number' ? record.requestWillBeSentAt : null
    const responseReceivedAt = typeof record?.responseReceivedAt === 'number' ? record.responseReceivedAt : null
    const baseRecord = record || {}

    upsertNetworkRequest({
      ...baseRecord,
      id: key,
      requestId,
      tabId,
      finishedAt,
      durationMs:
        requestWillBeSentAt !== null && typeof params?.timestamp === 'number'
          ? Math.max(0, (params.timestamp - requestWillBeSentAt) * 1000)
          : null,
      waitMs:
        requestWillBeSentAt !== null && responseReceivedAt !== null
          ? Math.max(0, (responseReceivedAt - requestWillBeSentAt) * 1000)
          : null,
      receiveMs:
        responseReceivedAt !== null && typeof params?.timestamp === 'number'
          ? Math.max(0, (params.timestamp - responseReceivedAt) * 1000)
          : null,
      encodedDataLength: typeof params?.encodedDataLength === 'number' ? params.encodedDataLength : null,
    })

    void finalizeNetworkRequestBody(tabId, requestId)
    return
  }

  if (method === 'Network.loadingFailed') {
    const requestId = String(params?.requestId || '')
    if (!requestId) {
      return
    }

    upsertNetworkRequest({
      id: createNetworkRequestKey(tabId, requestId),
      requestId,
      tabId,
      errorText: String(params?.errorText || 'request failed'),
      canceled: Boolean(params?.canceled),
      finishedAt: new Date().toISOString(),
    })
  }
}

function pushBounded(list, item, maxSize) {
  list.push(item)
  if (list.length > maxSize) {
    list.splice(0, list.length - maxSize)
  }
}

function persistDiagnostics(): void {
  chrome.storage.local
    .set({
      [CONNECTION_DIAGNOSTICS_STORAGE_KEY]: {
        status: state.connectionStatus,
        connectionError: state.connectionError,
        lastSocketClose: state.lastSocketClose,
        lastCommandError: state.lastCommandError,
        updatedAt: new Date().toISOString(),
      } satisfies DiagnosticsState,
    })
    .catch((error: Error) => {
      console.error('failed to persist plugin diagnostics', error)
    })
}

function setConnectionError(message: string, code?: string): void {
  state.connectionError = {
    message,
    at: new Date().toISOString(),
    ...(code ? { code } : {}),
  }
  persistDiagnostics()
}

function setConnectionStatus(status: ConnectionStatus): void {
  state.connectionStatus = status
  if (status === 'connected') {
    state.connectionError = null
  }
  persistDiagnostics()
}

function recordSocketClose(close: { code: number; reason: string; wasClean: boolean }): void {
  state.lastSocketClose = {
    code: close.code,
    reason: close.reason,
    wasClean: close.wasClean,
    at: new Date().toISOString(),
  }

  if (!state.suppressCloseError && close.code !== 1000) {
    setConnectionError(
      `relay socket closed: ${close.code}${close.reason ? ` ${close.reason}` : ''}`.trim(),
      'SOCKET_CLOSED',
    )
    setConnectionStatus('disconnected')
  }

  state.suppressCloseError = false
  persistDiagnostics()
}

function stringifyRemoteValue(value) {
  if (!value) {
    return ''
  }

  if (Object.prototype.hasOwnProperty.call(value, 'value')) {
    if (typeof value.value === 'string') {
      return value.value
    }

    try {
      return JSON.stringify(value.value)
    } catch (error) {
      console.debug('failed to stringify remote value', error)
      return String(value.value)
    }
  }

  if (value.unserializableValue) {
    return value.unserializableValue
  }

  return value.description || value.type || ''
}

function setupDebuggerEventListeners() {
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    if (method === 'Runtime.consoleAPICalled') {
      pushBounded(
        state.consoleMessages,
        {
          type: params.type,
          text: Array.isArray(params.args)
            ? params.args.map((item) => stringifyRemoteValue(item)).join(' ')
            : '',
          timestamp: Date.now(),
        },
        500,
      )
    }
    if (method === 'Runtime.exceptionThrown') {
      pushBounded(
        state.pageErrors,
        {
          error: params.exceptionDetails.exception?.description || params.exceptionDetails.text,
          url: params.exceptionDetails.url || null,
          line: params.exceptionDetails.lineNumber,
          column: params.exceptionDetails.columnNumber,
          timestamp: Date.now(),
        },
        100,
      )
    }

    if (method === 'Fetch.requestPaused') {
      const tabId = typeof source?.tabId === 'number' ? source.tabId : null
      if (tabId !== null) {
        void handleNetworkRequestPaused(tabId, params).catch((error) => {
          console.error('failed to handle paused network request', error)
        })
      }
    }

    if (
      method === 'Network.requestWillBeSent' ||
      method === 'Network.responseReceived' ||
      method === 'Network.loadingFinished' ||
      method === 'Network.loadingFailed'
    ) {
      void handleNetworkEvent(source, method, params).catch((error) => {
        console.error('failed to record network event', error)
      })
    }
  })
}

function promisifyChrome(thisArg: any, fn: any, ...args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    fn.call(thisArg, ...args, (result) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }

      resolve(result)
    })
  })
}

async function getToken() {
  const result = await promisifyChrome(chrome.storage.local, chrome.storage.local.get, STORAGE_KEY)
  return result?.[STORAGE_KEY] || ''
}

async function getRelayPort() {
  const result = await promisifyChrome(
    chrome.storage.local,
    chrome.storage.local.get,
    RELAY_PORT_STORAGE_KEY,
  )
  return normalizeRelayPort(result?.[RELAY_PORT_STORAGE_KEY])
}

async function saveToken(token) {
  await promisifyChrome(chrome.storage.local, chrome.storage.local.set, {
    [STORAGE_KEY]: token.trim(),
  })
  state.token = token.trim()
  requestReconnect()
}

function requestReconnect() {
  if (state.socket && state.socket.readyState < WebSocket.CLOSING) {
    state.suppressCloseError = true
    try {
      state.socket.close()
      return
    } catch (error) {
      console.warn('failed to close relay socket before reconnect', error)
    }
  }

  reconnect()
}

async function loadActiveTab(tabId) {
  if (typeof tabId === 'number') {
    return await promisifyChrome(chrome.tabs, chrome.tabs.get, tabId)
  }

  const tabs = await promisifyChrome(chrome.tabs, chrome.tabs.query, {
    active: true,
    currentWindow: true,
  })
  return tabs[0] || null
}

async function ensureDebuggerAttached(tabId) {
  if (state.attachedTabs.has(tabId)) {
    return
  }

  try {
    await promisifyChrome(chrome.debugger, chrome.debugger.attach, { tabId }, '1.3')
  } catch (error) {
    if (!String(error.message || '').includes('already attached')) {
      throw error
    }
  }

  state.attachedTabs.add(tabId)
  await enableDebuggerDomains(tabId)
  await refreshNetworkInterceptors()
}

async function detachDebugger(tabId) {
  if (!state.attachedTabs.has(tabId)) {
    return
  }

  try {
    await promisifyChrome(chrome.debugger, chrome.debugger.detach, { tabId })
  } catch (error) {
    console.warn('failed to detach debugger from tab', tabId, error)
  }

  state.attachedTabs.delete(tabId)
}

async function sendRawDebuggerCommand(tabId, method, params = {}) {
  return await promisifyChrome(
    chrome.debugger,
    chrome.debugger.sendCommand,
    { tabId },
    method,
    params,
  )
}

async function enableDebuggerDomains(tabId) {
  await Promise.allSettled([
    sendRawDebuggerCommand(tabId, 'Runtime.enable', {}),
    sendRawDebuggerCommand(tabId, 'Console.enable', {}),
    sendRawDebuggerCommand(tabId, 'Network.enable', {}),
  ])
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  await ensureDebuggerAttached(tabId)
  return await sendRawDebuggerCommand(tabId, method, params)
}

async function listTabs() {
  const tabs = await promisifyChrome(chrome.tabs, chrome.tabs.query, {})
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    status: tab.status || '',
    windowId: tab.windowId,
  }))
}

async function getTargetTab(tabId) {
  const tab = await loadActiveTab(tabId)
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('no active tab available')
  }

  return tab
}

function clearSelectedFrame(tabId) {
  state.selectedFrames.delete(tabId)
}

async function resolveFrameTarget(tabId, selector) {
  const tab = await getTargetTab(tabId)
  const evaluation = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return null;
      const frame = root.tagName === 'IFRAME' ? root : root.querySelector('iframe');
      if (!frame) return null;
      const rect = frame.getBoundingClientRect();
      return {
        src: frame.src || null,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  const target = unwrapEvaluationResult(evaluation.result)
  if (!target) {
    throw new Error(`frame not found: ${selector}`)
  }

  await sendDebuggerCommand(tab.id, 'DOM.enable', {})
  const location = await sendDebuggerCommand(tab.id, 'DOM.getNodeForLocation', {
    x: Math.round(target.x),
    y: Math.round(target.y),
    ignorePointerEventsNone: true,
  })
  if (!location.frameId) {
    throw new Error(`frame is not ready: ${selector}`)
  }

  return {
    tab,
    frameId: location.frameId,
    selector,
    src: target.src,
  }
}

async function getFrameExecutionContext(tabId) {
  const tab = await getTargetTab(tabId)
  const selector = state.selectedFrames.get(tab.id)
  if (!selector) {
    return { tab, executionContextId: null }
  }

  const frame = await resolveFrameTarget(tab.id, selector)
  await sendDebuggerCommand(tab.id, 'Page.enable', {})
  const isolatedWorld = await sendDebuggerCommand(tab.id, 'Page.createIsolatedWorld', {
    frameId: frame.frameId,
    worldName: FRAME_WORLD_NAME,
  })
  return {
    tab,
    executionContextId: isolatedWorld.executionContextId,
  }
}

async function evaluateInTabContext(tabId, expression, options = {}) {
  const { tab, executionContextId } = await getFrameExecutionContext(tabId)
  const response = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(executionContextId ? { contextId: executionContextId } : {}),
    ...options,
  })
  return {
    tab,
    response,
    value: unwrapEvaluationResult(response.result),
  }
}

async function getSavedStates() {
  const result = await promisifyChrome(
    chrome.storage.local,
    chrome.storage.local.get,
    SAVED_STATES_STORAGE_KEY,
  )
  const savedStates = result?.[SAVED_STATES_STORAGE_KEY]
  return savedStates && typeof savedStates === 'object' ? savedStates : {}
}

function unwrapEvaluationResult(result) {
  if (!result) {
    return null
  }

  if (Object.prototype.hasOwnProperty.call(result, 'value')) {
    return result.value
  }

  return result.description || null
}

async function evaluateScript(tabId, script) {
  const { value } = await evaluateInTabContext(tabId, script, {
    userGesture: true,
  })
  return value
}

async function navigateTo(tabId, url) {
  const tab = await getTargetTab(tabId)
  clearSelectedFrame(tab.id)
  await sendDebuggerCommand(tab.id, 'Page.enable', {})
  await sendDebuggerCommand(tab.id, 'Page.navigate', { url })
  return { tabId: tab.id, url }
}

async function clickSelector(tabId, selector) {
  const { tab, value: result } = await evaluateInTabContext(
    tabId,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.scrollIntoView({ block: 'center', inline: 'center' });
      node.click();
      return { found: true, selector: ${JSON.stringify(selector)} };
    })()`,
  )

  if (result?.found) {
    return result
  }

  const box = await getElementBox(tabId, selector)
  if (!box) {
    throw new Error(`element not found: ${selector}`)
  }

  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  })
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  })

  return { found: true, selector }
}

async function captureScreenshot(tabId) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Page.enable', {})
  const result = await sendDebuggerCommand(tab.id, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  })

  return {
    tabId: tab.id,
    mimeType: 'image/png',
    dataUrl: `data:image/png;base64,${result.data}`,
  }
}

async function snapshotTab(tabId) {
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
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
  )

  return value
}

// 解析组合键，返回 { key, modifiers }
function parseKeyboardKey(key) {
  const modifiers = { shift: false, ctrl: false, alt: false, meta: false }
  let remaining = key

  // 解析前缀修饰键
  if (remaining.includes('Control+')) {
    modifiers.ctrl = true
    remaining = remaining.replace('Control+', '')
  }
  if (remaining.includes('Shift+')) {
    modifiers.shift = true
    remaining = remaining.replace('Shift+', '')
  }
  if (remaining.includes('Alt+')) {
    modifiers.alt = true
    remaining = remaining.replace('Alt+', '')
  }
  if (remaining.includes('Meta+')) {
    modifiers.meta = true
    remaining = remaining.replace('Meta+', '')
  }

  // 计算 modifiers 位掩码
  let mask = 0
  if (modifiers.ctrl) mask |= 2
  if (modifiers.shift) mask |= 4
  if (modifiers.alt) mask |= 1
  if (modifiers.meta) mask |= 8

  return { key: remaining, modifiers: mask }
}

async function getElementBox(tabId, selector) {
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
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
  )
  return value
}

async function hoverElement(tabId, selector) {
  const box = await getElementBox(tabId, selector)
  if (!box) {
    throw new Error(`element not found: ${selector}`)
  }

  const tab = await getTargetTab(tabId)

  // 先尝试 JS 方式
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
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
  )

  if (value) {
    return { found: true, selector }
  }

  // Fallback: Input.dispatchMouseEvent
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y,
    button: 'none',
    clickCount: 0,
  })

  return { found: true, selector }
}

async function pressKey(tabId, key) {
  const { key: keyName, modifiers } = parseKeyboardKey(key)
  const tab = await getTargetTab(tabId)

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyName,
    code: keyName,
    modifiers,
  })

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    code: keyName,
    modifiers,
  })

  return { key, pressed: true }
}

async function focusElement(tabId, selector) {
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.focus();
      return { found: true, focused: document.activeElement === node };
    })()`,
  )

  if (value?.found) {
    return value
  }

  throw new Error(`element not found: ${selector}`)
}

async function selectOption(tabId, selector, value) {
  const { value: result } = await evaluateInTabContext(
    tabId,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.focus();
      node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, value: node.value };
    })()`,
  )

  if (result?.found) {
    return result
  }
  throw new Error(`element not found: ${selector}`)
}

async function checkElement(tabId, selector, checked) {
  const { value: result } = await evaluateInTabContext(
    tabId,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false };
      node.focus();
      node.checked = ${checked};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, checked: node.checked };
    })()`,
  )

  if (result?.found) {
    return result
  }
  throw new Error(`element not found: ${selector}`)
}

async function scrollElement(tabId, selector, deltaX = 0, deltaY = 100) {
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
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
  )

  return value || { found: true, scrolled: true }
}

async function dragElement(tabId, startSelector, endSelector) {
  const startBox = await getElementBox(tabId, startSelector)
  if (!startBox) {
    throw new Error(`start element not found: ${startSelector}`)
  }

  let endBox
  if (endSelector) {
    endBox = await getElementBox(tabId, endSelector)
    if (!endBox) {
      throw new Error(`end element not found: ${endSelector}`)
    }
  } else {
    endBox = { x: startBox.x, y: startBox.y + 100 }
  }

  const tab = await getTargetTab(tabId)

  // mousePressed
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startBox.x,
    y: startBox.y,
    button: 'left',
    clickCount: 1,
  })

  // mouseMoved - 分 10 步平滑移动
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    const x = startBox.x + (endBox.x - startBox.x) * (i / steps)
    const y = startBox.y + (endBox.y - startBox.y) * (i / steps)
    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }

  // mouseReleased
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endBox.x,
    y: endBox.y,
    button: 'left',
    clickCount: 1,
  })

  return { found: true, dragged: true }
}

async function uploadFiles(tabId, selector, filePaths) {
  const tab = await getTargetTab(tabId)
  const result = await sendDebuggerCommand(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return Boolean(node && node.tagName === 'INPUT' && node.type === 'file');
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })

  if (!unwrapEvaluationResult(result.result)) {
    throw new Error(`file input not found: ${selector}`)
  }

  await sendDebuggerCommand(tab.id, 'DOM.enable', {})
  const documentNode = await sendDebuggerCommand(tab.id, 'DOM.getDocument', {})
  const node = await sendDebuggerCommand(tab.id, 'DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector,
  })
  if (!node.nodeId) {
    throw new Error(`file input not found: ${selector}`)
  }

  await sendDebuggerCommand(tab.id, 'DOM.setFileInputFiles', {
    files: filePaths,
    nodeId: node.nodeId,
  })

  return { found: true, files: filePaths }
}

async function navigateBack(tabId) {
  const tab = await getTargetTab(tabId)
  clearSelectedFrame(tab.id)
  // 获取导航历史
  const history = await sendDebuggerCommand(tab.id, 'Page.getNavigationHistory')
  const entries = history.entries || []
  const currentIndex = history.currentIndex

  if (currentIndex > 0) {
    const targetIndex = currentIndex - 1
    const targetEntry = entries[targetIndex]
    if (targetEntry) {
      await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
        entryId: targetEntry.id,
      })
      return { navigated: true, back: true }
    }
  }
  return { navigated: false, reason: 'no back history' }
}

async function navigateForward(tabId) {
  const tab = await getTargetTab(tabId)
  clearSelectedFrame(tab.id)
  const history = await sendDebuggerCommand(tab.id, 'Page.getNavigationHistory')
  const entries = history.entries || []
  const currentIndex = history.currentIndex

  if (currentIndex < entries.length - 1) {
    const targetIndex = currentIndex + 1
    const targetEntry = entries[targetIndex]
    if (targetEntry) {
      await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
        entryId: targetEntry.id,
      })
      return { navigated: true, forward: true }
    }
  }
  return { navigated: false, reason: 'no forward history' }
}

async function reloadPage(tabId) {
  const tab = await getTargetTab(tabId)
  clearSelectedFrame(tab.id)
  await sendDebuggerCommand(tab.id, 'Page.reload', {})
  return { reloaded: true }
}

async function createWindow() {
  const window = await promisifyChrome(chrome.windows, chrome.windows.create, {
    url: 'about:blank',
    focused: true,
  })
  return { windowId: window.id, tabId: window.tabs?.[0]?.id }
}

async function switchToFrame(tabId, selector) {
  const tab = await getTargetTab(tabId)
  if (['top', 'main', 'default'].includes(selector)) {
    clearSelectedFrame(tab.id)
    return { found: true, cleared: true, frame: null }
  }

  const frame = await resolveFrameTarget(tab.id, selector)
  state.selectedFrames.set(tab.id, selector)
  return {
    found: true,
    frame: {
      selector: frame.selector,
      src: frame.src,
    },
  }
}

async function checkIsState(tabId, selector, stateType) {
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
  }

  const js = checkJs[stateType]
  if (!js) {
    throw new Error(`unknown state type: ${stateType}`)
  }

  const { value } = await evaluateInTabContext(tabId, js)
  return {
    found: true,
    state: stateType,
    value,
  }
}

async function getAttribute(tabId, selector, attrName) {
  if (attrName === 'text') {
    const { value } = await evaluateInTabContext(
      tabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        return node ? node.textContent : null;
      })()`,
    )
    return { found: true, value }
  }

  if (attrName === 'html') {
    const { value } = await evaluateInTabContext(
      tabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        return node ? node.innerHTML : null;
      })()`,
    )
    return { found: true, value }
  }

  if (attrName === 'value') {
    const { value } = await evaluateInTabContext(
      tabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        return node ? node.value : null;
      })()`,
    )
    return { found: true, value }
  }

  if (attrName === 'title') {
    const { value } = await evaluateInTabContext(tabId, 'document.title')
    return { found: true, value }
  }

  if (attrName === 'url') {
    const { value } = await evaluateInTabContext(tabId, 'window.location.href')
    return { found: true, value }
  }

  if (attrName === 'count') {
    const { value } = await evaluateInTabContext(
      tabId,
      `(() => {
        return document.querySelectorAll(${JSON.stringify(selector)}).length;
      })()`,
    )
    return { found: true, value }
  }

  if (attrName === 'box') {
    const { value } = await evaluateInTabContext(
      tabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`,
    )
    return { found: true, value }
  }

  // 其他属性
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node ? node.getAttribute(${JSON.stringify(attrName)}) : null;
    })()`,
  )
  return { found: true, value }
}

async function waitFor(tabId, condition, timeout = 30000) {
  const tab = await getTargetTab(tabId)
  const startTime = Date.now()

  if (condition === 'load') {
    // 等待页面加载
    return new Promise((resolve, reject) => {
      const listener = (source, method) => {
        if (source.tabId === tab.id && method === 'Page.loadEventFired') {
          chrome.debugger.onEvent.removeListener(listener)
          clearTimeout(timeoutId)
          resolve({ waited: true, condition: 'load' })
        }
      }
      const timeoutId = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener)
        reject(new Error('wait load timeout'))
      }, timeout)

      chrome.debugger.onEvent.addListener(listener)

      // 启用 Page domain
      sendDebuggerCommand(tab.id, 'Page.enable', {}).catch((err) => {
        chrome.debugger.onEvent.removeListener(listener)
        clearTimeout(timeoutId)
        reject(err)
      })
    })
  }

  if (condition === 'networkidle') {
    // 等待网络空闲
    return new Promise((resolve, reject) => {
      const listener = (source, method, params) => {
        if (
          source.tabId === tab.id &&
          method === 'Page.lifecycleEvent' &&
          params.name === 'networkidle'
        ) {
          chrome.debugger.onEvent.removeListener(listener)
          clearTimeout(timeoutId)
          resolve({ waited: true, condition: 'networkidle' })
        }
      }
      const timeoutId = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener)
        reject(new Error('wait networkidle timeout'))
      }, timeout)

      chrome.debugger.onEvent.addListener(listener)

      Promise.all([
        sendDebuggerCommand(tab.id, 'Page.enable', {}),
        sendDebuggerCommand(tab.id, 'Page.setLifecycleEventsEnabled', { enabled: true }),
      ]).catch((err) => {
        chrome.debugger.onEvent.removeListener(listener)
        clearTimeout(timeoutId)
        reject(err)
      })
    })
  }

  // 轮询方式等待 selector
  while (Date.now() - startTime < timeout) {
    const { value } = await evaluateInTabContext(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(condition)});
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })()`,
    )

    if (value === true) {
      return { waited: true, condition: 'selector', selector: condition }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`wait selector timeout: ${condition}`)
}

async function waitForUrl(tabId, urlPattern, timeout = 30000) {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const { value } = await evaluateInTabContext(tabId, 'window.location.href')
    const currentUrl = value || ''
    if (currentUrl.includes(urlPattern) || new RegExp(urlPattern).test(currentUrl)) {
      return {
        waited: true,
        condition: 'url',
        url: currentUrl,
        pattern: urlPattern,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`wait url timeout: ${urlPattern}`)
}

async function waitForText(tabId, text, timeout = 30000) {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const { value } = await evaluateInTabContext(
      tabId,
      "document.body ? document.body.innerText : ''",
    )
    const pageText = (value || '').toLowerCase()
    if (pageText.includes(text.toLowerCase())) {
      return { waited: true, condition: 'text', text }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`wait text timeout: ${text}`)
}

async function waitWithTimeout(tabId, ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { waited: true, condition: 'time', ms }
}

async function handleWait(tabId, args) {
  const timeout = args.timeout || 30000

  if (args.type === 'time' || args.ms) {
    return await waitWithTimeout(tabId, args.ms || args.timeout || 30000)
  }

  if (args.type === 'selector' || args.selector) {
    return await waitFor(tabId, args.selector, timeout)
  }

  if (args.type === 'url' || args.url) {
    return await waitForUrl(tabId, args.url, timeout)
  }

  if (args.type === 'text' || args.text) {
    return await waitForText(tabId, args.text, timeout)
  }

  if (args.type === 'load') {
    return await waitFor(tabId, 'load', timeout)
  }

  if (args.type === 'networkidle') {
    return await waitFor(tabId, 'networkidle', timeout)
  }

  throw new Error(`unsupported wait type: ${args.type}`)
}

// Cookies commands
async function cookiesGet(tabId) {
  const tab = await getTargetTab(tabId)
  const result = await sendDebuggerCommand(tab.id, 'Network.getCookies', {})
  return { cookies: result.cookies || [] }
}

async function cookiesSet(tabId, name, value, domain) {
  const tab = await getTargetTab(tabId)
  const cookie: { name: string; value: string; domain?: string } = { name, value }
  if (domain) {
    cookie.domain = domain
  }
  await sendDebuggerCommand(tab.id, 'Network.setCookie', cookie)
  return { set: true, name, value, domain }
}

async function cookiesClear(tabId) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Network.clearBrowserCookies', {})
  return { cleared: true }
}

// Storage commands
async function storageGet(tabId, key) {
  if (!key) {
    // 获取所有 localStorage
    const { value } = await evaluateInTabContext(
      tabId,
      `(() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          items[k] = localStorage.getItem(k);
        }
        return items;
      })()`,
    )
    return { storage: value || {} }
  }

  const { value } = await evaluateInTabContext(
    tabId,
    `localStorage.getItem(${JSON.stringify(key)})`,
  )
  return { key, value }
}

async function storageSet(tabId, key, value) {
  await evaluateInTabContext(
    tabId,
    `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
  )
  return { key, value, set: true }
}

async function storageClear(tabId) {
  await evaluateInTabContext(tabId, 'localStorage.clear()')
  return { cleared: true }
}

// Set commands
async function setViewport(tabId, width, height, deviceScaleFactor = 1, mobile = false) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Emulation.setDeviceMetricsOverride', {
    width: Number(width),
    height: Number(height),
    deviceScaleFactor: Number(deviceScaleFactor),
    mobile,
  })
  return { viewport: { width, height, deviceScaleFactor, mobile } }
}

async function setOffline(tabId, enabled) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Network.emulateNetworkConditions', {
    offline: enabled,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  return { offline: enabled }
}

async function setHeaders(tabId, headers) {
  const tab = await getTargetTab(tabId)
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
      )
  await sendDebuggerCommand(tab.id, 'Network.enable', {})
  await sendDebuggerCommand(tab.id, 'Network.setExtraHTTPHeaders', {
    headers: normalizedHeaders,
  })
  return { headers: normalizedHeaders }
}

async function setGeo(tabId, latitude, longitude, accuracy = 1) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Emulation.setGeolocationOverride', {
    latitude: Number(latitude),
    longitude: Number(longitude),
    accuracy: Number(accuracy),
  })
  return { geo: { latitude, longitude, accuracy } }
}

async function setMedia(tabId, media) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Emulation.setEmulatedMedia', {
    features: media ? [{ name: 'prefers-color-scheme', value: media }] : [],
  })
  return { media }
}

async function generatePdf(tabId) {
  const tab = await getTargetTab(tabId)
  const result = await sendDebuggerCommand(tab.id, 'Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.5,
    paperHeight: 11,
  })
  return {
    tabId: tab.id,
    mimeType: 'application/pdf',
    dataUrl: `data:application/pdf;base64,${result.data}`,
  }
}

async function clipboardRead(tabId) {
  const tab = await getTargetTab(tabId)
  // 首先请求剪贴板权限
  try {
    await sendDebuggerCommand(tab.id, 'Browser.setPermission', {
      permission: { name: 'clipboardReadWrite' },
      setting: 'granted',
    })
  } catch (error) {
    console.warn('clipboard read permission request failed', error)
  }

  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
      return navigator.clipboard.readText().catch(() => '');
    })()`,
  )
  return { text: value || '' }
}

async function clipboardWrite(tabId, text) {
  const tab = await getTargetTab(tabId)
  try {
    await sendDebuggerCommand(tab.id, 'Browser.setPermission', {
      permission: { name: 'clipboardReadWrite' },
      setting: 'granted',
    })
  } catch (error) {
    console.warn('clipboard write permission request failed', error)
  }

  await evaluateInTabContext(
    tabId,
    `navigator.clipboard.writeText(${JSON.stringify(text)}).catch(() => {})`,
  )
  return { written: true, text }
}

async function saveState(tabId, name) {
  const tab = await getTargetTab(tabId)
  const cookiesResult = await sendDebuggerCommand(tab.id, 'Network.getCookies', {})
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        items[k] = localStorage.getItem(k);
      }
      return items;
    })()`,
  )
  const savedState = {
    name,
    cookies: cookiesResult.cookies || [],
    storage: value || {},
  }
  const savedStates = await getSavedStates()
  await promisifyChrome(chrome.storage.local, chrome.storage.local.set, {
    [SAVED_STATES_STORAGE_KEY]: {
      ...savedStates,
      [name]: savedState,
    },
  })

  return {
    ...savedState,
    saved: true,
  }
}

async function loadState(tabId, stateData) {
  const tab = await getTargetTab(tabId)

  // 恢复 cookies
  if (stateData.cookies && stateData.cookies.length > 0) {
    for (const cookie of stateData.cookies) {
      await sendDebuggerCommand(tab.id, 'Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
      })
    }
  }

  // 恢复 storage
  if (stateData.storage) {
    for (const [key, value] of Object.entries(stateData.storage)) {
      await evaluateInTabContext(
        tab.id,
        `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
      )
    }
  }

  return { loaded: true, name: stateData.name }
}

async function handleDialog(tabId, accept, promptText) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Page.enable', {})

  try {
    await sendDebuggerCommand(tab.id, 'Page.handleJavaScriptDialog', {
      accept,
      promptText: accept ? promptText || '' : undefined,
    })
    return { handled: true, accepted: accept }
  } catch (error) {
    if (
      String(error.message || '')
        .toLowerCase()
        .includes('no dialog')
    ) {
      return { handled: false, reason: 'no dialog opened' }
    }

    throw error
  }
}

async function fillSelector(tabId, selector, value) {
  const { value: result } = await evaluateInTabContext(
    tabId,
    `(() => {
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
  )

  return result
}

async function dispatchInsertText(tabId, text) {
  const tab = await getTargetTab(tabId)
  await sendDebuggerCommand(tab.id, 'Input.insertText', {
    text: String(text || ''),
  })
  return { inserted: true, text }
}

async function insertTextSequentially(tabId, text) {
  const normalizedText = String(text || '')

  for (const character of normalizedText) {
    await dispatchInsertText(tabId, character)
  }

  return { typed: true, text: normalizedText }
}

async function insertTextOnce(tabId, text) {
  return await dispatchInsertText(tabId, text)
}

async function keyDownOnly(tabId, key) {
  const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
  const tab = await getTargetTab(tabId)

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyName,
    code: keyName,
    modifiers,
  })

  return { key, pressed: true, type: 'keydown' }
}

async function keyUpOnly(tabId, key) {
  const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
  const tab = await getTargetTab(tabId)

  await sendDebuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    code: keyName,
    modifiers,
  })

  return { key, released: true, type: 'keyup' }
}

async function typeIntoSelector(tabId, selector, value) {
  await focusElement(tabId, selector)
  const typed = await insertTextSequentially(tabId, value)
  return {
    found: true,
    selector,
    ...typed,
  }
}

async function doubleClickSelector(tabId, selector) {
  const box = await getElementBox(tabId, selector)
  if (!box) {
    throw new Error(`element not found: ${selector}`)
  }

  const tab = await getTargetTab(tabId)

  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 2,
  })
  await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 2,
  })

  return { found: true, selector, doubleClicked: true }
}

async function scrollIntoViewSelector(tabId, selector) {
  const { value } = await evaluateInTabContext(
    tabId,
    `(() => {
      try {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return { found: false, reason: 'element not found' };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        return { found: true, selector: ${JSON.stringify(selector)} };
      } catch (error) {
        return {
          found: false,
          reason: error instanceof Error ? error.message : 'failed to scroll into view',
        };
      }
    })()`,
  )

  return value
}

        function parseNetworkStatusFilter(statusFilter: string): (status: number | null | undefined) => boolean {
          const tokens = String(statusFilter || '')
            .split(',')
            .map((token) => token.trim())
            .filter(Boolean)

          if (tokens.length === 0) {
            return () => true
          }

          return (status) => {
            const numericStatus = Number(status || 0)
            return tokens.some((token) => {
              if (/^\dxx$/i.test(token)) {
                return Math.floor(numericStatus / 100) === Number(token[0])
              }

              if (/^\d{3}-\d{3}$/.test(token)) {
                const [start, end] = token.split('-').map((value) => Number(value))
                return numericStatus >= start && numericStatus <= end
              }

              return numericStatus === Number(token)
            })
          }
        }

        function matchesNetworkRequestFilters(record: Record<string, unknown>, filters: Record<string, unknown>): boolean {
          const filterText = String(filters.filter || '').trim().toLowerCase()
          const typeFilter = String(filters.type || '')
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)
          const methodFilter = String(filters.method || '').trim().toUpperCase()
          const statusMatches = parseNetworkStatusFilter(String(filters.status || ''))

          if (filterText) {
            const haystack = [
              record.id,
              record.requestId,
              record.url,
              record.method,
              record.resourceType,
              record.statusText,
              record.errorText,
            ]
              .map((value) => String(value || '').toLowerCase())
              .join(' ')

            if (!haystack.includes(filterText)) {
              return false
            }
          }

          if (typeFilter.length > 0) {
            const requestType = String(record.resourceType || '').trim().toLowerCase()
            if (!typeFilter.includes(requestType)) {
              return false
            }
          }

          if (methodFilter && String(record.method || '').toUpperCase() !== methodFilter) {
            return false
          }

          if (!statusMatches(record.status as number | null | undefined)) {
            return false
          }

          return true
        }

        async function routeNetworkRequest(tabId, url, abort = false, body = undefined) {
          const tab = await getTargetTab(tabId)
          await sendDebuggerCommand(tab.id, 'Network.enable', {})
          const route = {
            id: createNetworkRouteId(),
            pattern: String(url || '').trim(),
            abort: Boolean(abort),
            body: body === undefined ? undefined : body,
            createdAt: new Date().toISOString(),
          }

          if (!route.pattern) {
            throw new Error('missing url pattern')
          }

          state.network.routes.push(route)
          await refreshNetworkInterceptors()

          return {
            route,
            routes: state.network.routes,
          }
        }

        async function unrouteNetworkRequest(tabId, url) {
          if (tabId !== null && tabId !== undefined) {
            await getTargetTab(tabId)
          }

          if (url) {
            state.network.routes = state.network.routes.filter((route) => route.pattern !== String(url))
          } else {
            state.network.routes = []
          }

          await refreshNetworkInterceptors()

          return {
            routes: state.network.routes,
          }
        }

        function listNetworkRequests(filters: Record<string, unknown> = {}): Record<string, unknown> {
          const requests = state.network.requests.filter((record) => matchesNetworkRequestFilters(record, filters))
          return {
            total: requests.length,
            requests: requests.map((record) => summarizeNetworkRequest(record)),
          }
        }

        function getNetworkRequestDetail(requestId: string): Record<string, unknown> {
          const record = getNetworkRequestById(String(requestId || ''))
          if (!record) {
            throw new Error(`network request not found: ${requestId}`)
          }

          return {
            request: record,
            summary: summarizeNetworkRequest(record),
            harEntry: buildHarEntry(record),
          }
        }

        async function startNetworkHar(tabId): Promise<Record<string, unknown>> {
          const tab = await getTargetTab(tabId)
          await sendDebuggerCommand(tab.id, 'Network.enable', {})
          state.network.harRecording = true
          state.network.harStartedAt = new Date().toISOString()
          return {
            recording: true,
            startedAt: state.network.harStartedAt,
          }
        }

        function stopNetworkHar(): Record<string, unknown> {
          const startedAt = state.network.harStartedAt
          const stoppedAt = new Date().toISOString()
          state.network.harRecording = false
          state.network.harStartedAt = null

          const requests = state.network.requests.filter((record) => {
            if (!startedAt) {
              return true
            }

            return String(record.startedAt || '') >= startedAt
          })

          const entries = requests.map((record) => buildHarEntry(record))

          return {
            recording: false,
            startedAt,
            stoppedAt,
            har: buildHar(entries),
          }
        }

async function closeTabs(tabId, closeAll) {
  if (closeAll) {
    const tabs = await promisifyChrome(chrome.tabs, chrome.tabs.query, {
      currentWindow: true,
    })
    const tabIds = tabs.map((tab) => tab.id).filter((tabId) => typeof tabId === 'number')
    if (tabIds.length > 0) {
      await promisifyChrome(chrome.tabs, chrome.tabs.remove, tabIds)
    }
    return { closed: true, all: true, count: tabIds.length }
  }

  const tab = await getTargetTab(tabId)
  await promisifyChrome(chrome.tabs, chrome.tabs.remove, tab.id)
  return { closed: true, all: false, tabId: tab.id }
}

async function handleCommand(message) {
  const { command, args = {} } = message
  const tabId = args.tabId || undefined

  switch (command) {
    case 'status':
      return {
        connected: true,
        tabs: await listTabs(),
      }
    case 'tab.list':
      return { tabs: await listTabs() }
    case 'tab.new':
      return {
        tab: await promisifyChrome(chrome.tabs, chrome.tabs.create, {
          url: args.url || 'about:blank',
        }),
      }
    case 'goto':
    case 'open':
      return await navigateTo(tabId, args.url || 'about:blank')
    case 'eval':
      return await evaluateScript(tabId, args.script || 'document.title')
    case 'snapshot':
      return await snapshotTab(tabId)
    case 'screenshot':
      return await captureScreenshot(tabId)
    case 'click':
      return await clickSelector(tabId, args.selector || '')
    case 'dblclick':
      return await doubleClickSelector(tabId, args.selector || '')
    case 'fill':
      return await fillSelector(tabId, args.selector || '', args.value || '')
    case 'type':
      return await typeIntoSelector(tabId, args.selector || '', args.value || '')
    case 'hover':
      return await hoverElement(tabId, args.selector || '')
    case 'press':
      return await pressKey(tabId, args.key || '')
    case 'keyboard':
      if (args.action === 'type') {
        return await insertTextSequentially(tabId, args.text || '')
      }
      if (args.action === 'inserttext') {
        return await insertTextOnce(tabId, args.text || '')
      }
      if (args.action === 'keydown') {
        return await keyDownOnly(tabId, args.text || '')
      }
      if (args.action === 'keyup') {
        return await keyUpOnly(tabId, args.text || '')
      }
      throw new Error(`unsupported keyboard action: ${args.action}`)
    case 'focus':
      return await focusElement(tabId, args.selector || '')
    case 'select':
      return await selectOption(tabId, args.selector || '', args.value || '')
    case 'check':
      return await checkElement(tabId, args.selector || '', true)
    case 'uncheck':
      return await checkElement(tabId, args.selector || '', false)
    case 'scroll':
      return await scrollElement(tabId, args.selector || null, args.deltaX || 0, args.deltaY || 100)
    case 'scrollintoview':
      return await scrollIntoViewSelector(tabId, args.selector || '')
    case 'drag':
      return await dragElement(tabId, args.start || '', args.end || '')
    case 'upload':
      return await uploadFiles(tabId, args.selector || '', args.files || [])
    case 'back':
      return await navigateBack(tabId)
    case 'forward':
      return await navigateForward(tabId)
    case 'reload':
      return await reloadPage(tabId)
    case 'close':
      return await closeTabs(tabId, Boolean(args.all))
    case 'window':
      if (args.action === 'new') {
        return await createWindow()
      }
      throw new Error(`unsupported window action: ${args.action}`)
    case 'frame':
      return await switchToFrame(tabId, args.selector || '')
    case 'is':
      return await checkIsState(tabId, args.selector || '', args.state || 'visible')
    case 'get':
      return await getAttribute(tabId, args.selector || '', args.attr || 'text')
    case 'dialog':
      return await handleDialog(tabId, args.accept !== false, args.promptText)
    case 'wait':
      return await handleWait(tabId, args)
    case 'cookies':
      if (args.action === 'get') {
        return await cookiesGet(tabId)
      }
      if (args.action === 'set') {
        return await cookiesSet(tabId, args.name || '', args.value || '', args.domain)
      }
      if (args.action === 'clear') {
        return await cookiesClear(tabId)
      }
      throw new Error(`unsupported cookies action: ${args.action}`)
    case 'storage':
      if (args.action === 'get') {
        return await storageGet(tabId, args.key)
      }
      if (args.action === 'set') {
        return await storageSet(tabId, args.key || '', args.value || '')
      }
      if (args.action === 'clear') {
        return await storageClear(tabId)
      }
      throw new Error(`unsupported storage action: ${args.action}`)
    case 'console':
      return { messages: state.consoleMessages }
    case 'errors':
      return { errors: state.pageErrors }
    case 'network':
      if (args.action === 'route') {
        return await routeNetworkRequest(tabId, args.url || '', args.abort === true, args.body)
      }
      if (args.action === 'unroute') {
        return await unrouteNetworkRequest(tabId, args.url ? String(args.url) : '')
      }
      if (args.action === 'requests') {
        return listNetworkRequests(args)
      }
      if (args.action === 'request') {
        return getNetworkRequestDetail(String(args.requestId || ''))
      }
      if (args.action === 'har') {
        if (args.subaction === 'start') {
          return await startNetworkHar(tabId)
        }
        if (args.subaction === 'stop') {
          return stopNetworkHar()
        }
        throw new Error(`unsupported network har action: ${args.subaction}`)
      }
      throw new Error(`unsupported network action: ${args.action}`)
    case 'set':
      if (args.type === 'viewport') {
        return await setViewport(
          tabId,
          args.width,
          args.height,
          args.deviceScaleFactor,
          args.mobile,
        )
      }
      if (args.type === 'offline') {
        return await setOffline(tabId, args.enabled !== false)
      }
      if (args.type === 'headers') {
        return await setHeaders(tabId, args.headers)
      }
      if (args.type === 'geo') {
        return await setGeo(tabId, args.latitude, args.longitude, args.accuracy)
      }
      if (args.type === 'media') {
        return await setMedia(tabId, args.media)
      }
      throw new Error(`unsupported set type: ${args.type}`)
    case 'pdf':
      return await generatePdf(tabId)
    case 'clipboard':
      if (args.action === 'read') {
        return await clipboardRead(tabId)
      }
      if (args.action === 'write') {
        return await clipboardWrite(tabId, args.text || '')
      }
      throw new Error(`unsupported clipboard action: ${args.action}`)
    case 'state':
      if (args.action === 'save') {
        return await saveState(tabId, args.name || 'default')
      }
      if (args.action === 'load') {
        if (args.data && typeof args.data === 'object') {
          return await loadState(tabId, args.data)
        }

        const savedStates = await getSavedStates()
        const savedState = savedStates[args.name || 'default']
        if (!savedState) {
          throw new Error(`saved state not found: ${args.name || 'default'}`)
        }
        return await loadState(tabId, savedState)
      }
      throw new Error(`unsupported state action: ${args.action}`)
    default:
      throw new Error(`unsupported command: ${command}`)
  }
}

async function connect() {
  if (
    state.connecting ||
    (state.socket &&
      state.socket.readyState !== WebSocket.CLOSED &&
      state.socket.readyState !== WebSocket.CLOSING)
  ) {
    return
  }

  state.connecting = true
  setConnectionStatus('connecting')

  try {
    state.token = state.token || (await getToken())
    if (!state.token) {
      setConnectionStatus('missing-token')
      setConnectionError('missing token; save it in the options page')
      return
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${state.relayPort}/ws?token=${encodeURIComponent(state.token)}&extensionId=${encodeURIComponent(chrome.runtime.id)}`,
    )

    state.socket = socket

    socket.addEventListener('open', () => {
      setConnectionStatus('connected')
      socket.send(
        JSON.stringify({
          type: 'extension.hello',
          extensionId: chrome.runtime.id,
          version: chrome.runtime.getManifest().version,
        }),
      )
    })

    socket.addEventListener('message', async (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        console.warn('received invalid JSON from server', error)
        socket.send(
          JSON.stringify({
            type: 'response',
            id: null,
            ok: false,
            error: { message: 'invalid JSON from server' },
          }),
        )
        return
      }

      if (message?.type !== 'command') {
        return
      }

      try {
        const result = await handleCommand(message)
        socket.send(
          JSON.stringify({
            type: 'response',
            id: message.id,
            ok: true,
            result,
          }),
        )
      } catch (error) {
        const err = error as ErrorWithCode
        state.lastCommandError = {
          command: String(message.command || ''),
          message: err.message,
          code: err.code || 'EXTENSION_COMMAND_ERROR',
          at: new Date().toISOString(),
        }
        persistDiagnostics()
        socket.send(
          JSON.stringify({
            type: 'response',
            id: message.id,
            ok: false,
            error: {
              message: err.message,
              code: err.code || 'EXTENSION_COMMAND_ERROR',
            },
          }),
        )
      }

      try {
        const tabs = await listTabs()
        socket.send(
          JSON.stringify({
            type: 'state',
            tabs,
            activeTabId: tabs.find((tab) => tab.active)?.id || null,
          }),
        )
      } catch (error) {
        console.error('failed to publish extension state', error)
      }
    })

    socket.addEventListener('close', (event) => {
      state.socket = null
      state.connecting = false
      recordSocketClose({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })
      if (state.shouldReconnect) {
        reconnect()
      }
    })

    socket.addEventListener('error', () => {
      state.connecting = false
      setConnectionError('relay websocket error')
      try {
        socket.close()
      } catch (error) {
        console.warn('failed to close relay socket after websocket error', error)
      }
    })

    try {
      const tabs = await listTabs()
      socket.send(
        JSON.stringify({
          type: 'state',
          tabs,
          activeTabId: tabs.find((tab) => tab.active)?.id || null,
        }),
      )
    } catch (error) {
      console.error('failed to publish initial extension state', error)
    }
  } catch (error) {
    const err = error as ErrorWithCode
    setConnectionStatus('error')
    setConnectionError(err.message, err.code)
    throw error
  } finally {
    state.connecting = false
  }
}

async function reconnect() {
  if (!state.shouldReconnect) {
    return
  }

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
  }

  state.reconnectTimer = setTimeout(async () => {
    if (!state.socket || state.socket.readyState === WebSocket.CLOSED) {
      await connect()
    }
  }, 1000)
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => {})
})

chrome.runtime.onStartup.addListener(() => {
  connect().catch(() => {})
})

connect().catch(() => {})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'autobrowser.setToken') {
    saveToken(String(message.token || '')).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message }),
    )
    return true
  }

  if (message?.type === 'autobrowser.getStatus') {
    sendResponse({
      ok: true,
      connected: Boolean(state.socket && state.socket.readyState === WebSocket.OPEN),
      connectionStatus: state.connectionStatus,
      connectionError: state.connectionError,
      lastSocketClose: state.lastSocketClose,
      lastCommandError: state.lastCommandError,
      token: state.token || '',
      relayPort: state.relayPort,
    })
    return false
  }

  return false
})

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSelectedFrame(tabId)
  detachDebugger(tabId).catch(() => {})
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return
  }

  let needsReconnect = false

  if (changes[STORAGE_KEY]) {
    state.token = String(changes[STORAGE_KEY].newValue || '')
    needsReconnect = true
  }

  if (changes[RELAY_PORT_STORAGE_KEY]) {
    state.relayPort = normalizeRelayPort(changes[RELAY_PORT_STORAGE_KEY].newValue)
    needsReconnect = true
  }

  if (needsReconnect) {
    requestReconnect()
  }
})

Promise.all([getToken(), getRelayPort()])
  .then(([token, relayPort]) => {
    state.token = token
    state.relayPort = relayPort
    setupDebuggerEventListeners()
    return connect()
  })
  .catch(() => {})
