import {
  tabsCreate,
  tabsQuery,
  tabsRemove,
  tabsUpdate,
  windowsCreate,
  windowsUpdate,
} from './chrome.js'
import { getOrCreateTabHandle, rememberTargetTab, toTabSummary } from './targeting.js'
import type {
  CommandArgs,
  CommandMessage,
  ExtensionState,
  FrameSelector,
  SavedStateData,
  ScreenshotCaptureOptions,
  TabInput,
  TabSummary,
  TabWithId,
} from './types.js'
import type { FindSemanticTargetOptions, SemanticTargetResult } from './page-observe.js'

interface PageInputDomain {
  navigateTo: (tabId: TabInput, url: string) => Promise<unknown>
  evaluateScript: (
    tabId: TabInput,
    script: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  clickSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  doubleClickSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  fillSelector: (
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  typeIntoSelector: (
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  hoverElement: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  pressKey: (tabId: TabInput, key: string) => Promise<unknown>
  insertTextSequentially: (tabId: TabInput, text: string) => Promise<unknown>
  insertTextOnce: (tabId: TabInput, text: string) => Promise<unknown>
  keyDownOnly: (tabId: TabInput, key: string) => Promise<unknown>
  keyUpOnly: (tabId: TabInput, key: string) => Promise<unknown>
  focusElement: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  selectOption: (
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  checkElement: (
    tabId: TabInput,
    selector: string,
    checked: boolean,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  scrollElement: (
    tabId: TabInput,
    selector: string | null,
    deltaX: number,
    deltaY: number,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  scrollIntoViewSelector: (
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  dragElement: (
    tabId: TabInput,
    startSelector: string,
    endSelector: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  uploadFiles: (
    tabId: TabInput,
    selector: string,
    filePaths: string[],
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  navigateBack: (tabId: TabInput) => Promise<unknown>
  navigateForward: (tabId: TabInput) => Promise<unknown>
  reloadPage: (tabId: TabInput) => Promise<unknown>
  switchToFrame: (tabId: TabInput, selector: string) => Promise<unknown>
  checkIsState: (
    tabId: TabInput,
    selector: string,
    stateType: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  getAttribute: (
    tabId: TabInput,
    selector: string,
    attrName: string,
    frameSelector: FrameSelector,
  ) => Promise<{ value?: unknown } & Record<string, unknown>>
}

interface PageObserveDomain {
  snapshotTab: (tabId: TabInput, frameSelector: FrameSelector) => Promise<unknown>
  captureScreenshot: (
    tabId: TabInput,
    options: ScreenshotCaptureOptions,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  findSemanticTarget: (
    tabId: TabInput,
    options: FindSemanticTargetOptions,
    frameSelector: FrameSelector,
  ) => Promise<SemanticTargetResult>
  waitWithTimeout: (tabId: TabInput, ms: number) => Promise<unknown>
  waitForSelectorState: (
    tabId: TabInput,
    selector: string,
    state: string,
    timeout: number,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  waitForUrl: (
    tabId: TabInput,
    pattern: string,
    timeout: number,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  waitForText: (
    tabId: TabInput,
    text: string,
    timeout: number,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  waitForLoadEvent: (tabId: TabInput, timeout: number) => Promise<unknown>
  waitForNetworkIdle: (tabId: TabInput, timeout: number) => Promise<unknown>
  waitForExpression: (
    tabId: TabInput,
    expression: string,
    timeout: number,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
}

interface SessionDomain {
  getDialogStatus: () => Record<string, unknown>
  handleDialog: (tabId: TabInput, accept: boolean, promptText?: string) => Promise<unknown>
  cookiesGet: (tabId: TabInput) => Promise<unknown>
  cookiesSet: (tabId: TabInput, name: string, value: string, domain?: string) => Promise<unknown>
  cookiesClear: (tabId: TabInput) => Promise<unknown>
  storageGet: (
    tabId: TabInput,
    key: string | null | undefined,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  storageSet: (
    tabId: TabInput,
    key: string,
    value: string,
    frameSelector: FrameSelector,
  ) => Promise<unknown>
  storageClear: (tabId: TabInput, frameSelector: FrameSelector) => Promise<unknown>
  setViewport: (
    tabId: TabInput,
    width: number,
    height: number,
    deviceScaleFactor?: number,
    mobile?: boolean,
  ) => Promise<unknown>
  setOffline: (tabId: TabInput, enabled: boolean) => Promise<unknown>
  setHeaders: (
    tabId: TabInput,
    headers: Array<{ name?: string; value?: unknown }> | Record<string, unknown> | null | undefined,
  ) => Promise<unknown>
  setGeo: (
    tabId: TabInput,
    latitude: number,
    longitude: number,
    accuracy?: number,
  ) => Promise<unknown>
  setMedia: (tabId: TabInput, media: string | null | undefined) => Promise<unknown>
  generatePdf: (tabId: TabInput) => Promise<unknown>
  clipboardRead: (tabId: TabInput) => Promise<unknown>
  clipboardWrite: (tabId: TabInput, text: string) => Promise<unknown>
  saveState: (tabId: TabInput, name: string) => Promise<unknown>
  loadState: (tabId: TabInput, stateData: SavedStateData) => Promise<unknown>
  loadStateByName: (tabId: TabInput, name: string) => Promise<unknown>
}

interface NetworkDomain {
  routeRequest: (tabId: TabInput, url: string, abort: boolean, body: unknown) => Promise<unknown>
  unrouteRequest: (tabId: TabInput, url: string) => Promise<unknown>
  listRequests: (args: CommandArgs) => unknown
  getRequestDetail: (requestId: string) => unknown
  startHar: (tabId: TabInput) => Promise<unknown>
  stopHar: () => unknown
}

interface CommandRouterDependencies {
  state: ExtensionState
  pageInput: PageInputDomain
  pageObserve: PageObserveDomain
  session: SessionDomain
  network: NetworkDomain
  listTabs: () => Promise<TabSummary[]>
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
}

export function createCommandRouter({
  state,
  pageInput,
  pageObserve,
  session,
  network,
  listTabs,
  getTargetTab,
}: CommandRouterDependencies) {
  function readStringArg(args: CommandArgs, key: string, fallback = ''): string {
    const value = args[key]
    return typeof value === 'string' ? value : fallback
  }

  function readOptionalStringArg(args: CommandArgs, key: string): string | undefined {
    const value = args[key]
    return typeof value === 'string' ? value : undefined
  }

  function readNumberArg(args: CommandArgs, key: string, fallback = 0): number {
    const value = args[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  function readBooleanArg(args: CommandArgs, key: string, fallback = false): boolean {
    const value = args[key]
    return typeof value === 'boolean' ? value : fallback
  }

  function readStringArrayArg(args: CommandArgs, key: string): string[] {
    const value = args[key]
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  }

  function readTabInputArg(args: CommandArgs, key: string): TabInput {
    const value = args[key]
    return typeof value === 'number' || typeof value === 'string' || value == null
      ? value
      : undefined
  }

  function readFrameSelectorArg(args: CommandArgs, key: string): FrameSelector {
    const value = readOptionalStringArg(args, key)
    return value && value.trim() ? value.trim() : null
  }

  function readObjectArg(args: CommandArgs, key: string): Record<string, unknown> | undefined {
    const value = args[key]
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  }

  function readSavedStateArg(args: CommandArgs, key: string): SavedStateData | undefined {
    const value = args[key]
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as SavedStateData)
      : undefined
  }

  function readHeadersArg(
    args: CommandArgs,
    key: string,
  ): Array<{ name?: string; value?: unknown }> | Record<string, unknown> | undefined {
    const value = args[key]
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is { name?: string; value?: unknown } =>
          Boolean(item) && typeof item === 'object',
      )
    }

    return readObjectArg(args, key)
  }

  function readScreenshotOptions(args: CommandArgs): ScreenshotCaptureOptions {
    const format = readOptionalStringArg(args, 'format')
    const quality = readNumberArg(args, 'quality', 80)

    return {
      full: readBooleanArg(args, 'full', false),
      annotate: readBooleanArg(args, 'annotate', false),
      ...(format ? { format } : {}),
      ...(quality ? { quality } : {}),
    }
  }

  async function createWindow() {
    const window = await windowsCreate({
      url: 'about:blank',
      focused: true,
    })
    return { windowId: window?.id ?? null, tabId: window?.tabs?.[0]?.id ?? null }
  }

  async function handleFindCommand(
    tabId: TabInput,
    args: CommandArgs,
    frameSelector: FrameSelector,
  ) {
    const action = readStringArg(args, 'action', 'locate').trim()
    const actionValue = readStringArg(args, 'value')
    const findOptions: FindSemanticTargetOptions = {
      strategy: readStringArg(args, 'strategy').trim(),
      role: readStringArg(args, 'role').trim(),
      query: readStringArg(args, 'query').trim(),
      name: readStringArg(args, 'name').trim(),
      exact: args.exact === true,
    }
    const result = await pageObserve.findSemanticTarget(tabId, findOptions, frameSelector)
    const ref = result.match?.ref
    if (!ref) {
      throw new Error(result.reason || 'semantic target ref missing')
    }

    if (action === 'locate') {
      return result
    }

    if (action === 'click') {
      return { ...result, action, result: await pageInput.clickSelector(tabId, ref, frameSelector) }
    }

    if (action === 'fill') {
      return {
        ...result,
        action,
        result: await pageInput.fillSelector(tabId, ref, actionValue, frameSelector),
      }
    }

    if (action === 'type') {
      return {
        ...result,
        action,
        result: await pageInput.typeIntoSelector(tabId, ref, actionValue, frameSelector),
      }
    }

    if (action === 'hover') {
      return { ...result, action, result: await pageInput.hoverElement(tabId, ref, frameSelector) }
    }

    if (action === 'focus') {
      return { ...result, action, result: await pageInput.focusElement(tabId, ref, frameSelector) }
    }

    if (action === 'check') {
      return {
        ...result,
        action,
        result: await pageInput.checkElement(tabId, ref, true, frameSelector),
      }
    }

    if (action === 'uncheck') {
      return {
        ...result,
        action,
        result: await pageInput.checkElement(tabId, ref, false, frameSelector),
      }
    }

    if (action === 'text') {
      const textResult = await pageInput.getAttribute(tabId, ref, 'text', frameSelector)
      return {
        ...result,
        action,
        result: {
          found: true,
          value: textResult.value,
        },
      }
    }

    throw new Error(`unsupported find action: ${action}`)
  }

  async function handleWait(tabId: TabInput, args: CommandArgs, frameSelector: FrameSelector) {
    const timeout = readNumberArg(args, 'timeout', 30000)
    const waitType = readStringArg(args, 'type')
    const waitMs = readNumberArg(args, 'ms', 0)
    const waitSelector = readStringArg(args, 'selector')
    const waitState = readStringArg(args, 'state', 'visible')
    const waitUrl = readStringArg(args, 'url')
    const waitText = readStringArg(args, 'text')
    const waitFn = readStringArg(args, 'fn')

    if (waitType === 'time' || waitMs > 0) {
      return await pageObserve.waitWithTimeout(tabId, waitMs || timeout)
    }

    if (waitType === 'selector' || waitSelector) {
      return await pageObserve.waitForSelectorState(
        tabId,
        waitSelector,
        waitState,
        timeout,
        frameSelector,
      )
    }

    if (waitType === 'url' || waitUrl) {
      return await pageObserve.waitForUrl(tabId, waitUrl, timeout, frameSelector)
    }

    if (waitType === 'text' || waitText) {
      return await pageObserve.waitForText(tabId, waitText, timeout, frameSelector)
    }

    if (waitType === 'load') {
      return await pageObserve.waitForLoadEvent(tabId, timeout)
    }

    if (waitType === 'networkidle') {
      return await pageObserve.waitForNetworkIdle(tabId, timeout)
    }

    if (waitType === 'fn' || waitFn) {
      return await pageObserve.waitForExpression(tabId, waitFn, timeout, frameSelector)
    }

    throw new Error(`unsupported wait type: ${waitType}`)
  }

  async function closeTabs(tabId: TabInput, closeAll: boolean) {
    if (closeAll) {
      const tabs = await tabsQuery({
        currentWindow: true,
      })
      const tabIds = tabs.map((tab) => tab.id).filter((candidate) => typeof candidate === 'number')
      if (tabIds.length > 0) {
        await tabsRemove(tabIds)
      }
      return { closed: true, all: true, count: tabIds.length }
    }

    const tab = await getTargetTab(tabId)
    await tabsRemove([tab.id])
    return { closed: true, all: false, tabId: tab.id }
  }

  async function selectTab(tabHandle: TabInput) {
    const tab = await getTargetTab(tabHandle)
    const updatedTab = await tabsUpdate(tab.id, {
      active: true,
    })

    rememberTargetTab(state, tab.id)

    if (typeof updatedTab?.windowId === 'number') {
      try {
        await windowsUpdate(updatedTab.windowId, {
          focused: true,
        })
      } catch {
        // Best effort only.
      }
    }

    return {
      selected: true,
      tab: toTabSummary(state, updatedTab || tab),
    }
  }

  async function closeTab(tabHandle: TabInput) {
    const tab = await getTargetTab(tabHandle)
    const handle = getOrCreateTabHandle(state, tab.id)
    await tabsRemove([tab.id])
    return {
      closed: true,
      tab: {
        ...toTabSummary(state, tab),
        handle,
      },
    }
  }

  async function handleCommand(message: CommandMessage) {
    const { command, args = {} } = message
    const tabId = readTabInputArg(args, 'tabId')
    const handle = readTabInputArg(args, 'handle')
    const frameSelector = readFrameSelectorArg(args, 'frame')
    const action = readStringArg(args, 'action')
    const url = readStringArg(args, 'url', 'about:blank')
    const script = readStringArg(args, 'script', 'document.title')
    const selector = readStringArg(args, 'selector')
    const value = readStringArg(args, 'value')
    const key = readStringArg(args, 'key')
    const text = readStringArg(args, 'text')
    const start = readStringArg(args, 'start')
    const end = readStringArg(args, 'end')
    const stateName = readStringArg(args, 'state', 'visible')
    const attr = readStringArg(args, 'attr', 'text')
    const name = readStringArg(args, 'name', 'default')
    const domain = readOptionalStringArg(args, 'domain')
    const promptText = readOptionalStringArg(args, 'promptText')
    const files = readStringArrayArg(args, 'files')
    const scrollSelector = selector || null
    const deltaX = readNumberArg(args, 'deltaX', 0)
    const deltaY = readNumberArg(args, 'deltaY', 100)
    const viewportWidth = readNumberArg(args, 'width', 0)
    const viewportHeight = readNumberArg(args, 'height', 0)
    const deviceScaleFactor = readNumberArg(args, 'deviceScaleFactor', 1)
    const mobile = readBooleanArg(args, 'mobile', false)
    const enabled = readBooleanArg(args, 'enabled', true)
    const accept = readBooleanArg(args, 'accept', true)
    const headers = readHeadersArg(args, 'headers')
    const latitude = readNumberArg(args, 'latitude', 0)
    const longitude = readNumberArg(args, 'longitude', 0)
    const accuracy = readNumberArg(args, 'accuracy', 1)
    const media = readOptionalStringArg(args, 'media')
    const requestId = readStringArg(args, 'requestId')
    const subaction = readStringArg(args, 'subaction')
    const storageKey = readOptionalStringArg(args, 'key')
    const storageValue = readStringArg(args, 'value')
    const savedStateData = readSavedStateArg(args, 'data')
    const screenshotOptions = readScreenshotOptions(args)
    const tabTarget = handle || tabId

    switch (command) {
      case 'status':
        return {
          connected: true,
          tabs: await listTabs(),
        }
      case 'tab.list':
        return { tabs: await listTabs() }
      case 'tab.select':
        return await selectTab(tabTarget)
      case 'tab.new': {
        const tab = await tabsCreate({
          url,
        })

        if (tab && typeof tab.id === 'number') {
          rememberTargetTab(state, tab.id)
        }

        return { tab: toTabSummary(state, tab || {}) }
      }
      case 'tab.close':
        return await closeTab(tabTarget)
      case 'goto':
      case 'open':
        return await pageInput.navigateTo(tabId, url)
      case 'eval':
        return await pageInput.evaluateScript(tabId, script, frameSelector)
      case 'snapshot':
        return await pageObserve.snapshotTab(tabId, frameSelector)
      case 'screenshot':
        return await pageObserve.captureScreenshot(tabId, screenshotOptions, frameSelector)
      case 'click':
        return await pageInput.clickSelector(tabId, selector, frameSelector)
      case 'dblclick':
        return await pageInput.doubleClickSelector(tabId, selector, frameSelector)
      case 'fill':
        return await pageInput.fillSelector(tabId, selector, value, frameSelector)
      case 'find':
        return await handleFindCommand(tabId, args, frameSelector)
      case 'type':
        return await pageInput.typeIntoSelector(tabId, selector, value, frameSelector)
      case 'hover':
        return await pageInput.hoverElement(tabId, selector, frameSelector)
      case 'press':
        return await pageInput.pressKey(tabId, key)
      case 'keyboard':
        if (action === 'type') {
          return await pageInput.insertTextSequentially(tabId, text)
        }
        if (action === 'inserttext') {
          return await pageInput.insertTextOnce(tabId, text)
        }
        if (action === 'keydown') {
          return await pageInput.keyDownOnly(tabId, text)
        }
        if (action === 'keyup') {
          return await pageInput.keyUpOnly(tabId, text)
        }
        throw new Error(`unsupported keyboard action: ${action}`)
      case 'focus':
        return await pageInput.focusElement(tabId, selector, frameSelector)
      case 'select':
        return await pageInput.selectOption(tabId, selector, value, frameSelector)
      case 'check':
        return await pageInput.checkElement(tabId, selector, true, frameSelector)
      case 'uncheck':
        return await pageInput.checkElement(tabId, selector, false, frameSelector)
      case 'scroll':
        return await pageInput.scrollElement(tabId, scrollSelector, deltaX, deltaY, frameSelector)
      case 'scrollintoview':
        return await pageInput.scrollIntoViewSelector(tabId, selector, frameSelector)
      case 'drag':
        return await pageInput.dragElement(tabId, start, end, frameSelector)
      case 'upload':
        return await pageInput.uploadFiles(tabId, selector, files, frameSelector)
      case 'back':
        return await pageInput.navigateBack(tabId)
      case 'forward':
        return await pageInput.navigateForward(tabId)
      case 'reload':
        return await pageInput.reloadPage(tabId)
      case 'close':
        return await closeTabs(tabId, readBooleanArg(args, 'all', false))
      case 'window':
        if (action === 'new') {
          return await createWindow()
        }
        throw new Error(`unsupported window action: ${action}`)
      case 'frame':
        return await pageInput.switchToFrame(tabId, selector)
      case 'is':
        return await pageInput.checkIsState(tabId, selector, stateName, frameSelector)
      case 'get':
        return await pageInput.getAttribute(tabId, selector, attr, frameSelector)
      case 'dialog':
        if (action === 'status') {
          return session.getDialogStatus()
        }
        return await session.handleDialog(tabId, accept, promptText)
      case 'wait':
        return await handleWait(tabId, args, frameSelector)
      case 'cookies':
        if (action === 'get') {
          return await session.cookiesGet(tabId)
        }
        if (action === 'set') {
          return await session.cookiesSet(tabId, name, value, domain)
        }
        if (action === 'clear') {
          return await session.cookiesClear(tabId)
        }
        throw new Error(`unsupported cookies action: ${action}`)
      case 'storage':
        if (action === 'get') {
          return await session.storageGet(tabId, storageKey, frameSelector)
        }
        if (action === 'set') {
          return await session.storageSet(tabId, storageKey || '', storageValue, frameSelector)
        }
        if (action === 'clear') {
          return await session.storageClear(tabId, frameSelector)
        }
        throw new Error(`unsupported storage action: ${action}`)
      case 'console':
        return { messages: state.consoleMessages }
      case 'errors':
        return { errors: state.pageErrors }
      case 'network':
        if (action === 'route') {
          return await network.routeRequest(tabId, url, args.abort === true, args.body)
        }
        if (action === 'unroute') {
          return await network.unrouteRequest(tabId, readStringArg(args, 'url'))
        }
        if (action === 'requests') {
          return network.listRequests(args)
        }
        if (action === 'request') {
          return network.getRequestDetail(requestId)
        }
        if (action === 'har') {
          if (subaction === 'start') {
            return await network.startHar(tabId)
          }
          if (subaction === 'stop') {
            return network.stopHar()
          }
          throw new Error(`unsupported network har action: ${subaction}`)
        }
        throw new Error(`unsupported network action: ${action}`)
      case 'set':
        if (readStringArg(args, 'type') === 'viewport') {
          return await session.setViewport(
            tabId,
            viewportWidth,
            viewportHeight,
            deviceScaleFactor,
            mobile,
          )
        }
        if (readStringArg(args, 'type') === 'offline') {
          return await session.setOffline(tabId, enabled)
        }
        if (readStringArg(args, 'type') === 'headers') {
          return await session.setHeaders(tabId, headers)
        }
        if (readStringArg(args, 'type') === 'geo') {
          return await session.setGeo(tabId, latitude, longitude, accuracy)
        }
        if (readStringArg(args, 'type') === 'media') {
          return await session.setMedia(tabId, media)
        }
        throw new Error(`unsupported set type: ${readStringArg(args, 'type')}`)
      case 'pdf':
        return await session.generatePdf(tabId)
      case 'clipboard':
        if (action === 'read') {
          return await session.clipboardRead(tabId)
        }
        if (action === 'write') {
          return await session.clipboardWrite(tabId, text)
        }
        throw new Error(`unsupported clipboard action: ${action}`)
      case 'state':
        if (action === 'save') {
          return await session.saveState(tabId, name)
        }
        if (action === 'load') {
          if (savedStateData) {
            return await session.loadState(tabId, savedStateData)
          }

          return await session.loadStateByName(tabId, name)
        }
        throw new Error(`unsupported state action: ${action}`)
      default:
        throw new Error(`unsupported command: ${command}`)
    }
  }

  return {
    handleCommand,
  }
}
