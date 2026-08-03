import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CommandResponse } from '../src/cli/client.js'
import { AutobrowserMcpServer } from '../src/cli/mcp.js'

const KNOWN_TOOL_NAMES = [
  'navigate',
  'snapshot',
  'search',
  'find',
  'click',
  'dblclick',
  'hover',
  'fill',
  'type',
  'press',
  'scroll',
  'get',
  'wait',
  'screenshot',
  'tab_list',
  'tab_new',
  'tab_select',
  'tab_close',
  'eval',
]

interface RecordedCall {
  command: string
  args: Record<string, unknown>
}

type MockRequestCommand = {
  (command: string, args: Record<string, unknown>): Promise<CommandResponse>
  calls: RecordedCall[]
}

function recordingRequestCommand(payload: CommandResponse): MockRequestCommand {
  const calls: RecordedCall[] = []
  const mock = (async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args })
    return payload
  }) as MockRequestCommand
  mock.calls = calls
  return mock
}

function okResult(result: unknown): CommandResponse {
  return { ok: true, result }
}

describe('AutobrowserMcpServer.listTools', () => {
  test('exposes all 19 tools with object-typed input schemas', () => {
    const server = new AutobrowserMcpServer({ requestCommand: async () => okResult({}) })
    const tools = server.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(KNOWN_TOOL_NAMES)
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties).toBeTypeOf('object')
    }
  })

  test('adds tab/frame properties only where the underlying command supports them', () => {
    const server = new AutobrowserMcpServer({ requestCommand: async () => okResult({}) })
    const tools = new Map(server.listTools().map((tool) => [tool.name, tool]))

    const clickProps = tools.get('click')!.inputSchema.properties as Record<string, unknown>
    expect(clickProps.tab).toBeDefined()
    expect(clickProps.frame).toBeDefined()

    const navigateProps = tools.get('navigate')!.inputSchema.properties as Record<string, unknown>
    expect(navigateProps.tab).toBeDefined()
    expect(navigateProps.frame).toBeUndefined()

    const tabSelectProps = tools.get('tab_select')!.inputSchema.properties as Record<
      string,
      unknown
    >
    expect(tabSelectProps.tab).toBeUndefined()
    expect(tabSelectProps.frame).toBeUndefined()
  })
})

describe('AutobrowserMcpServer.callTool', () => {
  test('click forwards selector, tab -> tabId, and frame', async () => {
    const mock = recordingRequestCommand(okResult({ clicked: true }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const result = await server.callTool('click', {
      selector: '#submit',
      tab: 't2',
      frame: '@f1',
    })

    expect(result.isError).toBeFalsy()
    expect(mock.calls).toEqual([
      { command: 'click', args: { selector: '#submit', tabId: 't2', frame: '@f1' } },
    ])
    expect(result.structuredContent).toEqual({ clicked: true })
  })

  test('navigate maps to goto and injects tabId but not frame', async () => {
    const mock = recordingRequestCommand(okResult({ url: 'https://example.com' }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const result = await server.callTool('navigate', { url: 'https://example.com', tab: 't1' })

    expect(result.isError).toBeFalsy()
    expect(mock.calls).toEqual([
      { command: 'goto', args: { url: 'https://example.com', tabId: 't1' } },
    ])
  })

  test('snapshot maps target to selector and passes roles array', async () => {
    const mock = recordingRequestCommand(okResult({ elements: [] }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('snapshot', {
      target: '@e4',
      roles: ['button', 'link'],
    })

    expect(mock.calls).toEqual([
      {
        command: 'snapshot',
        args: { roles: ['button', 'link'], selector: '@e4' },
      },
    ])
  })

  test('wait infers type from url/text/fn/ms and defaults to selector', async () => {
    const mock = recordingRequestCommand(okResult({ waited: true }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('wait', { url: 'https://example.com/**' })
    await server.callTool('wait', { text: 'Done', gone: true, timeout: 5000 })
    await server.callTool('wait', { ms: 250 })
    await server.callTool('wait', { selector: '#list', state: 'hidden' })

    expect(mock.calls).toEqual([
      {
        command: 'wait',
        args: { type: 'url', url: 'https://example.com/**' },
      },
      {
        command: 'wait',
        args: {
          type: 'text',
          text: 'Done',
          gone: true,
          timeout: 5000,
        },
      },
      { command: 'wait', args: { type: 'time', ms: 250 } },
      { command: 'wait', args: { type: 'selector', selector: '#list', state: 'hidden' } },
    ])
  })

  test('wait rejects gone without text as an isError result', async () => {
    const mock = recordingRequestCommand(okResult({ waited: true }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const result = await server.callTool('wait', { ms: 100, gone: true })

    expect(result.isError).toBe(true)
    expect(mock.calls).toEqual([])
  })

  test('tab_select maps handle directly', async () => {
    const mock = recordingRequestCommand(okResult({ selected: true }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('tab_select', { handle: 't3' })

    expect(mock.calls).toEqual([{ command: 'tab.select', args: { handle: 't3' } }])
  })

  test('screenshot returns an image block plus a summary', async () => {
    const mock = recordingRequestCommand(
      okResult({
        data: 'aGVsbG8gd29ybGQ=',
        mimeType: 'image/png',
        width: 800,
        height: 600,
      }),
    )
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const result = await server.callTool('screenshot', { full: true })

    expect(result.isError).toBeFalsy()
    const imageBlock = result.content.find((block) => block.type === 'image')
    expect(imageBlock).toEqual({
      type: 'image',
      data: 'aGVsbG8gd29ybGQ=',
      mimeType: 'image/png',
    })
    expect(result.structuredContent).toEqual({
      mimeType: 'image/png',
      width: 800,
      height: 600,
    })
  })

  test('writes screenshots over 2MB to disk instead of inlining base64', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-mcp-home-'))
    const previousHome = process.env.AUTOBROWSER_HOME
    process.env.AUTOBROWSER_HOME = tempHome
    try {
      // ~3MB 的 base64（解码后约 2.25MB）超过 2MB 阈值
      const bigBase64 = 'A'.repeat(3_000_000)
      const mock = recordingRequestCommand(
        okResult({
          data: bigBase64,
          mimeType: 'image/png',
          width: 1920,
          height: 1080,
        }),
      )
      const server = new AutobrowserMcpServer({ requestCommand: mock })

      const result = await server.callTool('screenshot', { full: true })

      expect(result.isError).toBeFalsy()
      // 不再回 image content，改回文本路径
      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('screenshot saved to ')
      expect(text).toContain('(1920x1080 pixels')
      expect(text).toContain('too large to inline')

      const savedPath = (result.structuredContent as { path: string }).path
      expect(savedPath).toContain(path.join(tempHome, '.autobrowser', 'screenshots'))
      const stats = await stat(savedPath)
      expect(stats.size).toBeGreaterThan(2 * 1024 * 1024)
    } finally {
      if (previousHome === undefined) {
        delete process.env.AUTOBROWSER_HOME
      } else {
        process.env.AUTOBROWSER_HOME = previousHome
      }
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  test('keeps inlining screenshots that fit within the 2MB threshold', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-mcp-home-'))
    const previousHome = process.env.AUTOBROWSER_HOME
    process.env.AUTOBROWSER_HOME = tempHome
    try {
      const mock = recordingRequestCommand(
        okResult({ data: 'aGVsbG8gd29ybGQ=', mimeType: 'image/png', width: 800, height: 600 }),
      )
      const server = new AutobrowserMcpServer({ requestCommand: mock })

      const result = await server.callTool('screenshot', {})

      expect(result.content.some((block) => block.type === 'image')).toBe(true)
      expect(result.content.some((block) => block.type === 'text')).toBe(true)
    } finally {
      if (previousHome === undefined) {
        delete process.env.AUTOBROWSER_HOME
      } else {
        process.env.AUTOBROWSER_HOME = previousHome
      }
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  test('unknown tool returns an isError result with a suggestion', async () => {
    const mock = recordingRequestCommand(okResult({}))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const result = await server.callTool('definitely_not_a_tool', {})

    expect(result.isError).toBe(true)
    const textBlock = result.content[0]
    expect(textBlock.type).toBe('text')
    expect((textBlock as { text: string }).text).toContain('Unknown tool: definitely_not_a_tool')
    const error = (result.structuredContent as { error: Record<string, unknown> }).error
    expect(error.code).toBe('UNKNOWN_TOOL')
  })

  test('passes through command errors with code and suggestedAction', async () => {
    const mock = recordingRequestCommand({
      ok: false,
      error: {
        code: 'STALE_ELEMENT_REF',
        message: 'element ref @e7 is stale, re-snapshot the page',
        suggestedAction: 'Run snapshot to refresh element refs before retrying.',
      },
    })
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const result = await server.callTool('click', { selector: '@e7' })

    expect(result.isError).toBe(true)
    const textBlock = result.content[0]
    expect(textBlock.type).toBe('text')
    expect((textBlock as { text: string }).text).toContain('element ref @e7 is stale')
    expect((textBlock as { text: string }).text).toContain(
      '[AI SUGGESTION]: Run snapshot to refresh element refs before retrying.',
    )
    const error = (result.structuredContent as { error: Record<string, unknown> }).error
    expect(error.code).toBe('STALE_ELEMENT_REF')
    expect(error.suggestedAction).toContain('Run snapshot')
  })

  test('returns an isError result when requestCommand throws', async () => {
    const server = new AutobrowserMcpServer({
      requestCommand: async () => {
        throw new Error('server unreachable')
      },
    })

    const result = await server.callTool('tab_list', {})

    expect(result.isError).toBe(true)
    const textBlock = result.content[0]
    expect((textBlock as { text: string }).text).toContain('server unreachable')
  })
})

describe('AutobrowserMcpServer.connect (JSON-RPC over stdio)', () => {
  test('handles initialize, tools/list, and tools/call over a real transport', async () => {
    const mock = recordingRequestCommand(okResult({ ok: true }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const client = new PassThrough()
    const serverOutput = new PassThrough()
    const received: Array<Record<string, unknown>> = []
    serverOutput.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) {
          received.push(JSON.parse(line) as Record<string, unknown>)
        }
      }
    })

    const transport = new StdioServerTransport(client, serverOutput)
    await server.connect(transport)

    client.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.0' },
        },
      }) + '\n',
    )

    const initializeResponse = await waitForMessage(received, (message) => message.id === 1)
    const result = initializeResponse.result as {
      protocolVersion: string
      capabilities: { tools?: unknown }
      serverInfo: { name: string }
    }
    expect(initializeResponse.error).toBeUndefined()
    expect(result.protocolVersion).toBe('2025-03-26')
    expect(result.capabilities.tools).toBeDefined()
    expect(result.serverInfo.name).toBe('autobrowser')

    client.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }) + '\n',
    )

    client.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }) + '\n',
    )

    const listResponse = await waitForMessage(received, (message) => message.id === 2)
    const listResult = listResponse.result as { tools: Array<{ name: string }> }
    expect(listResult.tools.map((tool) => tool.name)).toEqual(KNOWN_TOOL_NAMES)

    client.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'click',
          arguments: { selector: '#a', tab: 't1' },
        },
      }) + '\n',
    )

    const callResponse = await waitForMessage(received, (message) => message.id === 3)
    const callResult = callResponse.result as {
      content: Array<Record<string, unknown>>
      structuredContent?: Record<string, unknown>
    }
    expect(callResponse.error).toBeUndefined()
    expect(callResult.content[0].type).toBe('text')
    expect(callResult.structuredContent).toEqual({ ok: true })
    expect(mock.calls).toEqual([{ command: 'click', args: { selector: '#a', tabId: 't1' } }])

    client.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'nope', arguments: {} },
      }) + '\n',
    )

    const errorResponse = await waitForMessage(received, (message) => message.id === 4)
    const errorResult = errorResponse.result as { isError: boolean }
    expect(errorResult.isError).toBe(true)

    await transport.close()
  })
})

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = messages.find(predicate)
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for JSON-RPC message')
}
