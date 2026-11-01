import { describe, expect, test } from 'bun:test'
import { formatStatusSummary } from '../src/cli/commands/server.js'

describe('server status summary', () => {
  test('includes page epochs and tab handles in raw output', () => {
    const summary = formatStatusSummary({
      relayPort: 57978,
      ipcPort: 57979,
      startedAt: '2026-05-18T10:00:00.000Z',
      extensionConnected: true,
      snapshot: {
        tabs: [
          {
            id: 11,
            handle: 't1',
            title: 'List page',
          },
          {
            id: 22,
            handle: 't2',
            title: 'Detail page',
          },
        ],
        activeTabId: 11,
        targetTabId: 22,
        pageEpochs: {
          11: 4,
          22: 7,
        },
      },
    })

    expect(summary).toContain('autobrowser status')
    expect(summary).toContain('relay: http://127.0.0.1:57978')
    expect(summary).toContain('ipc: http://127.0.0.1:57979')
    expect(summary).toContain('extension: connected')
    expect(summary).toContain('active: t1 - List page')
    expect(summary).toContain('target: t2 - Detail page')
    expect(summary).toContain('page epochs:')
    expect(summary).toContain('  t1 (11): 4')
    expect(summary).toContain('  t2 (22): 7')
  })

  test('brief mode collapses per-tab page epochs into a single line', () => {
    const summary = formatStatusSummary(
      {
        relayPort: 57978,
        ipcPort: 57979,
        startedAt: '2026-05-18T10:00:00.000Z',
        extensionConnected: true,
        snapshot: {
          tabs: [
            { id: 11, handle: 't1', title: 'List page' },
            { id: 22, handle: 't2', title: 'Detail page' },
          ],
          activeTabId: 11,
          targetTabId: 22,
          pageEpochs: { 11: 4, 22: 7 },
        },
      },
      true,
    )

    expect(summary).toContain('page epochs: 2 tabs')
    expect(summary).not.toContain('  t1 (11): 4')
    expect(summary).not.toContain('  t2 (22): 7')
    // brief 仍保留核心连接与目标信息
    expect(summary).toContain('extension: connected')
    expect(summary).toContain('active: t1 - List page')
    expect(summary).toContain('target: t2 - Detail page')
  })

  test('collapses restored epochs into one line while the extension is offline', () => {
    // 服务重启会恢复 epochs，但此时标签可能早就不在了，逐条列出会误导调用方。
    const summary = formatStatusSummary({
      relayPort: 57978,
      ipcPort: 57979,
      extensionConnected: false,
      snapshot: { tabs: [], pageEpochs: { 11: 1, 22: 1 } },
    })

    expect(summary).toContain('page epochs: 2 restored from last session (extension offline)')
    expect(summary).not.toContain('  tab 11 (11): 1')
    expect(summary).not.toContain('  tab 22 (22): 1')
  })

  test('lists only live tabs and summarizes stale epochs when connected', () => {
    const summary = formatStatusSummary({
      relayPort: 57978,
      ipcPort: 57979,
      extensionConnected: true,
      snapshot: {
        tabs: [{ id: 11, handle: 't1', title: 'List page' }],
        pageEpochs: { 11: 4, 99: 2 },
      },
    })

    expect(summary).toContain('  t1 (11): 4')
    expect(summary).not.toContain('  tab 99 (99): 2')
    expect(summary).toContain('+1 stale (tab closed or from previous session)')
  })

  test('brief mode handles an empty page epochs map', () => {
    const summary = formatStatusSummary(
      {
        relayPort: 57978,
        ipcPort: 57979,
        startedAt: '2026-05-18T10:00:00.000Z',
        extensionConnected: false,
        snapshot: { tabs: [], pageEpochs: {} },
      },
      true,
    )

    expect(summary).not.toContain('page epochs')
  })
})
