import { describe, expect, test } from 'bun:test'
import {
  ambientTabMeta,
  createMinimalRouter,
  EMPTY_META,
  explicitTabMeta,
  openConfirmDialog,
  singlePageInfo,
} from './command-router.test.js'

describe('command router meta context', () => {
  test('attaches target tab context to tab-target command results', async () => {
    const { router } = createMinimalRouter()

    const result = await router.handleCommand({
      command: 'goto',
      args: { tabId: 1, url: 'https://example.com' },
    })

    expect(result).toEqual({
      navigated: true,
      url: 'https://example.com',
      meta: explicitTabMeta({ url: 'https://example.com' }),
    })
  })

  test('attaches all-null meta to commands without page context', async () => {
    const { router } = createMinimalRouter()

    const status = await router.handleCommand({ command: 'status' })
    expect(status).toEqual({ connected: true, tabs: [], meta: EMPTY_META })

    const list = await router.handleCommand({ command: 'tab.list' })
    expect(list).toEqual({
      tabs: [],
      total: 0,
      pagination: singlePageInfo(0),
      meta: EMPTY_META,
    })
  })

  // 基线旧竞态：snapshot 已执行，但 meta 的 tab lookup 尚未返回时后继 frame 切换。
  for (const explicitFrame of [undefined, '#explicit', 'top']) {
    test(`snapshot metadata stays with its executed frame during a gated tab lookup (${explicitFrame})`, async () => {
      let releaseMeta!: () => void
      let enteredMeta!: () => void
      let enteredFollower!: () => void
      const metaGate = new Promise<void>((resolve) => {
        releaseMeta = resolve
      })
      const metaEntered = new Promise<void>((resolve) => {
        enteredMeta = resolve
      })
      const followerEntered = new Promise<void>((resolve) => {
        enteredFollower = resolve
      })
      let gateNextLookup = false
      let metadataWaiting = false
      const { router, state } = createMinimalRouter({
        getTargetTab: async () => {
          if (gateNextLookup) {
            gateNextLookup = false
            metadataWaiting = true
            enteredMeta()
            await metaGate
          } else if (metadataWaiting) enteredFollower()
          return { id: 1 }
        },
        snapshotTab: async (_tab, frame) => {
          const executedFrame =
            frame === 'top' ? null : frame || state.targeting.selectedFrames.get(1) || null
          gateNextLookup = true
          return { executedFrame }
        },
      })
      state.targeting.selectedFrames.set(1, '#frameA')
      const snapshot = router.handleCommand({
        command: 'snapshot',
        args: { tabId: 1, ...(explicitFrame ? { frame: explicitFrame } : {}) },
      })
      await metaEntered
      const follower = router.handleCommand({ command: 'frame', args: { selector: '#frameB' } })
      await followerEntered
      // 给后继命令完整的调度机会；它应停留在同 tab 队列，不能越过 metadata。
      await Bun.sleep(5)
      expect(state.targeting.selectedFrames.get(1)).toBe('#frameA')
      releaseMeta()
      const result = await snapshot
      const expected = explicitFrame === 'top' ? null : explicitFrame || '#frameA'
      expect(result).toMatchObject({ executedFrame: expected, meta: { frame: expected } })
      expect(await follower).toMatchObject({ meta: { frame: '#frameB' } })
      expect(
        await router.handleCommand({ command: 'frame', args: { tabId: 1, selector: 'top' } }),
      ).toMatchObject({ meta: { frame: null } })
    })
  }

  test('resolves effective frame selector into meta', async () => {
    const { router } = createMinimalRouter()

    // 'top' 归一化为 null
    const top = await router.handleCommand({
      command: 'snapshot',
      args: { tabId: 1, frame: 'top' },
    })
    expect(top).toMatchObject({ meta: { frame: null } })
  })

  test('resolves selected frame into meta when no explicit frame is given', async () => {
    const { router, state } = createMinimalRouter()
    state.targeting.selectedFrames.set(1, '@f1')

    const result = await router.handleCommand({
      command: 'snapshot',
      args: { tabId: 1 },
    })
    expect(result).toMatchObject({
      meta: { tabHandle: 't1', tabId: 1, frame: '@f1', pageEpoch: 1 },
    })
  })

  test('keeps a successful result even when target tab lookup fails', async () => {
    const { router } = createMinimalRouter({
      getTargetTab: async () => {
        throw new Error('tab gone')
      },
    })

    const result = await router.handleCommand({
      command: 'goto',
      args: { tabId: 1, url: 'https://example.com' },
    })

    expect(result).toEqual({
      navigated: true,
      url: 'https://example.com',
      meta: { ...EMPTY_META, url: 'https://example.com' },
    })
  })

  test('uses the fresh result url for meta when the tab snapshot is stale', async () => {
    // 导航命令返回时 tabsGet 可能还没反映新 URL，buildCommandMeta 会拿到旧值；
    // meta.url 必须以命令结果体里的 url 为准
    const { router } = createMinimalRouter({
      getTargetTab: async () => ({ id: 1, url: 'https://stale.example.com' }) as never,
    })

    const result = await router.handleCommand({
      command: 'goto',
      args: { tabId: 1, url: 'https://new.example.com' },
    })

    expect(result).toEqual({
      navigated: true,
      url: 'https://new.example.com',
      meta: explicitTabMeta({ url: 'https://new.example.com' }),
    })
  })
})

describe('command router meta dialog/emulation/target', () => {
  test('echoes an open dialog in meta', async () => {
    const { router, state } = createMinimalRouter()
    const dialog = openConfirmDialog(1)
    state.session.dialogs.set(1, dialog)

    const result = (await router.handleCommand({ command: 'console' })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta.dialog).toEqual({
      type: dialog.type,
      message: dialog.message,
      openedAt: dialog.openedAt,
    })
  })

  test('does not attach a dialog field when no dialog is open', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({ command: 'console' })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta).not.toHaveProperty('dialog')
  })

  test('echoes active emulation overrides in meta', async () => {
    const { router, state } = createMinimalRouter()
    state.session.emulation.set(1, { viewport: true, offline: true, headers: ['x-api-key'] })

    const result = (await router.handleCommand({ command: 'snapshot', args: { tabId: 1 } })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta.emulation).toEqual({
      viewport: true,
      offline: true,
      headers: ['x-api-key'],
    })
  })

  test('does not attach an emulation field without active overrides', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({ command: 'snapshot', args: { tabId: 1 } })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta).not.toHaveProperty('emulation')
  })

  test('target is explicit when tabId is given and omits the note', async () => {
    const { router } = createMinimalRouter()

    const result = (await router.handleCommand({ command: 'snapshot', args: { tabId: 1 } })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta.target).toEqual({ tabId: 1, handle: 't1', explicit: true })
  })

  test('target omits the note when the ambient target already matches', async () => {
    const { router, state } = createMinimalRouter()
    // 无显式指定，但当前 targetTabId 与解析结果一致：不是兜底选择
    state.targeting.targetTabId = 1

    const result = (await router.handleCommand({ command: 'snapshot' })) as {
      meta: Record<string, unknown>
    }

    expect(result.meta).toEqual(ambientTabMeta())
  })
})
