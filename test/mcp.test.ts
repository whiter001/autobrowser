import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parseSearchArgs } from '../src/cli/parse.js'
import { printHelp } from '../src/cli/help.js'
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
  'target',
  'command_control',
  'tab_new',
  'tab_select',
  'tab_close',
  'eval',
  'console',
  'errors',
  'network_requests',
  'network_har',
  'dialog',
  'cookies',
  'storage',
  'fill_form',
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
  test('exposes all 29 tools with object-typed input schemas', () => {
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

  test('recovery control tools map target and command actions', async () => {
    const mock = recordingRequestCommand(okResult({}))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('target', { action: 'clear' })
    await server.callTool('command_control', { action: 'cancel', commandId: 'cmd_1' })

    expect(mock.calls).toEqual([
      { command: 'target', args: { action: 'clear' } },
      { command: 'command', args: { action: 'cancel', commandId: 'cmd_1' } },
    ])
  })

  test('console/errors forward pagination and inject the tab target', async () => {
    const mock = recordingRequestCommand(okResult({ messages: [], pagination: {} }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('console', { pageIdx: 2, pageSize: 25, tab: 't2' })
    await server.callTool('errors', { pageSize: 10 })

    expect(mock.calls).toEqual([
      { command: 'console', args: { pageIdx: 2, pageSize: 25, tabId: 't2' } },
      { command: 'errors', args: { pageSize: 10 } },
    ])
  })

  test('network_requests maps to the network requests action with pagination', async () => {
    const mock = recordingRequestCommand(okResult({ requests: [], pagination: {} }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('network_requests', { pageIdx: 1, pageSize: 5, tab: 't4' })

    expect(mock.calls).toEqual([
      {
        command: 'network',
        args: { action: 'requests', pageIdx: 1, pageSize: 5, tabId: 't4' },
      },
    ])
  })

  test('network_har maps checkpoint recovery actions', async () => {
    const mock = recordingRequestCommand(okResult({ recovered: true }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('network_har', { action: 'recover' })

    expect(mock.calls).toEqual([
      { command: 'network', args: { action: 'har', subaction: 'recover' } },
    ])
  })

  test('dialog maps accept/dismiss to the accept boolean and status to the action', async () => {
    const mock = recordingRequestCommand(okResult({ handled: true }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('dialog', { action: 'accept' })
    await server.callTool('dialog', { action: 'accept', promptText: 'yes' })
    await server.callTool('dialog', { action: 'dismiss' })
    await server.callTool('dialog', { action: 'status' })

    expect(mock.calls).toEqual([
      { command: 'dialog', args: { accept: true } },
      { command: 'dialog', args: { accept: true, promptText: 'yes' } },
      { command: 'dialog', args: { accept: false } },
      { command: 'dialog', args: { action: 'status' } },
    ])
  })

  test('dialog rejects an unknown action as an isError result', async () => {
    const mock = recordingRequestCommand(okResult({}))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const result = await server.callTool('dialog', { action: 'snooze' })

    expect(result.isError).toBe(true)
    expect(mock.calls).toEqual([])
  })

  test('cookies maps action plus optional name/value/domain and injects the tab', async () => {
    const mock = recordingRequestCommand(okResult({ cookies: [] }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('cookies', {
      action: 'set',
      name: 'sid',
      value: 'abc',
      domain: '.example.com',
      tab: 't1',
    })
    await server.callTool('cookies', { action: 'get' })
    await server.callTool('cookies', { action: 'list' })

    expect(mock.calls).toEqual([
      {
        command: 'cookies',
        args: { action: 'set', name: 'sid', value: 'abc', domain: '.example.com', tabId: 't1' },
      },
      { command: 'cookies', args: { action: 'get' } },
      { command: 'cookies', args: { action: 'get' } },
    ])
  })

  test('storage maps action plus optional key/value/session and injects tab and frame', async () => {
    const mock = recordingRequestCommand(okResult({ storage: {} }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('storage', {
      action: 'set',
      key: 'theme',
      value: 'dark',
      session: true,
      tab: 't2',
      frame: '@f1',
    })

    expect(mock.calls).toEqual([
      {
        command: 'storage',
        args: {
          action: 'set',
          key: 'theme',
          value: 'dark',
          session: true,
          tabId: 't2',
          frame: '@f1',
        },
      },
    ])
  })

  test('fill_form passes the fields array through with tab and frame injection', async () => {
    const mock = recordingRequestCommand(okResult({ results: [], succeeded: 0, failed: 0 }))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    await server.callTool('fill_form', {
      fields: [
        { selector: '#name', value: 'Ada' },
        { selector: '#age', value: '36' },
      ],
      tab: 't1',
      frame: '@f2',
    })

    expect(mock.calls).toEqual([
      {
        command: 'fillform',
        args: {
          fields: [
            { selector: '#name', value: 'Ada' },
            { selector: '#age', value: '36' },
          ],
          tabId: 't1',
          frame: '@f2',
        },
      },
    ])
  })

  test('fill_form rejects a non-array fields argument', async () => {
    const mock = recordingRequestCommand(okResult({}))
    const server = new AutobrowserMcpServer({ requestCommand: mock })

    const result = await server.callTool('fill_form', { fields: 'oops' })

    expect(result.isError).toBe(true)
    expect(mock.calls).toEqual([])
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
      instructions: string
    }
    expect(initializeResponse.error).toBeUndefined()
    expect(result.protocolVersion).toBe('2025-03-26')
    expect(result.capabilities.tools).toBeDefined()
    expect(result.serverInfo.name).toBe('autobrowser')
    expect(result.instructions).toContain('30 minutes including allowance')
    expect(result.instructions).toContain('not automatically replayed')

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

describe('search interfaces', () => {
  test('parses 1-based cursors and preserves defaults', () => {
    expect(parseSearchArgs(['error'])).toEqual({ query: 'error', context: 3, limit: 20 })
    expect(
      parseSearchArgs(['/error/gi', '--start-line', '201', '--context', '50', '--limit', '0']),
    ).toEqual({ query: '/error/gi', startLine: 201, context: 50, limit: 0 })
    expect(
      parseSearchArgs(['error', '--start-line', String(Number.MAX_SAFE_INTEGER)]).startLine,
    ).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('rejects invalid cursors, context and unsafe limits before dispatch', () => {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '']) {
      expect(() => parseSearchArgs(['error', '--start-line', value])).toThrow()
    }
    expect(() => parseSearchArgs(['error', '--start-line'])).toThrow('missing start line value')
    for (const value of ['51', '-1', '1.5', 'Infinity']) {
      expect(() => parseSearchArgs(['error', '--context', value])).toThrow()
    }
    expect(() => parseSearchArgs(['error', '--limit', '9007199254740992'])).toThrow()
  })

  test('help and MCP schemas describe bounded pagination and recovery', () => {
    const tools = new AutobrowserMcpServer({ requestCommand: async () => okResult({}) }).listTools()
    const search = tools.find((tool) => tool.name === 'search')!
    expect(search.inputSchema.properties?.startLine).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    })
    expect(search.inputSchema.properties?.context).toMatchObject({ maximum: 50 })
    expect(printHelp(['search'])).toContain('--start-line <n>')
    expect(printHelp(['search'])).toContain('nextStartLine:201')
    expect(printHelp(['search'])).toContain('100000 UTF-8 bytes')
    expect(printHelp(['find'])).toContain('AMBIGUOUS_TARGET')
    expect(printHelp(['snapshot'])).toContain('removedRefs')
    expect(printHelp(['batch'])).toContain('NOT an idempotency guarantee')
    expect(JSON.stringify(tools.find((tool) => tool.name === 'find'))).toContain(
      'substring by default',
    )
  })

  test('CLI and SDK stdio client round-trip cursors and structured errors through isolated mock IPC', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-search-interfaces-'))
    const token = 'search-interface-test-token'
    const calls: RecordedCall[] = []
    const authorization: Array<string | null> = []
    const firstPage = {
      query: 'error',
      startLine: 1,
      nextStartLine: 201,
      truncated: true,
      returned: 1,
      windows: [
        { startLine: 1, endLine: 200, lines: [{ line: 1, text: 'error 一', matched: true }] },
      ],
    }
    const secondPage = {
      query: 'error',
      startLine: 201,
      truncated: false,
      returned: 1,
      windows: [
        { startLine: 201, endLine: 201, lines: [{ line: 201, text: 'error 二', matched: true }] },
      ],
    }
    const ambiguous = {
      code: 'AMBIGUOUS_TARGET',
      message: 'multiple matching buttons',
      suggestedAction: 'Inspect candidates or set position explicitly.',
      details: {
        candidates: [
          { ref: '@e1', name: 'Delete draft' },
          { ref: '@e2', name: 'Delete all' },
        ],
      },
    }
    const ipc = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/status') {
          return Response.json({ extensionConnected: true, token })
        }
        authorization.push(request.headers.get('authorization'))
        const call = (await request.json()) as RecordedCall
        calls.push(call)
        if (call.command === 'find') return Response.json({ ok: false, error: ambiguous })
        return Response.json(okResult(call.args.startLine === 201 ? secondPage : firstPage))
      },
    })
    const client = new Client({ name: 'search-interface-test', version: '1' })
    const cliPath = path.resolve(import.meta.dir, '../src/cli.ts')
    const serverUrl = `http://127.0.0.1:${ipc.port}`
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, '--server', serverUrl, 'mcp'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        AUTOBROWSER_HOME: home,
      },
      stderr: 'pipe',
    })
    try {
      await mkdir(path.join(home, '.autobrowser'))
      await writeFile(path.join(home, '.autobrowser', 'token'), JSON.stringify({ token }))
      const runSearch = async (rest: string[]) => {
        const child = Bun.spawn(
          [process.execPath, cliPath, '--server', serverUrl, 'search', ...rest],
          {
            env: { ...process.env, AUTOBROWSER_HOME: home },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        try {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          return { stdout, stderr, exitCode }
        } finally {
          child.kill()
          await child.exited
        }
      }
      const first = await runSearch(['error', '--context', '0'])
      expect(first.exitCode).toBe(0)
      expect(JSON.parse(first.stdout).result).toEqual(firstPage)
      const next = JSON.parse(first.stdout).result.nextStartLine
      const second = await runSearch(['error', '--context', '0', '--start-line', String(next)])
      expect(second.exitCode).toBe(0)
      expect(JSON.parse(second.stdout).result).toEqual(secondPage)
      expect(calls.slice(0, 2)).toEqual([
        { command: 'search', args: { query: 'error', context: 0, limit: 20 } },
        { command: 'search', args: { query: 'error', context: 0, limit: 20, startLine: 201 } },
      ])
      const invalidCli = await runSearch(['error', '--start-line', '0'])
      expect(invalidCli.exitCode).toBe(1)
      expect(calls).toHaveLength(2)

      await client.connect(transport)
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(KNOWN_TOOL_NAMES)
      const page = await client.callTool({
        name: 'search',
        arguments: { query: 'error', context: 0, limit: 2, tab: 't2', frame: '@f1' },
      })
      expect(page.structuredContent).toEqual(firstPage)
      const resumed = await client.callTool({
        name: 'search',
        arguments: {
          query: 'error',
          context: 0,
          limit: 2,
          startLine: (page.structuredContent as typeof firstPage).nextStartLine,
          tab: 't2',
          frame: '@f1',
        },
      })
      expect(resumed.structuredContent).toEqual(secondPage)
      expect(calls.at(-1)).toEqual({
        command: 'search',
        args: { query: 'error', context: 0, limit: 2, startLine: 201, tabId: 't2', frame: '@f1' },
      })
      for (const args of [
        { startLine: 0 },
        { startLine: 1.5 },
        { startLine: Number.MAX_SAFE_INTEGER + 1 },
        { context: 51 },
      ]) {
        const before = calls.length
        const invalid = await client.callTool({
          name: 'search',
          arguments: { query: 'error', ...args },
        })
        expect(invalid.isError).toBe(true)
        expect(invalid.structuredContent).toMatchObject({ error: { code: 'INVALID_COMMAND_ARGS' } })
        expect(calls).toHaveLength(before)
      }
      const failure = await client.callTool({
        name: 'find',
        arguments: { strategy: 'role', role: 'button', name: 'Delete', action: 'click' },
      })
      expect(failure.isError).toBe(true)
      expect(failure.structuredContent).toEqual({ error: ambiguous })
      await client.callTool({
        name: 'find',
        arguments: {
          strategy: 'role',
          role: 'button',
          name: 'Delete',
          exact: true,
          position: 'nth=2',
          action: 'click',
        },
      })
      expect(calls.at(-1)?.args).toMatchObject({ exact: true, position: 'nth=2', action: 'click' })
      expect(authorization.every((value) => value === `Bearer ${token}`)).toBe(true)
    } finally {
      await client.close()
      await transport.close()
      await ipc.stop(true)
      await rm(home, { recursive: true, force: true })
    }
  }, 15000)
})
