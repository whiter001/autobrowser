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
})
