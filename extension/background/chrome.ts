import type { TabWithId } from './types.js'

function rejectChromeLastError(reject: (reason?: unknown) => void): boolean {
  const error = chrome.runtime.lastError
  if (!error) {
    return false
  }

  reject(new Error(error.message))
  return true
}

function runChromeCallback<TResult>(
  invoke: (callback: (result: TResult) => void) => void,
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    invoke((result: TResult) => {
      if (rejectChromeLastError(reject)) {
        return
      }

      resolve(result)
    })
  })
}

function runChromeVoidCallback(invoke: (callback: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    invoke(() => {
      if (rejectChromeLastError(reject)) {
        return
      }

      resolve()
    })
  })
}

/**
 * chrome.storage.local.get 的 Promise 封装。
 */
export function storageLocalGet<T extends Record<string, unknown> = Record<string, unknown>>(
  keys: string | string[] | null,
): Promise<T> {
  return runChromeCallback((callback) => {
    chrome.storage.local.get(keys, (items) => callback(items as T))
  })
}

/**
 * chrome.storage.local.set 的 Promise 封装。
 */
export function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  return runChromeVoidCallback((callback) => {
    chrome.storage.local.set(items, callback)
  })
}

/**
 * chrome.tabs.get 的 Promise 封装。
 */
export function tabsGet(tabId: number): Promise<TabWithId> {
  return runChromeCallback((callback) => {
    chrome.tabs.get(tabId, (tab) => callback(tab as TabWithId))
  })
}

/**
 * chrome.tabs.query 的 Promise 封装。
 */
export function tabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return runChromeCallback((callback) => {
    chrome.tabs.query(queryInfo, callback)
  })
}

/**
 * chrome.tabs.remove 的 Promise 封装，支持单个或批量标签 ID。
 */
export function tabsRemove(tabIds: number | number[]): Promise<void> {
  return runChromeVoidCallback((callback) => {
    chrome.tabs.remove(Array.isArray(tabIds) ? tabIds : [tabIds], callback)
  })
}

/**
 * chrome.tabs.update 的 Promise 封装。
 */
export function tabsUpdate(
  tabId: number,
  updateProperties: chrome.tabs.UpdateProperties,
): Promise<chrome.tabs.Tab | undefined> {
  return runChromeCallback((callback) => {
    chrome.tabs.update(tabId, updateProperties, callback)
  })
}

/**
 * chrome.tabs.create 的 Promise 封装。
 */
export function tabsCreate(
  createProperties: chrome.tabs.CreateProperties,
): Promise<chrome.tabs.Tab | undefined> {
  return runChromeCallback((callback) => {
    chrome.tabs.create(createProperties, callback)
  })
}

/**
 * chrome.windows.create 的 Promise 封装。
 */
export function windowsCreate(
  createData: chrome.windows.CreateData,
): Promise<chrome.windows.Window | undefined> {
  return runChromeCallback((callback) => {
    chrome.windows.create(createData, callback)
  })
}

/**
 * chrome.windows.update 的 Promise 封装。
 */
export function windowsUpdate(
  windowId: number,
  updateInfo: chrome.windows.UpdateInfo,
): Promise<chrome.windows.Window | undefined> {
  return runChromeCallback((callback) => {
    chrome.windows.update(windowId, updateInfo, callback)
  })
}

/**
 * chrome.debugger.attach 的 Promise 封装，失败原因由统一的回调错误处理转成异常。
 */
export function debuggerAttach(
  target: chrome.debugger.Debuggee,
  requiredVersion: string,
): Promise<void> {
  return runChromeVoidCallback((callback) => {
    chrome.debugger.attach(target, requiredVersion, callback)
  })
}

/**
 * chrome.debugger.detach 的 Promise 封装。
 */
export function debuggerDetach(target: chrome.debugger.Debuggee): Promise<void> {
  return runChromeVoidCallback((callback) => {
    chrome.debugger.detach(target, callback)
  })
}

/**
 * chrome.debugger.sendCommand 的 Promise 封装，CDP 调用统一从这里走。
 */
export function debuggerSendCommand<TResult = unknown>(
  target: chrome.debugger.DebuggerSession,
  method: string,
  commandParams: Record<string, unknown> = {},
): Promise<TResult> {
  return runChromeCallback((callback) => {
    chrome.debugger.sendCommand(
      target,
      method,
      commandParams,
      callback as (result?: object) => void,
    )
  })
}
