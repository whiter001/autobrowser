import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { commandSupportsFrameTarget, commandSupportsTabTarget } from '../core/command-spec.js'
import { isRecord, type CommandResponse } from './client.js'
import { helpRequested } from './commands/shared.js'
import type { CommandContext } from './commands/types.js'

interface McpToolDefinition {
  name: string
  description: string
  command: string
  inputSchema: {
    type: 'object'
    properties: Record<string, object>
    required?: string[]
  }
  toArgs(args: Record<string, unknown>): Record<string, unknown>
}

function selectorOnlyTool(name: string, description: string, command: string): McpToolDefinition {
  return {
    name,
    description,
    command,
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'A CSS selector or an @eN element ref from snapshot (e.g. "button.submit" or "@e4").',
        },
      },
      required: ['selector'],
    },
    toArgs: (args) => ({ selector: args.selector }),
  }
}

function onlyDefined(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (args[key] !== undefined) {
      out[key] = args[key]
    }
  }
  return out
}

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'navigate',
    description:
      'Navigate to a URL in the current tab. Waits for the page to finish loading before returning.',
    command: 'goto',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to.' },
      },
      required: ['url'],
    },
    toArgs: (args) => ({ url: args.url }),
  },
  {
    name: 'snapshot',
    description:
      'Capture the page as a structured snapshot: a list of interactive/visible elements with stable @eN refs, roles, accessible names, and positions. Elements refs stay usable across commands even as the page changes; re-run snapshot to refresh them. Also returns frame refs (@fN) for the current page view. Start here to discover selectors and refs before interacting.',
    command: 'snapshot',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Restrict the snapshot to an element subtree: a CSS selector or an @eN ref.',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only return elements with these roles (e.g. button, link); refs are renumbered.',
        },
        changed: {
          type: 'boolean',
          description:
            'Only return elements added or changed since the last snapshot; the first run (or after navigation) returns the full snapshot with full: true.',
        },
      },
    },
    toArgs: (args) => {
      const out = onlyDefined(args, ['roles', 'changed'])
      if (args.target !== undefined) {
        out.selector = args.target
      }
      return out
    },
  },
  {
    name: 'search',
    description:
      'Search the page visible text and return matching lines with surrounding context. Good for reading page data rather than locating elements.',
    command: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Text to match (case-insensitive substring) or a /pattern/flags regular expression.',
        },
        context: {
          type: 'number',
          description: 'Number of context lines around each match (default 3).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of match windows to return (default 20).',
        },
      },
      required: ['query'],
    },
    toArgs: (args) => onlyDefined(args, ['query', 'context', 'limit']),
  },
  {
    name: 'find',
    description:
      'Find elements by role, text, label, placeholder, alt, title, test-id, or exact-name and optionally act on them. Returns matching @eN refs so follow-up commands can use them directly.',
    command: 'find',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          description: 'The lookup strategy.',
          enum: ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'test-id', 'exact-name'],
        },
        role: {
          type: 'string',
          description: 'The ARIA role to look up (when strategy is role).',
        },
        query: {
          type: 'string',
          description: 'The text/attribute to look up (when strategy is text, label, ...).',
        },
        name: {
          type: 'string',
          description:
            'Restrict candidates to the exact accessible name (best with strategy role).',
        },
        exact: {
          type: 'boolean',
          description: 'Require an exact text match instead of a substring match.',
        },
        position: {
          type: 'string',
          description: 'Pick the first, last, or Nth match (e.g. "first", "last", "nth=2").',
        },
        candidates: {
          type: 'number',
          description: 'Return a Top-N ranked candidate list (only with action locate).',
        },
        action: {
          type: 'string',
          description: 'Optional action to perform on the matched element.',
          enum: ['locate', 'click', 'fill', 'type', 'hover', 'focus', 'check', 'uncheck', 'text'],
        },
        value: {
          type: 'string',
          description: 'Text to enter when action is fill or type.',
        },
      },
      required: ['strategy'],
    },
    toArgs: findToArgs,
  },
  selectorOnlyTool(
    'click',
    'Click an element. Accepts a CSS selector or an @eN element ref from snapshot.',
    'click',
  ),
  selectorOnlyTool(
    'dblclick',
    'Double-click an element. Accepts a CSS selector or an @eN element ref from snapshot.',
    'dblclick',
  ),
  selectorOnlyTool(
    'hover',
    'Move the mouse over an element. Accepts a CSS selector or an @eN element ref from snapshot.',
    'hover',
  ),
  {
    name: 'fill',
    description:
      'Replace the value of a text field (input, textarea, contenteditable). Accepts a CSS selector or an @eN element ref.',
    command: 'fill',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'A CSS selector or an @eN element ref from snapshot.',
        },
        value: { type: 'string', description: 'The text to enter.' },
      },
      required: ['selector', 'value'],
    },
    toArgs: (args) => ({ selector: args.selector, value: args.value }),
  },
  {
    name: 'type',
    description:
      'Type text into a field, optionally pressing Enter (submit) afterward. Accepts a CSS selector or an @eN element ref.',
    command: 'type',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'A CSS selector or an @eN element ref from snapshot.',
        },
        value: { type: 'string', description: 'The text to type.' },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing to submit the form.',
        },
      },
      required: ['selector', 'value'],
    },
    toArgs: (args) => onlyDefined(args, ['selector', 'value', 'submit']),
  },
  {
    name: 'press',
    description: 'Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace).',
    command: 'press',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key name to press.' },
      },
      required: ['key'],
    },
    toArgs: (args) => ({ key: args.key }),
  },
  {
    name: 'scroll',
    description: 'Scroll the page or an element horizontally/vertically by a number of pixels.',
    command: 'scroll',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'Optional element to scroll (CSS selector or @eN ref); scrolls the page when omitted.',
        },
        deltaX: { type: 'number', description: 'Horizontal scroll delta in pixels.' },
        deltaY: { type: 'number', description: 'Vertical scroll delta in pixels.' },
      },
    },
    toArgs: (args) => onlyDefined(args, ['selector', 'deltaX', 'deltaY']),
  },
  {
    name: 'get',
    description:
      'Read page or element data: text (default), html, value, count, box, styles, title, url, or any other element attribute.',
    command: 'get',
    inputSchema: {
      type: 'object',
      properties: {
        attr: {
          type: 'string',
          description:
            'What to read: text (default), html, value, count, box, styles, title, url, or an attribute name.',
        },
        selector: {
          type: 'string',
          description:
            'The element to read from (CSS selector or @eN ref). Ignored for title, url, cdp-url.',
        },
      },
    },
    toArgs: (args) => {
      const out: Record<string, unknown> = {}
      const attr = args.attr
      if (attr !== undefined) {
        out.attr = attr
      } else {
        out.attr = 'text'
      }
      if (args.selector !== undefined) {
        out.selector = args.selector
      }
      return out
    },
  },
  {
    name: 'wait',
    description:
      'Wait for a selector state, text, URL, load state, a function expression, or a fixed duration.',
    command: 'wait',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'What to wait for; inferred from the other arguments when omitted.',
          enum: ['selector', 'url', 'text', 'fn', 'time', 'load', 'networkidle'],
        },
        selector: {
          type: 'string',
          description: 'Element to wait on (CSS selector or @eN ref).',
        },
        state: {
          type: 'string',
          description:
            'Expected state for selector waits: visible (default), hidden, stable, or new.',
          enum: ['visible', 'hidden', 'stable', 'new'],
        },
        text: { type: 'string', description: 'Text that should appear (or disappear with gone).' },
        url: { type: 'string', description: 'URL pattern the page should navigate to.' },
        fn: { type: 'string', description: 'JS expression that should evaluate truthy.' },
        timeout: { type: 'number', description: 'Total timeout in milliseconds (default 30000).' },
        ms: { type: 'number', description: 'Fixed duration to wait in milliseconds.' },
        gone: { type: 'boolean', description: 'Wait for text to disappear instead of appear.' },
      },
    },
    toArgs: waitToArgs,
  },
  {
    name: 'screenshot',
    description:
      'Capture a screenshot of the page or a specific element and return it as an image.',
    command: 'screenshot',
    inputSchema: {
      type: 'object',
      properties: {
        full: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of the viewport.',
        },
        annotate: { type: 'boolean', description: 'Overlay numbered labels on elements.' },
        format: { type: 'string', description: 'Image format.', enum: ['png', 'jpeg'] },
        quality: { type: 'number', description: 'JPEG quality (1-100).' },
        element: {
          type: 'string',
          description:
            'Capture only this element (CSS selector or @eN ref); cannot be combined with full.',
        },
      },
    },
    toArgs: (args) => onlyDefined(args, ['full', 'annotate', 'format', 'quality', 'element']),
  },
  {
    name: 'tab_list',
    description: 'List open tabs with their stable handles (tN), titles, and URLs.',
    command: 'tab.list',
    inputSchema: { type: 'object', properties: {} },
    toArgs: () => ({}),
  },
  {
    name: 'tab_new',
    description: 'Open a new tab, optionally at a URL.',
    command: 'tab.new',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open; opens a blank tab when omitted.' },
      },
    },
    toArgs: (args) => ({ url: typeof args.url === 'string' ? args.url : 'about:blank' }),
  },
  {
    name: 'tab_select',
    description: 'Select a tab by its handle (tN) to make it the active tab.',
    command: 'tab.select',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The tab handle, e.g. "t2".' },
      },
      required: ['handle'],
    },
    toArgs: (args) => ({ handle: args.handle }),
  },
  {
    name: 'tab_close',
    description: 'Close the current tab, a specific tab by handle (tN), or all tabs with "all".',
    command: 'tab.close',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description:
            'The tab handle to close (e.g. "t3"); omit to close the current tab, pass "all" to close all.',
        },
      },
    },
    toArgs: (args) => (args.handle !== undefined ? { handle: args.handle } : {}),
  },
  {
    name: 'eval',
    description:
      'Run JavaScript in the page context and return the serialized result. The script can use await.',
    command: 'eval',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The JavaScript source to execute.' },
      },
      required: ['script'],
    },
    toArgs: (args) => ({ script: args.script }),
  },
]

const MCP_TOOLS_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]))

function findToArgs(args: Record<string, unknown>): Record<string, unknown> {
  const strategy = args.strategy
  if (typeof strategy !== 'string') {
    throw new Error(
      'find requires a strategy: role, text, label, placeholder, alt, title, test-id, or exact-name',
    )
  }

  const out: Record<string, unknown> = { strategy }
  if (strategy === 'role') {
    out.role = typeof args.role === 'string' ? args.role : args.query
  } else {
    out.query = typeof args.query === 'string' ? args.query : args.role
  }
  for (const key of ['name', 'exact', 'position', 'candidates', 'action', 'value']) {
    if (args[key] !== undefined) {
      out[key] = args[key]
    }
  }
  return out
}

function waitToArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const gone = args.gone === true
  const explicitType = args.type

  if (explicitType !== undefined) {
    out.type = explicitType
  } else if (args.url !== undefined) {
    out.type = 'url'
  } else if (args.text !== undefined) {
    out.type = 'text'
  } else if (args.fn !== undefined) {
    out.type = 'fn'
  } else if (args.ms !== undefined) {
    out.type = 'time'
  } else {
    out.type = 'selector'
  }

  if (gone && String(out.type) !== 'text') {
    throw new Error('wait --gone requires --text <text>')
  }

  return {
    ...out,
    ...onlyDefined(args, ['selector', 'state', 'text', 'url', 'fn', 'timeout', 'ms', 'gone']),
  }
}

function extractScreenshotData(result: Record<string, unknown>): {
  data: string
  mimeType: string
} {
  const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : ''
  const rawData =
    typeof result.data === 'string'
      ? result.data
      : dataUrl.includes(',')
        ? dataUrl.slice(dataUrl.indexOf(',') + 1)
        : ''

  if (!rawData) {
    throw new Error('missing screenshot data')
  }

  const mimeType =
    typeof result.mimeType === 'string'
      ? result.mimeType
      : dataUrl.startsWith('data:image/jpeg')
        ? 'image/jpeg'
        : 'image/png'

  return {
    data: rawData,
    mimeType,
  }
}

function toErrorResult(
  code: string | undefined,
  message: string,
  error: {
    suggestion?: string
    suggestedAction?: string
    details?: unknown
  } = {},
): CallToolResult {
  const suggestion = error.suggestion || error.suggestedAction
  const text = suggestion ? `${message}\n\n[AI SUGGESTION]: ${suggestion}` : message
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      error: {
        ...(code ? { code } : {}),
        message,
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        ...(error.suggestedAction ? { suggestedAction: error.suggestedAction } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
  }
}

function toSuccessResult(result: unknown): CallToolResult {
  const structuredContent = isRecord(result) && !Array.isArray(result) ? result : undefined
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

function toScreenshotResult(result: Record<string, unknown>): CallToolResult {
  const { data, mimeType } = extractScreenshotData(result)
  const summary: Record<string, unknown> = { mimeType }
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'data' && key !== 'dataUrl') {
      summary[key] = value
    }
  }
  const dimensions =
    typeof result.width === 'number' && typeof result.height === 'number'
      ? ` (${result.width}x${result.height})`
      : ''
  return {
    content: [
      { type: 'image', data, mimeType },
      { type: 'text', text: `Screenshot captured as ${mimeType}${dimensions}.` },
    ],
    structuredContent: summary,
  }
}

export interface McpServerDependencies {
  name?: string
  version?: string
  requestCommand: (command: string, args: Record<string, unknown>) => Promise<CommandResponse>
}

export class AutobrowserMcpServer {
  readonly name: string
  readonly version: string
  private readonly requestCommand: McpServerDependencies['requestCommand']

  constructor(dependencies: McpServerDependencies) {
    this.name = dependencies.name ?? 'autobrowser'
    this.version = dependencies.version ?? '0.1.0'
    this.requestCommand = dependencies.requestCommand
  }

  listTools(): Tool[] {
    return MCP_TOOLS.map((definition) => {
      const properties: Record<string, object> = { ...definition.inputSchema.properties }
      if (commandSupportsTabTarget(definition.command)) {
        properties.tab = {
          type: 'string',
          description: 'Target a specific tab by handle (tN) or id.',
        }
      }
      if (commandSupportsFrameTarget(definition.command)) {
        properties.frame = {
          type: 'string',
          description: 'Target a specific frame by reference (@fN) or selector.',
        }
      }
      return {
        name: definition.name,
        description: definition.description,
        inputSchema: {
          type: 'object',
          properties,
          ...(definition.inputSchema.required ? { required: definition.inputSchema.required } : {}),
        },
      }
    })
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    const definition = MCP_TOOLS_BY_NAME.get(name)
    if (!definition) {
      return toErrorResult('UNKNOWN_TOOL', `Unknown tool: ${name}`, {
        suggestedAction: `Available tools: ${MCP_TOOLS.map((tool) => tool.name).join(', ')}`,
      })
    }

    const commandArgs: Record<string, unknown> = {}
    try {
      Object.assign(commandArgs, definition.toArgs(args ?? {}))
      if (commandSupportsTabTarget(definition.command) && args?.tab !== undefined) {
        commandArgs.tabId = args.tab
      }
      if (commandSupportsFrameTarget(definition.command) && args?.frame !== undefined) {
        commandArgs.frame = args.frame
      }
    } catch (error) {
      return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
    }

    let payload: CommandResponse
    try {
      payload = await this.requestCommand(definition.command, commandArgs)
    } catch (error) {
      return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
    }

    if (payload.ok === false) {
      const error = payload.error
      return toErrorResult(error?.code, error?.message || 'command failed', {
        suggestion: error?.suggestion,
        suggestedAction: error?.suggestedAction,
        details: error?.details,
      })
    }

    if (
      definition.command === 'screenshot' &&
      isRecord(payload.result) &&
      !Array.isArray(payload.result)
    ) {
      try {
        return toScreenshotResult(payload.result)
      } catch (error) {
        return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
      }
    }

    return toSuccessResult(payload.result)
  }

  async connect(transport: Transport): Promise<void> {
    const server = new Server(
      { name: this.name, version: this.version },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listTools() }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return await this.callTool(request.params.name, request.params.arguments)
    })
    await server.connect(transport)
  }
}

export async function handleMcpCommand(
  rest: string[],
  context: CommandContext,
): Promise<number | void> {
  if (helpRequested(rest[0], context, ['mcp'])) {
    return 0
  }

  try {
    await context.getCommandStatus(context.flags.server)
  } catch {
    // The first tool call surfaces any connection problem as an isError result.
  }

  const server = new AutobrowserMcpServer({
    requestCommand: async (command, args) =>
      await context.requestCommand(context.flags.server, command, args),
  })
  const transport = new StdioServerTransport()
  transport.onclose = () => process.exit(0)
  await server.connect(transport)
  return undefined
}
