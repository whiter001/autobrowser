import { describe, expect, test } from 'bun:test'
import {
  resolveAutomaticWorkspaceId,
  WORKSPACE_IDENTITY_UNAVAILABLE,
  WorkspaceIdentityError,
} from '../src/cli/caller-identity.js'
import type {
  ProcessInfo,
  ProcessQuery,
  ResolveWorkspaceIdOptions,
} from '../src/cli/caller-identity.js'

const WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{16,}$/

function makeTreeQuery(map: Record<number, ProcessInfo | null>): ProcessQuery {
  return async (pid: number) => map[pid] ?? null
}

function trustedHost(pid: number, startTime: string): ProcessInfo {
  return {
    pid,
    ppid: 1,
    startTime,
    name: 'code',
    commandLine: '/usr/share/code/code --type=watcher',
  }
}

function autobrowserProcess(pid: number, ppid: number): ProcessInfo {
  return {
    pid,
    ppid,
    startTime: 'Mon Jan 1 09:00:00 2024',
    name: 'node',
    commandLine: 'autobrowser click #field',
  }
}

function shellProcess(pid: number, ppid: number, name = 'bash'): ProcessInfo {
  return { pid, ppid, startTime: 'Mon Jan 1 08:00:00 2024', name, commandLine: name }
}

describe('resolveAutomaticWorkspaceId', () => {
  test('uses AUTOBROWSER_CALLER_ID when set and keeps it stable', async () => {
    const options: ResolveWorkspaceIdOptions = { callerId: 'ai-host-42', getEnv: () => ({}) }

    const first = await resolveAutomaticWorkspaceId(options)
    const second = await resolveAutomaticWorkspaceId(options)

    expect(first).toBe(second)
    expect(first).toMatch(WORKSPACE_ID_PATTERN)
  })

  test('treats an empty AUTOBROWSER_CALLER_ID as unset and falls back to the process tree', async () => {
    const options: ResolveWorkspaceIdOptions = {
      callerId: '',
      queryProcess: makeTreeQuery({
        1000: autobrowserProcess(1000, 900),
        900: trustedHost(900, 'Mon Jan 1 10:00:00 2024'),
      }),
      getCurrentPid: () => 1000,
      getEnv: () => ({ WT_SESSION: 's1' }),
    }

    const id = await resolveAutomaticWorkspaceId(options)
    expect(id).toMatch(WORKSPACE_ID_PATTERN)
  })

  test('produces a stable id for the same trusted ancestor across calls', async () => {
    const map = {
      1000: autobrowserProcess(1000, 900),
      900: trustedHost(900, 'Mon Jan 1 10:00:00 2024'),
    }
    const options: ResolveWorkspaceIdOptions = {
      queryProcess: makeTreeQuery(map),
      getCurrentPid: () => 1000,
      getEnv: () => ({ WT_SESSION: 's1' }),
    }

    const a = await resolveAutomaticWorkspaceId(options)
    const b = await resolveAutomaticWorkspaceId(options)

    expect(a).toBe(b)
    expect(a).toMatch(WORKSPACE_ID_PATTERN)
  })

  test('distinguishes the same PID with different start times (PID reuse)', async () => {
    const base = { ppid: 1, name: 'code', commandLine: '/usr/share/code/code' }
    const early = makeTreeQuery({
      1000: autobrowserProcess(1000, 900),
      900: { ...base, pid: 900, startTime: 'Mon Jan 1 10:00:00 2024' },
    })
    const late = makeTreeQuery({
      1000: autobrowserProcess(1000, 900),
      900: { ...base, pid: 900, startTime: 'Mon Jan 1 11:00:00 2024' },
    })
    const env = { WT_SESSION: 's1' }

    const earlyId = await resolveAutomaticWorkspaceId({
      queryProcess: early,
      getCurrentPid: () => 1000,
      getEnv: () => env,
    })
    const lateId = await resolveAutomaticWorkspaceId({
      queryProcess: late,
      getCurrentPid: () => 1000,
      getEnv: () => env,
    })

    expect(earlyId).not.toBe(lateId)
  })

  test('skips the transient shell between autobrowser and the host', async () => {
    // autobrowser -> bash -> code：shell 被跳过，最终身份应落在 code 上，
    // 与 autobrowser 直接挂在 code 下得到同一结果。
    const viaShell = makeTreeQuery({
      1000: autobrowserProcess(1000, 200),
      200: shellProcess(200, 900),
      900: trustedHost(900, 'Mon Jan 1 10:00:00 2024'),
    })
    const direct = makeTreeQuery({
      1000: autobrowserProcess(1000, 900),
      900: trustedHost(900, 'Mon Jan 1 10:00:00 2024'),
    })
    const env = { WT_SESSION: 's1' }

    const a = await resolveAutomaticWorkspaceId({
      queryProcess: viaShell,
      getCurrentPid: () => 1000,
      getEnv: () => env,
    })
    const b = await resolveAutomaticWorkspaceId({
      queryProcess: direct,
      getCurrentPid: () => 1000,
      getEnv: () => env,
    })

    expect(a).toBe(b)
  })

  test('throws WORKSPACE_IDENTITY_UNAVAILABLE when no trusted ancestor exists', async () => {
    // autobrowser -> bash -> 根（pid 1 查不到），没有可信祖先
    const map = {
      1000: autobrowserProcess(1000, 200),
      200: shellProcess(200, 1),
      1: null,
    }
    const options: ResolveWorkspaceIdOptions = {
      queryProcess: makeTreeQuery(map),
      getCurrentPid: () => 1000,
      getEnv: () => ({}),
    }

    let caught: unknown
    try {
      await resolveAutomaticWorkspaceId(options)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(WorkspaceIdentityError)
    const error = caught as WorkspaceIdentityError
    expect(error.code).toBe(WORKSPACE_IDENTITY_UNAVAILABLE)
    expect(typeof error.suggestedAction).toBe('string')
    expect(error.suggestedAction.length).toBeGreaterThan(0)
  })

  test('throws WORKSPACE_IDENTITY_UNAVAILABLE when the process query fails', async () => {
    const failing: ProcessQuery = () => Promise.reject(new Error('ps: command not found'))
    const options: ResolveWorkspaceIdOptions = {
      queryProcess: failing,
      getCurrentPid: () => 1000,
      getEnv: () => ({}),
      timeoutMs: 500,
    }

    let caught: unknown
    try {
      await resolveAutomaticWorkspaceId(options)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(WorkspaceIdentityError)
    expect((caught as WorkspaceIdentityError).code).toBe(WORKSPACE_IDENTITY_UNAVAILABLE)
  })

  test('does not hang when the process query never resolves (timeout guard)', async () => {
    const hanging: ProcessQuery = () => new Promise<ProcessInfo | null>(() => {})
    const options: ResolveWorkspaceIdOptions = {
      queryProcess: hanging,
      getCurrentPid: () => 1000,
      getEnv: () => ({}),
      timeoutMs: 50,
    }

    const start = Date.now()
    let caught: unknown
    try {
      await resolveAutomaticWorkspaceId(options)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(WorkspaceIdentityError)
    expect((caught as WorkspaceIdentityError).code).toBe(WORKSPACE_IDENTITY_UNAVAILABLE)
    // 整体兜底超时必须在远小于默认 2s 内触发，证明不会挂死
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
