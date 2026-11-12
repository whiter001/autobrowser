import { tabsQuery, tabsRemove, windowsCreate } from './chrome.js'
import { createToolError } from '../../src/core/tool-error.js'
import { getPageEpoch, rememberTargetTab } from './targeting.js'
import type { CommandExecutionContext } from './command-queue.js'
import type { CommandRunScope } from './command-router-context.js'
import {
  readBooleanArg,
  readNumberArg,
  readObjectArg,
  readOptionalNumberArg,
  readOptionalStringArg,
  readStringArg,
  readStringArrayArg,
} from './command-router-context.js'
import type {
  DownloadsDomain,
  FileTransferDomain,
  InitScriptDomain,
  MediaDomain,
  PageInputDomain,
  PageObserveDomain,
  WebMcpDomain,
} from './command-domains.js'
import type { CollectFeedOptions, FindSemanticTargetOptions } from './page-observe.js'
import type {
  CommandArgs,
  ErrorWithCode,
  ExtensionState,
  FrameSelector,
  ScreenshotCaptureOptions,
  TabInput,
  TabWithId,
} from './types.js'

interface CommandHandlerInput {
  scope: CommandRunScope
  executionFrame: FrameSelector
  context?: CommandExecutionContext
  request?: { id?: string; deadlineAt?: string }
}

type CommandHandler = (input: CommandHandlerInput) => Promise<unknown>
type ScopeHandler = (scope: CommandRunScope) => Promise<unknown>

interface CommandHandlerDependencies {
  state: ExtensionState
  pageInput: PageInputDomain
  pageObserve: PageObserveDomain
  webmcp: WebMcpDomain
  downloads: DownloadsDomain
  fileTransfer: FileTransferDomain
  mediaDomain: MediaDomain
  initScripts: InitScriptDomain
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
  handleTabsCommand: ScopeHandler
  handleDiagnosticsCommand: ScopeHandler
  handleNetworkCommand: ScopeHandler
  handleSessionCommand: ScopeHandler
  handleBatchCommand: (args: CommandArgs, context?: CommandExecutionContext) => Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readFillFormFields(args: CommandArgs): Array<{ selector: string; value: string }> {
  return Array.isArray(args.fields)
    ? args.fields.filter(
        (field): field is { selector: string; value: string } =>
          isRecord(field) && typeof field.selector === 'string' && typeof field.value === 'string',
      )
    : []
}

function readScreenshotOptions(args: CommandArgs): ScreenshotCaptureOptions {
  const element = readOptionalStringArg(args, 'element')
  const format = readOptionalStringArg(args, 'format')
  const quality = readOptionalNumberArg(args, 'quality')
  return {
    full: readBooleanArg(args, 'full', false),
    annotate: readBooleanArg(args, 'annotate', false),
    ...(element ? { element } : {}),
    ...(format ? { format } : {}),
    ...(quality ? { quality } : {}),
  }
}

/** 业务命令注册表；目标固定、队列、meta 和日志由调用方的统一管线负责。 */
export function createCommandHandlers({
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
}: CommandHandlerDependencies) {
  const handlers = new Map<string, CommandHandler>()
  const register = (commands: readonly string[], handler: CommandHandler) => {
    for (const command of commands) handlers.set(command, handler)
  }

  const VALID_FIND_ACTIONS = [
    'locate',
    'click',
    'fill',
    'type',
    'hover',
    'focus',
    'check',
    'uncheck',
    'text',
  ] as const

  async function handleFindCommand(
    tabId: TabInput,
    args: CommandArgs,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const action = readStringArg(args, 'action', 'locate').trim()
    if (!VALID_FIND_ACTIONS.includes(action as (typeof VALID_FIND_ACTIONS)[number])) {
      const err = new Error(`unsupported find action: ${action}`) as ErrorWithCode
      err.code = 'INVALID_ACTION'
      err.suggestedAction = `Supported actions are: ${VALID_FIND_ACTIONS.join(', ')}.`
      throw err
    }
    const actionValue = readStringArg(args, 'value')
    const position = readStringArg(args, 'position').trim()
    const candidatesCount = Math.floor(readNumberArg(args, 'candidates', 0))
    const findOptions: FindSemanticTargetOptions = {
      strategy: readStringArg(args, 'strategy').trim(),
      role: readStringArg(args, 'role').trim(),
      query: readStringArg(args, 'query').trim(),
      name: readStringArg(args, 'name').trim(),
      exact: args.exact === true,
      requireUnique: action !== 'locate' && action !== 'text' && !position,
      allowNoMatch: action === 'locate',
      ...(position ? { position } : {}),
      ...(candidatesCount > 0 ? { candidates: candidatesCount } : {}),
    }
    const result = await pageObserve.findSemanticTarget(tabId, findOptions, frameSelector)
    context?.throwIfCancelled()
    if (findOptions.candidates && Array.isArray(result.candidates)) return result
    if (action === 'locate' && result.empty === true) return result
    const ref = result.match?.ref
    if (!ref) {
      throw createToolError('ELEMENT_NOT_FOUND', result.reason || 'semantic target ref missing', {
        ...(Array.isArray(result.candidates) && result.candidates.length > 0
          ? { details: { candidates: result.candidates.slice(0, 10) } }
          : {}),
        suggestedAction:
          'Change the query or inspect the limited candidates in details; use snapshot to refresh the current page state.',
      })
    }
    if (action === 'locate') return result
    if (action === 'click') {
      return {
        ...result,
        action,
        result: await pageInput.clickSelector(tabId, ref, frameSelector, undefined, context),
      }
    }
    if (action === 'fill') {
      return {
        ...result,
        action,
        result: await pageInput.fillSelector(tabId, ref, actionValue, frameSelector, context),
      }
    }
    if (action === 'type') {
      return {
        ...result,
        action,
        result: await pageInput.typeIntoSelector(
          tabId,
          ref,
          actionValue,
          frameSelector,
          undefined,
          context,
        ),
      }
    }
    if (action === 'hover') {
      return {
        ...result,
        action,
        result: await pageInput.hoverElement(tabId, ref, frameSelector, context),
      }
    }
    if (action === 'focus') {
      return {
        ...result,
        action,
        result: await pageInput.focusElement(tabId, ref, frameSelector, context),
      }
    }
    if (action === 'check' || action === 'uncheck') {
      return {
        ...result,
        action,
        result: await pageInput.checkElement(tabId, ref, action === 'check', frameSelector),
      }
    }
    if (action === 'text') {
      const textResult = await pageInput.getAttribute(tabId, ref, 'text', frameSelector)
      return { ...result, action, result: { found: true, value: textResult.value } }
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
    const waitGone = readBooleanArg(args, 'gone', false)

    if (waitGone && waitType !== 'text' && !waitText) {
      throw new Error('wait --gone requires --text <text>')
    }
    if (waitType === 'time' || waitMs > 0) {
      if (waitMs <= 0) {
        throw new Error('wait type "time" requires a positive ms duration (pass --ms <ms>)')
      }
      return await pageObserve.waitWithTimeout(tabId, waitMs)
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
      return await pageObserve.waitForText(tabId, waitText, timeout, frameSelector, waitGone)
    }
    if (waitType === 'load') return await pageObserve.waitForLoadEvent(tabId, timeout)
    if (waitType === 'networkidle') return await pageObserve.waitForNetworkIdle(tabId, timeout)
    if (waitType === 'fn' || waitFn) {
      return await pageObserve.waitForExpression(tabId, waitFn, timeout, frameSelector)
    }
    throw new Error(`unsupported wait type: ${waitType}`)
  }

  async function closeTabs(tabId: TabInput, closeAll: boolean, workspace: string | null) {
    if (closeAll) {
      const tabs = await tabsQuery({ currentWindow: true })
      const tabIds = workspace
        ? Array.from(state.workspaces.attachments.values())
            .filter(
              (attachment) => attachment.workspaceId === workspace && attachment.mode === 'owned',
            )
            .map((attachment) => attachment.tabId)
        : tabs.map((tab) => tab.id).filter((candidate) => typeof candidate === 'number')
      if (tabIds.length > 0) await tabsRemove(tabIds)
      if (workspace) {
        for (const id of tabIds) state.workspaces.attachments.delete(id)
        const record = state.workspaces.workspaces.get(workspace)
        if (record && tabIds.includes(record.targetTabId ?? -1)) record.targetTabId = null
      }
      return {
        closed: true,
        all: true,
        count: tabIds.length,
        ...(workspace ? { workspace, tabIds } : {}),
      }
    }
    const tab = await getTargetTab(tabId)
    await tabsRemove([tab.id])
    return { closed: true, all: false, tabId: tab.id }
  }

  async function createWindow() {
    const window = await windowsCreate({ url: 'about:blank', focused: true })
    const tabId = window?.tabs?.[0]?.id
    if (typeof tabId === 'number') rememberTargetTab(state, tabId)
    return { windowId: window?.id ?? null, tabId: tabId ?? null }
  }

  register(['extension', 'status'], async ({ scope }) => await handleTabsCommand(scope))
  register(['actions', 'tracing', 'video'], async ({ scope }) => {
    return await handleDiagnosticsCommand(scope)
  })
  register(
    [
      'workspace',
      'tab.list',
      'tab.attach',
      'tab.detach',
      'tab.select',
      'tab.new',
      'tab.close',
      'target',
      'command',
    ],
    async ({ scope }) => await handleTabsCommand(scope),
  )

  register(['webmcp'], async ({ scope, context }) => {
    const { action, tabId, frameSelector, args } = scope
    if (action === 'list') return await webmcp.list(tabId, frameSelector, context)
    if (action === 'call') {
      return await webmcp.call(
        tabId,
        frameSelector,
        readStringArg(args, 'name'),
        readObjectArg(args, 'args') || {},
        context,
      )
    }
    throw new Error(`unsupported webmcp action: ${action}`)
  })

  register(['goto', 'open'], async ({ scope }) => {
    const { args, tabId, url, frameSelector } = scope
    const navigationResult = await pageInput.navigateTo(tabId, url, {
      timeoutMs: readNumberArg(args, 'timeoutMs', 10000),
      wait: readBooleanArg(args, 'wait', true),
      waitUntil: readStringArg(args, 'waitUntil', 'domquiet'),
      settleTimeoutMs: readOptionalNumberArg(args, 'settleTimeoutMs'),
      domQuietMs: readOptionalNumberArg(args, 'domQuietMs'),
    })
    const waitFor = readOptionalStringArg(args, 'waitFor')
    if (!waitFor) return navigationResult
    const value = readStringArg(args, waitFor === 'url' ? 'waitUrl' : 'selector')
    try {
      const wait = await handleWait(
        tabId,
        {
          type: waitFor,
          timeout: readNumberArg(args, 'timeoutMs', 30000),
          ...(waitFor === 'url' ? { url: value } : { selector: value, state: 'visible' }),
        },
        frameSelector,
      )
      return {
        ...(navigationResult as Record<string, unknown>),
        wait: { ...(wait as Record<string, unknown>), type: waitFor, value, completed: true },
      }
    } catch (error) {
      const failure =
        error instanceof Error
          ? (error as ErrorWithCode)
          : (new Error(String(error)) as ErrorWithCode)
      failure.details = {
        ...(isRecord(failure.details) ? failure.details : {}),
        result: {
          ...(navigationResult as Record<string, unknown>),
          navigationResult,
          wait: { type: waitFor, value, completed: false },
        },
      }
      throw failure
    }
  })

  register(['eval'], async ({ scope }) => {
    const { args, tabId, frameSelector } = scope
    return await pageInput.evaluateScript(
      tabId,
      readStringArg(args, 'script', 'document.title'),
      frameSelector,
      readOptionalNumberArg(args, 'timeoutMs'),
      readOptionalStringArg(args, 'element'),
      readOptionalNumberArg(args, 'maxResultBytes') ??
        (args.responseFormat === 'detailed' ? undefined : 32_768),
    )
  })
  register(['locator'], async ({ scope }) => {
    return await pageInput.generateLocator(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      scope.frameSelector,
    )
  })
  register(['highlight'], async ({ scope }) => {
    const { args } = scope
    return await pageInput.highlightElement(
      scope.tabId,
      readOptionalStringArg(args, 'selector'),
      readOptionalStringArg(args, 'style'),
      readBooleanArg(args, 'hide'),
      scope.frameSelector,
    )
  })
  register(['cdp'], async ({ scope, context }) => {
    const tab = await getTargetTab(scope.tabId)
    const method = readStringArg(scope.args, 'method')
    const result = await sendDebuggerCommand(
      tab.id,
      method,
      (scope.args.params || {}) as Record<string, unknown>,
      context,
    )
    return { method, result }
  })

  register(['snapshot'], async ({ scope }) => {
    const roles = readStringArrayArg(scope.args, 'roles')
    const selector = readStringArg(scope.args, 'selector')
    return await pageObserve.snapshotTab(scope.tabId, scope.frameSelector, {
      selector: selector.trim() || undefined,
      ...(roles.length > 0 ? { roles } : {}),
      ...(readBooleanArg(scope.args, 'changed') ? { changed: true } : {}),
      ...(scope.args.limit !== undefined
        ? { limit: readOptionalNumberArg(scope.args, 'limit') }
        : {}),
      responseFormat: scope.args.responseFormat === 'detailed' ? 'detailed' : 'concise',
    })
  })
  register(['feed'], async ({ scope }) => {
    const { args } = scope
    return await pageObserve.collectFeed(
      scope.tabId,
      {
        selector: readOptionalStringArg(args, 'selector')?.trim() || 'article',
        limit: readNumberArg(args, 'limit', 30),
        dedupe: readStringArg(args, 'dedupe', 'url') as CollectFeedOptions['dedupe'],
        maxScrolls: readNumberArg(args, 'maxScrolls', 20),
        pauseMs: readNumberArg(args, 'pauseMs', 900),
        stallRounds: readNumberArg(args, 'stallRounds', 3),
      },
      scope.frameSelector,
    )
  })
  register(['search'], async ({ scope }) => {
    const { args } = scope
    return await pageObserve.searchPageText(
      scope.tabId,
      {
        query: readStringArg(args, 'query'),
        context: readNumberArg(args, 'context', 3),
        limit: readNumberArg(args, 'limit', args.responseFormat === 'detailed' ? 20 : 10),
        responseFormat: args.responseFormat === 'detailed' ? 'detailed' : 'concise',
        ...(args.startLine !== undefined ? { startLine: readNumberArg(args, 'startLine', 1) } : {}),
      },
      scope.frameSelector,
    )
  })
  register(['screenshot'], async ({ scope }) => {
    return await pageObserve.captureScreenshot(
      scope.tabId,
      readScreenshotOptions(scope.args),
      scope.frameSelector,
    )
  })

  register(['click'], async ({ scope, context }) => {
    return await pageInput.clickSelector(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      scope.frameSelector,
      readNumberArg(scope.args, 'timeoutMs', 10000),
      context,
    )
  })
  register(['dblclick'], async ({ scope, context }) => {
    return await pageInput.doubleClickSelector(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      scope.frameSelector,
      context,
    )
  })
  register(['fill'], async ({ scope, context }) => {
    return await pageInput.fillSelector(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      readStringArg(scope.args, 'value'),
      scope.frameSelector,
      context,
    )
  })
  register(['fillform'], async ({ scope, context }) => {
    return await pageInput.fillFields(
      scope.tabId,
      readFillFormFields(scope.args),
      scope.frameSelector,
      context,
    )
  })
  register(['find'], async ({ scope, context }) => {
    return await handleFindCommand(scope.tabId, scope.args, scope.frameSelector, context)
  })
  register(['type'], async ({ scope, context }) => {
    return await pageInput.typeIntoSelector(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      readStringArg(scope.args, 'value'),
      scope.frameSelector,
      readBooleanArg(scope.args, 'submit'),
      context,
    )
  })
  register(['hover'], async ({ scope, context }) => {
    return await pageInput.hoverElement(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      scope.frameSelector,
      context,
    )
  })
  register(['press'], async ({ scope, context }) => {
    return await pageInput.pressKey(scope.tabId, readStringArg(scope.args, 'key'), context)
  })
  register(['keyboard'], async ({ scope, context }) => {
    const text = readStringArg(scope.args, 'text')
    if (scope.action === 'type') {
      return await pageInput.insertTextSequentially(scope.tabId, text, context)
    }
    if (scope.action === 'inserttext') {
      return await pageInput.insertTextOnce(scope.tabId, text, context)
    }
    if (scope.action === 'keydown') return await pageInput.keyDownOnly(scope.tabId, text, context)
    if (scope.action === 'keyup') return await pageInput.keyUpOnly(scope.tabId, text, context)
    throw new Error(`unsupported keyboard action: ${scope.action}`)
  })

  register(['focus'], async ({ scope, context }) => {
    return await pageInput.focusElement(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      scope.frameSelector,
      context,
    )
  })
  register(['select'], async ({ scope }) => {
    return await pageInput.selectOption(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      readStringArg(scope.args, 'value'),
      scope.frameSelector,
    )
  })
  register(['check', 'uncheck'], async ({ scope }) => {
    return await pageInput.checkElement(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      scope.command === 'check',
      scope.frameSelector,
    )
  })
  register(['scroll'], async ({ scope, context }) => {
    const selector = readOptionalStringArg(scope.args, 'selector') || null
    return await pageInput.scrollElement(
      scope.tabId,
      selector,
      readNumberArg(scope.args, 'deltaX'),
      readNumberArg(scope.args, 'deltaY', 100),
      scope.frameSelector,
      context,
    )
  })
  register(['scrollintoview'], async ({ scope, context }) => {
    return await pageInput.scrollIntoViewSelector(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      scope.frameSelector,
      context,
    )
  })
  register(['drag'], async ({ scope, context }) => {
    return await pageInput.dragElement(
      scope.tabId,
      readStringArg(scope.args, 'start'),
      readStringArg(scope.args, 'end'),
      scope.frameSelector,
      context,
    )
  })
  register(['drop'], async ({ scope, context }) => {
    return await pageInput.dropData(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      (scope.args.data || {}) as Record<string, string>,
      (scope.args.files || []) as Array<{ name: string; mimeType: string; dataBase64: string }>,
      scope.frameSelector,
      context,
    )
  })
  register(['mousemove'], async ({ scope, context }) => {
    return await pageInput.mouseMove(
      scope.tabId,
      readNumberArg(scope.args, 'x'),
      readNumberArg(scope.args, 'y'),
      context,
    )
  })
  register(['mousedown', 'mouseup'], async ({ scope, context }) => {
    return await pageInput.mouseButton(
      scope.tabId,
      scope.command === 'mousedown',
      readStringArg(scope.args, 'button', 'left'),
      context,
    )
  })
  register(['mousewheel'], async ({ scope, context }) => {
    return await pageInput.mouseWheel(
      scope.tabId,
      readNumberArg(scope.args, 'deltaX'),
      readNumberArg(scope.args, 'deltaY'),
      context,
    )
  })
  register(['upload'], async ({ scope, context }) => {
    return await pageInput.uploadFiles(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      readStringArrayArg(scope.args, 'files'),
      scope.frameSelector,
      context,
    )
  })

  register(['back'], async ({ scope }) => await pageInput.navigateBack(scope.tabId))
  register(['forward'], async ({ scope }) => await pageInput.navigateForward(scope.tabId))
  register(['reload'], async ({ scope }) => {
    const { args, tabId, frameSelector } = scope
    const reloadResult = await pageInput.reloadPage(tabId, {
      timeoutMs: readOptionalNumberArg(args, 'timeoutMs'),
      waitUntil: readOptionalStringArg(args, 'waitUntil'),
    })
    const waitFor = readOptionalStringArg(args, 'waitFor')
    const timeout = readNumberArg(args, 'timeoutMs', 30000)
    if (waitFor === 'url') {
      return {
        ...(reloadResult as Record<string, unknown>),
        wait: await pageObserve.waitForUrl(
          tabId,
          readStringArg(args, 'url'),
          timeout,
          frameSelector,
        ),
      }
    }
    if (waitFor === 'selector') {
      return {
        ...(reloadResult as Record<string, unknown>),
        wait: await pageObserve.waitForSelectorState(
          tabId,
          readStringArg(args, 'selector'),
          'visible',
          timeout,
          frameSelector,
        ),
      }
    }
    if (waitFor) throw new Error('reload waitFor must be url or selector')
    return reloadResult
  })
  register(['close'], async ({ scope }) => {
    return await closeTabs(scope.tabId, readBooleanArg(scope.args, 'all'), scope.workspace)
  })
  register(['window'], async ({ scope }) => {
    if (scope.action === 'new') return await createWindow()
    throw new Error(`unsupported window action: ${scope.action}`)
  })
  register(['frame'], async ({ scope }) => {
    return await pageInput.switchToFrame(scope.tabId, readStringArg(scope.args, 'selector'))
  })
  register(['is'], async ({ scope }) => {
    return await pageInput.checkIsState(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      readStringArg(scope.args, 'state', 'visible'),
      scope.frameSelector,
    )
  })
  register(['get'], async ({ scope }) => {
    return await pageInput.getAttribute(
      scope.tabId,
      readStringArg(scope.args, 'selector'),
      readStringArg(scope.args, 'attr', 'text'),
      scope.frameSelector,
    )
  })

  register(
    ['dialog', 'cookies', 'storage', 'set', 'pdf', 'clipboard', 'state'],
    async ({ scope }) => {
      return await handleSessionCommand(scope)
    },
  )
  register(['downloads'], async ({ scope }) => {
    if (scope.action === 'clear') return downloads.clearDownloads()
    return scope.limit === undefined && !scope.cursor
      ? downloads.listDownloads(scope.pageIdx, scope.pageSize)
      : downloads.listDownloads(scope.pageIdx, scope.pageSize, scope.limit, scope.cursor)
  })
  register(['download'], async ({ scope, context, request }) => {
    return await fileTransfer.download({
      url: scope.url,
      retries: readOptionalNumberArg(scope.args, 'retries'),
      retryDelayMs: readOptionalNumberArg(scope.args, 'retryDelayMs'),
      ...(typeof request?.id === 'string' ? { requestId: request.id } : {}),
      ...(typeof request?.deadlineAt === 'string' ? { deadlineAt: request.deadlineAt } : {}),
      context,
    })
  })
  register(['media'], async ({ scope, executionFrame, context }) => {
    const { args, tabId } = scope
    if (typeof tabId !== 'number') throw new Error('media list requires a resolved tab')
    const waitFor = readOptionalStringArg(args, 'waitFor')
    const wait = waitFor
      ? {
          selector: waitFor,
          completed: true,
          result: await handleWait(
            tabId,
            {
              type: 'selector',
              selector: waitFor,
              state: 'visible',
              timeout: readNumberArg(args, 'timeoutMs', 30000),
            },
            executionFrame,
          ),
        }
      : undefined
    const mediaEpoch = readOptionalNumberArg(args, 'mediaEpoch')
    if (mediaEpoch !== undefined && mediaEpoch !== getPageEpoch(state, tabId)) {
      throw Object.assign(new Error('media epoch changed; collect again'), {
        code: 'STALE_MEDIA_STATE',
      })
    }
    const result = await mediaDomain.list(
      tabId,
      executionFrame,
      {
        resolve: readBooleanArg(args, 'resolve'),
        selector: readOptionalStringArg(args, 'selector') ?? null,
        includeBackground: readBooleanArg(args, 'includeBackground'),
      },
      context,
    )
    return { ...result, ...(wait ? { wait } : {}) }
  })
  register(['wait'], async ({ scope }) => {
    return await handleWait(scope.tabId, scope.args, scope.frameSelector)
  })
  register(['console', 'errors'], async ({ scope }) => await handleDiagnosticsCommand(scope))
  register(['batch'], async ({ scope, context }) => await handleBatchCommand(scope.args, context))
  register(['script'], async ({ scope }) => {
    const { action, args } = scope
    if (action === 'add') return await initScripts.addScript(readStringArg(args, 'source'))
    if (action === 'list') return await initScripts.listScripts()
    if (action === 'remove') {
      if (readBooleanArg(args, 'all')) return await initScripts.removeAllScripts()
      const scriptId = readStringArg(args, 'id')
      if (!scriptId) throw new Error('script remove requires an id or --all')
      return await initScripts.removeScript(scriptId)
    }
    throw new Error(`unsupported script action: ${action}`)
  })
  register(['network'], async ({ scope }) => await handleNetworkCommand(scope))

  async function handle(input: CommandHandlerInput): Promise<unknown> {
    const handler = handlers.get(input.scope.command)
    if (!handler) throw new Error(`unsupported command: ${input.scope.command}`)
    return await handler(input)
  }

  return { handle, commands: [...handlers.keys()] }
}
