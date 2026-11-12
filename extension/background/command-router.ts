import { resolveEffectiveFrameSelector, resolveTabInput } from './targeting.js'
import { createCommandQueue, type CommandExecutionContext } from './command-queue.js'
import { createBatchCommandHandler } from './command-batch.js'
import { createCommandMetaBuilder } from './command-meta.js'
import { createDiagnosticsCommandHandler } from './command-router-diagnostics.js'
import { createCommandHandlers } from './command-handlers.js'
import { createNetworkCommandHandler } from './command-router-network.js'
import { createSessionCommandHandler } from './command-router-session.js'
import { createTabsCommandHandler } from './command-router-tabs.js'
import { createWorkspaceManager } from './workspaces.js'
import type { CommandRunScope } from './command-router-context.js'
import { getCommandRequestBudgetMs } from '../../src/core/command-budget.js'
import { commandSupportsTabTarget, validateCommandArgs } from '../../src/core/command-spec.js'
import type { ExtensionControlDomain } from './extension-control.js'
import type {
  DownloadsDomain,
  FileTransferDomain,
  InitScriptDomain,
  MediaDomain,
  NetworkDomain,
  PageInputDomain,
  PageObserveDomain,
  SessionDomain,
  TracingDomain,
  VideoDomain,
  WebMcpDomain,
} from './command-domains.js'
import type {
  CommandArgs,
  CommandMessage,
  DialogState,
  ExtensionState,
  FrameSelector,
  ErrorWithCode,
  TabInput,
  TabSummary,
  TabWithId,
} from './types.js'

/** 目标 tab 存在未处理 JS 对话框时需要拒绝的命令（交互/导航/读取类）。 */
const DIALOG_BLOCKED_COMMANDS = new Set([
  'goto',
  'open',
  'eval',
  'feed',
  'screenshot',
  'click',
  'dblclick',
  'fill',
  'fillform',
  'find',
  'type',
  'highlight',
  'hover',
  'locator',
  'press',
  'keyboard',
  'focus',
  'select',
  'check',
  'uncheck',
  'scroll',
  'scrollintoview',
  'drag',
  'drop',
  'mousemove',
  'mousedown',
  'mouseup',
  'mousewheel',
  'upload',
  'back',
  'forward',
  'reload',
  'frame',
  'is',
  'get',
  'media',
  'wait',
])

interface CommandRouterDependencies {
  state: ExtensionState
  extensionControl: ExtensionControlDomain
  pageInput: PageInputDomain
  pageObserve: PageObserveDomain
  session: SessionDomain
  network: NetworkDomain
  downloads: DownloadsDomain
  fileTransfer: FileTransferDomain
  mediaDomain: MediaDomain
  initScripts: InitScriptDomain
  tracing: TracingDomain
  video: VideoDomain
  webmcp: WebMcpDomain
  listTabs: () => Promise<TabSummary[]>
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  createTab?: (url: string) => Promise<chrome.tabs.Tab | undefined>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
}

interface CommandExecutionOptions {
  skipQueue?: boolean
  request?: { id?: string; deadlineAt?: string }
  context?: CommandExecutionContext
}

/** 命令执行管线：校验、目标固定、对话框检查、队列、取消、meta 和动作日志。 */
export function createCommandRouter({
  state,
  extensionControl,
  pageInput,
  pageObserve,
  session,
  network,
  downloads,
  fileTransfer,
  mediaDomain,
  initScripts,
  tracing,
  video,
  webmcp,
  listTabs,
  getTargetTab,
  createTab,
  sendDebuggerCommand,
}: CommandRouterDependencies) {
  const commandQueue = createCommandQueue()
  const workspaceManager = createWorkspaceManager({ state, getTargetTab, createTab })
  const { handleBatchCommand } = createBatchCommandHandler(executeCommand)
  const { buildCommandMeta, attachCommandMeta } = createCommandMetaBuilder({ state, getTargetTab })
  const { handleDiagnosticsCommand } = createDiagnosticsCommandHandler({ state, tracing, video })
  const { handleNetworkCommand } = createNetworkCommandHandler({ state, network })
  const { handleSessionCommand } = createSessionCommandHandler({ state, session })
  const { handleTabsCommand } = createTabsCommandHandler({
    state,
    extensionControl,
    listTabs,
    getTargetTab,
    workspaceManager,
    commandQueue,
    cancelTrackedCommand,
    resolveCommandQueueKey,
  })
  const commandHandlers = createCommandHandlers({
    state,
    pageInput,
    pageObserve,
    webmcp,
    downloads,
    fileTransfer,
    mediaDomain,
    initScripts,
    getTargetTab,
    sendDebuggerCommand,
    handleTabsCommand,
    handleDiagnosticsCommand,
    handleNetworkCommand,
    handleSessionCommand,
    handleBatchCommand,
  })

  function cancelTrackedCommand(id: string): boolean {
    return commandQueue.cancel(id)
  }

  function readStringArg(args: CommandArgs, key: string, fallback = ''): string {
    const value = args[key]
    return typeof value === 'string' ? value : fallback
  }

  function readNumberArg(args: CommandArgs, key: string, fallback = 0): number {
    const value = args[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  function readOptionalNumberArg(args: CommandArgs, key: string): number | undefined {
    const value = args[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  function readTabInputArg(args: CommandArgs, key: string): TabInput {
    const value = args[key]
    return typeof value === 'number' || typeof value === 'string' || value == null
      ? value
      : undefined
  }

  function readFrameSelectorArg(args: CommandArgs, key: string): FrameSelector {
    return typeof args[key] === 'string' ? (args[key] as string) : null
  }

  function resolveDialogTabId(tabTarget: TabInput): number | null {
    if (typeof tabTarget === 'number') return tabTarget
    if (typeof tabTarget === 'string') {
      return state.targeting.tabIdsByHandle.get(tabTarget) ?? null
    }
    return state.targeting.targetTabId
  }

  function resolveEffectiveTargetTabId(tabTarget: TabInput): number | null {
    return resolveTabInput(state, tabTarget) ?? state.targeting.targetTabId
  }

  function resolveCommandQueueKey(tabTarget: TabInput): string {
    const tabId = resolveEffectiveTargetTabId(tabTarget)
    return typeof tabId === 'number' ? `tab:${tabId}` : 'default'
  }

  async function pinCommandTargetTabId(
    command: string,
    tabTarget: TabInput,
  ): Promise<number | null> {
    if (!commandSupportsTabTarget(command)) return null
    const resolved = resolveTabInput(state, tabTarget)
    if (typeof resolved === 'number') return resolved
    // 显式但无法解析的 handle 留到执行阶段抛 STALE_TAB_HANDLE。
    if (tabTarget != null && String(tabTarget).trim()) return null
    try {
      const tab = await getTargetTab(tabTarget)
      return typeof tab?.id === 'number' ? tab.id : null
    } catch {
      return null
    }
  }

  function createDialogBlockedError(dialog: DialogState): ErrorWithCode {
    const error = new Error(
      `page has an open ${dialog.type} dialog: ${dialog.message || '(no message)'}`,
    ) as ErrorWithCode
    error.code = 'MODAL_OPEN'
    error.suggestedAction =
      "Handle the dialog first: run 'dialog accept' to accept it, 'dialog dismiss' to dismiss it, or run 'dialog status' to inspect it."
    error.details = {
      type: dialog.type,
      message: dialog.message,
      defaultPrompt: dialog.defaultPrompt,
    }
    return error
  }

  async function assertNoOpenDialog(command: string, tabTarget: TabInput): Promise<void> {
    if (!DIALOG_BLOCKED_COMMANDS.has(command)) return
    let tabId = resolveDialogTabId(tabTarget)
    if (tabId === null && (tabTarget == null || typeof tabTarget === 'string')) {
      const tab = await getTargetTab(tabTarget)
      tabId = typeof tab?.id === 'number' ? tab.id : null
    }
    if (tabId !== null) {
      const dialog = state.session.dialogs.get(tabId)
      if (dialog) throw createDialogBlockedError(dialog)
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  }

  const CONTROL_COMMANDS = new Set([
    'extension',
    'status',
    'workspace',
    'tab.list',
    'tab.attach',
    'tab.detach',
    'tab.select',
    'tab.new',
    'tab.close',
    'target',
    'command',
  ])
  const AUTO_SNAPSHOT_COMMANDS = new Set([
    'goto',
    'open',
    'back',
    'forward',
    'reload',
    'click',
    'dblclick',
    'fill',
    'fillform',
    'type',
    'press',
    'keyboard',
    'check',
    'uncheck',
    'select',
    'drag',
    'drop',
    'mousemove',
    'mousedown',
    'mouseup',
    'mousewheel',
    'upload',
  ])

  function recordAction(
    command: string,
    request: { id?: string } | undefined,
    tabId: number | null,
    frame: string | null,
    selector: string,
    startedAt: number,
    ok: boolean,
    error: unknown,
  ): void {
    if (tabId !== null) void video.handleAction(command, tabId, frame, selector, ok).catch(() => {})
    state.session.actionLog.push({
      id: request?.id || null,
      command,
      tabId,
      frame,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ok,
      error: ok
        ? null
        : typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'Command failed',
    })
    if (state.session.actionLog.length > 500) {
      state.session.actionLog.splice(0, state.session.actionLog.length - 500)
    }
  }

  async function executeCommand(
    command: string,
    args: CommandArgs = {},
    options: CommandExecutionOptions = {},
  ) {
    let context = options.context
    const { request } = options
    context?.throwIfCancelled()
    const workspace = readStringArg(args, 'workspace').trim() || null
    if (workspace && command === 'batch' && Array.isArray(args.steps)) {
      args = {
        ...args,
        steps: args.steps.map((step) =>
          isRecord(step) && isRecord(step.args)
            ? { ...step, args: { ...step.args, workspace } }
            : step,
        ),
      }
    }
    validateCommandArgs(command, args)

    const requestedTabId = readTabInputArg(args, 'tabId')
    const handle = readTabInputArg(args, 'handle')
    const explicitTabTarget = handle || requestedTabId
    const frameSelector = readFrameSelectorArg(args, 'frame')
    const action = readStringArg(args, 'action')
    const url = readStringArg(args, 'url', 'about:blank')
    const selector = readStringArg(args, 'selector')
    const requestId = readStringArg(args, 'requestId')
    const subaction = readStringArg(args, 'subaction')
    const pageIdx = readNumberArg(args, 'pageIdx', 0)
    const pageSize = readOptionalNumberArg(args, 'pageSize')
    const limit = readOptionalNumberArg(args, 'limit')
    const cursor = readStringArg(args, 'cursor')

    // fallback note 与旧模式的全局查询口径都要用固定之前的目标。
    const targetTabIdBeforeCommand = state.targeting.targetTabId
    const legacyQueryTargetTabId = resolveEffectiveTargetTabId(explicitTabTarget)
    const networkControl =
      command === 'network' && action === 'har' && ['stop', 'status', 'recover'].includes(subaction)
    let pinnedTabId: number | null = null
    if (workspace) {
      const workspaceGlobalCommand = [
        'workspace',
        'status',
        'extension',
        'tab.list',
        'tab.new',
        'tab.attach',
        'tab.detach',
      ].includes(command)
      const workspaceTargetCommand =
        commandSupportsTabTarget(command) ||
        command === 'open' ||
        ['tab.select', 'tab.close'].includes(command) ||
        (command === 'target' && action === 'set') ||
        (command === 'command' && action === 'reset')
      if (
        !workspaceGlobalCommand &&
        workspaceTargetCommand &&
        !(command === 'window' && action === 'new')
      ) {
        if (command === 'open') {
          try {
            pinnedTabId = await workspaceManager.resolveCommandTab(
              workspace,
              command,
              args,
              explicitTabTarget,
            )
          } catch (error) {
            if ((error as ErrorWithCode).code !== 'WORKSPACE_TARGET_REQUIRED') throw error
            const created = await workspaceManager.createWorkspaceTab(workspace, url)
            const tab = isRecord(created.tab) ? created.tab : {}
            if (typeof tab.id !== 'number') throw new Error('workspace open created no target tab')
            pinnedTabId = tab.id
          }
        } else {
          pinnedTabId = await workspaceManager.resolveCommandTab(
            workspace,
            command,
            args,
            explicitTabTarget,
          )
        }
      }
    } else {
      pinnedTabId =
        CONTROL_COMMANDS.has(command) || networkControl
          ? null
          : await pinCommandTargetTabId(command, explicitTabTarget)
    }
    const tabId: TabInput = typeof pinnedTabId === 'number' ? pinnedTabId : explicitTabTarget
    const queryTargetTabId = workspace
      ? (pinnedTabId ?? legacyQueryTargetTabId)
      : legacyQueryTargetTabId

    await assertNoOpenDialog(command, tabId)

    const scope: CommandRunScope = {
      command,
      args,
      workspace,
      action,
      subaction,
      url,
      requestId,
      tabId,
      explicitTabTarget,
      frameSelector,
      queryTargetTabId,
      pageIdx,
      pageSize,
      limit,
      cursor,
    }

    async function runWithMeta() {
      context?.throwIfCancelled()
      if (workspace && pinnedTabId !== null) {
        await workspaceManager.resolveCommandTab(workspace, command, args, pinnedTabId)
      }
      await assertNoOpenDialog(command, tabId)
      const executionFrame =
        pinnedTabId === null
          ? frameSelector
          : resolveEffectiveFrameSelector(state, { id: pinnedTabId }, frameSelector) || 'top'

      const evalTabId = command === 'eval' ? pinnedTabId : null
      const terminateEval = () => {
        if (evalTabId !== null) {
          void sendDebuggerCommand(evalTabId, 'Runtime.terminateExecution', {}).catch(() => {})
        }
      }
      if (evalTabId !== null && context?.signal) {
        context.signal.addEventListener('abort', terminateEval, { once: true })
      }
      const stopLease =
        workspace && pinnedTabId !== null
          ? workspaceManager.startCommandLease(workspace, command, args, pinnedTabId)
          : () => {}
      let result: unknown
      try {
        result = await commandHandlers.handle({ scope, executionFrame, context, request })
        if (workspace && command === 'close' && args.all === true && isRecord(result)) {
          if (Array.isArray(result.tabIds)) {
            for (const id of result.tabIds) {
              if (typeof id === 'number') await workspaceManager.detach(workspace, id)
            }
          }
        }
        if (workspace && command === 'window' && action === 'new' && isRecord(result)) {
          if (typeof result.tabId === 'number')
            await workspaceManager.attach(workspace, result.tabId)
        }
      } finally {
        stopLease()
        if (evalTabId !== null) context?.signal?.removeEventListener('abort', terminateEval)
      }

      if (state.session.autoSnapshot && AUTO_SNAPSHOT_COMMANDS.has(command) && isRecord(result)) {
        const actionResult = result
        try {
          result = {
            ...result,
            snapshot: await pageObserve.snapshotTab(tabId, executionFrame),
          }
        } catch (error) {
          result = {
            ...actionResult,
            snapshotError: error instanceof Error ? error.message : String(error),
          }
        }
      }
      const metaFrame =
        command === 'frame' && typeof tabId === 'number'
          ? resolveEffectiveFrameSelector(state, { id: tabId }, null)
          : frameSelector
      const meta = await buildCommandMeta(command, args, tabId, metaFrame, {
        pinnedTabId,
        targetTabIdBeforeCommand,
      })
      const withMeta = attachCommandMeta(result, meta)
      if (workspace && isRecord(withMeta) && isRecord(withMeta.meta)) {
        return { ...withMeta, meta: { ...withMeta.meta, workspace } }
      }
      return withMeta
    }

    const runsInQueue = !options.skipQueue && !CONTROL_COMMANDS.has(command) && !networkControl
    const actionStartedAt = Date.now()
    try {
      const result = runsInQueue
        ? await commandQueue.enqueue(
            command === 'download'
              ? `download:${request?.id || crypto.randomUUID()}`
              : resolveCommandQueueKey(tabId),
            async (queueContext) => {
              context = queueContext
              return await runWithMeta()
            },
            {
              ...request,
              deadlineAt:
                request?.deadlineAt ??
                new Date(Date.now() + getCommandRequestBudgetMs(command, args)).toISOString(),
            },
          )
        : await runWithMeta()
      recordAction(
        command,
        request,
        queryTargetTabId,
        frameSelector || null,
        selector,
        actionStartedAt,
        true,
        null,
      )
      return result
    } catch (error) {
      recordAction(
        command,
        request,
        queryTargetTabId,
        frameSelector || null,
        selector,
        actionStartedAt,
        false,
        error,
      )
      throw error
    }
  }

  async function handleCommand(message: CommandMessage) {
    return await executeCommand(String(message.command || ''), message.args || {}, {
      request: {
        ...(typeof message.id === 'string' ? { id: message.id } : {}),
        ...(typeof message.deadlineAt === 'string' ? { deadlineAt: message.deadlineAt } : {}),
      },
    })
  }

  function cancelCommand(id: string): boolean {
    return cancelTrackedCommand(id)
  }

  return { handleCommand, cancelCommand }
}
