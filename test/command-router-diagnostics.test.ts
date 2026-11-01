import { describe, expect, test } from 'bun:test'
import { createMinimalRouter } from './command-router.test.js'

describe('diagnostics and automatic snapshots', () => {
  test('records successful and failed actions without argument values', async () => {
    const { router, state } = createMinimalRouter()
    await router.handleCommand({ command: 'click', args: { selector: '#safe' }, id: 'command-1' })
    await expect(
      router.handleCommand({ command: 'click', args: { selector: '#missing' }, id: 'command-2' }),
    ).rejects.toMatchObject({ code: 'STALE_REFERENCE' })
    const timeline = await router.handleCommand({ command: 'actions', args: { action: 'list' } })
    expect(timeline).toMatchObject({
      actions: [
        { id: 'command-1', command: 'click', ok: true },
        { id: 'command-2', command: 'click', ok: false },
      ],
    })
    expect(JSON.stringify(timeline)).not.toContain('#safe')
    expect(JSON.stringify(timeline)).not.toContain('#missing')
    expect(state.session.actionLog).toHaveLength(3)
    await expect(
      router.handleCommand({ command: 'actions', args: { action: 'clear' } }),
    ).resolves.toMatchObject({
      cleared: true,
      count: 3,
    })
  })

  test('attaches snapshots only after enabled actions and preserves results on snapshot failure', async () => {
    const { router, state } = createMinimalRouter()
    await router.handleCommand({ command: 'set', args: { type: 'auto-snapshot', enabled: true } })
    expect(state.session.autoSnapshot).toBe(true)
    const clicked = await router.handleCommand({ command: 'click', args: { selector: '#ok' } })
    expect(clicked).toMatchObject({ found: true, snapshot: { snapshotId: 'snapshot-1' } })
    await expect(
      router.handleCommand({ command: 'snapshot', args: {} }),
    ).resolves.not.toHaveProperty('snapshot.snapshotId')
  })

  test('returns snapshotError without replacing the successful action', async () => {
    const { router } = createMinimalRouter({
      snapshotTab: async () => {
        throw new Error('snapshot failed')
      },
    })
    await router.handleCommand({ command: 'set', args: { type: 'auto-snapshot', enabled: true } })
    await expect(
      router.handleCommand({ command: 'click', args: { selector: '#ok' } }),
    ).resolves.toMatchObject({
      found: true,
      snapshotError: 'snapshot failed',
    })
  })

  test('forwards tracing lifecycle actions', async () => {
    const { router, tracingCalls } = createMinimalRouter()
    await router.handleCommand({ command: 'tracing', args: { action: 'start' } })
    await router.handleCommand({ command: 'tracing', args: { action: 'status' } })
    await router.handleCommand({ command: 'tracing', args: { action: 'stop' } })
    expect(tracingCalls.map((call) => call.action)).toEqual(['start', 'status', 'stop'])
  })

  test('forwards video lifecycle and non-blocking action callouts', async () => {
    const { router, state, videoCalls } = createMinimalRouter()
    state.targeting.targetTabId = 1
    await router.handleCommand({ command: 'video', args: { action: 'start', maxDurationMs: 1000 } })
    await router.handleCommand({
      command: 'video',
      args: { action: 'chapter', title: 'Chapter', description: 'Details', durationMs: 500 },
    })
    await router.handleCommand({
      command: 'video',
      args: { action: 'show-actions', durationMs: 600, highlightStyle: '2px solid red' },
    })
    await router.handleCommand({ command: 'click', args: { selector: '#ok' } })
    await router.handleCommand({ command: 'video', args: { action: 'hide-actions' } })
    await router.handleCommand({ command: 'video', args: { action: 'stop' } })
    expect(
      videoCalls.filter((call) => call.action !== 'handle-action').map((call) => call.action),
    ).toEqual(['start', 'chapter', 'show-actions', 'hide-actions', 'stop'])
    expect(
      videoCalls.some((call) => call.action === 'handle-action' && call.args[0] === 'click'),
    ).toBe(true)
  })

  test('forwards WebMCP list and call targets and object args', async () => {
    const { router, webmcpCalls } = createMinimalRouter()
    await router.handleCommand({ command: 'webmcp', args: { action: 'list', frame: '@f1' } })
    await router.handleCommand({
      command: 'webmcp',
      args: { action: 'call', name: 'lookup', args: { id: 42 }, frame: 'frame-id' },
    })
    expect(webmcpCalls[0]?.args.slice(0, 2)).toEqual([1, '@f1'])
    expect(webmcpCalls[1]?.args.slice(0, 4)).toEqual([1, 'frame-id', 'lookup', { id: 42 }])
  })
})
