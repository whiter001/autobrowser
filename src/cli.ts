/// <reference types="bun" />
/// <reference types="node" />
/// <reference lib="dom" />

import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import {
  resolveConnectLaunchConfig,
  resolveExtensionId,
  type BrowserLaunchConfig,
} from './core/config.js'
import { getExtensionUrl } from './core/extension.js'
import { buildHarPayload, compareHarRecords } from './core/har.js'
import { validateCommandArgs } from './core/command-spec.js'
import { commandSupportsFrameTarget, commandSupportsTabTarget } from './core/command-spec.js'
import {
  DEFAULT_IPC_PORT,
  DEFAULT_RELAY_PORT,
  getHomeDir,
  getTokenPath,
  isValidPort,
  writeJsonFile,
} from './core/protocol.js'
import { printHelp } from './cli/help.js'
import { type ScreenshotArgs } from './cli/parse.js'
import {
  getStatus,
  isRecord,
  requestCommandRaw,
  shouldTriggerAutoConnect,
  type CommandResponse,
} from './cli/client.js'
import { CommandResultError, writeResult as baseWriteResult } from './cli/output.js'
import {
  buildServerLaunchArgs,
  isServerSnapshotOnPorts,
  type ServerSnapshotStatus,
  isServerSnapshotStatus,
  killDetachedProcess,
  normalizeSavedPort,
  parseWindowsNetstatListeningPid,
  readPersistedConnectionInfo,
  spawnDetachedProcess,
  waitForServerStatus,
} from './cli/server-control.js'
import { COMMAND_REGISTRY } from './cli/commands/index.js'
import { type CommandContext } from './cli/commands/types.js'
import { type CliDependencies, type CliFlags, type ParsedCli } from './cli/types.js'

const execFileAsync = promisify(execFile)
const JSON_INDENT = '  '

const SUPPORTED_GLOBAL_FLAGS = [
  '--json',
  '--raw',
  '--stdin',
  '--base64',
  '--tab',
  '--frame',
  '--file',
  '--server',
  '--relay-port',
  '--ipc-port',
  '--extension-id',
  '--auto-connect',
  '--browser-command',
  '--browser-arg',
]

function readFlagValue(argv: string[], index: number, flag: string): string {
  if (index + 1 >= argv.length) {
    throw new Error(`missing value for ${flag}`)
  }

  const value = argv[index + 1]
  if (value === undefined) {
    throw new Error(`missing value for ${flag}`)
  }

  return value
}

function parsePortFlag(value: string, flag: string): number {
  const port = Number(value)
  if (!isValidPort(port)) {
    throw new Error(
      `invalid ${flag} ${JSON.stringify(value)}: expected an integer between 1 and 65535`,
    )
  }

  return port
}

function parseCli(argv: string[]): ParsedCli {
  const flags: CliFlags = {
    json: true,
    server: `http://127.0.0.1:${DEFAULT_IPC_PORT}`,
    relayPort: DEFAULT_RELAY_PORT,
    ipcPort: DEFAULT_IPC_PORT,
    extensionId: null,
    autoConnect: false,
    browserCommand: null,
    browserArgs: [],
    stdin: false,
    file: null,
    base64: false,
    tab: null,
    frame: null,
  }

  const args: string[] = []
  let serverExplicitlySet = false

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--json') {
      flags.json = true
      continue
    }

    if (value === '--raw') {
      flags.json = false
      continue
    }

    if (value === '--stdin') {
      flags.stdin = true
      continue
    }

    if (value === '--base64') {
      flags.base64 = true
      continue
    }

    if (value === '--tab') {
      flags.tab = readFlagValue(argv, index, value)
      index += 1
      continue
    }

    if (value === '--frame') {
      flags.frame = readFlagValue(argv, index, value)
      index += 1
      continue
    }

    if (value === '--file') {
      flags.file = readFlagValue(argv, index, value)
      index += 1
      continue
    }

    if (value === '--server') {
      flags.server = readFlagValue(argv, index, value)
      serverExplicitlySet = true
      index += 1
      continue
    }

    if (value === '--relay-port') {
      flags.relayPort = parsePortFlag(readFlagValue(argv, index, value), value)
      index += 1
      continue
    }

    if (value === '--ipc-port') {
      flags.ipcPort = parsePortFlag(readFlagValue(argv, index, value), value)
      if (!serverExplicitlySet) {
        flags.server = `http://127.0.0.1:${flags.ipcPort}`
      }
      index += 1
      continue
    }

    if (value === '--extension-id') {
      flags.extensionId = readFlagValue(argv, index, value)
      index += 1
      continue
    }

    if (value === '--auto-connect') {
      flags.autoConnect = true
      continue
    }

    if (value === '--browser-command') {
      flags.browserCommand = readFlagValue(argv, index, value)
      index += 1
      continue
    }

    if (value === '--browser-arg') {
      flags.browserArgs.push(readFlagValue(argv, index, value))
      index += 1
      continue
    }

    // 命令名（首个位置参数）之前的 --flag 只能是全局 flag；
    // 拼错时直接报错，避免被静默当成命令名/位置参数发给扩展
    if (args.length === 0 && value.startsWith('--') && value !== '--help') {
      throw new Error(
        `unsupported global option: ${value} (supported: ${SUPPORTED_GLOBAL_FLAGS.join(', ')})`,
      )
    }

    args.push(value)
  }

  return { flags, args }
}

function* serializeJsonValue(
  value: unknown,
  depth: number = 0,
  seen: Set<object> = new Set<object>(),
): Generator<string> {
  if (value === null) {
    yield 'null'
    return
  }

  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    yield JSON.stringify(value)
    return
  }

  if (valueType === 'bigint') {
    throw new TypeError('Do not know how to serialize a BigInt')
  }

  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol') {
    yield 'null'
    return
  }

  const objectValue = value as Record<string, unknown>
  if (seen.has(objectValue)) {
    throw new TypeError('Converting circular structure to JSON')
  }

  seen.add(objectValue)
  try {
    if (Array.isArray(objectValue)) {
      if (objectValue.length === 0) {
        yield '[]'
        return
      }

      yield '[\n'
      for (let index = 0; index < objectValue.length; index += 1) {
        yield `${JSON_INDENT.repeat(depth + 1)}`
        const item = objectValue[index]
        yield* serializeJsonValue(
          item === undefined || typeof item === 'function' || typeof item === 'symbol'
            ? null
            : item,
          depth + 1,
          seen,
        )
        yield index < objectValue.length - 1 ? ',\n' : '\n'
      }

      yield `${JSON_INDENT.repeat(depth)}]`
      return
    }

    const entries = Object.entries(objectValue).filter(([, entryValue]) => {
      const entryType = typeof entryValue
      return entryValue !== undefined && entryType !== 'function' && entryType !== 'symbol'
    })

    if (entries.length === 0) {
      yield '{}'
      return
    }

    yield '{\n'
    for (let index = 0; index < entries.length; index += 1) {
      const [key, entryValue] = entries[index]!
      yield `${JSON_INDENT.repeat(depth + 1)}${JSON.stringify(key)}: `
      yield* serializeJsonValue(entryValue, depth + 1, seen)
      yield index < entries.length - 1 ? ',\n' : '\n'
    }

    yield `${JSON_INDENT.repeat(depth)}}`
  } finally {
    seen.delete(objectValue)
  }
}

function* serializeJsonDocument(value: unknown): Generator<string> {
  yield* serializeJsonValue(value)
  yield '\n'
}

async function writeHarFile(har: unknown, outputPath: string | null): Promise<string> {
  const targetPath = outputPath || path.join(await mkTempHarDir(), 'network.har')
  await mkdir(path.dirname(targetPath), { recursive: true })
  await pipeline(Readable.from(serializeJsonDocument(har)), createWriteStream(targetPath, 'utf8'))
  return targetPath
}

async function mkTempHarDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'autobrowser-har-'))
}

async function mkTempScreenshotDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'autobrowser-screenshot-'))
}

function extractScreenshotData(result: Record<string, unknown> | undefined): {
  data: Buffer
  mimeType: string
} {
  const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl : ''
  const rawData =
    typeof result?.data === 'string'
      ? result.data
      : dataUrl.includes(',')
        ? dataUrl.slice(dataUrl.indexOf(',') + 1)
        : ''

  if (!rawData) {
    throw new Error('missing screenshot data')
  }

  const mimeType =
    typeof result?.mimeType === 'string'
      ? result.mimeType
      : dataUrl.startsWith('data:image/jpeg')
        ? 'image/jpeg'
        : 'image/png'

  return {
    data: Buffer.from(rawData, 'base64'),
    mimeType,
  }
}

async function resolveScreenshotOutputPath(screenshotArgs: ScreenshotArgs): Promise<string> {
  if (screenshotArgs.path) {
    await mkdir(path.dirname(screenshotArgs.path), { recursive: true })
    return screenshotArgs.path
  }

  const outputDir = screenshotArgs.screenshotDir || (await mkTempScreenshotDir())
  await mkdir(outputDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const extension = screenshotArgs.format === 'jpeg' ? 'jpeg' : 'png'
  return path.join(outputDir, `screenshot-${timestamp}.${extension}`)
}

function writeHelp(pathParts: string[] = []): 0 {
  const normalized = printHelp(pathParts).replace(/\r\n?/g, '\n')
  for (const line of normalized.split('\n')) {
    process.stdout.write(`${line}\n`)
  }
  return 0
}

function createInvalidCommandArgsResponse(error: unknown): CommandResponse {
  const message = error instanceof Error ? error.message : String(error)
  const validationError = error as { code?: string; details?: unknown }

  return {
    ok: false,
    error: {
      message,
      code: validationError.code || 'INVALID_COMMAND_ARGS',
      ...(typeof validationError.details !== 'undefined'
        ? { details: validationError.details }
        : {}),
    },
  }
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

export function buildSystemOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] }
  }

  if (platform === 'win32') {
    return {
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
    }
  }

  return { command: 'xdg-open', args: [url] }
}

async function openUrl(url: string, browserConfig: BrowserLaunchConfig | null): Promise<void> {
  if (browserConfig?.command) {
    await execFileAsync(browserConfig.command, [...browserConfig.args, url])
    return
  }

  const systemOpenCommand = buildSystemOpenCommand(process.platform, url)
  await execFileAsync(systemOpenCommand.command, systemOpenCommand.args)
}

function getLocalControlBaseUrl(ipcPort: number): string {
  return `http://127.0.0.1:${ipcPort}`
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function targetsLocalControlServer(baseUrl: string, ipcPort: number): boolean {
  try {
    const url = new URL(baseUrl)
    const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'))

    return url.protocol === 'http:' && isLoopbackHostname(url.hostname) && port === ipcPort
  } catch {
    return false
  }
}

function isServerConnectionError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase()

  return (
    message.includes('unable to connect') ||
    message.includes('status unavailable') ||
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('econnrefused') ||
    message.includes('connection refused') ||
    message.includes('econnreset')
  )
}

interface ConnectionRecoveryHints {
  localTarget: boolean
  serverStartAttempted: boolean
  serverStarted: boolean
  connectPageAttempted: boolean
  connectPageOpened: boolean
}

function createConnectionRecoveryHints(localTarget: boolean): ConnectionRecoveryHints {
  return {
    localTarget,
    serverStartAttempted: false,
    serverStarted: false,
    connectPageAttempted: false,
    connectPageOpened: false,
  }
}

function formatConnectionRecoveryMessage(
  baseUrl: string,
  originalMessage: string,
  options: {
    problem: 'server-unreachable' | 'extension-disconnected'
    recoveryHints: ConnectionRecoveryHints
  },
): string {
  const lines: string[] = []
  const { recoveryHints } = options

  if (options.problem === 'server-unreachable') {
    lines.push(
      recoveryHints.localTarget
        ? `autobrowser could not reach its local control server at ${baseUrl}.`
        : `autobrowser could not reach its configured control server at ${baseUrl}.`,
    )
  } else {
    lines.push('autobrowser is not connected to a browser yet.')
  }

  lines.push('Recovery status:')

  if (recoveryHints.localTarget) {
    if (recoveryHints.serverStartAttempted) {
      lines.push(
        recoveryHints.serverStarted
          ? '- The local autobrowser server was started automatically.'
          : '- autobrowser tried to start the local server automatically, but it did not become ready.',
      )
    } else if (options.problem === 'server-unreachable') {
      lines.push('- The local autobrowser server did not respond.')
    }
  } else if (options.problem === 'server-unreachable') {
    lines.push('- The configured remote autobrowser server was not auto-started.')
  }

  if (recoveryHints.connectPageAttempted || recoveryHints.connectPageOpened) {
    lines.push(
      recoveryHints.connectPageOpened
        ? '- autobrowser opened the connect page automatically.'
        : '- autobrowser tried to open the connect page automatically, but that failed.',
    )
  }

  lines.push('Next steps:')

  let step = 1

  if (!recoveryHints.localTarget) {
    lines.push(`${step}. Make sure the autobrowser server at ${baseUrl} is reachable.`)
    step += 1
  }

  if (recoveryHints.connectPageOpened) {
    lines.push(`${step}. Complete the connect page that autobrowser opened automatically.`)
  } else {
    lines.push(`${step}. Run \`autobrowser connect\` if the connect page is not already open.`)
  }
  step += 1

  lines.push(
    `${step}. Keep Chrome or Edge running with the autobrowser extension installed and enabled.`,
  )
  step += 1

  lines.push(`${step}. Wait for \`autobrowser status\` to show \`extension: connected\`.`)
  step += 1

  lines.push(`${step}. Retry the original command.`)
  lines.push(`Original error: ${originalMessage}`)

  return lines.join('\n')
}

interface ConnectionTarget {
  token: string
  relayPort: number
  ipcPort: number
}

interface NetworkRequestSummary {
  id?: string
  requestId?: string
  tabId?: number
  url?: string
  method?: string
  resourceType?: string
  status?: number
  statusText?: string
  startedAt?: string
  durationMs?: number
}

const HAR_MIME_TYPES: Record<string, string> = {
  Document: 'text/html',
  XHR: 'application/json',
  Fetch: 'application/json',
  Script: 'application/javascript',
  Stylesheet: 'text/css',
  Image: 'image/*',
  Font: 'font/woff2',
  Ping: 'text/plain',
  Manifest: 'application/json',
  Other: 'application/octet-stream',
}

function buildFallbackHarEntry(summary: NetworkRequestSummary): Record<string, unknown> {
  const resourceType = String(summary.resourceType || 'Other')
  const mimeType = HAR_MIME_TYPES[resourceType] || 'application/octet-stream'
  const startedDateTime =
    typeof summary.startedAt === 'string' ? summary.startedAt : new Date().toISOString()
  const durationMs = typeof summary.durationMs === 'number' ? summary.durationMs : 0

  return {
    startedDateTime,
    time: durationMs,
    request: {
      method: summary.method || 'GET',
      url: summary.url || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: Number(summary.status || 0),
      statusText: String(summary.statusText || ''),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: {
        size: 0,
        mimeType,
        text: '',
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: {
      send: 0,
      wait: durationMs,
      receive: 0,
    },
    pageref:
      summary.tabId === null || summary.tabId === undefined ? undefined : `tab-${summary.tabId}`,
  }
}

async function collectHarFromNetwork(
  baseUrl: string,
  startedAt: string | null,
  token: string | null = null,
): Promise<Record<string, unknown>> {
  const requestListPayload = await requestCommandRaw(
    baseUrl,
    'network',
    {
      action: 'requests',
    },
    { token },
  )

  if (requestListPayload?.ok === false) {
    throw new Error(requestListPayload.error?.message || 'failed to read network requests')
  }

  const requestListResult = isRecord(requestListPayload?.result)
    ? (requestListPayload.result as Record<string, unknown>)
    : null
  const requestSummaries = Array.isArray(requestListResult?.requests)
    ? requestListResult.requests.filter(isRecord).map((request) => request as NetworkRequestSummary)
    : []

  const filteredSummaries = requestSummaries
    .filter((request) => !startedAt || String(request.startedAt || '') >= startedAt)
    .sort((left, right) => compareHarRecords(left, right))

  // 逐条回拉 harEntry 是 N+1 往返，用有界并发池提速；按原列表下标写入以保持输出顺序
  const entries: Record<string, unknown>[] = Array.from({ length: filteredSummaries.length })
  const HAR_DETAIL_CONCURRENCY = 8
  let nextIndex = 0

  const collectOne = (request: NetworkRequestSummary): Promise<Record<string, unknown>> => {
    const requestId = String(request.requestId || request.id || '')
    if (!requestId) {
      return Promise.resolve(buildFallbackHarEntry(request))
    }

    return requestCommandRaw(
      baseUrl,
      'network',
      {
        action: 'request',
        requestId,
      },
      { token },
    )
      .then((requestPayload) => {
        if (requestPayload?.ok === false) {
          return buildFallbackHarEntry(request)
        }

        const requestResult = isRecord(requestPayload?.result)
          ? (requestPayload.result as Record<string, unknown>)
          : null
        const harEntry = isRecord(requestResult?.harEntry) ? requestResult.harEntry : null

        return harEntry || buildFallbackHarEntry(request)
      })
      .catch(() => buildFallbackHarEntry(request))
  }

  const worker = async () => {
    while (nextIndex < filteredSummaries.length) {
      const index = nextIndex
      nextIndex += 1
      entries[index] = await collectOne(filteredSummaries[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HAR_DETAIL_CONCURRENCY, filteredSummaries.length) }, () =>
      worker(),
    ),
  )

  return buildHarPayload(entries)
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
  const { flags, args } = parseCli(argv)
  const [command, ...rest] = args
  const homeDir = getHomeDir()
  const launchUrl = dependencies.openUrl ?? openUrl
  let connectPageOpened = false
  let commandToken: string | null | undefined

  const openRelayConnectPage = async (relayPort: number): Promise<void> => {
    await launchUrl(`http://127.0.0.1:${relayPort}/connect`, null)
  }

  async function resolveConnectionTarget(
    status: Record<string, unknown> | ServerSnapshotStatus | null,
  ): Promise<ConnectionTarget> {
    const serverStatus = isServerSnapshotStatus(status) ? status : null
    const persistedConnectionInfo = await readPersistedConnectionInfo(
      flags.relayPort,
      flags.ipcPort,
    )

    const token =
      typeof serverStatus?.token === 'string' && serverStatus.token
        ? serverStatus.token
        : persistedConnectionInfo?.token || ''

    if (token) {
      commandToken = token
    }

    const relayPort = normalizeSavedPort(
      serverStatus?.relayPort ?? persistedConnectionInfo?.relayPort,
      flags.relayPort,
    )
    const ipcPort = normalizeSavedPort(
      serverStatus?.ipcPort ?? persistedConnectionInfo?.ipcPort,
      flags.ipcPort,
    )

    return {
      token,
      relayPort,
      ipcPort,
    }
  }

  async function openExtensionConnectPage(target: ConnectionTarget): Promise<void> {
    const { browserConfig, extensionId } = await resolveConnectLaunchConfig(homeDir, {
      extensionId: flags.extensionId,
      browserCommand: flags.browserCommand,
      browserArgs: flags.browserArgs,
    })

    await launchUrl(
      getExtensionUrl(
        '/connect.html',
        {
          token: target.token,
          relayPort: target.relayPort,
          ipcPort: target.ipcPort,
        },
        extensionId,
      ),
      browserConfig,
    )
  }

  async function openConnectFlow(
    status: Record<string, unknown> | ServerSnapshotStatus | null,
    allowRelayFallback: boolean,
    recoveryHints: ConnectionRecoveryHints | null = null,
  ): Promise<boolean> {
    const target = await resolveConnectionTarget(status)

    if (!target.token) {
      if (!allowRelayFallback) {
        return false
      }

      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openRelayConnectPage(target.relayPort)
      if (recoveryHints) {
        recoveryHints.connectPageOpened = true
      }
      return true
    }

    try {
      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openExtensionConnectPage(target)
      if (recoveryHints) {
        recoveryHints.connectPageOpened = true
      }
      return true
    } catch (error) {
      if (!allowRelayFallback) {
        throw error
      }

      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openRelayConnectPage(target.relayPort)
      if (recoveryHints) {
        recoveryHints.connectPageOpened = true
      }
      return true
    }
  }

  async function ensureBackgroundServerStatus(
    recoveryHints: ConnectionRecoveryHints | null = null,
  ): Promise<{
    status: ServerSnapshotStatus
    started: boolean
  } | null> {
    const controlBaseUrl = getLocalControlBaseUrl(flags.ipcPort)
    const existingStatus = await getStatus(controlBaseUrl).catch(() => null)

    if (isServerSnapshotOnPorts(existingStatus, flags.relayPort, flags.ipcPort)) {
      return {
        status: existingStatus,
        started: false,
      }
    }

    if (recoveryHints) {
      recoveryHints.serverStartAttempted = true
    }

    const extensionId = await resolveExtensionId(homeDir, flags.extensionId)
    const spawnCommand = dependencies.spawnDetachedProcess ?? spawnDetachedProcess
    let backgroundProcess

    try {
      backgroundProcess = await spawnCommand(
        'bun',
        buildServerLaunchArgs(
          {
            relayPort: flags.relayPort,
            ipcPort: flags.ipcPort,
          },
          extensionId,
        ),
      )
    } catch {
      return null
    }

    const readyResult = backgroundProcess.waitForExit
      ? await Promise.race([
          waitForServerStatus(controlBaseUrl, flags.relayPort, flags.ipcPort).then((status) => ({
            kind: 'ready' as const,
            status,
          })),
          backgroundProcess.waitForExit().then((exitInfo) => ({
            kind: 'exit' as const,
            exitInfo,
          })),
        ])
      : {
          kind: 'ready' as const,
          status: await waitForServerStatus(controlBaseUrl, flags.relayPort, flags.ipcPort),
        }

    if (readyResult.kind === 'exit') {
      return null
    }

    if (!readyResult.status) {
      killDetachedProcess(backgroundProcess)
      return null
    }

    if (recoveryHints) {
      recoveryHints.serverStarted = true
    }

    return {
      status: readyResult.status,
      started: true,
    }
  }

  async function assistCommandConnection(
    baseUrl: string,
    recoveryHints: ConnectionRecoveryHints,
  ): Promise<boolean> {
    let status: Record<string, unknown> | ServerSnapshotStatus | null = await getStatus(
      baseUrl,
    ).catch(() => null)

    if (!isServerSnapshotStatus(status) && targetsLocalControlServer(baseUrl, flags.ipcPort)) {
      const serverState = await ensureBackgroundServerStatus(recoveryHints)
      status = serverState?.status || null
    }

    if (!isServerSnapshotStatus(status)) {
      return false
    }

    if (status.extensionConnected === false) {
      try {
        const opened = await openConnectFlow(status, true, recoveryHints)
        if (opened) {
          connectPageOpened = true
        }
        return opened
      } catch {
        return false
      }
    }

    return true
  }

  async function triggerAutoConnect(
    baseUrl: string,
    force: boolean = false,
    recoveryHints: ConnectionRecoveryHints | null = null,
  ): Promise<boolean> {
    if ((!flags.autoConnect && !force) || connectPageOpened) {
      return false
    }

    const status = await getStatus(baseUrl).catch(() => null)
    if (!status || status.extensionConnected !== false) {
      return false
    }

    const target = await resolveConnectionTarget(status)
    if (!target.token) {
      return false
    }

    try {
      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openExtensionConnectPage(target)
      connectPageOpened = true
      if (recoveryHints) {
        recoveryHints.connectPageOpened = true
      }
      return true
    } catch (error) {
      console.warn('failed to proactively open extension connect page', error)
      return false
    }
  }

  const createConnectionErrorBuilder =
    (baseUrl: string, recoveryHints: ConnectionRecoveryHints) =>
    (problem: 'server-unreachable' | 'extension-disconnected', message: string): string =>
      formatConnectionRecoveryMessage(baseUrl, message, {
        problem,
        recoveryHints: {
          ...recoveryHints,
          connectPageOpened: recoveryHints.connectPageOpened || connectPageOpened,
        },
      })

  async function getCommandStatus(
    baseUrl: string,
    recoveryHints: ConnectionRecoveryHints = createConnectionRecoveryHints(
      targetsLocalControlServer(baseUrl, flags.ipcPort),
    ),
  ): Promise<Record<string, unknown>> {
    const buildConnectionError = createConnectionErrorBuilder(baseUrl, recoveryHints)

    try {
      return await getStatus(baseUrl)
    } catch (error) {
      if (!isServerConnectionError(error)) {
        throw error
      }

      if (!recoveryHints.localTarget) {
        throw new Error(
          buildConnectionError(
            'server-unreachable',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }

      const serverState = await ensureBackgroundServerStatus(recoveryHints)
      if (!serverState) {
        throw new Error(
          buildConnectionError(
            'server-unreachable',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }

      try {
        return await getStatus(baseUrl)
      } catch (retryError) {
        if (!isServerConnectionError(retryError)) {
          throw retryError
        }

        throw new Error(
          buildConnectionError(
            'server-unreachable',
            retryError instanceof Error ? retryError.message : String(retryError),
          ),
        )
      }
    }
  }

  async function getCdpUrlForCommand(baseUrl: string): Promise<string> {
    const recoveryHints = createConnectionRecoveryHints(
      targetsLocalControlServer(baseUrl, flags.ipcPort),
    )
    const status = await getCommandStatus(baseUrl, recoveryHints)
    const relayPort = Number(status.relayPort || DEFAULT_RELAY_PORT)
    const token = typeof status.token === 'string' ? status.token : ''

    if (!token) {
      const buildConnectionError = createConnectionErrorBuilder(baseUrl, recoveryHints)
      throw new Error(buildConnectionError('extension-disconnected', 'missing token'))
    }

    return `ws://127.0.0.1:${relayPort}/ws?token=${encodeURIComponent(token)}`
  }

  async function resolveCommandToken(): Promise<string | null> {
    if (commandToken !== undefined) {
      return commandToken
    }

    const persistedConnectionInfo = await readPersistedConnectionInfo(
      flags.relayPort,
      flags.ipcPort,
    )
    commandToken = persistedConnectionInfo?.token || null
    return commandToken
  }

  async function requestCommandWithToken(
    baseUrl: string,
    command: string,
    args: Record<string, unknown>,
  ): Promise<CommandResponse> {
    const token = await resolveCommandToken()
    const payload = await requestCommandRaw(baseUrl, command, args, { token })
    if (payload.ok !== false || payload.error?.code !== 'UNAUTHORIZED') {
      return payload
    }

    const status = await getStatus(baseUrl).catch(() => null)
    const target = await resolveConnectionTarget(status)
    if (!target.token || target.token === token) {
      return payload
    }

    commandToken = target.token
    try {
      await writeJsonFile(getTokenPath(homeDir), { token: target.token })
    } catch {
      // 令牌写盘失败不应阻断本次重试；下一次运行仍可重新读取状态重新发现。
    }

    return await requestCommandRaw(baseUrl, command, args, { token: target.token })
  }

  async function requestCommand(
    baseUrl: string,
    command: string,
    args: object = {},
  ): Promise<CommandResponse> {
    const requestArgs: Record<string, unknown> = { ...args }
    if (commandSupportsTabTarget(command) && requestArgs.tabId === undefined && flags.tab) {
      requestArgs.tabId = flags.tab
    }
    if (commandSupportsFrameTarget(command) && requestArgs.frame === undefined && flags.frame) {
      requestArgs.frame = flags.frame
    }

    try {
      validateCommandArgs(command, requestArgs)
    } catch (error) {
      return createInvalidCommandArgsResponse(error)
    }

    if (flags.autoConnect && !connectPageOpened) {
      await triggerAutoConnect(baseUrl)
    }

    const recoveryHints = createConnectionRecoveryHints(
      targetsLocalControlServer(baseUrl, flags.ipcPort),
    )
    const buildConnectionError = createConnectionErrorBuilder(baseUrl, recoveryHints)

    const withConnectionHelp = (payload: CommandResponse): CommandResponse => {
      if (payload.ok !== false) {
        return payload
      }

      return {
        ...payload,
        error: {
          ...payload.error,
          message: buildConnectionError(
            'extension-disconnected',
            payload.error?.message || 'no extension is connected',
          ),
        },
      }
    }

    let payload: CommandResponse

    try {
      payload = await requestCommandWithToken(baseUrl, command, requestArgs)
    } catch (error) {
      if (!isServerConnectionError(error)) {
        throw error
      }

      const recovered = await assistCommandConnection(baseUrl, recoveryHints)
      if (!recovered) {
        throw new Error(
          buildConnectionError(
            'server-unreachable',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }

      try {
        payload = await requestCommandWithToken(baseUrl, command, requestArgs)
      } catch (retryError) {
        if (!isServerConnectionError(retryError)) {
          throw retryError
        }

        throw new Error(
          buildConnectionError(
            'server-unreachable',
            retryError instanceof Error ? retryError.message : String(retryError),
          ),
        )
      }
    }

    if (shouldTriggerAutoConnect(payload)) {
      const opened = await triggerAutoConnect(baseUrl, true, recoveryHints)
      if (opened) {
        try {
          const retriedPayload = await requestCommandWithToken(baseUrl, command, requestArgs)
          return shouldTriggerAutoConnect(retriedPayload)
            ? withConnectionHelp(retriedPayload)
            : retriedPayload
        } catch (error) {
          if (!isServerConnectionError(error)) {
            throw error
          }

          throw new Error(
            buildConnectionError(
              'server-unreachable',
              error instanceof Error ? error.message : String(error),
            ),
          )
        }
      }

      return withConnectionHelp(payload)
    }

    return payload
  }

  const writeResult = (
    payload:
      | CommandResponse
      | Record<string, unknown>
      | string
      | number
      | boolean
      | bigint
      | null
      | undefined,
  ): void => {
    baseWriteResult(payload, { json: flags.json })
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
    getCdpUrl: getCdpUrlForCommand,
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
  if (handler) {
    return await handler(rest, context)
  }

  process.stderr.write(`${printHelp()}\n`)
  return 1
}

export async function main(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number | void> {
  try {
    return await runMain(argv, dependencies)
  } catch (error) {
    if (error instanceof CommandResultError) {
      return 1
    }

    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
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

export { parseWindowsNetstatListeningPid }
