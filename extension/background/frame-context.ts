import {
  AGENT_FRAME_REF_ATTRIBUTE,
  formatAgentFrameRef,
  resolveAgentFrameSelector,
} from '../../src/core/agent-handles.js'
import { buildDeepDomTraversalHelpersSource } from './deep-dom.js'
import { unwrapEvaluationResult } from './page-evaluation.js'
import { assertFreshFrameRef, getPageEpoch, resolveEffectiveFrameSelector } from './targeting.js'
import type { CommandExecutionContext } from './command-queue.js'
import type {
  ExtensionState,
  FrameExecutionContext,
  FrameSelector,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  TabInput,
  TabWithId,
} from './types.js'

const FRAME_WORLD_NAME = 'autobrowser-frame'
const PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE = buildDeepDomTraversalHelpersSource()

interface FrameTargetEvaluation {
  refValue: string | null
  src: string | null
  left: number
  top: number
  width: number
  height: number
  x: number
  y: number
}

interface FrameContextDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
}

/** 管理 frame 定位和 isolated world；缓存按 tab 统一失效，避免导航或关标签后复用旧上下文。 */
export function createFrameContext({
  state,
  getTargetTab,
  sendDebuggerCommand,
}: FrameContextDependencies) {
  const frameWorldContextCache = new Map<string, { epoch: number; contextId: number }>()

  async function resolveFrameSelectorForTab(
    tabId: TabInput,
    selector: string,
  ): Promise<ResolvedSelectorTarget> {
    const tab = await getTargetTab(tabId)
    assertFreshFrameRef(state, tab.id, selector)
    return {
      tab,
      pageEpoch: getPageEpoch(state, tab.id),
      resolvedSelector: resolveAgentFrameSelector(selector),
    }
  }

  async function resolveFrameTarget(
    tabId: TabInput,
    selector: string,
  ): Promise<ResolvedFrameTarget> {
    const { tab, pageEpoch, resolvedSelector } = await resolveFrameSelectorForTab(tabId, selector)
    const evaluation = await sendDebuggerCommand<{ result: unknown }>(tab.id, 'Runtime.evaluate', {
      expression: `(() => {
        ${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

        const root = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!root) return null;
        const frame = root.tagName === 'IFRAME' ? root : deepQuerySelector(root, 'iframe');
        if (!frame) return null;
        const rect = frame.getBoundingClientRect();
        const refValue = frame.getAttribute(${JSON.stringify(AGENT_FRAME_REF_ATTRIBUTE)});
        return {
          src: frame.src || null,
          refValue: refValue || null,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    const target = unwrapEvaluationResult<FrameTargetEvaluation>(evaluation.result)
    if (!target) {
      throw new Error(`frame not found: ${selector}`)
    }

    await sendDebuggerCommand(tab.id, 'DOM.enable', {})
    const location = await sendDebuggerCommand<{ frameId?: string }>(
      tab.id,
      'DOM.getNodeForLocation',
      {
        x: Math.round(target.x),
        y: Math.round(target.y),
        ignorePointerEventsNone: true,
      },
    )
    if (!location.frameId) {
      throw new Error(`frame is not ready: ${selector}`)
    }

    return {
      tab,
      frameId: location.frameId,
      selector,
      ref: target.refValue
        ? formatAgentFrameRef(Number(String(target.refValue).slice(1)), pageEpoch)
        : null,
      src: target.src,
      pageEpoch,
      left: Number(target.left || 0),
      top: Number(target.top || 0),
      width: Number(target.width || 0),
      height: Number(target.height || 0),
    }
  }

  async function getFrameExecutionContext(
    tabId: TabInput,
    frameSelector: FrameSelector,
  ): Promise<FrameExecutionContext> {
    const tab = await getTargetTab(tabId)
    const selector = resolveEffectiveFrameSelector(state, tab, frameSelector)
    if (!selector) {
      return { tab, executionContextId: null }
    }

    const frame = await resolveFrameTarget(tab.id, selector)
    const worldCacheKey = `${tab.id}:${frame.frameId}`
    const cachedWorld = frameWorldContextCache.get(worldCacheKey)
    if (cachedWorld && cachedWorld.epoch === frame.pageEpoch) {
      return {
        tab,
        executionContextId: cachedWorld.contextId,
        worldCacheKey,
        worldFromCache: true,
      }
    }

    await sendDebuggerCommand(tab.id, 'Page.enable', {})
    const isolatedWorld = await sendDebuggerCommand<{ executionContextId?: number | null }>(
      tab.id,
      'Page.createIsolatedWorld',
      {
        frameId: frame.frameId,
        worldName: FRAME_WORLD_NAME,
      },
    )
    const executionContextId = isolatedWorld.executionContextId ?? null
    if (executionContextId !== null) {
      frameWorldContextCache.set(worldCacheKey, {
        epoch: frame.pageEpoch,
        contextId: executionContextId,
      })
    }
    return {
      tab,
      executionContextId,
      worldCacheKey,
      worldFromCache: false,
    }
  }

  function clearWorldContext(key: string): void {
    frameWorldContextCache.delete(key)
  }

  function clearTab(tabId: number): void {
    for (const key of frameWorldContextCache.keys()) {
      if (key.startsWith(`${tabId}:`)) frameWorldContextCache.delete(key)
    }
  }

  return {
    resolveFrameTarget,
    getFrameExecutionContext,
    clearWorldContext,
    clearTab,
  }
}
