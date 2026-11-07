/// <reference types="bun" />
/// <reference types="node" />
/// <reference lib="dom" />

import { readFile } from 'node:fs/promises'
import { getStatus, isRecord } from './cli/client.js'
import { CLI_ERROR_CODES, CliUsageError, writeCliError } from './cli/cli-error.js'
import { COMMAND_REGISTRY } from './cli/commands/index.js'
import { type CommandContext, type CommandResultPayload } from './cli/commands/types.js'
import { createConnectionFlow } from './cli/connection-flow.js'
import { collectHarFromNetwork, writeHarFile } from './cli/har.js'
import { printHelp } from './cli/help.js'
import { resolveInvocation } from './cli/invocation.js'
import { didYouMeanCommand } from './cli/option-hints.js'
import { writeResult as baseWriteResult } from './cli/output.js'
import { extractScreenshotData, resolveScreenshotOutputPath } from './cli/screenshot.js'
import { type CliDependencies, type CliFlags } from './cli/types.js'
import { createWebDriverCommandHandler } from './cli/webdriver.js'

// 未知命令的纠错候选来自命令注册表：它是"哪些命令真的能跑"的唯一事实来源
const COMMAND_NAME_CANDIDATES = Object.keys(COMMAND_REGISTRY).filter(
  (name) => !name.startsWith('-'),
)

/**
 * flags 解析失败时也要知道该用 JSON 还是文本输出。
 * --json 是默认行为，只有显式 --raw/--brief 才退回文本模式。
 */
function resolveOutputMode(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === '--') break
    if (arg === '--raw' || arg === '--brief') return false
  }
  return true
}

function createUnknownCommandError(command: string): CliUsageError {
  const candidates = didYouMeanCommand(command, COMMAND_NAME_CANDIDATES)
  const message =
    candidates.length > 0
      ? `Unknown command "${command}". Did you mean: ${candidates.join(', ')}?`
      : `Unknown command "${command}".`

  return new CliUsageError(message, {
    code: CLI_ERROR_CODES.UNKNOWN_COMMAND,
    details: { command, ...(candidates.length > 0 ? { candidates } : {}) },
    suggestedAction:
      candidates.length > 0
        ? `Run 'autobrowser help' to list every command, then retry with one of: ${candidates.join(', ')}.`
        : "Run 'autobrowser help' to list every available command, then retry with an exact command name.",
  })
}

function writeHelp(pathParts: string[] = []): 0 {
  const normalized = printHelp(pathParts).replace(/\r\n?/g, '\n')
  for (const line of normalized.split('\n')) {
    process.stdout.write(`${line}\n`)
  }
  return 0
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return ''
  }

  let content = ''
  for await (const chunk of process.stdin) {
    content += chunk
  }

  return content
}

async function resolveEvalScript(flags: CliFlags, rest: string[]): Promise<string> {
  if (flags.file) {
    return await readFile(flags.file, 'utf8')
  }

  if (flags.base64) {
    const raw = rest.join(' ').trim()
    return Buffer.from(raw, 'base64').toString('utf8')
  }

  if (flags.stdin) {
    return await readStdin()
  }

  if (rest.length > 0) {
    return rest.join(' ')
  }

  return await readStdin()
}

async function runMain(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number | void> {
  const { flags, args, homeDir } = await resolveInvocation(argv)
  const [command, ...rest] = args
  const webDriverCommand =
    flags.engine === 'chromium'
      ? null
      : createWebDriverCommandHandler({
          engine: flags.engine,
          driverUrl:
            flags.webdriverUrl ||
            (flags.engine === 'firefox' ? 'http://127.0.0.1:4444' : 'http://127.0.0.1:4723'),
          homeDir,
        })
  const flow = createConnectionFlow({ flags, homeDir, dependencies, webDriverCommand })
  const { requestCommand, openConnectFlow, getCommandStatus, getCdpUrl, resolveCommandToken } = flow
  let lastResponseFailed = false
  const writeResult = (payload: CommandResultPayload): void => {
    baseWriteResult(payload, { json: flags.json })
    // 只看已写出的顶层响应；后续成功可恢复早期失败，batch 内部步骤不影响聚合结果。
    if (isRecord(payload) && typeof payload.ok === 'boolean') {
      lastResponseFailed = payload.ok === false
    }
  }

  const context: CommandContext = {
    flags,
    homeDir,
    dependencies,
    writeHelp,
    writeResult,
    requestCommand,
    openConnectFlow,
    getStatus,
    getCommandStatus,
    resolveEvalScript: async (evalRest) => await resolveEvalScript(flags, evalRest),
    getCdpUrl,
    extractScreenshotData,
    resolveScreenshotOutputPath,
    collectHarFromNetwork: async (baseUrl, startedAt) =>
      await collectHarFromNetwork(baseUrl, startedAt, await resolveCommandToken()),
    writeHarFile,
  }

  if (!command) {
    return writeHelp()
  }

  const handler = COMMAND_REGISTRY[command]
  if (!handler) {
    // 未知命令曾经直接打印整页根 help，用户和 agent 只能自己在上百行里找差异
    return writeCliError(createUnknownCommandError(command), { json: flags.json, command })
  }

  try {
    const code = await handler(rest, context)
    if (typeof code === 'number' && code !== 0) return code
    return lastResponseFailed ? 1 : code
  } catch (error) {
    // mcp 命令的 stdout 是 JSON-RPC 通道，错误只能写 stderr，否则会污染协议流
    if (command === 'mcp') {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    return writeCliError(error, { json: flags.json, command })
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number | void> {
  try {
    return await runMain(argv, dependencies)
  } catch (error) {
    // flags 解析阶段就失败时还没有 flags，只能从原始 argv 判断输出模式
    return writeCliError(error, { json: resolveOutputMode(argv) })
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      if (typeof code === 'number') {
        process.exitCode = code
      }
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
