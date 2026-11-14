import { describe, expect, test } from 'bun:test'
import { resolveInvocation } from '../src/cli/invocation.js'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

/** 临时改写 AUTOBROWSER_WORKSPACE；runCli 保持 preserveWorkspaceEnv 时才不会被测试工具覆盖。 */
async function withWorkspaceEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AUTOBROWSER_WORKSPACE
  if (value === undefined) delete process.env.AUTOBROWSER_WORKSPACE
  else process.env.AUTOBROWSER_WORKSPACE = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.AUTOBROWSER_WORKSPACE
    else process.env.AUTOBROWSER_WORKSPACE = previous
  }
}

async function withCallerId<T>(callerId: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AUTOBROWSER_CALLER_ID
  process.env.AUTOBROWSER_CALLER_ID = callerId
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.AUTOBROWSER_CALLER_ID
    else process.env.AUTOBROWSER_CALLER_ID = previous
  }
}

describe('workspace CLI context', () => {
  test('forwards an explicit workspace to page commands', async () => {
    const result = await runCli(['--workspace', 'ai-a', 'snapshot'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'snapshot',
      args: { workspace: 'ai-a', responseFormat: 'concise' },
    })
  })

  test('routes attach, detach and workspace release', async () => {
    const attached = await runCli(['--workspace', 'ai-a', 'tab', 'attach', 't12', '--readonly'])
    expect(attached.fetchCalls[0].body).toMatchObject({
      command: 'tab.attach',
      args: { workspace: 'ai-a', handle: 't12', readonly: true },
    })

    const detached = await runCli(['--workspace', 'ai-a', 'tab', 'detach', 't12'])
    expect(detached.fetchCalls[0].body).toMatchObject({
      command: 'tab.detach',
      args: { workspace: 'ai-a', handle: 't12' },
    })

    const released = await runCli(['--workspace', 'ai-a', 'workspace', 'release', 'ai-old'])
    expect(released.fetchCalls[0].body).toMatchObject({
      command: 'workspace',
      args: { workspace: 'ai-a', action: 'release', workspaceId: 'ai-old' },
    })
  })

  test('open creates a workspace target while goto keeps navigation semantics', async () => {
    const opened = await runCli(['--workspace', 'ai-a', 'open', 'https://example.com'])
    expect(opened.fetchCalls[0].body).toMatchObject({
      command: 'open',
      args: { workspace: 'ai-a', url: 'https://example.com' },
    })

    const navigated = await runCli(['--workspace', 'ai-a', 'goto', 'https://example.com'])
    expect(navigated.fetchCalls[0].body).toMatchObject({ command: 'goto' })
  })

  test('auto mode derives a stable workspace from the injected caller identity', async () => {
    const previousCaller = process.env.AUTOBROWSER_CALLER_ID
    process.env.AUTOBROWSER_CALLER_ID = 'workspace-cli-test'
    try {
      const first = await withWorkspaceEnv('auto', () =>
        runCli(['workspace', 'current'], undefined, { preserveWorkspaceEnv: true }),
      )
      const second = await withWorkspaceEnv('auto', () =>
        runCli(['workspace', 'current'], undefined, { preserveWorkspaceEnv: true }),
      )
      const firstWorkspace = first.fetchCalls[0].body?.args?.workspace
      expect(firstWorkspace).toMatch(/^ws_[0-9a-f]{32}$/)
      expect(second.fetchCalls[0].body?.args?.workspace).toBe(firstWorkspace)
    } finally {
      if (previousCaller === undefined) delete process.env.AUTOBROWSER_CALLER_ID
      else process.env.AUTOBROWSER_CALLER_ID = previousCaller
    }
  })

  test('defaults to auto mode when neither the flag nor the env var is set', async () => {
    await withCallerId('workspace-cli-default', async () => {
      const first = await withWorkspaceEnv(undefined, () =>
        runCli(['snapshot'], undefined, { preserveWorkspaceEnv: true }),
      )
      // 空环境变量等同未设置，仍走默认 auto
      const second = await withWorkspaceEnv('', () =>
        runCli(['snapshot'], undefined, { preserveWorkspaceEnv: true }),
      )

      const firstWorkspace = first.fetchCalls[0].body?.args?.workspace
      expect(firstWorkspace).toMatch(/^ws_[0-9a-f]{32}$/)
      expect(second.fetchCalls[0].body?.args?.workspace).toBe(firstWorkspace)
    })
  })

  test('--no-workspace disables workspace even when the env var says auto', async () => {
    const result = await withWorkspaceEnv('auto', () =>
      runCli(['--no-workspace', 'snapshot'], undefined, { preserveWorkspaceEnv: true }),
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body?.args).not.toHaveProperty('workspace')
  })

  test('AUTOBROWSER_WORKSPACE=off disables workspace case-insensitively', async () => {
    const result = await withWorkspaceEnv('OFF', () =>
      runCli(['snapshot'], undefined, { preserveWorkspaceEnv: true }),
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body?.args).not.toHaveProperty('workspace')
  })

  test('rejects --no-workspace combined with --workspace before dispatching', async () => {
    const result = await runCli(['--workspace', 'ai-a', '--no-workspace', 'snapshot'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.code).toBe('CLI_INVALID_ARGUMENT')
  })

  test('an explicit workspace overrides AUTOBROWSER_WORKSPACE=off', async () => {
    const result = await withWorkspaceEnv('off', () =>
      runCli(['--workspace', 'ai-a', 'snapshot'], undefined, { preserveWorkspaceEnv: true }),
    )

    expect(result.fetchCalls[0].body).toMatchObject({
      command: 'snapshot',
      args: { workspace: 'ai-a' },
    })
  })

  test('does not enable the default workspace for WebDriver engines', async () => {
    await withCallerId('workspace-cli-firefox', async () => {
      const invocation = await withWorkspaceEnv(undefined, () =>
        resolveInvocation(['--engine', 'firefox', 'snapshot']),
      )
      expect(invocation.flags.workspace).toBeNull()

      // 显式 workspace 在 WebDriver 下保持原来的报错行为
      await expect(
        resolveInvocation(['--engine', 'firefox', '--workspace', 'ai-a', 'snapshot']),
      ).rejects.toThrow('only supported by the Chromium extension')
    })
  })

  test('rejects an invalid workspace id before dispatch', async () => {
    const result = await runCli(['--workspace', 'not valid', 'snapshot'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stdout).toContain('invalid workspace id')
  })
})

describe('workspace groups CLI', () => {
  test('status is the default mode and sends no enabled flag', async () => {
    for (const argv of [
      ['workspace', 'groups'],
      ['workspace', 'groups', 'status'],
    ]) {
      const result = await runCli(argv)

      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls[0].body).toEqual({
        command: 'workspace',
        args: { action: 'groups' },
      })
    }
  })

  test('on and off map to a boolean enabled flag', async () => {
    const on = await runCli(['workspace', 'groups', 'on'])
    expect(on.fetchCalls[0].body).toEqual({
      command: 'workspace',
      args: { action: 'groups', enabled: true },
    })

    const off = await runCli(['workspace', 'groups', 'off'])
    expect(off.fetchCalls[0].body).toEqual({
      command: 'workspace',
      args: { action: 'groups', enabled: false },
    })
  })

  test('works without a workspace because the switch is profile-wide', async () => {
    const result = await runCli(['--no-workspace', 'workspace', 'groups', 'off'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'workspace',
      args: { action: 'groups', enabled: false },
    })
  })

  test('rejects an invalid mode or extra arguments before dispatch', async () => {
    for (const argv of [
      ['workspace', 'groups', 'maybe'],
      ['workspace', 'groups', 'on', 'extra'],
      ['workspace', 'groups', 'status', 'extra'],
    ]) {
      const result = await runCli(argv)

      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(cliErrorPayload(result.stdout).error.code).toBe('CLI_INVALID_ARGUMENT')
    }
  })
})
