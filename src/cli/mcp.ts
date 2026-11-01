import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { commandSupportsFrameTarget, commandSupportsTabTarget } from '../core/command-spec.js'
import { isRecord, type CommandResponse } from './client.js'
import { helpRequested } from './commands/shared.js'
import type { CommandContext } from './commands/types.js'
import {
  toErrorResult,
  toScreenshotResult,
  toSuccessResult,
  toTracingResult,
  toVideoResult,
} from './mcp-response.js'
import { MCP_TOOLS, MCP_TOOLS_BY_NAME } from './mcp-tools.js'

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
      if (
        definition.name !== 'navigate' &&
        commandSupportsFrameTarget(definition.command) &&
        args?.frame !== undefined
      ) {
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

    if (definition.command === 'video' && isRecord(payload.result)) {
      try {
        return await toVideoResult(payload.result)
      } catch (error) {
        return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
      }
    }

    if (definition.command === 'tracing' && isRecord(payload.result)) {
      try {
        return await toTracingResult(payload.result)
      } catch (error) {
        return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
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
        return toErrorResult(undefined, error instanceof Error ? error.message : String(error))
      }
    }

    return toSuccessResult(payload.result)
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
