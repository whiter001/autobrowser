import { clearRemovedTabId } from '../../src/core/tab-selection.js'
import {
  clearRemovedPageEpoch,
  clearRemovedTabHandle,
  clearSelectedFrame,
  createStaleTabHandleError,
  invalidatePageRefs,
} from './targeting.js'
import type { ExtensionState } from './types.js'

interface TabSessionDependencies {
  state: ExtensionState
  attach: (target: { tabId: number }, requiredVersion: string) => Promise<void>
  detach: (target: { tabId: number }) => Promise<void>
  onAttached: (tabId: number) => Promise<void>
  clearFrameContext: (tabId: number) => void
}

interface TabSessionRecord {
  attachPromise: Promise<void> | null
  disposed: boolean
}

/** 每个 tab 的 CDP 生命周期唯一所有者；全局 target/handle 清理由 dispose 一并收口。 */
export function createTabSessionRegistry({
  state,
  attach,
  detach,
  onAttached,
  clearFrameContext,
}: TabSessionDependencies) {
  const sessions = new Map<number, TabSessionRecord>()

  function getSession(tabId: number): TabSessionRecord {
    let session = sessions.get(tabId)
    if (!session) {
      session = { attachPromise: null, disposed: false }
      sessions.set(tabId, session)
    }
    return session
  }

  async function ensureAttached(tabId: number): Promise<void> {
    if (state.targeting.attachedTabs.has(tabId)) return
    const session = getSession(tabId)
    if (session.disposed) throw createStaleTabHandleError(tabId)
    if (session.attachPromise) return await session.attachPromise

    const attachPromise = (async () => {
      try {
        await attach({ tabId }, '1.3')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('already attached')) throw error
      }
      if (session.disposed) {
        await detach({ tabId }).catch(() => {})
        throw createStaleTabHandleError(tabId)
      }
      state.targeting.attachedTabs.add(tabId)
      await onAttached(tabId)
    })()
    session.attachPromise = attachPromise
    try {
      await attachPromise
    } finally {
      if (session.attachPromise === attachPromise) session.attachPromise = null
    }
  }

  async function detachDebugger(tabId: number): Promise<void> {
    if (!state.targeting.attachedTabs.has(tabId)) return
    try {
      await detach({ tabId })
    } catch (error) {
      console.warn('failed to detach debugger from tab', tabId, error)
    }
    state.targeting.attachedTabs.delete(tabId)
  }

  function handleDetach(tabId: number): void {
    state.targeting.attachedTabs.delete(tabId)
    const session = sessions.get(tabId)
    if (session) session.attachPromise = null
  }

  function invalidatePage(tabId: number): void {
    invalidatePageRefs(state, tabId)
    clearFrameContext(tabId)
  }

  function dispose(tabId: number): void {
    const session = sessions.get(tabId)
    if (session) session.disposed = true
    sessions.delete(tabId)
    clearSelectedFrame(state, tabId)
    state.targeting.targetTabId = clearRemovedTabId(state.targeting.targetTabId, tabId)
    clearRemovedTabHandle(state, tabId)
    clearRemovedPageEpoch(state, tabId)
    state.session.dialogs.delete(tabId)
    state.session.emulation.delete(tabId)
    state.session.mediaEmulation.delete(tabId)
    clearFrameContext(tabId)
  }

  return { ensureAttached, detachDebugger, handleDetach, invalidatePage, dispose }
}
