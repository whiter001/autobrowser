/// <reference types="bun" />
/// <reference types="node" />
/// <reference lib="dom" />

import { readFile } from 'node:fs/promises'
import { getStatus, isRecord } from './cli/client.js'
import { CLI_ERROR_CODES, CliUsageError, writeCliError } from './cli/cli-error.js'
import { COMMAND_LOADERS } from './cli/commands/index.js'
import { type CommandContext, type CommandResultPayload } from './cli/commands/types.js'
import { createConnectionFlow } from './cli/connection-flow.js'
import { getCommandOptionCandidates, printHelp } from './cli/help.js'
import { resolveInvocation } from './cli/invocation.js'
import { didYouMeanCommand, optionHintSuffix } from './cli/option-hints.js'
import { writeResult as baseWriteResult } from './cli/output.js'
import { presentCommandResponse } from './cli/response-presenters.js'
import { extractScreenshotData, resolveScreenshotOutputPath } from './cli/screenshot.js'
import { type CliDependencies, type CliFlags } from './cli/types.js'
import { stripBom } from './core/text.js'

// 未知命令的纠错候选来自命令注册表：它是"哪些命令真的能跑"的唯一事实来源
const COMMAND_NAME_CANDIDATES = Object.keys(COMMAND_LOADERS).filter((name) => !name.startsWith('-'))

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

function addCommandOptionHint(error: unknown, command: string, rest: string[]): unknown {
  if (!(error instanceof Error) || error.message.includes('did you mean')) return error
  const match = /^(?:unsupported .*option|unexpected .*argument).*:\s*(--\S+)/.exec(error.message)
  if (!match) return error
  const suffix = optionHintSuffix(match[1], getCommandOptionCandidates([command, ...rest]))
  if (suffix) error.message += suffix
  return error
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
  // 统一剥掉 UTF-8 BOM：Windows PowerShell 写出的文件/管道都可能是带 BOM 的，
  // 而 JSON.parse 不接受 U+FEFF，报错信息里的 BOM 字符又不可见。
  if (flags.file) {
    return stripBom(await readFile(flags.file, 'utf8'))
  }

  if (flags.base64) {
    const raw = rest.join(' ').trim()
    return stripBom(Buffer.from(raw, 'base64').toString('utf8'))
  }

  if (flags.stdin) {
    return stripBom(await readStdin())
  }

  if (rest.length > 0) {
    return stripBom(rest.join(' '))
  }

  return stripBom(await readStdin())
}

async function runMain(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number | void> {
  const { flags, args, homeDir } = await resolveInvocation(argv)
  const [command, ...rest] = args
  // WebDriver 引擎只有 Firefox / WebKit 会用到，chromium 走扩展通道。
  // 这里按需加载，否则每条 chromium 命令都要白白解析一遍 WebDriver 实现。
  const webDriverCommand =
    flags.engine === 'chromium'
      ? null
      : (await import('./cli/webdriver.js')).createWebDriverCommandHandler({
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
    const presented = presentCommandResponse(command, payload, flags.responseFormat)
    baseWriteResult(presented as CommandResultPayload, {
      json: flags.json,
      responseFormat: flags.responseFormat,
    })
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
    // HAR 相关实现按需加载：只有 network har 这类命令真正用到时才解析它。
    collectHarFromNetwork: async (baseUrl, startedAt) => {
      const { collectHarFromNetwork } = await import('./cli/har.js')
      return await collectHarFromNetwork(baseUrl, startedAt, await resolveCommandToken())
    },
    writeHarFile: async (har, outputPath) => {
      const { writeHarFile } = await import('./cli/har.js')
      return await writeHarFile(har, outputPath)
    },
  }

  if (!command) {
    return writeHelp()
  }

  const loadHandler = COMMAND_LOADERS[command]
  if (!loadHandler) {
    // 未知命令曾经直接打印整页根 help，用户和 agent 只能自己在上百行里找差异
    return writeCliError(createUnknownCommandError(command), { json: flags.json, command })
  }

  try {
    // 实现按需加载：只有真正执行的那个命令才会加载自己的模块
    const handler = await loadHandler()
    const code = await handler(rest, context)
    if (typeof code === 'number' && code !== 0) return code
    return lastResponseFailed ? 1 : code
  } catch (error) {
    // mcp 命令的 stdout 是 JSON-RPC 通道，错误只能写 stderr，否则会污染协议流
    if (command === 'mcp') {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    return writeCliError(addCommandOptionHint(error, command, rest), {
      json: flags.json,
      command,
    })
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
