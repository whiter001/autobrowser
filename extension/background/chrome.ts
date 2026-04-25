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

export function storageLocalGet<T extends Record<string, unknown> = Record<string, unknown>>(
  keys: string | string[] | null,
): Promise<T> {
  return runChromeCallback((callback) => {
    chrome.storage.local.get(keys, (items) => callback(items as T))
  })
}

export function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  return runChromeVoidCallback((callback) => {
    chrome.storage.local.set(items, callback)
  })
}

export function tabsGet(tabId: number): Promise<TabWithId> {
  return runChromeCallback((callback) => {
    chrome.tabs.get(tabId, (tab) => callback(tab as TabWithId))
  })
}

export function tabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return runChromeCallback((callback) => {
    chrome.tabs.query(queryInfo, callback)
  })
}

export function tabsRemove(tabIds: number | number[]): Promise<void> {
  return runChromeVoidCallback((callback) => {
    chrome.tabs.remove(Array.isArray(tabIds) ? tabIds : [tabIds], callback)
  })
}

export function tabsUpdate(
  tabId: number,
  updateProperties: chrome.tabs.UpdateProperties,
): Promise<chrome.tabs.Tab | undefined> {
  return runChromeCallback((callback) => {
    chrome.tabs.update(tabId, updateProperties, callback)
  })
}

export function tabsCreate(
  createProperties: chrome.tabs.CreateProperties,
): Promise<chrome.tabs.Tab | undefined> {
  return runChromeCallback((callback) => {
    chrome.tabs.create(createProperties, callback)
  })
}

export function windowsCreate(
  createData: chrome.windows.CreateData,
): Promise<chrome.windows.Window | undefined> {
  return runChromeCallback((callback) => {
    chrome.windows.create(createData, callback)
  })
}

export function windowsUpdate(
  windowId: number,
  updateInfo: chrome.windows.UpdateInfo,
): Promise<chrome.windows.Window | undefined> {
  return runChromeCallback((callback) => {
    chrome.windows.update(windowId, updateInfo, callback)
  })
}

export function debuggerAttach(
  target: chrome.debugger.Debuggee,
  requiredVersion: string,
): Promise<void> {
  return runChromeVoidCallback((callback) => {
    chrome.debugger.attach(target, requiredVersion, callback)
  })
}

export function debuggerDetach(target: chrome.debugger.Debuggee): Promise<void> {
  return runChromeVoidCallback((callback) => {
    chrome.debugger.detach(target, callback)
  })
}

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
