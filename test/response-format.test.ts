import { describe, expect, test } from 'bun:test'
import { parseCli } from '../src/cli/flags.js'
import { presentCommandResult } from '../src/cli/response-presenters.js'
import { AutobrowserMcpServer } from '../src/cli/mcp.js'

describe('response format', () => {
  test('defaults to concise and accepts detailed explicitly', () => {
    expect(parseCli(['network', 'requests']).flags.responseFormat).toBe('concise')
    expect(
      parseCli(['network', 'requests', '--response-format', 'detailed']).flags.responseFormat,
    ).toBe('detailed')
    expect(() => parseCli(['network', 'requests', '--response-format', 'full'])).toThrow(
      'concise or detailed',
    )
    expect(() =>
      parseCli(['--raw', '--response-format', 'detailed', 'network', 'requests']),
    ).toThrow('cannot be combined')
  })

  test('projects network lists and pagination without changing detailed output', () => {
    const result = {
      total: 2,
      requests: [
        {
          id: '11:ABCDEF',
          requestId: 'ABCDEF',
          ref: 'r1',
          tabId: 11,
          method: 'GET',
          url: 'https://example.com/api',
          status: 200,
          resourceType: 'xhr',
          durationMs: 12,
        },
      ],
      pagination: { hasNextPage: true, nextCursor: 'next', totalPages: 2 },
    }

    expect(presentCommandResult('network', result, 'concise')).toEqual({
      total: 2,
      requests: [
        {
          ref: 'r1',
          method: 'GET',
          url: 'https://example.com/api',
          status: 200,
          type: 'xhr',
          durationMs: 12,
        },
      ],
      pagination: { hasMore: true, nextCursor: 'next' },
    })
    expect(presentCommandResult('network', result, 'detailed')).toBe(result)
  })

  test('bounds concise network detail bodies and omits duplicate HAR/summary data', () => {
    const result = presentCommandResult(
      'network',
      {
        request: {
          ref: 'r1',
          method: 'GET',
          url: 'https://example.com/large',
          responseBody: '界'.repeat(10_000),
        },
        summary: { duplicated: true },
        harEntry: { duplicated: true },
      },
      'concise',
    ) as {
      request: { responseBody: string; responseBodyTruncated: boolean }
      truncated: boolean
    }

    expect(result.truncated).toBe(true)
    expect(result.request.responseBodyTruncated).toBe(true)
    expect(new TextEncoder().encode(result.request.responseBody).byteLength).toBeLessThanOrEqual(
      16_384,
    )
    expect(result).not.toHaveProperty('summary')
    expect(result).not.toHaveProperty('harEntry')
  })

  test('concise tab list preserves explicit null workspace ownership', () => {
    const result = presentCommandResult(
      'tab.list',
      {
        tabs: [
          {
            handle: 't1',
            title: 'Existing page',
            url: 'https://example.com',
            workspace: null,
            attachment: null,
            attachable: true,
          },
        ],
      },
      'concise',
    )

    expect(result).toMatchObject({
      tabs: [{ workspace: null, attachment: null, attachable: true }],
    })
  })

  test('MCP advertises response_format and emits compact concise content', async () => {
    const server = new AutobrowserMcpServer({
      requestCommand: async () => ({
        ok: true,
        result: {
          tabs: [{ id: 123, handle: 't123', title: 'Example', url: 'https://example.com' }],
          pagination: { hasNextPage: false },
        },
      }),
    })
    const tool = server.listTools().find((item) => item.name === 'tab_list')!
    expect(tool.inputSchema.properties?.response_format).toBeDefined()

    const result = await server.callTool('tab_list')
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '{"tabs":[{"handle":"t123","title":"Example","url":"https://example.com"}],"pagination":{"hasMore":false}}',
    })
    expect(result.structuredContent).toMatchObject({
      tabs: [{ handle: 't123', title: 'Example' }],
    })
  })
})
