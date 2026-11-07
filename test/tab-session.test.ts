import { describe, expect, test } from 'bun:test'
import { createExtensionState } from '../extension/background/state.js'
import { createTabSessionRegistry } from '../extension/background/tab-session.js'

function createHarness() {
  const state = createExtensionState(57978)
  const clearedFrames: number[] = []
  let attachCount = 0
  let initializedCount = 0
  let releaseAttach!: () => void
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve
  })
  const registry = createTabSessionRegistry({
    state,
    attach: async () => {
      attachCount += 1
      await attachGate
    },
    detach: async () => {},
    onAttached: async () => {
      initializedCount += 1
    },
    clearFrameContext: (tabId) => clearedFrames.push(tabId),
  })
  return {
    state,
    registry,
    clearedFrames,
    releaseAttach: () => releaseAttach(),
    counts: () => ({ attachCount, initializedCount }),
  }
}

describe('tab session lifecycle', () => {
  test('deduplicates concurrent attach and initialization', async () => {
    const h = createHarness()
    const first = h.registry.ensureAttached(7)
    const second = h.registry.ensureAttached(7)
    h.releaseAttach()
    await Promise.all([first, second])

    expect(h.counts()).toEqual({ attachCount: 1, initializedCount: 1 })
    expect(h.state.targeting.attachedTabs.has(7)).toBe(true)
    await h.registry.ensureAttached(7)
    expect(h.counts()).toEqual({ attachCount: 1, initializedCount: 1 })
  })

  test('navigation invalidates refs, selected frame and isolated worlds together', () => {
    const h = createHarness()
    h.state.targeting.selectedFrames.set(7, '#child')
    const initialEpoch = h.state.targeting.pageEpochs.get(7) || 1

    h.registry.invalidatePage(7)

    expect(h.state.targeting.pageEpochs.get(7)).toBe(initialEpoch + 1)
    expect(h.state.targeting.selectedFrames.has(7)).toBe(false)
    expect(h.clearedFrames).toEqual([7])
  })

  test('dispose clears all per-tab runtime state', () => {
    const h = createHarness()
    h.state.targeting.targetTabId = 7
    h.state.targeting.selectedFrames.set(7, '#child')
    h.state.targeting.pageEpochs.set(7, 3)
    h.state.session.dialogs.set(7, {
      open: true,
      type: 'confirm',
      message: 'continue?',
      defaultPrompt: '',
      url: null,
      openedAt: new Date().toISOString(),
    })
    h.state.session.emulation.set(7, { offline: true })
    h.state.session.mediaEmulation.set(7, { media: 'dark', features: {} })
    h.state.targeting.tabHandles.set(7, 't7')
    h.state.targeting.tabIdsByHandle.set('t7', 7)

    h.registry.dispose(7)

    expect(h.state.targeting.targetTabId).toBeNull()
    expect(h.state.targeting.selectedFrames.has(7)).toBe(false)
    expect(h.state.targeting.pageEpochs.has(7)).toBe(false)
    expect(h.state.targeting.tabHandles.has(7)).toBe(false)
    expect(h.state.targeting.tabIdsByHandle.has('t7')).toBe(false)
    expect(h.state.session.dialogs.has(7)).toBe(false)
    expect(h.state.session.emulation.has(7)).toBe(false)
    expect(h.state.session.mediaEmulation.has(7)).toBe(false)
    expect(h.clearedFrames).toEqual([7])
  })

  test('an attach finishing after dispose cannot resurrect the tab', async () => {
    const h = createHarness()
    const pending = h.registry.ensureAttached(7)
    h.registry.dispose(7)
    h.releaseAttach()

    await expect(pending).rejects.toMatchObject({ code: 'STALE_TAB_HANDLE' })
    expect(h.state.targeting.attachedTabs.has(7)).toBe(false)
  })
})
