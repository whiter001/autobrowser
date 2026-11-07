import { describe, expect, test } from 'bun:test'
import { runCli } from './command-line-test-utils.js'

const healthyStatus = {
  relayPort: 57978,
  ipcPort: 57979,
  extensionConnected: true,
  snapshot: {
    extension: { extensionId: 'bfccnpkjkbhceghimfjgnkigilidldep', version: '0.1.5' },
    tabs: [{ id: 11, handle: 't11', title: 'Example', url: 'https://example.com' }],
    activeTabId: 11,
    targetTabId: 11,
    pageEpochs: { 11: 1 },
  },
}

describe('doctor', () => {
  test('reports runtime, extension, connection and target checks as text', async () => {
    const result = await runCli(['doctor'], healthyStatus)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('runtime')
    expect(result.stdout).toContain('extension  ok')
    expect(result.stdout).toContain('id=bfccnpkjkbhceghimfjgnkigilidldep')
    expect(result.stdout).toContain('connection ok')
    expect(result.stdout).toContain('relay 127.0.0.1:57978')
    expect(result.stdout).toContain('target     ok')
    expect(result.stdout).toContain('t11 - Example')
  })

  test('returns structured checks with explicit --json', async () => {
    const result = await runCli(['--json', 'doctor'], healthyStatus)
    const payload = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(0)
    expect(payload.ok).toBe(true)
    expect(payload.result.checks.map((check: { name: string }) => check.name)).toEqual([
      'runtime',
      'extension',
      'connection',
      'version',
      'target',
    ])
  })

  test('reports version skew as a warning without failing the whole check', async () => {
    const result = await runCli(['doctor'], {
      ...healthyStatus,
      versionSkew: {
        consistent: false,
        cli: '2.0.0',
        extension: '1.0.0',
        hint: 'Rebuild and reload the extension.',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('version    warn  CLI 2.0.0 != extension 1.0.0')
    expect(result.stdout).toContain('Rebuild and reload the extension.')
  })

  test('explains how to repair a disconnected extension and exits non-zero', async () => {
    const result = await runCli(['doctor'], { ...healthyStatus, extensionConnected: false })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('extension  fail  not connected')
    expect(result.stdout).toContain('autobrowser connect')
    expect(result.stdout).toContain('target     fail')
  })

  test('still emits actionable checks when the local server cannot start', async () => {
    const result = await runCli(['doctor'], undefined, {
      spawnDetachedProcess: () => ({
        pid: 12345,
        unref() {},
        async waitForExit() {
          return { code: 1, signal: null }
        },
      }),
      fetchImpl: async () => {
        throw new Error('connection refused')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('runtime')
    expect(result.stdout).toContain('connection fail')
    expect(result.stdout).toContain('autobrowser server --serve')
  })
})
