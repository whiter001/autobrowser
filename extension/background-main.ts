import { CONNECTION_DIAGNOSTICS_STORAGE_KEY, DEFAULT_RELAY_PORT } from './shared.js'
import type { DiagnosticsState } from './shared.js'
import {
  debuggerAttach,
  debuggerDetach,
  debuggerSendCommand,
  storageLocalGet,
  storageLocalSet,
  tabsGet,
  tabsQuery,
} from './background/chrome.js'
import { createCommandRouter } from './background/command-router.js'
import { createConnectionRuntime } from './background/connection.js'
import { createDebuggerCommandSender } from './background/debugger-command.js'
import { createExtensionControl } from './background/extension-control.js'
import { readExtensionBuildInfo } from './background/build-info.js'
import { createDownloadsDomain } from './background/downloads.js'
import { createFileTransferDomain } from './background/file-transfer.js'
import { createFrameContext } from './background/frame-context.js'
import { createMediaDomain } from './background/media.js'
import { createNetworkDomain } from './background/network.js'
import { createInitScriptDomain } from './background/init-scripts.js'
import { createPageEvaluation } from './background/page-evaluation.js'
import { createPageInputDomain } from './background/page-input.js'
import { createPageObserveDomain } from './background/page-observe.js'
import { createSessionDomain } from './background/session.js'
import { createTracingDomain } from './background/tracing.js'
import { createVideoDomain } from './background/video.js'
import { createWebMcpDomain } from './background/webmcp.js'
import { createExtensionState } from './background/state.js'
import { createTabSessionRegistry } from './background/tab-session.js'
import {
  assertFreshElementRef,
  createStaleTabHandleError,
  getPageEpoch,
  rememberTargetTab,
  resolveTabInput,
  toTabSummary,
} from './background/targeting.js'
import type { ResolvedSelectorTarget, TabInput, TabWithId } from './background/types.js'
import { resolveAgentSelector } from '../src/core/agent-selectors.js'
import { pickFallbackTab } from '../src/core/tab-selection.js'

const DEFAULT_SERVER_PORT = DEFAULT_RELAY_PORT
const state = createExtensionState(DEFAULT_SERVER_PORT)
const tabSessions = createTabSessionRegistry({
  state,
  attach: debuggerAttach,
  detach: debuggerDetach,
  clearFrameContext: (tabId) => frameContext.clearTab(tabId),
  onAttached: async (tabId) => {
    await enableDebuggerDomains(tabId)
    await network.refreshInterceptors()
    await initScripts.replayForTab(tabId)
  },
})
const { sendDebuggerCommand } = createDebuggerCommandSender({
  ensureDebuggerAttached: tabSessions.ensureAttached,
  sendRawDebuggerCommand,
})

const downloads = createDownloadsDomain(state)

const network = createNetworkDomain({
  state,
  getTargetTab,
  sendRawDebuggerCommand,
  sendDebuggerCommand,
})

const initScripts = createInitScriptDomain({
  state,
  sendRawDebuggerCommand,
  // 用 storage.local 而非 storage.session：实测 chrome.runtime.reload() 会清掉 session 区，
  // 而重载扩展正是"升级后脚本还在不在"的主要场景；脚本本身是配置，跨浏览器会话保留也符合预期
  storage: { get: storageLocalGet, set: storageLocalSet },
})

const frameContext = createFrameContext({ state, getTargetTab, sendDebuggerCommand })
const { resolveFrameTarget, getFrameExecutionContext } = frameContext
const { evaluateInTabContext } = createPageEvaluation({
  getFrameExecutionContext,
  sendDebuggerCommand,
  clearWorldContext: frameContext.clearWorldContext,
})

const pageInput = createPageInputDomain({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  getFrameExecutionContext,
  evaluateInTabContext,
  sendDebuggerCommand,
})

const pageObserve = createPageObserveDomain({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  evaluateInTabContext,
  sendDebuggerCommand,
})

const session = createSessionDomain({
  state,
  getTargetTab,
  evaluateInTabContext,
  sendDebuggerCommand,
  storageLocalGet,
  storageLocalSet,
})

const tracing = createTracingDomain({
  getTargetTab,
  sendDebuggerCommand,
})

const video = createVideoDomain({
  getTargetTab,
  evaluateInTabContext,
  browser: {
    getMediaStreamId: async (tabId) =>
      await chrome.tabCapture.getMediaStreamId({ consumerTabId: tabId }),
    ensureOffscreen: async () => {
      if (await chrome.offscreen.hasDocument()) return
      await chrome.offscreen.createDocument({
        url: 'offscreen-recorder.html',
        reasons: ['USER_MEDIA'],
        justification: 'Record the target tab as WebM video',
      })
    },
    sendMessage: async (message) => await chrome.runtime.sendMessage(message),
    addResultListener: (listener) => {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'autobrowser.video.result') listener(message)
      })
    },
  },
})

const webmcp = createWebMcpDomain({
  getTargetTab,
  resolveFrameTarget,
  sendDebuggerCommand,
})

const fileTransfer = createFileTransferDomain({ state })
const media = createMediaDomain({ state, evaluateInTabContext })

const extensionControl = createExtensionControl({
  info: async () => {
    // 诊断信息落在 storage 里（连接状态、心跳、keepalive 计数），这里一并带出，
    // 让 CLI 侧不用 DevTools 就能判断报警链路是否在工作。
    const stored = await storageLocalGet<Record<string, unknown>>([
      CONNECTION_DIAGNOSTICS_STORAGE_KEY,
    ])
    return {
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      ...(await readExtensionBuildInfo(chrome.runtime.getURL('build-info.json'))),
      diagnostics: (stored?.[CONNECTION_DIAGNOSTICS_STORAGE_KEY] as DiagnosticsState) || null,
    }
  },
  reload: () => chrome.runtime.reload(),
  reconnect: () => connection.reconnect(),
})

const commandRouter = createCommandRouter({
  state,
  extensionControl,
  pageInput,
  pageObserve,
  session,
  network,
  downloads,
  fileTransfer,
  mediaDomain: media,
  initScripts,
  listTabs,
  getTargetTab,
  sendDebuggerCommand,
  tracing,
  video,
  webmcp,
})

const connection = createConnectionRuntime({
  state,
  network,
  fileUploads: {
    confirm: (transferId, ok, message) => fileTransfer.confirmRegistration(transferId, ok, message),
    dispose: () => fileTransfer.dispose(),
  },
  tracing,
  video,
  listTabs,
  handleCommand: commandRouter.handleCommand,
  cancelCommand: commandRouter.cancelCommand,
  sendDebuggerCommand,
  storageLocalGet,
  storageLocalSet,
  clearTabRuntimeState: tabSessions.dispose,
  detachDebugger: tabSessions.detachDebugger,
  handleDebuggerDetach: tabSessions.handleDetach,
  handlePageNavigation: tabSessions.invalidatePage,
  getDialogStatus: session.getDialogStatus,
})

async function loadTargetTab(tabId: TabInput): Promise<TabWithId | null> {
  const resolvedTabId = resolveTabInput(state, tabId)

  if (typeof resolvedTabId === 'number') {
    try {
      return await tabsGet(resolvedTabId)
    } catch {
      // 数字 tabId / 已失效 handle 指向的 tab 已关闭：统一抛机器可读的错误码，
      // 让 agent 能区分「句柄过期」与其它失败，并按 suggestedAction 重新拉取 tab 列表
      throw createStaleTabHandleError(tabId)
    }
  }

  if (tabId !== undefined && tabId !== null && String(tabId).trim()) {
    throw createStaleTabHandleError(tabId)
  }

  if (typeof state.targeting.targetTabId === 'number') {
    try {
      return await tabsGet(state.targeting.targetTabId)
    } catch {
      rememberTargetTab(state, null)
    }
  }

  const tabs = await tabsQuery({
    currentWindow: true,
  })
  // 兜底目标要排除浏览器自身页面：否则没指定 tab 时会打到扩展管理页/devtools 上
  const fallbackTab = pickFallbackTab(
    tabs
      .filter(
        (candidate): candidate is chrome.tabs.Tab & { id: number } =>
          typeof candidate.id === 'number',
      )
      .map((candidate) => ({
        ...candidate,
        active: Boolean(candidate.active),
      })),
  )
  if (!fallbackTab || typeof fallbackTab.id !== 'number') {
    return null
  }

  return await tabsGet(fallbackTab.id)
}

async function sendRawDebuggerCommand<TResult = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<TResult> {
  return await debuggerSendCommand<TResult>({ tabId }, method, params)
}

async function enableDebuggerDomains(tabId: number): Promise<void> {
  await Promise.allSettled([
    sendRawDebuggerCommand(tabId, 'Runtime.enable', {}),
    sendRawDebuggerCommand(tabId, 'Console.enable', {}),
    sendRawDebuggerCommand(tabId, 'Network.enable', {}),
    sendRawDebuggerCommand(tabId, 'Page.enable', {}),
  ])
}

async function listTabs() {
  const tabs = await tabsQuery({})
  return tabs.map((tab) => toTabSummary(state, tab))
}

async function getTargetTab(tabId: TabInput): Promise<TabWithId> {
  const tab = await loadTargetTab(tabId)
  if (!tab) {
    throw new Error('no target tab available')
  }

  rememberTargetTab(state, tab.id)
  return tab
}

async function resolveElementSelectorForTab(
  tabId: TabInput,
  selector: string,
): Promise<ResolvedSelectorTarget> {
  const tab = await getTargetTab(tabId)
  assertFreshElementRef(state, tab.id, selector)
  return {
    tab,
    pageEpoch: getPageEpoch(state, tab.id),
    resolvedSelector: resolveAgentSelector(selector),
  }
}

connection.registerChromeListeners()
downloads.registerChromeListeners()
connection.initialize()
