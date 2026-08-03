import { withFrameSelectorOptions } from './targeting.js'
import type {
  EmulationOverrides,
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

function resolveTabHostname(tabUrl: string | undefined): string {
  try {
    return new URL(tabUrl || '').hostname.toLowerCase()
  } catch {
    // chrome:// 等无法解析的 URL 没有可匹配的域名
    return ''
  }
}

function cookieMatchesHostname(cookieDomain: string, hostname: string): boolean {
  // cookie 的 domain 可能带前导点（如 .example.com），归一化后按域名后缀匹配父域/子域
  const normalizedDomain = String(cookieDomain || '')
    .replace(/^\.+/, '')
    .toLowerCase()
  return Boolean(
    normalizedDomain &&
    hostname &&
    (normalizedDomain === hostname ||
      hostname.endsWith(`.${normalizedDomain}`) ||
      normalizedDomain.endsWith(`.${hostname}`)),
  )
}

/** 记录/清除单 tab 的仿真覆盖摘要：更新后为空则整条删除，避免残留空记录 */
function updateEmulation(
  state: ExtensionState,
  tabId: number,
  update: (overrides: EmulationOverrides) => void,
): void {
  const overrides = state.session.emulation.get(tabId) ?? {}
  update(overrides)
  if (Object.keys(overrides).length === 0) {
    state.session.emulation.delete(tabId)
  } else {
    state.session.emulation.set(tabId, overrides)
  }
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
    return await readAllStorage(tabId, false, frameSelector)
  }

  // sessionStorage 是 per-tab per-origin，与 localStorage 一样直接走页面内 evaluate，
  // 用同一个表达式模板切换 store 对象，避免两套读取逻辑漂移
  async function readAllStorage(
    tabId: TabInput,
    sessionOnly: boolean,
    frameSelector?: FrameSelector,
  ) {
    const store = sessionOnly ? 'sessionStorage' : 'localStorage'
    const { value } = await evaluateInTabContext<Record<string, string | null>>(
      tabId,
      `(() => {
        const items = {};
        for (let i = 0; i < ${store}.length; i++) {
          const k = ${store}.key(i);
          items[k] = ${store}.getItem(k);
        }
        return items;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    return value || {}
  }

  async function cookiesGet(tabId: TabInput, filters: { domain?: string; path?: string } = {}) {
    const tab = await getTargetTab(tabId)
    const result = await sendDebuggerCommand<{ cookies?: unknown[] }>(
      tab.id,
      'Network.getCookies',
      {},
    )
    const domainFilter = String(filters.domain || '')
      .replace(/^\.+/, '')
      .toLowerCase()
    const pathFilter = typeof filters.path === 'string' ? filters.path : ''
    const cookies = (result.cookies || []).filter((cookie) => {
      if (!cookie || typeof cookie !== 'object') {
        return false
      }

      const record = cookie as { domain?: string; path?: string }
      // domain 过滤复用域名后缀匹配，允许按父域/子域收敛结果
      if (domainFilter && !cookieMatchesHostname(String(record.domain || ''), domainFilter)) {
        return false
      }

      if (pathFilter && String(record.path || '') !== pathFilter) {
        return false
      }

      return true
    })
    return { cookies }
  }

  async function cookiesDelete(tabId: TabInput, name: string) {
    const tab = await getTargetTab(tabId)
    const hostname = resolveTabHostname(tab.url)
    if (!hostname) {
      return { deleted: 0, name, domain: null }
    }

    const result = await sendDebuggerCommand<{
      cookies?: Array<{ name?: string; domain?: string; path?: string }>
    }>(tab.id, 'Network.getCookies', {})

    let deleted = 0
    for (const cookie of result.cookies || []) {
      if (
        String(cookie.name || '') === name &&
        cookieMatchesHostname(String(cookie.domain || ''), hostname)
      ) {
        await sendDebuggerCommand(tab.id, 'Network.deleteCookies', {
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
        })
        deleted += 1
      }
    }

    return { deleted, name, domain: hostname }
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
    // 只清当前 tab 站点域名的 cookie，避免误清用户其他站点的登录态
    const hostname = resolveTabHostname(tab.url)

    if (!hostname) {
      return { cleared: 0, domain: null }
    }

    const result = await sendDebuggerCommand<{
      cookies?: Array<{ name?: string; domain?: string; path?: string }>
    }>(tab.id, 'Network.getCookies', {})

    let cleared = 0
    for (const cookie of result.cookies || []) {
      if (cookieMatchesHostname(String(cookie.domain || ''), hostname)) {
        await sendDebuggerCommand(tab.id, 'Network.deleteCookies', {
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
        })
        cleared += 1
      }
    }

    return { cleared, domain: hostname }
  }

  async function storageGet(
    tabId: TabInput,
    key: string | null | undefined,
    frameSelector: FrameSelector,
    sessionOnly = false,
  ) {
    if (!key) {
      return { storage: await readAllStorage(tabId, sessionOnly, frameSelector) }
    }

    const store = sessionOnly ? 'sessionStorage' : 'localStorage'
    const { value } = await evaluateInTabContext(
      tabId,
      `${store}.getItem(${JSON.stringify(key)})`,
      withFrameSelectorOptions(frameSelector),
    )
    return { key, value }
  }

  async function storageSet(
    tabId: TabInput,
    key: string,
    value: string,
    frameSelector: FrameSelector,
    sessionOnly = false,
  ) {
    const store = sessionOnly ? 'sessionStorage' : 'localStorage'
    await evaluateInTabContext(
      tabId,
      `${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
      withFrameSelectorOptions(frameSelector),
    )
    return { key, value, set: true }
  }

  async function storageDelete(
    tabId: TabInput,
    key: string,
    frameSelector: FrameSelector,
    sessionOnly = false,
  ) {
    const store = sessionOnly ? 'sessionStorage' : 'localStorage'
    await evaluateInTabContext(
      tabId,
      `${store}.removeItem(${JSON.stringify(key)})`,
      withFrameSelectorOptions(frameSelector),
    )
    return { key, deleted: true }
  }

  async function storageClear(tabId: TabInput, frameSelector: FrameSelector, sessionOnly = false) {
    const store = sessionOnly ? 'sessionStorage' : 'localStorage'
    await evaluateInTabContext(tabId, `${store}.clear()`, withFrameSelectorOptions(frameSelector))
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
    updateEmulation(state, tab.id, (overrides) => {
      overrides.viewport = true
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
    // offline:false 即恢复联网默认值，不再视为生效中的覆盖
    updateEmulation(state, tab.id, (overrides) => {
      if (enabled) {
        overrides.offline = true
      } else {
        delete overrides.offline
      }
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
    updateEmulation(state, tab.id, (overrides) => {
      if (Object.keys(normalizedHeaders).length > 0) {
        // headers 只回显键名列表，不暴露值
        overrides.headers = Object.keys(normalizedHeaders)
      } else {
        delete overrides.headers
      }
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
    updateEmulation(state, tab.id, (overrides) => {
      overrides.geo = true
    })
    return { geo: { latitude, longitude, accuracy } }
  }

  async function setMedia(tabId: TabInput, media: string | null | undefined) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Emulation.setEmulatedMedia', {
      features: media ? [{ name: 'prefers-color-scheme', value: media }] : [],
    })
    // 空值恢复默认配色方案，不再视为生效中的覆盖
    updateEmulation(state, tab.id, (overrides) => {
      if (media) {
        overrides.media = true
      } else {
        delete overrides.media
      }
    })
    return { media }
  }

  async function setPermission(tabId: TabInput, name: string, reset = false) {
    const tab = await getTargetTab(tabId)
    let origin: string | undefined
    try {
      const parsed = new URL(tab.url || '')
      origin = parsed.origin === 'null' ? undefined : parsed.origin
    } catch {
      // chrome:// 等无法解析的 URL 不带 origin，授权退化为浏览器级默认上下文
    }

    await sendDebuggerCommand(tab.id, 'Browser.setPermission', {
      permission: { name },
      setting: reset ? 'default' : 'granted',
      ...(origin ? { origin } : {}),
    })
    return { permission: name, setting: reset ? 'default' : 'granted', origin: origin ?? null }
  }

  async function setUserAgent(tabId: TabInput, userAgent: string | null | undefined) {
    const tab = await getTargetTab(tabId)
    // CDP 语义：空字符串即恢复默认 UA
    await sendDebuggerCommand(tab.id, 'Emulation.setUserAgentOverride', {
      userAgent: userAgent || '',
    })
    updateEmulation(state, tab.id, (overrides) => {
      if (userAgent) {
        overrides.ua = true
      } else {
        delete overrides.ua
      }
    })
    return { userAgent: userAgent || null }
  }

  async function setTimezone(tabId: TabInput, timezone: string | null | undefined) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Emulation.setTimezoneOverride', {
      timezoneId: timezone || '',
    })
    updateEmulation(state, tab.id, (overrides) => {
      if (timezone) {
        overrides.timezone = true
      } else {
        delete overrides.timezone
      }
    })
    return { timezone: timezone || null }
  }

  async function setLocale(tabId: TabInput, locale: string | null | undefined) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Emulation.setLocaleOverride', {
      locale: locale || '',
    })
    updateEmulation(state, tab.id, (overrides) => {
      if (locale) {
        overrides.locale = true
      } else {
        delete overrides.locale
      }
    })
    return { locale: locale || null }
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
      const openDialog = state.session.dialogs.get(tab.id)
      state.session.dialogs.delete(tab.id)
      if (openDialog) {
        state.session.lastDialog = {
          tabId: tab.id,
          type: openDialog.type,
          message: openDialog.message,
          handledBy: 'dialog-command',
          accepted: accept,
          openedAt: openDialog.openedAt,
          handledAt: new Date().toISOString(),
        }
      }
      return { handled: true, accepted: accept }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage.toLowerCase().includes('no dialog')) {
        return { handled: false, reason: 'no dialog opened' }
      }

      throw error
    }
  }

  function resolveDialogTab(tabInput?: TabInput): number | null {
    if (typeof tabInput === 'number') {
      return tabInput
    }
    if (typeof tabInput === 'string') {
      return state.targeting.tabIdsByHandle.get(tabInput) ?? null
    }
    return state.targeting.targetTabId
  }

  function getDialogStatus(tabInput?: TabInput): Record<string, unknown> {
    const tabId = resolveDialogTab(tabInput)
    const openDialog = tabId !== null ? state.session.dialogs.get(tabId) : undefined

    if (!openDialog) {
      return {
        open: false,
        type: null,
        message: null,
        defaultPrompt: null,
        url: null,
        openedAt: null,
        lastDialog: state.session.lastDialog,
      }
    }

    return {
      ...openDialog,
      lastDialog: state.session.lastDialog,
    }
  }

  function getDialogAutoAccept(): boolean {
    return state.session.dialogAutoAccept !== false
  }

  function setDialogAutoAccept(enabled: boolean): { autoAccept: boolean; note: string } {
    // 不持久化：扩展重启后回到默认 true，命令返回里说明即可
    state.session.dialogAutoAccept = enabled
    return {
      autoAccept: enabled,
      note: 'dialogAutoAccept is a runtime-only setting; it resets to true when the extension restarts',
    }
  }

  return {
    clipboardRead,
    clipboardWrite,
    cookiesClear,
    cookiesDelete,
    cookiesGet,
    cookiesSet,
    generatePdf,
    getDialogAutoAccept,
    getDialogStatus,
    handleDialog,
    loadState,
    loadStateByName,
    saveState,
    setDialogAutoAccept,
    setGeo,
    setHeaders,
    setLocale,
    setMedia,
    setOffline,
    setPermission,
    setTimezone,
    setUserAgent,
    setViewport,
    storageClear,
    storageDelete,
    storageGet,
    storageSet,
  }
}
