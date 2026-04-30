/// <reference types="bun-types" />
/// <reference types="node" />
/// <reference lib="dom" />

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { resolveConnectLaunchConfig, type BrowserLaunchConfig } from './core/config.js'
import { getExtensionUrl } from './core/extension.js'
import { buildHarPayload, compareHarRecords } from './core/har.js'
import { commandSupportsFrameTarget, commandSupportsTabTarget } from './core/command-spec.js'
import { DEFAULT_IPC_PORT, DEFAULT_RELAY_PORT, getHomeDir } from './core/protocol.js'
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
  isServerSnapshotStatus,
  normalizeSavedPort,
  parseWindowsNetstatListeningPid,
  readPersistedConnectionInfo,
} from './cli/server-control.js'
import { COMMAND_REGISTRY } from './cli/commands/index.js'
import { type CommandContext } from './cli/commands/types.js'
import { type CliDependencies, type CliFlags, type ParsedCli } from './cli/types.js'

const execFileAsync = promisify(execFile)

function parseCli(argv: string[]): ParsedCli {
  const flags: CliFlags = {
    json: false,
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

    if (value === '--stdin') {
      flags.stdin = true
      continue
    }

    if (value === '--base64') {
      flags.base64 = true
      continue
    }

    if (value === '--tab') {
      flags.tab = argv[index + 1] || null
      index += 1
      continue
    }

    if (value === '--frame') {
      flags.frame = argv[index + 1] || null
      index += 1
      continue
    }

    if (value === '--file') {
      flags.file = argv[index + 1] || null
      index += 1
      continue
    }

    if (value === '--server') {
      flags.server = argv[index + 1] || flags.server
      serverExplicitlySet = true
      index += 1
      continue
    }

    if (value === '--relay-port') {
      flags.relayPort = Number(argv[index + 1] || flags.relayPort)
      index += 1
      continue
    }

    if (value === '--ipc-port') {
      flags.ipcPort = Number(argv[index + 1] || flags.ipcPort)
      if (!serverExplicitlySet) {
        flags.server = `http://127.0.0.1:${flags.ipcPort}`
      }
      index += 1
      continue
    }

    if (value === '--extension-id') {
      flags.extensionId = argv[index + 1] || flags.extensionId
      index += 1
      continue
    }

    if (value === '--auto-connect') {
      flags.autoConnect = true
      continue
    }

    if (value === '--browser-command') {
      flags.browserCommand = argv[index + 1] || flags.browserCommand
      index += 1
      continue
    }

    if (value === '--browser-arg') {
      flags.browserArgs.push(argv[index + 1] || '')
      index += 1
      continue
    }

    args.push(value)
  }

  return { flags, args }
}

async function writeHarFile(har: unknown, outputPath: string | null): Promise<string> {
  const serialized = `${JSON.stringify(har, null, 2)}\n`
  const targetPath = outputPath || path.join(await mkTempHarDir(), 'network.har')
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, serialized, 'utf8')
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

async function getCdpUrl(baseUrl: string): Promise<string> {
  const status = await getStatus(baseUrl)
  const relayPort = Number(status.relayPort || DEFAULT_RELAY_PORT)
  const token = typeof status.token === 'string' ? status.token : ''

  if (!token) {
    throw new Error('missing token')
  }

  return `ws://127.0.0.1:${relayPort}/ws?token=${encodeURIComponent(token)}`
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
): Promise<Record<string, unknown>> {
  const requestListPayload = await requestCommandRaw(baseUrl, 'network', {
    action: 'requests',
  })

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

  const entries: Record<string, unknown>[] = []

  for (const request of filteredSummaries) {
    const requestId = String(request.requestId || request.id || '')
    if (!requestId) {
      entries.push(buildFallbackHarEntry(request))
      continue
    }

    try {
      const requestPayload = await requestCommandRaw(baseUrl, 'network', {
        action: 'request',
        requestId,
      })

      if (requestPayload?.ok === false) {
        entries.push(buildFallbackHarEntry(request))
        continue
      }

      const requestResult = isRecord(requestPayload?.result)
        ? (requestPayload.result as Record<string, unknown>)
        : null
      const harEntry = isRecord(requestResult?.harEntry) ? requestResult.harEntry : null

      entries.push(harEntry || buildFallbackHarEntry(request))
    } catch {
      entries.push(buildFallbackHarEntry(request))
    }
  }

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

  const openRelayConnectPage = async (relayPort: number): Promise<void> => {
    await launchUrl(`http://127.0.0.1:${relayPort}/connect`, null)
  }

  async function resolveConnectionTarget(
    status: Record<string, unknown> | null,
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
    status: Record<string, unknown> | null,
    allowRelayFallback: boolean,
  ): Promise<boolean> {
    const target = await resolveConnectionTarget(status)

    if (!target.token) {
      if (!allowRelayFallback) {
        return false
      }

      await openRelayConnectPage(target.relayPort)
      return true
    }

    try {
      await openExtensionConnectPage(target)
      return true
    } catch (error) {
      if (!allowRelayFallback) {
        throw error
      }

      await openRelayConnectPage(target.relayPort)
      return true
    }
  }

  async function triggerAutoConnect(baseUrl: string): Promise<boolean> {
    if (!flags.autoConnect || connectPageOpened) {
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

    connectPageOpened = true
    try {
      await openExtensionConnectPage(target)
      return true
    } catch (error) {
      console.warn('failed to proactively open extension connect page', error)
      return false
    }
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

    if (flags.autoConnect && !connectPageOpened) {
      await triggerAutoConnect(baseUrl)
    }

    const payload = await requestCommandRaw(baseUrl, command, requestArgs)
    if (flags.autoConnect && !connectPageOpened && shouldTriggerAutoConnect(payload)) {
      const opened = await triggerAutoConnect(baseUrl)
      if (opened) {
        return await requestCommandRaw(baseUrl, command, requestArgs)
      }
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
    resolveEvalScript: async (evalRest) => await resolveEvalScript(flags, evalRest),
    getCdpUrl,
    extractScreenshotData,
    resolveScreenshotOutputPath,
    collectHarFromNetwork,
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
