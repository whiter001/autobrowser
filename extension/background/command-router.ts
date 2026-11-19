import {
  recordElementRefFrame,
  resolveEffectiveFrameSelector,
  resolveElementRefFrameForRefs,
  resolveTabInput,
} from './targeting.js'
import { isAgentElementRef } from '../../src/core/agent-selectors.js'
import {
  createCommandQueue,
  type CommandExecutionContext,
  type CommandQueueStorage,
} from './command-queue.js'
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
  commandQueueStorage?: CommandQueueStorage
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
}

interface CommandExecutionOptions {
  skipQueue?: boolean
  request?: { id?: string; deadlineAt?: string; requestedAt?: string; receivedAt?: string }
  context?: CommandExecutionContext
}

// 结果遍历必须有界：快照/查找正常只有数百个节点，但异常时不能因为深层结构或循环引用卡住命令。
const ELEMENT_REF_SCAN_NODE_LIMIT = 5000
const ELEMENT_REF_SCAN_DEPTH_LIMIT = 8

/** 命令参数里可能携带 @e 引用的字段；fields 只取前 100 项，避免超长表单拖慢路由。 */
function collectElementRefsFromArgs(args: CommandArgs): string[] {
  const refs: string[] = []
  for (const key of ['selector', 'element', 'start', 'end']) {
    const value = args[key]
    if (typeof value === 'string') refs.push(value)
  }
  if (Array.isArray(args.fields)) {
    for (const field of args.fields.slice(0, 100)) {
      if (field && typeof field === 'object' && !Array.isArray(field)) {
        const selector = (field as Record<string, unknown>).selector
        if (typeof selector === 'string') refs.push(selector)
      }
    }
  }
  return refs
}

/** 收集结果对象中任意层级的元素 ref；只认 ref 字段，网络短引用 rN / frame ref 不会误入。 */
function collectElementRefsFromResult(value: unknown): string[] {
  const refs = new Set<string>()
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let visited = 0

  while (stack.length > 0 && visited < ELEMENT_REF_SCAN_NODE_LIMIT) {
    const current = stack.pop()!
    visited += 1
    const node = current.value
    if (!node || typeof node !== 'object') continue
    if (seen.has(node)) continue
    seen.add(node)
    if (current.depth >= ELEMENT_REF_SCAN_DEPTH_LIMIT) continue

    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object' && stack.length < ELEMENT_REF_SCAN_NODE_LIMIT) {
          stack.push({ value: item, depth: current.depth + 1 })
        }
      }
      continue
    }

    for (const [key, item] of Object.entries(node)) {
      if (key === 'ref' && typeof item === 'string') {
        const ref = item.trim()
        if (isAgentElementRef(ref)) refs.add(ref)
        continue
      }
      if (item && typeof item === 'object' && stack.length < ELEMENT_REF_SCAN_NODE_LIMIT) {
        stack.push({ value: item, depth: current.depth + 1 })
      }
    }
  }

  return [...refs]
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
  commandQueueStorage,
  sendDebuggerCommand,
}: CommandRouterDependencies) {
  const commandQueue = createCommandQueue({ storage: commandQueueStorage })
  const workspaceManager = createWorkspaceManager({ state, getTargetTab, createTab, listTabs })
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
    createTab,
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

  /**
   * 显式 --frame 永远优先；没有显式 frame 时，已登记的 @e 引用按它被观察到的文档路由，
   * 不再沿用 selectedFrames（切换 frame 后同号 ref 可能来自另一个文档）。
   * 主框架必须传 'top'：null/空串会被下游回退成 selectedFrames。
   * 多个 ref 指向不同文档时 fail closed：执行前抛错，绝不退回当前 frame 误操作。
   */
  function resolveCommandFrameSelector(
    tabId: number | null,
    args: CommandArgs,
    frameSelector: FrameSelector,
  ): FrameSelector {
    if (typeof frameSelector === 'string' && frameSelector.trim()) return frameSelector
    if (typeof tabId !== 'number') return frameSelector
    const resolution = resolveElementRefFrameForRefs(state, tabId, collectElementRefsFromArgs(args))
    if (resolution.kind === 'conflict') {
      const error = new Error(
        'element refs in this command were observed in different frames; one command cannot act across frames',
      ) as ErrorWithCode
      error.code = 'INVALID_COMMAND_ARGS'
      error.suggestedAction =
        'Run the action one frame at a time, pass an explicit --frame for each step, then snapshot again before retrying.'
      error.details = { field: 'frame', reason: 'element refs resolve to different frames' }
      throw error
    }
    return resolution.kind === 'frame' ? (resolution.frame ?? 'top') : frameSelector
  }

  /** 把 snapshot/find 结果里出现的 ref 记到实际执行 frame，供后续命令按来源路由 */
  function indexResultElementRefs(
    tabId: number,
    frameSelector: FrameSelector,
    value: unknown,
  ): void {
    for (const ref of collectElementRefsFromResult(value)) {
      recordElementRefFrame(state, tabId, ref, frameSelector)
    }
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
    const autoAttachDisabled = args.autoAttach === false
    if (command === 'batch' && Array.isArray(args.steps) && (workspace || autoAttachDisabled)) {
      // 外层 workspace / --no-auto-attach 必须压过 step 自身的 args，否则步骤能绕开归属或重新开启自动认领
      const stepOverrides: CommandArgs = {}
      if (workspace) stepOverrides.workspace = workspace
      if (autoAttachDisabled) stepOverrides.autoAttach = false
      args = {
        ...args,
        steps: args.steps.map((step) => {
          if (typeof step === 'string') return { command: step, args: { ...stepOverrides } }
          if (!isRecord(step) || (step.args !== undefined && !isRecord(step.args))) return step
          return {
            ...step,
            args: { ...(isRecord(step.args) ? step.args : {}), ...stepOverrides },
          }
        }),
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
    let autoAttachedTabId: number | null = null
    // 自动认领只在该命令的首次 resolve 时报告；后续 lease/重试的 resolve 不再重复标记
    const trackAutoAttachment = (tabId: number): number => {
      if (workspace && workspaceManager.consumeAutoAttachment(workspace, tabId)) {
        autoAttachedTabId = tabId
      }
      return tabId
    }
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
            pinnedTabId = trackAutoAttachment(
              await workspaceManager.resolveCommandTab(workspace, command, args, explicitTabTarget),
            )
          } catch (error) {
            if ((error as ErrorWithCode).code !== 'WORKSPACE_TARGET_REQUIRED') throw error
            const created = await workspaceManager.createWorkspaceTab(workspace, url)
            const tab = isRecord(created.tab) ? created.tab : {}
            if (typeof tab.id !== 'number') throw new Error('workspace open created no target tab')
            pinnedTabId = tab.id
          }
        } else {
          pinnedTabId = trackAutoAttachment(
            await workspaceManager.resolveCommandTab(workspace, command, args, explicitTabTarget),
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

    // 入队时的 raw frame 只作为缺省值；真正的来源解析推迟到 runWithMeta（队列内、执行前）。
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
    // 供 actionLog 使用：记录本次实际执行解析出的 frame，中途抛错则保持 raw 值
    let executedFrameSelector: FrameSelector = frameSelector

    async function runWithMeta() {
      context?.throwIfCancelled()
      if (workspace && pinnedTabId !== null) {
        await workspaceManager.resolveCommandTab(workspace, command, args, pinnedTabId)
      }
      await assertNoOpenDialog(command, tabId)
      // 同 tab 的 snapshot/find 可能就在本命令排队等待期间更新了 ref 来源，必须此时再解析一次。
      const routedFrameSelector = resolveCommandFrameSelector(pinnedTabId, args, frameSelector)
      executedFrameSelector = routedFrameSelector
      const effectiveScope: CommandRunScope = { ...scope, frameSelector: routedFrameSelector }
      const executionFrame =
        pinnedTabId === null
          ? routedFrameSelector
          : resolveEffectiveFrameSelector(state, { id: pinnedTabId }, routedFrameSelector) || 'top'

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
        result = await commandHandlers.handle({
          scope: effectiveScope,
          executionFrame,
          context,
          request,
        })
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

      // 观察结果里的 ref 只有登记了来源，后续 click/fill/get 才能在 selectedFrames 漂移后回到正确文档。
      if (typeof pinnedTabId === 'number' && (command === 'snapshot' || command === 'find')) {
        indexResultElementRefs(pinnedTabId, executionFrame, result)
      }

      if (state.session.autoSnapshot && AUTO_SNAPSHOT_COMMANDS.has(command) && isRecord(result)) {
        const actionResult = result
        try {
          const snapshot = await pageObserve.snapshotTab(tabId, executionFrame)
          if (typeof pinnedTabId === 'number') {
            indexResultElementRefs(pinnedTabId, executionFrame, snapshot)
          }
          result = {
            ...result,
            snapshot,
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
          : routedFrameSelector
      const meta = await buildCommandMeta(command, args, tabId, metaFrame, {
        pinnedTabId,
        targetTabIdBeforeCommand,
        autoAttached: autoAttachedTabId !== null,
      })
      const withMeta = attachCommandMeta(result, meta)
      if (workspace && isRecord(withMeta) && isRecord(withMeta.meta)) {
        return {
          ...withMeta,
          meta: {
            ...withMeta.meta,
            workspace,
            ...(autoAttachedTabId !== null ? { autoAttached: true, autoAttachedTabId } : {}),
          },
        }
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
              // 只记录命令名和所属 workspace，命令参数可能含 URL/脚本/selector，不能进入历史
              command,
              workspace,
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
        executedFrameSelector || null,
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
        executedFrameSelector || null,
        selector,
        actionStartedAt,
        false,
        error,
      )
      throw error
    }
  }

  async function handleCommand(message: CommandMessage & { requestedAt?: unknown }) {
    // receivedAt 在这里生成：它与 requestedAt/deadlineAt/enqueuedAt/startedAt 一起
    // 把 relay→扩展接收→入队→执行→完成拆成可分别度量的区段。
    const requestedAt = typeof message.requestedAt === 'string' ? message.requestedAt : undefined
    return await executeCommand(String(message.command || ''), message.args || {}, {
      request: {
        ...(typeof message.id === 'string' ? { id: message.id } : {}),
        ...(typeof message.deadlineAt === 'string' ? { deadlineAt: message.deadlineAt } : {}),
        ...(requestedAt ? { requestedAt } : {}),
        receivedAt: new Date().toISOString(),
      },
    })
  }

  function cancelCommand(id: string): boolean {
    return cancelTrackedCommand(id)
  }

  return { handleCommand, cancelCommand }
}
