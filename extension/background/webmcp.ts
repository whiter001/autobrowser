import type { CommandExecutionContext } from './command-queue.js'
import type {
  ErrorWithCode,
  FrameSelector,
  ResolvedFrameTarget,
  TabInput,
  TabWithId,
} from './types.js'

const WEBMCP_EVALUATE_TIMEOUT_MS = 30_000

interface WebMcpDependencies {
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  resolveFrameTarget: (tabId: TabInput, selector: string) => Promise<ResolvedFrameTarget>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<TResult>
}

interface FrameTreeNode {
  frame: { id: string; url?: string }
  childFrames?: FrameTreeNode[]
}

interface WebMcpFrame {
  id: string
  parentId: string | null
  url: string
}

interface RawTool {
  name?: unknown
  title?: unknown
  description?: unknown
  inputSchema?: unknown
  annotations?: unknown
}

interface ToolEntry {
  name: string
  title: string | null
  description: string
  inputSchema: unknown
  inputSchemaError?: true
  annotations: unknown
  frame: WebMcpFrame
  untrusted: true
}

interface EvaluationResponse {
  result?: { value?: unknown }
  exceptionDetails?: {
    text?: string
    exception?: { description?: string }
  }
}

function webmcpError(
  message: string,
  code: string,
  suggestedAction?: string,
  details?: unknown,
): ErrorWithCode {
  const error = new Error(message) as ErrorWithCode
  error.code = code
  if (suggestedAction) error.suggestedAction = suggestedAction
  if (details !== undefined) error.details = details
  return error
}

function flattenFrames(node: FrameTreeNode, parentId: string | null = null): WebMcpFrame[] {
  return [
    { id: node.frame.id, parentId, url: node.frame.url || '' },
    ...(node.childFrames || []).flatMap((child) => flattenFrames(child, node.frame.id)),
  ]
}

function parseSchema(schema: unknown): Pick<ToolEntry, 'inputSchema' | 'inputSchemaError'> {
  if (typeof schema !== 'string') return { inputSchema: schema ?? {} }
  try {
    return { inputSchema: JSON.parse(schema) }
  } catch {
    return { inputSchema: schema, inputSchemaError: true }
  }
}

function parseResult(result: unknown): unknown {
  if (typeof result !== 'string') return result
  try {
    return JSON.parse(result)
  } catch {
    return result
  }
}

const DISCOVERY_EXPRESSION = `(async () => {
  const context = document.modelContext;
  if (!context || typeof context.getTools !== 'function' || typeof context.executeTool !== 'function') {
    return { supported: false };
  }
  const tools = await context.getTools();
  return {
    supported: true,
    tools: tools.map(tool => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? null
    }))
  };
})()`

function callExpression(name: string, args: Record<string, unknown>): string {
  return `(async () => {
    const context = document.modelContext;
    if (!context || typeof context.getTools !== 'function' || typeof context.executeTool !== 'function') {
      return { supported: false };
    }
    const matches = (await context.getTools()).filter(tool => tool.name === ${JSON.stringify(name)});
    if (matches.length !== 1) return { supported: true, matchCount: matches.length };
    try {
      const result = await context.executeTool(matches[0], ${JSON.stringify(args)});
      return { supported: true, matchCount: 1, result };
    } catch (error) {
      return {
        supported: true,
        matchCount: 1,
        error: {
          name: typeof error?.name === 'string' ? error.name : 'Error',
          message: typeof error?.message === 'string' ? error.message : String(error)
        }
      };
    }
  })()`
}

export function createWebMcpDomain({
  getTargetTab,
  resolveFrameTarget,
  sendDebuggerCommand,
}: WebMcpDependencies) {
  async function evaluate<TValue>(
    tabId: number,
    frameId: string,
    expression: string,
    context?: CommandExecutionContext,
  ): Promise<TValue> {
    context?.throwIfCancelled()
    const world = await sendDebuggerCommand<{ executionContextId: number }>(
      tabId,
      'Page.createIsolatedWorld',
      { frameId, worldName: 'autobrowser-webmcp' },
      context,
    )
    context?.throwIfCancelled()
    const response = await sendDebuggerCommand<EvaluationResponse>(
      tabId,
      'Runtime.evaluate',
      {
        expression,
        contextId: world.executionContextId,
        awaitPromise: true,
        returnByValue: true,
        timeout: WEBMCP_EVALUATE_TIMEOUT_MS,
      },
      context,
    )
    if (response.exceptionDetails) {
      const message =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'WebMCP evaluation failed'
      throw webmcpError(message, 'WEBMCP_EVALUATION_ERROR')
    }
    return response.result?.value as TValue
  }

  async function resolveFrames(
    tabId: TabInput,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ): Promise<{ tab: TabWithId; frames: WebMcpFrame[] }> {
    const tab = await getTargetTab(tabId)
    const tree = await sendDebuggerCommand<{ frameTree: FrameTreeNode }>(
      tab.id,
      'Page.getFrameTree',
      {},
      context,
    )
    const allFrames = flattenFrames(tree.frameTree)
    if (!frameSelector || frameSelector === 'top') {
      return { tab, frames: frameSelector === 'top' ? allFrames.slice(0, 1) : allFrames }
    }
    const byId = allFrames.find((frame) => frame.id === frameSelector)
    if (byId) return { tab, frames: [byId] }
    const resolved = await resolveFrameTarget(tab.id, frameSelector)
    const frame = allFrames.find((item) => item.id === resolved.frameId)
    if (!frame) {
      throw webmcpError(`frame not found: ${frameSelector}`, 'FRAME_NOT_FOUND')
    }
    return { tab, frames: [frame] }
  }

  async function list(
    tabId: TabInput,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const { tab, frames } = await resolveFrames(tabId, frameSelector, context)
    const tools: ToolEntry[] = []
    const errors: Array<{ frame: WebMcpFrame; message: string }> = []
    let supportedFrames = 0
    for (const frame of frames) {
      context?.throwIfCancelled()
      try {
        const discovery = await evaluate<{ supported?: boolean; tools?: RawTool[] }>(
          tab.id,
          frame.id,
          DISCOVERY_EXPRESSION,
          context,
        )
        if (!discovery?.supported) continue
        supportedFrames += 1
        for (const tool of discovery.tools || []) {
          if (typeof tool.name !== 'string' || !tool.name) continue
          tools.push({
            name: tool.name,
            title: typeof tool.title === 'string' ? tool.title : null,
            description: typeof tool.description === 'string' ? tool.description : '',
            ...parseSchema(tool.inputSchema),
            annotations: tool.annotations ?? null,
            frame,
            untrusted: true,
          })
        }
      } catch (error) {
        if (frameSelector) throw error
        errors.push({ frame, message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (!supportedFrames) {
      if (errors.length === frames.length && errors.length) {
        throw webmcpError(
          'Unable to inspect any frame for WebMCP tools',
          'WEBMCP_FRAME_ERROR',
          undefined,
          {
            errors,
          },
        )
      }
      throw webmcpError(
        'WebMCP is not supported or is not enabled in this browser/frame',
        'WEBMCP_UNSUPPORTED',
        'Use a WebMCP-capable browser and enable the required WebMCP feature; do not substitute arbitrary eval.',
      )
    }
    return {
      tools,
      untrusted: true as const,
      frameCount: frames.length,
      supportedFrames,
      ...(errors.length ? { errors } : {}),
    }
  }

  async function call(
    tabId: TabInput,
    frameSelector: FrameSelector,
    name: string,
    args: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) {
    const listed = await list(tabId, frameSelector, context)
    const candidates = listed.tools.filter((tool) => tool.name === name)
    if (!candidates.length) {
      throw webmcpError(
        `WebMCP tool not found: ${name}`,
        'WEBMCP_TOOL_NOT_FOUND',
        'Run webmcp list to refresh the available tools.',
      )
    }
    if (candidates.length > 1) {
      throw webmcpError(
        `WebMCP tool is ambiguous across frames: ${name}`,
        'WEBMCP_AMBIGUOUS_TOOL',
        'Pass --frame with the frame id returned by webmcp list.',
        { candidates: candidates.map(({ frame }) => frame), untrusted: true },
      )
    }
    const frame = candidates[0]!.frame
    const tab = await getTargetTab(tabId)
    const response = await evaluate<{
      supported?: boolean
      matchCount?: number
      result?: unknown
      error?: { name?: string; message?: string }
    }>(tab.id, frame.id, callExpression(name, args), context)
    if (!response?.supported) {
      throw webmcpError('WebMCP is no longer available in the selected frame', 'WEBMCP_UNSUPPORTED')
    }
    if (response.matchCount !== 1) {
      throw webmcpError(
        `WebMCP tool changed between discovery and call: ${name}`,
        response.matchCount ? 'WEBMCP_AMBIGUOUS_TOOL' : 'WEBMCP_TOOL_NOT_FOUND',
        'Run webmcp list again before retrying.',
      )
    }
    if (response.error) {
      throw webmcpError(
        response.error.message || 'WebMCP tool execution failed',
        'WEBMCP_TOOL_ERROR',
        'Inspect the untrusted tool error and input arguments before retrying.',
        { untrusted: true, ...response.error },
      )
    }
    return { name, frame, untrusted: true as const, result: parseResult(response.result) }
  }

  return { list, call }
}
