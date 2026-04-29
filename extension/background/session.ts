import { withFrameSelectorOptions } from './targeting.js'
import type {
  EvaluateInTabContextOptions,
  ExtensionState,
  FrameSelector,
  SavedStateData,
  SavedStatesMap,
  TabInput,
  TabWithId,
} from './types.js'

const SAVED_STATES_STORAGE_KEY = 'autobrowserSavedStates'

interface SessionDomainDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<{
    tab: TabWithId
    response: { result: unknown }
    value: TValue | null
  }>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
  storageLocalGet: <T extends Record<string, unknown> = Record<string, unknown>>(
    keys: string | string[] | null,
  ) => Promise<T>
  storageLocalSet: (items: Record<string, unknown>) => Promise<void>
}

export function createSessionDomain({
  state,
  getTargetTab,
  evaluateInTabContext,
  sendDebuggerCommand,
  storageLocalGet,
  storageLocalSet,
}: SessionDomainDependencies) {
  async function getSavedStates(): Promise<SavedStatesMap> {
    const result = await storageLocalGet(SAVED_STATES_STORAGE_KEY)
    const savedStates = result?.[SAVED_STATES_STORAGE_KEY]
    return savedStates && typeof savedStates === 'object' ? (savedStates as SavedStatesMap) : {}
  }

  async function readAllLocalStorage(tabId: TabInput, frameSelector?: FrameSelector) {
    // 统一复用同一段页面内脚本，避免 `storage get` 与 `state save` 序列化结果逐渐漂移。
    const { value } = await evaluateInTabContext<Record<string, string | null>>(
      tabId,
      `(() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          items[k] = localStorage.getItem(k);
        }
        return items;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    return value || {}
  }

  async function cookiesGet(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    const result = await sendDebuggerCommand<{ cookies?: unknown[] }>(
      tab.id,
      'Network.getCookies',
      {},
    )
    return { cookies: result.cookies || [] }
  }

  async function cookiesSet(tabId: TabInput, name: string, value: string, domain?: string) {
    const tab = await getTargetTab(tabId)
    const cookie: { name: string; value: string; domain?: string } = { name, value }
    if (domain) {
      cookie.domain = domain
    }
    await sendDebuggerCommand(tab.id, 'Network.setCookie', cookie)
    return { set: true, name, value, domain }
  }

  async function cookiesClear(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Network.clearBrowserCookies', {})
    return { cleared: true }
  }

  async function storageGet(
    tabId: TabInput,
    key: string | null | undefined,
    frameSelector: FrameSelector,
  ) {
    if (!key) {
      return { storage: await readAllLocalStorage(tabId, frameSelector) }
    }

    const { value } = await evaluateInTabContext(
      tabId,
      `localStorage.getItem(${JSON.stringify(key)})`,
      withFrameSelectorOptions(frameSelector),
    )
    return { key, value }
  }

  async function storageSet(
    tabId: TabInput,
    key: string,
    value: string,
    frameSelector: FrameSelector,
  ) {
    await evaluateInTabContext(
      tabId,
      `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
      withFrameSelectorOptions(frameSelector),
    )
    return { key, value, set: true }
  }

  async function storageClear(tabId: TabInput, frameSelector: FrameSelector) {
    await evaluateInTabContext(
      tabId,
      'localStorage.clear()',
      withFrameSelectorOptions(frameSelector),
    )
    return { cleared: true }
  }

  async function setViewport(
    tabId: TabInput,
    width: number,
    height: number,
    deviceScaleFactor = 1,
    mobile = false,
  ) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Emulation.setDeviceMetricsOverride', {
      width: Number(width),
      height: Number(height),
      deviceScaleFactor: Number(deviceScaleFactor),
      mobile,
    })
    return { viewport: { width, height, deviceScaleFactor, mobile } }
  }

  async function setOffline(tabId: TabInput, enabled: boolean) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Network.emulateNetworkConditions', {
      offline: enabled,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    return { offline: enabled }
  }

  async function setHeaders(
    tabId: TabInput,
    headers: Array<{ name?: string; value?: unknown }> | Record<string, unknown> | null | undefined,
  ) {
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

  async function setGeo(tabId: TabInput, latitude: number, longitude: number, accuracy = 1) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Emulation.setGeolocationOverride', {
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: Number(accuracy),
    })
    return { geo: { latitude, longitude, accuracy } }
  }

  async function setMedia(tabId: TabInput, media: string | null | undefined) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Emulation.setEmulatedMedia', {
      features: media ? [{ name: 'prefers-color-scheme', value: media }] : [],
    })
    return { media }
  }

  async function generatePdf(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    const result = await sendDebuggerCommand<{ data: string }>(tab.id, 'Page.printToPDF', {
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

  async function clipboardRead(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
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

  async function clipboardWrite(tabId: TabInput, text: string) {
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

  async function saveState(tabId: TabInput, name: string) {
    const tab = await getTargetTab(tabId)
    const cookiesResult = await sendDebuggerCommand<{ cookies?: unknown[] }>(
      tab.id,
      'Network.getCookies',
      {},
    )
    const storage = await readAllLocalStorage(tab.id)
    const savedState: SavedStateData = {
      name,
      cookies: (cookiesResult.cookies || []) as SavedStateData['cookies'],
      storage,
    }
    const savedStates = await getSavedStates()
    await storageLocalSet({
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

  async function loadState(tabId: TabInput, stateData: SavedStateData) {
    const tab = await getTargetTab(tabId)

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

  async function loadStateByName(tabId: TabInput, name: string) {
    const savedStates = await getSavedStates()
    const savedState = savedStates[name]
    if (!savedState) {
      throw new Error(`saved state not found: ${name}`)
    }

    return await loadState(tabId, savedState)
  }

  async function handleDialog(tabId: TabInput, accept: boolean, promptText?: string) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Page.enable', {})

    try {
      await sendDebuggerCommand(tab.id, 'Page.handleJavaScriptDialog', {
        accept,
        promptText: accept ? promptText || '' : undefined,
      })
      state.dialog = null
      return { handled: true, accepted: accept }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage.toLowerCase().includes('no dialog')) {
        return { handled: false, reason: 'no dialog opened' }
      }

      throw error
    }
  }

  function getDialogStatus(): Record<string, unknown> {
    if (!state.dialog) {
      return {
        open: false,
        type: null,
        message: null,
        defaultPrompt: null,
        url: null,
        openedAt: null,
      }
    }

    return {
      ...state.dialog,
    }
  }

  return {
    clipboardRead,
    clipboardWrite,
    cookiesClear,
    cookiesGet,
    cookiesSet,
    generatePdf,
    getDialogStatus,
    handleDialog,
    loadState,
    loadStateByName,
    saveState,
    setGeo,
    setHeaders,
    setMedia,
    setOffline,
    setViewport,
    storageClear,
    storageGet,
    storageSet,
  }
}
