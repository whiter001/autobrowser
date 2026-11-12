import { describe, expect, test } from 'bun:test'
import { runCli } from './command-line-test-utils.js'

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
    const previousWorkspace = process.env.AUTOBROWSER_WORKSPACE
    const previousCaller = process.env.AUTOBROWSER_CALLER_ID
    process.env.AUTOBROWSER_WORKSPACE = 'auto'
    process.env.AUTOBROWSER_CALLER_ID = 'workspace-cli-test'
    try {
      const first = await runCli(['workspace', 'current'])
      const second = await runCli(['workspace', 'current'])
      const firstWorkspace = first.fetchCalls[0].body?.args?.workspace
      expect(firstWorkspace).toMatch(/^ws_[0-9a-f]{32}$/)
      expect(second.fetchCalls[0].body?.args?.workspace).toBe(firstWorkspace)
    } finally {
      if (previousWorkspace === undefined) delete process.env.AUTOBROWSER_WORKSPACE
      else process.env.AUTOBROWSER_WORKSPACE = previousWorkspace
      if (previousCaller === undefined) delete process.env.AUTOBROWSER_CALLER_ID
      else process.env.AUTOBROWSER_CALLER_ID = previousCaller
    }
  })

  test('rejects an invalid workspace id before dispatch', async () => {
    const result = await runCli(['--workspace', 'not valid', 'snapshot'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stdout).toContain('invalid workspace id')
  })
})
