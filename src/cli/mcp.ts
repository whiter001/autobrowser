import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { commandSupportsFrameTarget, commandSupportsTabTarget } from '../core/command-spec.js'
import { createId } from '../core/protocol.js'
import { isRecord, type CommandResponse } from './client.js'
import { CLI_ERROR_CODES } from './cli-error.js'
import { helpRequested } from './commands/shared.js'
import type { CommandContext } from './commands/types.js'
import {
  parseMcpResponseMode,
  toErrorResult,
  toScreenshotResult,
  toSuccessResult,
  toTracingResult,
  toVideoResult,
  type McpResponseMode,
} from './mcp-response.js'
import { MCP_TOOLS, MCP_TOOLS_BY_NAME } from './mcp-tools.js'
import { parseResponseFormat } from './response-format.js'

const CURSOR_LIST_COMMANDS = new Set([
  'tab.list',
  'console',
  'errors',
  'network',
  'actions',
  'command',
])

/**
 * 默认只暴露高频工具，避免 tools/list 一次塞进约 41KB schema 占满模型上下文。
 * 未列出的工具仍然注册在 callTool 中，知道名字的调用方可以直接使用。
 */
export const MCP_CORE_TOOL_NAMES = [
  'navigate',
  'reload',
  'snapshot',
  'search',
  'find',
  'click',
  'fill',
  'type',
  'press',
  'get',
  'wait',
  'eval',
  'tab_list',
  'tab_attach',
  'tab_detach',
  'tab_new',
  'tab_select',
  'tab_close',
  'workspace',
] as const

export type McpToolset = 'core' | 'all'

export function parseMcpToolset(value: string | undefined): McpToolset {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return 'core'
  if (normalized === 'core' || normalized === 'all') {
    return normalized
  }
  throw new Error(`Invalid AUTOBROWSER_MCP_TOOLSET "${value}": expected "core" or "all".`)
}

interface McpServerDependencies {
  name?: string
  version?: string
  responseMode?: McpResponseMode
  toolset?: McpToolset
  requestCommand: (command: string, args: Record<string, unknown>) => Promise<CommandResponse>
}

export class AutobrowserMcpServer {
  readonly name: string
  readonly version: string
  readonly responseMode: McpResponseMode
  readonly toolset: McpToolset
  private readonly requestCommand: McpServerDependencies['requestCommand']

  constructor(dependencies: McpServerDependencies) {
    this.name = dependencies.name ?? 'autobrowser'
    this.version = dependencies.version ?? '0.1.0'
    this.responseMode = dependencies.responseMode ?? 'text'
    this.toolset = dependencies.toolset ?? 'core'
    this.requestCommand = dependencies.requestCommand
  }

  listTools(): Tool[] {
    const definitions =
      this.toolset === 'all'
        ? MCP_TOOLS
        : MCP_CORE_TOOL_NAMES.flatMap((name) => {
            const definition = MCP_TOOLS_BY_NAME.get(name)
            return definition ? [definition] : []
          })
    return definitions.map((definition) => {
      const properties: Record<string, object> = {
        ...definition.inputSchema.properties,
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response detail level (default concise).',
        },
      }
      if (CURSOR_LIST_COMMANDS.has(definition.command)) {
        properties.limit = {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum records to return (default 20; tab lists default 50).',
        }
        properties.cursor = {
          type: 'string',
          description: 'Opaque nextCursor from the previous response using the same filters.',
        }
      }
      if (commandSupportsTabTarget(definition.command)) {
        properties.tab = {
          type: 'string',
          description: 'Target a specific tab by handle (tN) or id.',
        }
      }
      // goto supports frames for its additional waitFor, which MCP navigate does not expose.
      // Keep navigate's existing schema instead of advertising an ineffective frame target.
      if (definition.name !== 'navigate' && commandSupportsFrameTarget(definition.command)) {
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
      return toErrorResult(
        'UNKNOWN_TOOL',
        `Unknown tool: ${name}`,
        {
          suggestedAction: `Available tools: ${this.listTools()
            .map((tool) => tool.name)
            .join(', ')}`,
        },
        { responseMode: this.responseMode },
      )
    }

    const commandArgs: Record<string, unknown> = {}
    let responseFormat: ReturnType<typeof parseResponseFormat> = 'concise'
    try {
      responseFormat = parseResponseFormat(args?.response_format)
      Object.assign(commandArgs, definition.toArgs(args ?? {}))
      if (['snapshot', 'search', 'eval'].includes(definition.command)) {
        commandArgs.responseFormat = responseFormat
      }
      if (CURSOR_LIST_COMMANDS.has(definition.command)) {
        if (args?.limit !== undefined) commandArgs.limit = args.limit
        if (args?.cursor !== undefined) commandArgs.cursor = args.cursor
      }
      if (commandSupportsTabTarget(definition.command) && args?.tab !== undefined) {
        commandArgs.tabId = args.tab
      }
      if (
        definition.name !== 'navigate' &&
        commandSupportsFrameTarget(definition.command) &&
        args?.frame !== undefined
      ) {
        commandArgs.frame = args.frame
      }
    } catch (error) {
      // 参数不合法与 CLI 解析期错误同源，给同一个错误码，调用方才能统一分支处理
      return toErrorResult(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
        error instanceof Error ? error.message : String(error),
        {},
        { responseMode: this.responseMode },
      )
    }

    let payload: CommandResponse
    try {
      payload = await this.requestCommand(definition.command, commandArgs)
    } catch (error) {
      return toErrorResult(
        undefined,
        error instanceof Error ? error.message : String(error),
        {},
        { responseMode: this.responseMode },
      )
    }

    if (payload.ok === false) {
      const error = payload.error
      return toErrorResult(
        error?.code,
        error?.message || 'command failed',
        {
          suggestion: error?.suggestion,
          suggestedAction: error?.suggestedAction,
          details: error?.details,
        },
        { responseMode: this.responseMode },
      )
    }

    if (definition.command === 'video' && isRecord(payload.result)) {
      try {
        return await toVideoResult(payload.result)
      } catch (error) {
        return toErrorResult(
          undefined,
          error instanceof Error ? error.message : String(error),
          {},
          { responseMode: this.responseMode },
        )
      }
    }

    if (definition.command === 'tracing' && isRecord(payload.result)) {
      try {
        return await toTracingResult(payload.result)
      } catch (error) {
        return toErrorResult(
          undefined,
          error instanceof Error ? error.message : String(error),
          {},
          { responseMode: this.responseMode },
        )
      }
    }

    if (
      definition.command === 'screenshot' &&
      isRecord(payload.result) &&
      !Array.isArray(payload.result)
    ) {
      try {
        return toScreenshotResult(payload.result)
      } catch (error) {
        return toErrorResult(
          undefined,
          error instanceof Error ? error.message : String(error),
          {},
          { responseMode: this.responseMode },
        )
      }
    }

    return toSuccessResult(payload.result, {
      command: definition.command,
      responseFormat,
      responseMode: this.responseMode,
    })
  }

  async connect(transport: Transport): Promise<void> {
    const server = new Server(
      { name: this.name, version: this.version },
      {
        capabilities: { tools: {} },
        instructions:
          'Request budgets default to 30s. Explicit eval/navigation/click timeoutMs or wait timeout/ms adds 5s transport allowance (at least 30s); batch combines step/retry/delay budgets, capped at 30 minutes including allowance. Sent commands with unknown outcomes are not automatically replayed: inspect status, command_control and page state before retrying. Explicit batch retries may repeat side effects and are not an idempotency guarantee.',
      },
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

  // 非法配置直接抛错，由 CLI 顶层写 stderr 并退出 1，避免静默回退到默认值
  const responseMode = parseMcpResponseMode(process.env.AUTOBROWSER_MCP_RESPONSE_MODE)
  const toolset = parseMcpToolset(process.env.AUTOBROWSER_MCP_TOOLSET)

  try {
    await context.getCommandStatus(context.flags.server)
  } catch {
    // The first tool call surfaces any connection problem as an isError result.
  }

  const workspace = context.flags.workspace || createId('mcp')
  const server = new AutobrowserMcpServer({
    responseMode,
    toolset,
    requestCommand: async (command, args) =>
      await context.requestCommand(context.flags.server, command, { workspace, ...args }),
  })
  const transport = new StdioServerTransport()
  const leaseRenewal = setInterval(
    () => {
      void context
        .requestCommand(context.flags.server, 'workspace', { action: 'current', workspace })
        .catch(() => {})
    },
    10 * 60 * 1000,
  )
  leaseRenewal.unref()
  transport.onclose = () => {
    clearInterval(leaseRenewal)
    process.exit(0)
  }
  await server.connect(transport)
  return undefined
}
