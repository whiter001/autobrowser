import { describe, expect, test } from 'bun:test'
import {
  compareBuilds,
  normalizeBuildInfo,
  readCliBuildInfo,
  type CliBuildInfo,
} from '../src/cli/build-info.js'
import { parseCli } from '../src/cli/flags.js'
import { runCli } from './command-line-test-utils.js'

function buildInfo(
  version: string | null,
  commit: string | null,
  buildTime: string | null = '2026-11-15T02:13:16.000Z',
): CliBuildInfo {
  return { version, commit, buildTime }
}

const connectedStatus = {
  relayPort: 57978,
  ipcPort: 57979,
  extensionConnected: true,
  snapshot: {
    extension: { extensionId: 'test-extension', version: '0.1.5' },
    tabs: [],
  },
}

const extensionInfo = {
  extensionId: 'test-extension',
  version: '0.1.5',
  buildTime: '2026-11-15T02:13:16.000Z',
  commit: 'a458338',
  userAgent: 'test-browser',
}

describe('cli build info', () => {
  test('reports nulls instead of failing when build-info.json is absent (dev run)', async () => {
    // `bun src/cli.ts` 没有 dist/build-info.json：诊断信息缺失不能让命令失败
    expect(await readCliBuildInfo()).toEqual({
      version: null,
      commit: null,
      buildTime: null,
    })
  })

  test('normalizes invalid build metadata to null', () => {
    expect(
      normalizeBuildInfo({ version: '0.1.5', commit: 'not-a-commit!', buildTime: 'soon' }),
    ).toEqual({ version: '0.1.5', commit: null, buildTime: null })
    expect(
      normalizeBuildInfo({
        version: '0.1.5',
        commit: 'a458338',
        buildTime: '2026-11-15T10:13:16.000+08:00',
      }).buildTime,
    ).toBeNull()
    expect(normalizeBuildInfo(null)).toEqual({ version: null, commit: null, buildTime: null })
  })
})

describe('compareBuilds', () => {
  test('treats same version and same commit as consistent', () => {
    expect(compareBuilds(buildInfo('0.1.5', 'a458338'), buildInfo('0.1.5', 'a458338'))).toEqual({
      consistent: true,
      reason: null,
      cli: '0.1.5',
      extension: '0.1.5',
      hint: null,
    })
  })

  test('flags matching versions built from different commits with both commits and repair advice', () => {
    const skew = compareBuilds(
      buildInfo('0.1.5', 'a458338'),
      buildInfo('0.1.5', 'b123456', '2026-11-16T03:00:00.000Z'),
    )

    expect(skew.consistent).toBe(false)
    expect(skew.reason).toBe('commit')
    expect(skew.hint).toContain('both 0.1.5')
    expect(skew.hint).toContain('different commits')
    expect(skew.hint).toContain('a458338')
    expect(skew.hint).toContain('b123456')
    expect(skew.hint).toContain('build:chrome')
    expect(skew.hint).toContain('extension reload')
  })

  test('never uses buildTime to decide whether two builds match', () => {
    const skew = compareBuilds(
      buildInfo('0.1.5', 'a458338', '2026-11-15T02:13:16.000Z'),
      buildInfo('0.1.5', 'a458338', '2026-11-16T03:00:00.000Z'),
    )

    expect(skew.consistent).toBe(true)
    expect(skew.reason).toBeNull()
  })

  test('flags version mismatches with the original hint', () => {
    const skew = compareBuilds(buildInfo('0.1.5', 'a458338'), buildInfo('0.1.1', 'c999999'))

    expect(skew.consistent).toBe(false)
    expect(skew.reason).toBe('version')
    expect(skew.hint).toContain('extension is 0.1.1')
    expect(skew.hint).toContain('extension reload')
  })

  test('stays inconclusive when either side lacks a version', () => {
    // 老扩展/未连接的扩展没有版本字段，宁可不判断也不能误报错配
    expect(
      compareBuilds(buildInfo('0.1.5', 'a458338'), buildInfo(null, null)).consistent,
    ).toBeNull()
    expect(compareBuilds(buildInfo(null, null), buildInfo('0.1.5', null)).consistent).toBeNull()

    const unknown = compareBuilds(buildInfo(null, null), buildInfo(null, null))
    expect(unknown.reason).toBeNull()
    expect(unknown.hint).toBeNull()
  })

  test('does not guess a commit mismatch when either side has no commit', () => {
    // 旧构建没有 commit：同版本只能认为一致，不能凭空报错配
    expect(compareBuilds(buildInfo('0.1.5', 'a458338'), buildInfo('0.1.5', null)).consistent).toBe(
      true,
    )
  })
})

describe('autobrowser version', () => {
  test('--json returns the full extension build and asks the extension for commit/buildTime', async () => {
    const result = await runCli(
      ['--json', '--server', 'http://127.0.0.1:3000', 'version'],
      undefined,
      {
        fetchImpl: async (url) => {
          if (url.endsWith('/status')) {
            return { ok: true, json: async () => connectedStatus }
          }
          return { ok: true, json: async () => ({ ok: true, result: extensionInfo }) }
        },
      },
    )

    expect(result.exitCode).toBe(0)
    const commandCall = result.fetchCalls.find((call) => call.url.endsWith('/command'))
    expect(commandCall?.body).toEqual({ command: 'extension', args: { action: 'info' } })

    const payload = JSON.parse(result.stdout)
    expect(payload.result.cli).toEqual({ version: null, commit: null, buildTime: null })
    expect(payload.result.extension).toEqual({
      version: '0.1.5',
      commit: 'a458338',
      buildTime: '2026-11-15T02:13:16.000Z',
    })
    expect(payload.result.versionSkew.consistent).toBeNull()
    expect(payload.result.versionSkew.reason).toBeNull()
  })

  test('falls back to the snapshot version when extension info fails, without failing the command', async () => {
    const result = await runCli(
      ['--json', '--server', 'http://127.0.0.1:3000', 'version'],
      undefined,
      {
        fetchImpl: async (url) => {
          if (url.endsWith('/status')) {
            return { ok: true, json: async () => connectedStatus }
          }
          throw new Error('extension did not answer')
        },
      },
    )

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.ok).toBe(true)
    expect(payload.result.extension).toEqual({
      version: '0.1.5',
      commit: null,
      buildTime: null,
    })
    expect(result.fetchCalls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:3000/status',
      'http://127.0.0.1:3000/command',
    ])
    expect(result.spawnCalls).toEqual([])
    expect(result.openCalls).toEqual([])
  })

  test('falls back to the snapshot version when an old extension returns an error or no version', async () => {
    for (const infoResponse of [
      { ok: false, error: { message: 'unknown action', code: 'BAD_COMMAND' } },
      { ok: true, result: { extensionId: 'test-extension' } },
    ]) {
      const result = await runCli(
        ['--json', '--server', 'http://127.0.0.1:3000', 'version'],
        undefined,
        {
          fetchImpl: async (url) =>
            url.endsWith('/status')
              ? { ok: true, json: async () => connectedStatus }
              : { ok: true, json: async () => infoResponse },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout).result.extension).toEqual({
        version: '0.1.5',
        commit: null,
        buildTime: null,
      })
    }
  })

  test('text mode shows version, commit and build time for both sides', async () => {
    const result = await runCli(['--server', 'http://127.0.0.1:3000', 'version'], undefined, {
      fetchImpl: async (url) => {
        if (url.endsWith('/status')) {
          return { ok: true, json: async () => connectedStatus }
        }
        return { ok: true, json: async () => ({ ok: true, result: extensionInfo }) }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('autobrowser unknown')
    expect(result.stdout).toContain('extension 0.1.5 (a458338) built 2026-11-15T02:13:16.000Z')
    expect(result.stdout).not.toContain('not connected')
  })

  test('text mode still reports a disconnected extension', async () => {
    const result = await runCli(['--server', 'http://127.0.0.1:3000', 'version'], undefined, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ ...connectedStatus, extensionConnected: false, snapshot: {} }),
      }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('extension not connected')
  })

  test('is shorthand for the version command', () => {
    expect(parseCli(['--version']).args).toEqual(['version'])
    // 命令名之后的 --json 仍按全局参数消费，不会留在位置参数里
    const explicit = parseCli(['version', '--json'])
    expect(explicit.args).toEqual(['version'])
    expect(explicit.flags.jsonExplicitlySet).toBe(true)
    expect(() => parseCli(['--totally-unknown'])).toThrow('unsupported global option')
  })
})
