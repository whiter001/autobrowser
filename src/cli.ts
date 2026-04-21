/// <reference types="bun-types" />
/// <reference types="node" />
/// <reference lib="dom" />

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import {
  resolveBrowserLaunchConfig,
  resolveExtensionId,
  type BrowserLaunchConfig,
} from './core/config.js'
import { getExtensionUrl } from './core/extension.js'
import {
  DEFAULT_IPC_PORT,
  DEFAULT_RELAY_PORT,
  getHomeDir,
  getStatePath,
  getTokenPath,
  isPortInUse,
  readJsonFile,
} from './core/protocol.js'
import { startServers } from './server.js'

const execFileAsync = promisify(execFile)

interface CliFlags {
  json: boolean
  server: string
  relayPort: number
  ipcPort: number
  extensionId: string | null
  browserCommand: string | null
  browserArgs: string[]
  stdin: boolean
  file: string | null
  base64: boolean
}

interface ParsedCli {
  flags: CliFlags
  args: string[]
}

interface DetachedProcessHandle {
  pid?: number
  unref(): void
  kill?(signal?: NodeJS.Signals | number): boolean
  waitForExit?: () => Promise<{ code: number | null; signal: string | null }>
}

interface ServerSnapshotStatus {
  token: string
  relayPort: number
  ipcPort: number
  startedAt?: string
  extensionConnected?: boolean
}

interface CliDependencies {
  openUrl?: (url: string, browserConfig: BrowserLaunchConfig | null) => Promise<void>
  spawnDetachedProcess?: (
    command: string,
    args: string[],
  ) => DetachedProcessHandle | Promise<DetachedProcessHandle>
  findProcessIdByPort?: (port: number) => Promise<number | null>
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean
}

class CommandResultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandResultError'
  }
}

function parseCli(argv: string[]): ParsedCli {
  const flags: CliFlags = {
    json: false,
    server: `http://127.0.0.1:${DEFAULT_IPC_PORT}`,
    relayPort: DEFAULT_RELAY_PORT,
    ipcPort: DEFAULT_IPC_PORT,
    extensionId: process.env.AUTOBROWSER_EXTENSION_ID || null,
    browserCommand: null,
    browserArgs: [],
    stdin: false,
    file: null,
    base64: false,
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

function commandNeedsSelector(attr: string): boolean {
  return !['title', 'url', 'cdp-url'].includes(attr)
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`invalid JSON: ${value}`)
  }
}

function isServerSnapshotStatus(value: unknown): value is ServerSnapshotStatus {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  const relayPort = record.relayPort
  const ipcPort = record.ipcPort
  return (
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    typeof relayPort === 'number' &&
    Number.isInteger(relayPort) &&
    relayPort >= 1 &&
    typeof ipcPort === 'number' &&
    Number.isInteger(ipcPort) &&
    ipcPort >= 1
  )
}

function isServerSnapshotOnPorts(
  value: unknown,
  relayPort: number,
  ipcPort: number,
): value is ServerSnapshotStatus {
  return isServerSnapshotStatus(value) && value.relayPort === relayPort && value.ipcPort === ipcPort
}

function parseNetworkRequestsArgs(rest: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--filter') {
      result.filter = rest[index + 1] || ''
      index += 1
      continue
    }

    if (value === '--type') {
      result.type = rest[index + 1] || ''
      index += 1
      continue
    }

    if (value === '--method') {
      result.method = rest[index + 1] || ''
      index += 1
      continue
    }

    if (value === '--status') {
      result.status = rest[index + 1] || ''
      index += 1
      continue
    }
  }

  return result
}

function parseNetworkRouteArgs(rest: string[]): {
  url: string
  abort: boolean
  body?: unknown
} {
  const result: { url: string; abort: boolean; body?: unknown } = {
    url: '',
    abort: false,
  }

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--abort') {
      result.abort = true
      continue
    }

    if (value === '--body') {
      const rawBody = rest[index + 1]
      if (rawBody === undefined) {
        throw new Error('missing body value')
      }

      result.body = parseJsonValue(rawBody)
      index += 1
      continue
    }

    if (!value.startsWith('--') && !result.url) {
      result.url = value
    }
  }

  return result
}

function killDetachedProcess(handle: DetachedProcessHandle | null | undefined): void {
  if (!handle) {
    return
  }

  try {
    if (typeof handle.kill === 'function') {
      handle.kill()
      return
    }
  } catch {
    // Fall through to best-effort pid-based termination.
  }

  if (typeof handle.pid === 'number') {
    try {
      process.kill(handle.pid)
    } catch {
      // Best effort only.
    }
  }
}

function killProcessByPid(pid: number, signal?: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

async function waitForPortToClose(
  port: number,
  timeoutMs: number = 3000,
  intervalMs: number = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    try {
      if (!(await isPortInUse(port))) {
        return true
      }
    } catch {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return false
}

export function parseWindowsNetstatListeningPid(stdout: string, port: number): number | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }

  const portToken = `:${port}`

  for (const line of String(stdout).split(/\r?\n/)) {
    const normalizedLine = line.trim()
    if (!normalizedLine || !normalizedLine.startsWith('TCP')) {
      continue
    }

    const columns = normalizedLine.split(/\s+/)
    if (columns.length < 5) {
      continue
    }

    const localAddress = columns[1] || ''
    const state = columns[3] || ''
    if (!localAddress.endsWith(portToken) || state.toUpperCase() !== 'LISTENING') {
      continue
    }

    const pid = Number(columns[columns.length - 1] || '')
    if (Number.isInteger(pid) && pid > 0) {
      return pid
    }
  }

  return null
}

async function findListeningProcessIdByPort(port: number): Promise<number | null> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }

  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'])
      return parseWindowsNetstatListeningPid(stdout, port)
    }

    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])

    for (const line of String(stdout).split(/\r?\n/)) {
      const pid = Number(line.trim())
      if (Number.isInteger(pid) && pid > 0) {
        return pid
      }
    }

    return null
  } catch {
    return null
  }
}

async function terminateProcessListeningOnPort(
  port: number,
  findProcessIdByPort: (port: number) => Promise<number | null> = findListeningProcessIdByPort,
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean = killProcessByPid,
): Promise<boolean> {
  const pid = await findProcessIdByPort(port)
  if (!pid) {
    return false
  }

  killProcess(pid, 'SIGTERM')
  return await waitForPortToClose(port)
}

async function spawnDetachedProcess(
  command: string,
  args: string[],
): Promise<DetachedProcessHandle> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })

    const exitPromise = new Promise<{
      code: number | null
      signal: string | null
    }>((resolveExit) => {
      child.once('exit', (code, signal) => {
        resolveExit({
          code,
          signal: signal ? String(signal) : null,
        })
      })
    })

    const cleanup = (): void => {
      child.removeListener('error', onError)
      child.removeListener('spawn', onSpawn)
    }

    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const onSpawn = (): void => {
      cleanup()
      child.unref()
      resolve({
        pid: child.pid ?? undefined,
        unref() {
          child.unref()
        },
        kill(signal?: NodeJS.Signals | number) {
          return child.kill(signal)
        },
        waitForExit() {
          return exitPromise
        },
      })
    }

    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}

async function waitForServerStatus(
  baseUrl: string,
  relayPort: number,
  ipcPort: number,
  timeoutMs: number = 5000,
  intervalMs: number = 100,
): Promise<ServerSnapshotStatus | null> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    try {
      const status = await getStatus(baseUrl)
      if (isServerSnapshotOnPorts(status, relayPort, ipcPort)) {
        return status
      }
    } catch {
      // keep polling until the server becomes available or the timeout elapses
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return null
}

async function stopBackgroundServer(
  ipcPort: number,
  token: string,
  findProcessIdByPort: (port: number) => Promise<number | null> = findListeningProcessIdByPort,
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean = killProcessByPid,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${ipcPort}/shutdown`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token }),
  })

  const bodyText = await response.text().catch(() => '')
  const trimmedBodyText = bodyText.trim()
  let payload: {
    ok?: boolean
    error?: { message?: string }
  } | null = null

  if (trimmedBodyText) {
    try {
      payload = JSON.parse(trimmedBodyText) as {
        ok?: boolean
        error?: { message?: string }
      }
    } catch {
      if (response.ok) {
        return
      }
    }
  } else if (response.ok) {
    return
  }

  if (
    response.status === 404 &&
    (await terminateProcessListeningOnPort(ipcPort, findProcessIdByPort, killProcess))
  ) {
    return
  }

  if (!response.ok || payload?.ok === false) {
    throw new Error(
      payload?.error?.message ||
        trimmedBodyText ||
        response.statusText ||
        'failed to stop background server',
    )
  }
}

function buildServerLaunchArgs(flags: CliFlags, extensionId: string): string[] {
  const args = [
    process.argv[1],
    'server',
    '--serve',
    '--relay-port',
    String(flags.relayPort),
    '--ipc-port',
    String(flags.ipcPort),
    '--extension-id',
    extensionId,
  ]

  return args
}

function parseWaitArgs(rest: string[]): WaitArgs {
  const waitArgs: WaitArgs = {
    timeout: 30000,
    state: 'visible',
  }

  const positionals: string[] = []

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--timeout') {
      const rawTimeout = rest[index + 1]
      if (rawTimeout === undefined) {
        throw new Error('missing timeout value')
      }
      waitArgs.timeout = Number(rawTimeout) || waitArgs.timeout
      index += 1
      continue
    }

    if (value === '--state') {
      const rawState = rest[index + 1]
      if (rawState === undefined) {
        throw new Error('missing state value')
      }
      waitArgs.state = rawState
      index += 1
      continue
    }

    if (value === '--text') {
      const rawText = rest[index + 1]
      if (rawText === undefined) {
        throw new Error('missing text value')
      }
      waitArgs.type = 'text'
      waitArgs.text = rawText
      index += 1
      continue
    }

    if (value === '--url') {
      const rawUrl = rest[index + 1]
      if (rawUrl === undefined) {
        throw new Error('missing url value')
      }
      waitArgs.type = 'url'
      waitArgs.url = rawUrl
      index += 1
      continue
    }

    if (value === '--fn') {
      const rawFn = rest[index + 1]
      if (rawFn === undefined) {
        throw new Error('missing fn value')
      }
      waitArgs.type = 'fn'
      waitArgs.fn = rawFn
      index += 1
      continue
    }

    if (value === '--load') {
      const rawLoadState = rest[index + 1]
      if (rawLoadState && !rawLoadState.startsWith('--')) {
        waitArgs.type = rawLoadState === 'networkidle' ? 'networkidle' : 'load'
        index += 1
      } else {
        waitArgs.type = 'networkidle'
      }
      continue
    }

    if (value === '--ms') {
      const rawMs = rest[index + 1]
      if (rawMs === undefined) {
        throw new Error('missing ms value')
      }
      waitArgs.type = 'time'
      waitArgs.ms = Number(rawMs)
      index += 1
      continue
    }

    if (!value.startsWith('--')) {
      positionals.push(value)
    }
  }

  if (!waitArgs.type && positionals.length > 0) {
    const [first, second] = positionals

    if (first === 'selector') {
      waitArgs.type = 'selector'
      waitArgs.selector = second || ''
    } else if (first === 'url') {
      waitArgs.type = 'url'
      waitArgs.url = second || ''
    } else if (first === 'text') {
      waitArgs.type = 'text'
      waitArgs.text = second || ''
    } else if (first === 'time' || first === 'ms') {
      waitArgs.type = 'time'
      waitArgs.ms = Number(second || first)
    } else if (first === 'load') {
      waitArgs.type = second === 'networkidle' ? 'networkidle' : 'load'
    } else if (first === 'networkidle') {
      waitArgs.type = 'networkidle'
    } else if (!isNaN(Number(first)) && positionals.length === 1) {
      waitArgs.type = 'time'
      waitArgs.ms = Number(first)
    } else {
      waitArgs.type = 'selector'
      waitArgs.selector = first
    }
  }

  if (!waitArgs.type) {
    waitArgs.type = 'networkidle'
  }

  if (waitArgs.type === 'selector' && !waitArgs.selector && positionals.length > 0) {
    waitArgs.selector = positionals[0]
  }

  if (waitArgs.type === 'url' && !waitArgs.url && positionals.length > 0) {
    waitArgs.url = positionals[0]
  }

  if (waitArgs.type === 'text' && !waitArgs.text && positionals.length > 0) {
    waitArgs.text = positionals[0]
  }

  return waitArgs
}

function parseScreenshotArgs(rest: string[]): ScreenshotArgs {
  const screenshotArgs: ScreenshotArgs = {
    path: null,
    full: false,
    annotate: false,
    screenshotDir: null,
    format: 'png',
    quality: null,
  }

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (value === '--full') {
      screenshotArgs.full = true
      continue
    }

    if (value === '--annotate') {
      screenshotArgs.annotate = true
      continue
    }

    if (value === '--screenshot-dir') {
      const rawDir = rest[index + 1]
      if (rawDir === undefined) {
        throw new Error('missing screenshot dir value')
      }
      screenshotArgs.screenshotDir = rawDir
      index += 1
      continue
    }

    if (value === '--screenshot-format') {
      const rawFormat = rest[index + 1]
      if (rawFormat === undefined) {
        throw new Error('missing screenshot format value')
      }
      if (rawFormat !== 'png' && rawFormat !== 'jpeg') {
        throw new Error(`unsupported screenshot format: ${rawFormat}`)
      }
      screenshotArgs.format = rawFormat
      index += 1
      continue
    }

    if (value === '--screenshot-quality') {
      const rawQuality = rest[index + 1]
      if (rawQuality === undefined) {
        throw new Error('missing screenshot quality value')
      }
      screenshotArgs.quality = Number(rawQuality)
      index += 1
      continue
    }

    if (!value.startsWith('--') && !screenshotArgs.path) {
      screenshotArgs.path = value
    }
  }

  return screenshotArgs
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

interface HelpNode {
  name: string
  summary: string
  usage: string
  options?: string[]
  children?: HelpNode[]
}

function helpNode(
  name: string,
  summary: string,
  usage: string,
  options?: string[],
  children?: HelpNode[],
): HelpNode {
  return {
    name,
    summary,
    usage,
    ...(options && options.length > 0 ? { options } : {}),
    ...(children && children.length > 0 ? { children } : {}),
  }
}

const HELP_ROOT = helpNode(
  'autobrowser',
  'Browser automation CLI for controlling Chrome/Edge through a relay server and extension.',
  'autobrowser [command] [options]',
  [
    '--json',
    '--server <url>',
    '--stdin',
    '--file <path>',
    '--base64',
    '--extension-id <id>',
    '--browser-command <command>',
    '--browser-arg <arg>',
  ],
  [
    helpNode('help', 'Show help for a command path.', 'autobrowser help [command ...]'),
    helpNode(
      'server',
      'Manage the background relay and IPC servers.',
      'autobrowser server [--extension-id <id>] [--browser-command <command>] [--browser-arg <arg>]',
      undefined,
      [helpNode('stop', 'Stop the background servers.', 'autobrowser server stop')],
    ),
    helpNode('status', 'Show server status.', 'autobrowser status'),
    helpNode(
      'connect',
      'Open the extension connect page.',
      'autobrowser connect [--extension-id <id>] [--browser-command <command>] [--browser-arg <arg>]',
    ),
    helpNode('tab', 'Manage tabs.', 'autobrowser tab <list|new>', undefined, [
      helpNode('list', 'List tabs.', 'autobrowser tab list'),
      helpNode('new', 'Open a new tab.', 'autobrowser tab new <url>'),
    ]),
    helpNode('open', 'Navigate to a URL.', 'autobrowser open <url>'),
    helpNode('goto', 'Navigate to a URL.', 'autobrowser goto <url>'),
    helpNode('back', 'Go back in browser history.', 'autobrowser back'),
    helpNode('forward', 'Go forward in browser history.', 'autobrowser forward'),
    helpNode('reload', 'Reload the current page.', 'autobrowser reload'),
    helpNode('window', 'Manage browser windows.', 'autobrowser window <new>', undefined, [
      helpNode('new', 'Open a new window.', 'autobrowser window new'),
    ]),
    helpNode(
      'eval',
      'Run JavaScript in the page context.',
      'autobrowser eval [--stdin|--file path|--base64] <script>',
      ['--stdin', '--file <path>', '--base64'],
    ),
    helpNode('click', 'Click a selector.', 'autobrowser click <selector>'),
    helpNode('dblclick', 'Double-click a selector.', 'autobrowser dblclick <selector>'),
    helpNode('fill', 'Fill a selector with text.', 'autobrowser fill <selector> <value>'),
    helpNode('type', 'Type text into a selector.', 'autobrowser type <selector> <value>'),
    helpNode('press', 'Press a keyboard key.', 'autobrowser press <key>'),
    helpNode(
      'keyboard',
      'Send keyboard input.',
      'autobrowser keyboard <type|inserttext|keydown|keyup> <text>',
    ),
    helpNode('hover', 'Hover a selector.', 'autobrowser hover <selector>'),
    helpNode('focus', 'Focus a selector.', 'autobrowser focus <selector>'),
    helpNode('select', 'Select an option.', 'autobrowser select <selector> <value>'),
    helpNode('check', 'Check a checkbox.', 'autobrowser check <selector>'),
    helpNode('uncheck', 'Uncheck a checkbox.', 'autobrowser uncheck <selector>'),
    helpNode(
      'scroll',
      'Scroll a page or element.',
      'autobrowser scroll [selector] [deltaX] [deltaY]',
    ),
    helpNode(
      'scrollintoview',
      'Scroll a selector into view.',
      'autobrowser scrollintoview <selector>',
    ),
    helpNode('drag', 'Drag between elements.', 'autobrowser drag <startSelector> [endSelector]'),
    helpNode(
      'upload',
      'Upload files through a file input.',
      'autobrowser upload <selector> <files...>',
    ),
    helpNode('frame', 'Select a frame.', 'autobrowser frame <selector|top>'),
    helpNode(
      'is',
      'Check element state.',
      'autobrowser is <visible|enabled|checked|disabled|focused> <selector>',
    ),
    helpNode(
      'get',
      'Read page or element data.',
      'autobrowser get <text|html|value|title|url|cdp-url|count|attr|box|styles> [selector]',
    ),
    helpNode('dialog', 'Handle dialogs.', 'autobrowser dialog <accept|dismiss|status>', undefined, [
      helpNode('accept', 'Accept the active dialog.', 'autobrowser dialog accept [promptText]'),
      helpNode('dismiss', 'Dismiss the active dialog.', 'autobrowser dialog dismiss [promptText]'),
      helpNode('status', 'Show dialog status.', 'autobrowser dialog status'),
    ]),
    helpNode(
      'wait',
      'Wait for a selector, text, URL, load state, function, or time.',
      'autobrowser wait <selector|ms> [--state visible|hidden] [--timeout <ms>]',
      [
        '--state <visible|hidden>',
        '--timeout <ms>',
        '--text <text>',
        '--url <pattern>',
        '--load [networkidle]',
        '--fn <expression>',
        '--ms <ms>',
      ],
    ),
    helpNode(
      'cookies',
      'Inspect or update cookies.',
      'autobrowser cookies <get|set|clear>',
      undefined,
      [
        helpNode('get', 'List cookies.', 'autobrowser cookies get'),
        helpNode('set', 'Set a cookie.', 'autobrowser cookies set <name> <value> [domain]'),
        helpNode('clear', 'Clear cookies.', 'autobrowser cookies clear'),
      ],
    ),
    helpNode(
      'storage',
      'Inspect or update storage.',
      'autobrowser storage <get|set|clear>',
      undefined,
      [
        helpNode('get', 'Read storage by key.', 'autobrowser storage get [key]'),
        helpNode('set', 'Write storage by key.', 'autobrowser storage set <key> <value>'),
        helpNode('clear', 'Clear storage.', 'autobrowser storage clear'),
      ],
    ),
    helpNode('console', 'Read console output.', 'autobrowser console'),
    helpNode('errors', 'Read page errors.', 'autobrowser errors'),
    helpNode(
      'set',
      'Adjust browser state.',
      'autobrowser set <viewport|offline|headers|geo|media>',
      undefined,
      [
        helpNode(
          'viewport',
          'Set viewport settings.',
          'autobrowser set viewport <width> <height> [deviceScaleFactor] [mobile]',
        ),
        helpNode('offline', 'Toggle offline mode.', 'autobrowser set offline [false]'),
        helpNode('headers', 'Set request headers.', 'autobrowser set headers <name:value,...>'),
        helpNode(
          'geo',
          'Set geolocation.',
          'autobrowser set geo <latitude> <longitude> [accuracy]',
        ),
        helpNode('media', 'Set media emulation.', 'autobrowser set media <scheme>'),
      ],
    ),
    helpNode('pdf', 'Export the current page as PDF.', 'autobrowser pdf'),
    helpNode(
      'clipboard',
      'Read or write clipboard contents.',
      'autobrowser clipboard <read|write>',
      undefined,
      [
        helpNode('read', 'Read the clipboard.', 'autobrowser clipboard read'),
        helpNode('write', 'Write to the clipboard.', 'autobrowser clipboard write [text]'),
      ],
    ),
    helpNode('state', 'Save or load browser state.', 'autobrowser state <save|load>', undefined, [
      helpNode('save', 'Save state.', 'autobrowser state save [name]'),
      helpNode(
        'load',
        'Load state from a name or JSON payload.',
        'autobrowser state load [name|json]',
      ),
    ]),
    helpNode(
      'network',
      'Inspect and control network activity.',
      'autobrowser network <route|unroute|requests|request|har>',
      undefined,
      [
        helpNode(
          'route',
          'Add a network route.',
          'autobrowser network route <url> [--abort] [--body <json>]',
          ['--abort', '--body <json>'],
        ),
        helpNode('unroute', 'Remove a network route.', 'autobrowser network unroute [url]'),
        helpNode(
          'requests',
          'List captured requests.',
          'autobrowser network requests [--filter <text>] [--type <xhr,fetch>] [--method <POST>] [--status <2xx>]',
          ['--filter <text>', '--type <xhr,fetch>', '--method <POST>', '--status <2xx>'],
        ),
        helpNode('request', 'Inspect a single request.', 'autobrowser network request <requestId>'),
        helpNode(
          'har',
          'Record or stop HAR capture.',
          'autobrowser network har <start|stop>',
          undefined,
          [
            helpNode('start', 'Start HAR capture.', 'autobrowser network har start'),
            helpNode(
              'stop',
              'Stop HAR capture and save it.',
              'autobrowser network har stop [output.har]',
            ),
          ],
        ),
      ],
    ),
    helpNode(
      'screenshot',
      'Capture a screenshot.',
      'autobrowser screenshot [path] [--full] [--annotate] [--screenshot-dir <dir>] [--screenshot-format png|jpeg] [--screenshot-quality <n>]',
      [
        '--full',
        '--annotate',
        '--screenshot-dir <dir>',
        '--screenshot-format png|jpeg',
        '--screenshot-quality <n>',
      ],
    ),
    helpNode('snapshot', 'Capture a page snapshot.', 'autobrowser snapshot'),
  ],
)

const ROOT_HELP_FLAGS = [
  '--json        output JSON',
  '--server URL  target server base URL, default http://127.0.0.1:57979',
  '--stdin       read command body from stdin',
  '--file PATH   read command body from file',
  '--base64      decode command body from base64',
]

function isHelpToken(value: string | undefined): boolean {
  return value === '--help' || value === '-h' || value === 'help'
}

function resolveHelpNode(
  node: HelpNode,
  pathParts: string[],
): { node: HelpNode; remainder: string[] } {
  let current = node
  let index = 0

  for (; index < pathParts.length; index += 1) {
    const next = current.children?.find((child) => child.name === pathParts[index])
    if (!next) {
      break
    }
    current = next
  }

  return {
    node: current,
    remainder: pathParts.slice(index),
  }
}

function renderHelp(node: HelpNode, isRoot = false): string {
  const lines: string[] = []
  const newline = '\n'

  lines.push(node.name)
  lines.push('')
  lines.push(node.summary)
  lines.push('')
  lines.push('Usage:')
  lines.push(`  ${node.usage}`)

  if (isRoot) {
    lines.push('')
    lines.push('Flags:')
    for (const flag of ROOT_HELP_FLAGS) {
      lines.push(`  ${flag}`)
    }
  }

  if (!isRoot && node.options && node.options.length > 0) {
    lines.push('')
    lines.push('Options:')
    for (const option of node.options) {
      lines.push(`  ${option}`)
    }
  }

  if (node.children && node.children.length > 0) {
    lines.push('')
    lines.push('Commands:')
    for (const child of node.children) {
      lines.push(`  ${child.name.padEnd(18)} ${child.summary}`)
    }
  }

  return `${lines.join(newline)}${newline}`
}

function printHelp(pathParts: string[] = []): string {
  const { node, remainder } = resolveHelpNode(HELP_ROOT, pathParts)
  const rendered = renderHelp(node, node === HELP_ROOT)
  if (remainder.length === 0) {
    return rendered
  }

  return `${rendered}Unknown command path: ${remainder.join(' ')}\r\n`
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

interface CommandResponse {
  ok: boolean
  result?: unknown
  error?: { message: string; code?: string }
}

function shouldOpenInNewTab(payload: CommandResponse): boolean {
  if (payload.ok !== false) {
    return false
  }

  const message = String(payload.error?.message || '').toLowerCase()
  return (
    message.includes('cannot access chrome:// and edge:// urls') ||
    message.includes('cannot access chrome://') ||
    message.includes('cannot access edge://')
  )
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

interface NetworkHarStopResult {
  har?: unknown
  startedAt?: string
  stoppedAt?: string
  requestCount?: number
}

const HAR_CREATOR = {
  name: 'autobrowser',
  version: '0.1.0',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

async function requestCommand(
  baseUrl: string,
  command: string,
  args: object = {},
): Promise<CommandResponse> {
  const response = await fetch(`${baseUrl}/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ command, args }),
  })

  return (await response.json()) as CommandResponse
}

async function getStatus(baseUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/status`)
  return (await response.json()) as Record<string, unknown>
}

function compareNetworkRequestSummaries(
  left: NetworkRequestSummary,
  right: NetworkRequestSummary,
): number {
  const leftStartedAt = Date.parse(left.startedAt || '') || 0
  const rightStartedAt = Date.parse(right.startedAt || '') || 0

  if (leftStartedAt !== rightStartedAt) {
    return leftStartedAt - rightStartedAt
  }

  const leftId = String(left.id || left.requestId || '')
  const rightId = String(right.id || right.requestId || '')
  return leftId.localeCompare(rightId)
}

function buildHar(entries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    log: {
      version: '1.2',
      creator: HAR_CREATOR,
      entries,
    },
  }
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
  const requestListPayload = await requestCommand(baseUrl, 'network', {
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
    .sort(compareNetworkRequestSummaries)

  const entries: Record<string, unknown>[] = []

  for (const request of filteredSummaries) {
    const requestId = String(request.requestId || request.id || '')
    if (!requestId) {
      entries.push(buildFallbackHarEntry(request))
      continue
    }

    try {
      const requestPayload = await requestCommand(baseUrl, 'network', {
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

  return buildHar(entries)
}

function normalizeSavedPort(value: unknown, fallback: number): number {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback
}

function readPersistedToken(
  stateRecord: Record<string, unknown> | null,
  tokenRecord: Record<string, unknown> | null,
): string {
  const stateToken = typeof stateRecord?.token === 'string' ? stateRecord.token : ''
  if (stateToken) {
    return stateToken
  }

  return typeof tokenRecord?.token === 'string' ? tokenRecord.token : ''
}

async function readPersistedConnectionInfo(
  fallbackRelayPort: number,
  fallbackIpcPort: number,
): Promise<{ token: string; relayPort: number; ipcPort: number } | null> {
  const homeDir = getHomeDir()
  const [stateResult, tokenFileResult] = await Promise.allSettled([
    readJsonFile<{
      token?: unknown
      relayPort?: unknown
      ipcPort?: unknown
    } | null>(getStatePath(homeDir), null),
    readJsonFile<{ token?: unknown } | null>(getTokenPath(homeDir), null),
  ])

  const state = stateResult.status === 'fulfilled' ? stateResult.value : null
  const tokenFile = tokenFileResult.status === 'fulfilled' ? tokenFileResult.value : null

  const stateRecord = state && typeof state === 'object' ? (state as Record<string, unknown>) : null
  const tokenRecord =
    tokenFile && typeof tokenFile === 'object' ? (tokenFile as Record<string, unknown>) : null

  const token = readPersistedToken(stateRecord, tokenRecord)

  if (!token) {
    return null
  }

  return {
    token,
    relayPort: normalizeSavedPort(stateRecord?.relayPort, fallbackRelayPort),
    ipcPort: normalizeSavedPort(stateRecord?.ipcPort, fallbackIpcPort),
  }
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

interface WaitArgs {
  timeout: number
  type?: string
  selector?: string
  url?: string
  text?: string
  ms?: number
  state?: string
  fn?: string
}

interface ScreenshotArgs {
  path: string | null
  full: boolean
  annotate: boolean
  screenshotDir: string | null
  format: 'png' | 'jpeg'
  quality: number | null
}

async function runMain(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number | void> {
  const { flags, args } = parseCli(argv)
  const [command, ...rest] = args
  const homeDir = getHomeDir()
  const launchUrl = dependencies.openUrl ?? openUrl

  const openRelayConnectPage = async (relayPort: number): Promise<void> => {
    await launchUrl(`http://127.0.0.1:${relayPort}/connect`, null)
  }

  function isFailedCommandResponse(payload: unknown): payload is CommandResponse {
    return isRecord(payload) && (payload as Record<string, unknown>).ok === false
  }

  function writeResult(
    payload:
      | CommandResponse
      | Record<string, unknown>
      | string
      | number
      | boolean
      | bigint
      | null
      | undefined,
  ): void {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      if (isFailedCommandResponse(payload)) {
        throw new CommandResultError(payload.error?.message || 'command failed')
      }
      return
    }

    if (
      typeof payload === 'string' ||
      typeof payload === 'number' ||
      typeof payload === 'boolean' ||
      typeof payload === 'bigint'
    ) {
      process.stdout.write(`${String(payload)}\n`)
      return
    }

    const p = payload as CommandResponse
    if (p?.ok === false) {
      process.stderr.write(`${p.error?.message || 'command failed'}\n`)
      throw new CommandResultError(p.error?.message || 'command failed')
    }

    const result = p?.result ?? payload
    if (typeof result === 'string') {
      process.stdout.write(result.endsWith('\n') ? result : `${result}\n`)
      return
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }

  if (!command) {
    return writeHelp()
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    return writeHelp(rest)
  }

  if (command === 'server') {
    if (rest[0] === '--serve') {
      if (await isPortInUse(flags.relayPort)) {
        process.stderr.write('Server already running on port ' + flags.relayPort + '\n')
        return 1
      }

      const extensionId = await resolveExtensionId(homeDir, flags.extensionId)
      const servers = await startServers({
        relayPort: flags.relayPort,
        ipcPort: flags.ipcPort,
        extensionId,
      })
      process.stdout.write(
        `autobrowser server started\nrelay: http://127.0.0.1:${servers.runtime.runtime.relayPort}\nipc: http://127.0.0.1:${servers.runtime.runtime.ipcPort}\n`,
      )

      const shutdown = () => {
        servers.stop()
        process.exit(0)
      }

      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      return new Promise(() => {})
    }

    if (rest[0] === 'stop') {
      if (isHelpToken(rest[1])) {
        return writeHelp(['server', 'stop'])
      }

      const persistedConnectionInfo = await readPersistedConnectionInfo(
        flags.relayPort,
        flags.ipcPort,
      )

      if (!persistedConnectionInfo?.token) {
        process.stderr.write('No persisted background server state found.\n')
        return 1
      }

      try {
        await stopBackgroundServer(
          persistedConnectionInfo.ipcPort,
          persistedConnectionInfo.token,
          dependencies.findProcessIdByPort,
          dependencies.killProcess,
        )
        process.stdout.write('autobrowser server stopped\n')
        return
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : 'failed to stop background server'}\n`,
        )
        return 1
      }
    }

    if (isHelpToken(rest[0])) {
      return writeHelp(['server'])
    }

    const controlBaseUrl = `http://127.0.0.1:${flags.ipcPort}`
    const existingStatus = await getStatus(controlBaseUrl).catch(() => null)
    if (isServerSnapshotOnPorts(existingStatus, flags.relayPort, flags.ipcPort)) {
      process.stdout.write(`autobrowser server already running\n`)
      return 0
    }

    const extensionId = await resolveExtensionId(homeDir, flags.extensionId)
    const spawnCommand = dependencies.spawnDetachedProcess ?? spawnDetachedProcess
    let backgroundProcess: DetachedProcessHandle

    try {
      backgroundProcess = await spawnCommand('bun', buildServerLaunchArgs(flags, extensionId))
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'failed to start background server'}\n`,
      )
      return 1
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
      process.stderr.write(
        `Background server exited before becoming ready${
          readyResult.exitInfo.code !== null ? ` (code ${readyResult.exitInfo.code})` : ''
        }${readyResult.exitInfo.signal ? ` (signal ${readyResult.exitInfo.signal})` : ''}.\n`,
      )
      return 1
    }

    if (!readyResult.status) {
      killDetachedProcess(backgroundProcess)
      process.stderr.write(`Failed to start background server on ${controlBaseUrl}\n`)
      return 1
    }

    process.stdout.write(
      `autobrowser server started in background\nrelay: http://127.0.0.1:${flags.relayPort}\nipc: ${controlBaseUrl}\n`,
    )
    return
  }

  if (command === 'connect') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['connect'])
    }
    const status = await getStatus(flags.server).catch(() => null)
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

    if (!token) {
      await openRelayConnectPage(relayPort)
      return 0
    }

    const browserConfig = await resolveBrowserLaunchConfig(
      homeDir,
      flags.browserCommand,
      flags.browserArgs,
    )
    const extensionId = await resolveExtensionId(homeDir, flags.extensionId)

    try {
      await launchUrl(
        getExtensionUrl(
          '/connect.html',
          {
            token,
            relayPort,
            ipcPort,
          },
          extensionId,
        ),
        browserConfig,
      )
    } catch {
      await openRelayConnectPage(relayPort)
    }
    return 0
  }

  if (command === 'status') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['status'])
    }
    const status = await getStatus(flags.server)
    writeResult(status)
    return 0
  }

  if (command === 'tab') {
    const [subcommand, ...tabArgs] = rest
    if (isHelpToken(subcommand)) {
      return writeHelp(['tab'])
    }
    if (subcommand === 'list') {
      if (isHelpToken(tabArgs[0])) {
        return writeHelp(['tab', 'list'])
      }
      const payload = await requestCommand(flags.server, 'tab.list', {})
      writeResult(payload)
      return 0
    }

    if (subcommand === 'new') {
      if (isHelpToken(tabArgs[0])) {
        return writeHelp(['tab', 'new'])
      }
      const url = tabArgs[0] || 'about:blank'
      const payload = await requestCommand(flags.server, 'tab.new', { url })
      writeResult(payload)
      return 0
    }

    return writeHelp(['tab'])
  }

  if (command === 'open' || command === 'goto') {
    const url = rest[0]
    if (isHelpToken(url)) {
      return writeHelp([command])
    }
    if (!url) {
      return writeHelp([command])
    }

    const payload = await requestCommand(flags.server, 'goto', { url })
    if (shouldOpenInNewTab(payload)) {
      const fallbackPayload = await requestCommand(flags.server, 'tab.new', { url })
      writeResult(fallbackPayload)
      return fallbackPayload.ok === false ? 1 : 0
    }

    writeResult(payload)
    return payload.ok === false ? 1 : 0
  }

  if (command === 'eval') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['eval'])
    }
    const script = await resolveEvalScript(flags, rest)
    const payload = await requestCommand(flags.server, 'eval', { script })
    writeResult(payload)
    return 0
  }

  if (command === 'click') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['click'])
    }
    if (!selector) {
      return writeHelp(['click'])
    }

    const payload = await requestCommand(flags.server, 'click', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'dblclick') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['dblclick'])
    }
    if (!selector) {
      return writeHelp(['dblclick'])
    }

    const payload = await requestCommand(flags.server, 'dblclick', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'fill') {
    const selector = rest[0]
    const value = rest.slice(1).join(' ')
    if (isHelpToken(selector)) {
      return writeHelp(['fill'])
    }
    if (!selector) {
      return writeHelp(['fill'])
    }

    const payload = await requestCommand(flags.server, 'fill', {
      selector,
      value,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'snapshot' || command === 'screenshot') {
    if (command === 'snapshot') {
      if (isHelpToken(rest[0])) {
        return writeHelp(['snapshot'])
      }
      const payload = await requestCommand(flags.server, command, {})
      writeResult(payload)
      return 0
    }

    if (isHelpToken(rest[0])) {
      return writeHelp(['screenshot'])
    }

    let screenshotArgs: ScreenshotArgs
    try {
      screenshotArgs = parseScreenshotArgs(rest)
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`)
      return 1
    }

    const payload = await requestCommand(flags.server, command, {
      full: screenshotArgs.full,
      annotate: screenshotArgs.annotate,
      format: screenshotArgs.format,
      ...(screenshotArgs.quality !== null ? { quality: screenshotArgs.quality } : {}),
    })

    if (payload.ok === false) {
      writeResult(payload)
      return 1
    }

    const { data, mimeType } = extractScreenshotData(
      payload.result as Record<string, unknown> | undefined,
    )
    const outputPath = await resolveScreenshotOutputPath(screenshotArgs)
    await writeFile(outputPath, data)

    if (flags.json) {
      writeResult({
        path: outputPath,
        mimeType,
        format: screenshotArgs.format,
        full: screenshotArgs.full,
        annotate: screenshotArgs.annotate,
      })
      return 0
    }

    process.stdout.write(`${outputPath}\n`)
    return 0
  }

  if (command === 'hover') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['hover'])
    }
    if (!selector) {
      return writeHelp(['hover'])
    }
    const payload = await requestCommand(flags.server, 'hover', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'press') {
    const key = rest[0]
    if (isHelpToken(key)) {
      return writeHelp(['press'])
    }
    if (!key) {
      return writeHelp(['press'])
    }
    const payload = await requestCommand(flags.server, 'press', { key })
    writeResult(payload)
    return 0
  }

  if (command === 'focus') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['focus'])
    }
    if (!selector) {
      return writeHelp(['focus'])
    }
    const payload = await requestCommand(flags.server, 'focus', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'select') {
    const selector = rest[0]
    const value = rest[1]
    if (isHelpToken(selector)) {
      return writeHelp(['select'])
    }
    if (!selector || value === undefined) {
      return writeHelp(['select'])
    }
    const payload = await requestCommand(flags.server, 'select', {
      selector,
      value,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'check') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['check'])
    }
    if (!selector) {
      return writeHelp(['check'])
    }
    const payload = await requestCommand(flags.server, 'check', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'uncheck') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['uncheck'])
    }
    if (!selector) {
      return writeHelp(['uncheck'])
    }
    const payload = await requestCommand(flags.server, 'uncheck', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'scroll') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['scroll'])
    }
    const deltaX = Number(rest[1] || 0)
    const deltaY = Number(rest[2] || 100)
    const payload = await requestCommand(flags.server, 'scroll', {
      selector: selector || null,
      deltaX,
      deltaY,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'drag') {
    const start = rest[0]
    const end = rest[1]
    if (isHelpToken(start)) {
      return writeHelp(['drag'])
    }
    if (!start) {
      return writeHelp(['drag'])
    }
    const payload = await requestCommand(flags.server, 'drag', {
      start,
      end: end || '',
    })
    writeResult(payload)
    return 0
  }

  if (command === 'upload') {
    const selector = rest[0]
    const files = rest.slice(1)
    if (isHelpToken(selector)) {
      return writeHelp(['upload'])
    }
    if (!selector) {
      return writeHelp(['upload'])
    }
    if (!files || files.length === 0) {
      return writeHelp(['upload'])
    }
    const payload = await requestCommand(flags.server, 'upload', {
      selector,
      files,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'back') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['back'])
    }
    const payload = await requestCommand(flags.server, 'back', {})
    writeResult(payload)
    return 0
  }

  if (command === 'forward') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['forward'])
    }
    const payload = await requestCommand(flags.server, 'forward', {})
    writeResult(payload)
    return 0
  }

  if (command === 'type') {
    const selector = rest[0]
    const value = rest.slice(1).join(' ')
    if (isHelpToken(selector)) {
      return writeHelp(['type'])
    }
    if (!selector) {
      return writeHelp(['type'])
    }

    const payload = await requestCommand(flags.server, 'type', {
      selector,
      value,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'keyboard') {
    const action = rest[0]
    const value = rest.slice(1).join(' ')
    if (
      isHelpToken(action) ||
      !action ||
      !['type', 'inserttext', 'keydown', 'keyup'].includes(action)
    ) {
      return writeHelp(['keyboard'])
    }

    const payload = await requestCommand(flags.server, 'keyboard', {
      action,
      text: value,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'reload') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['reload'])
    }
    const payload = await requestCommand(flags.server, 'reload', {})
    writeResult(payload)
    return 0
  }

  if (command === 'close' || command === 'quit' || command === 'exit') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['close'])
    }
    const all = rest[0] === 'all' || rest[0] === '--all'
    const payload = await requestCommand(flags.server, 'close', { all })
    writeResult(payload)
    return 0
  }

  if (command === 'window') {
    const action = rest[0]
    if (isHelpToken(action)) {
      return writeHelp(['window'])
    }
    if (action === 'new') {
      const payload = await requestCommand(flags.server, 'window', {
        action: 'new',
      })
      writeResult(payload)
      return 0
    }
    return writeHelp(['window'])
  }

  if (command === 'frame') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['frame'])
    }
    if (!selector) {
      return writeHelp(['frame'])
    }
    const payload = await requestCommand(flags.server, 'frame', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'scrollintoview') {
    const selector = rest[0]
    if (isHelpToken(selector)) {
      return writeHelp(['scrollintoview'])
    }
    if (!selector) {
      return writeHelp(['scrollintoview'])
    }

    const payload = await requestCommand(flags.server, 'scrollintoview', {
      selector,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'is') {
    const state = rest[0] || 'visible'
    const selector = rest[1]
    if (isHelpToken(state) || isHelpToken(selector)) {
      return writeHelp(['is'])
    }
    if (!selector) {
      return writeHelp(['is'])
    }
    const payload = await requestCommand(flags.server, 'is', {
      selector,
      state,
    })
    if (payload.ok === false) {
      writeResult(payload)
      return 1
    }

    const value = (payload.result as { value?: unknown } | undefined)?.value
    if (value !== undefined) {
      writeResult(value as string | number | boolean | bigint)
      return 0
    }

    writeResult(payload)
    return 0
  }

  if (command === 'get') {
    const attr = rest[0] || 'text'
    const selector = rest[1]
    if (isHelpToken(attr) || isHelpToken(selector)) {
      return writeHelp(['get'])
    }

    if (attr === 'cdp-url') {
      try {
        const cdpUrl = await getCdpUrl(flags.server)
        writeResult(cdpUrl)
        return 0
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`)
        return 1
      }
    }

    if (commandNeedsSelector(attr) && !selector) {
      process.stderr.write('missing selector\n')
      return 1
    }
    const payload = await requestCommand(flags.server, 'get', {
      selector,
      attr,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'dialog') {
    const action = rest[0]
    if (isHelpToken(action)) {
      return writeHelp(['dialog'])
    }
    if (action === 'status') {
      const payload = await requestCommand(flags.server, 'dialog', {
        action: 'status',
      })
      writeResult(payload)
      return 0
    }
    if (!action || !['accept', 'dismiss'].includes(action)) {
      return writeHelp(['dialog'])
    }
    const promptText = rest.slice(1).join(' ')
    const accept = action !== 'dismiss'
    const payload = await requestCommand(flags.server, 'dialog', {
      accept,
      promptText,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'wait') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['wait'])
    }
    let waitArgs: WaitArgs
    try {
      waitArgs = parseWaitArgs(rest)
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`)
      return 1
    }

    const payload = await requestCommand(flags.server, 'wait', waitArgs)
    writeResult(payload)
    return 0
  }

  if (command === 'cookies') {
    const action = rest[0]
    if (isHelpToken(action)) {
      return writeHelp(['cookies'])
    }
    if (action === 'get') {
      const payload = await requestCommand(flags.server, 'cookies', {
        action: 'get',
      })
      writeResult(payload)
      return 0
    }
    if (action === 'set') {
      const name = rest[1]
      const value = rest[2]
      const domain = rest[3]
      if (!name || !value) {
        return writeHelp(['cookies', 'set'])
      }
      const payload = await requestCommand(flags.server, 'cookies', {
        action: 'set',
        name,
        value,
        domain,
      })
      writeResult(payload)
      return 0
    }
    if (action === 'clear') {
      const payload = await requestCommand(flags.server, 'cookies', {
        action: 'clear',
      })
      writeResult(payload)
      return 0
    }
    return writeHelp(['cookies'])
  }

  if (command === 'storage') {
    const action = rest[0]
    if (isHelpToken(action)) {
      return writeHelp(['storage'])
    }
    if (action === 'get') {
      const key = rest[1]
      const payload = await requestCommand(flags.server, 'storage', {
        action: 'get',
        key,
      })
      writeResult(payload)
      return 0
    }
    if (action === 'set') {
      const key = rest[1]
      const value = rest[2]
      if (!key || value === undefined) {
        return writeHelp(['storage', 'set'])
      }
      const payload = await requestCommand(flags.server, 'storage', {
        action: 'set',
        key,
        value,
      })
      writeResult(payload)
      return 0
    }
    if (action === 'clear') {
      const payload = await requestCommand(flags.server, 'storage', {
        action: 'clear',
      })
      writeResult(payload)
      return 0
    }
    return writeHelp(['storage'])
  }

  if (command === 'console') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['console'])
    }
    const payload = await requestCommand(flags.server, 'console', {})
    writeResult(payload)
    return 0
  }

  if (command === 'errors') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['errors'])
    }
    const payload = await requestCommand(flags.server, 'errors', {})
    writeResult(payload)
    return 0
  }

  if (command === 'set') {
    const type = rest[0]
    const subArgs = rest.slice(1)
    if (isHelpToken(type)) {
      return writeHelp(['set'])
    }

    if (type === 'viewport') {
      const width = Number(subArgs[0] || 1280)
      const height = Number(subArgs[1] || 720)
      const deviceScaleFactor = Number(subArgs[2] || 1)
      const mobile = subArgs[3] === 'mobile'
      const payload = await requestCommand(flags.server, 'set', {
        type: 'viewport',
        width,
        height,
        deviceScaleFactor,
        mobile,
      })
      writeResult(payload)
      return 0
    }
    if (type === 'offline') {
      const enabled = subArgs[0] !== 'false'
      const payload = await requestCommand(flags.server, 'set', {
        type: 'offline',
        enabled,
      })
      writeResult(payload)
      return 0
    }
    if (type === 'headers') {
      const headers = subArgs
        .join(' ')
        .split(',')
        .map((h) => {
          const [name, ...valueParts] = h.split(':')
          return { name: name.trim(), value: valueParts.join(':').trim() }
        })
        .filter((h) => h.name)
      const payload = await requestCommand(flags.server, 'set', {
        type: 'headers',
        headers,
      })
      writeResult(payload)
      return 0
    }
    if (type === 'geo') {
      const latitude = Number(subArgs[0] || 0)
      const longitude = Number(subArgs[1] || 0)
      const accuracy = Number(subArgs[2] || 1)
      const payload = await requestCommand(flags.server, 'set', {
        type: 'geo',
        latitude,
        longitude,
        accuracy,
      })
      writeResult(payload)
      return 0
    }
    if (type === 'media') {
      const media = subArgs[0] || ''
      const payload = await requestCommand(flags.server, 'set', {
        type: 'media',
        media,
      })
      writeResult(payload)
      return 0
    }
    return writeHelp(['set'])
  }

  if (command === 'pdf') {
    if (isHelpToken(rest[0])) {
      return writeHelp(['pdf'])
    }
    const payload = await requestCommand(flags.server, 'pdf', {})
    writeResult(payload)
    return 0
  }

  if (command === 'clipboard') {
    const action = rest[0]
    if (isHelpToken(action)) {
      return writeHelp(['clipboard'])
    }
    if (action === 'read') {
      const payload = await requestCommand(flags.server, 'clipboard', {
        action: 'read',
      })
      writeResult(payload)
      return 0
    }
    if (action === 'write') {
      const text = rest.slice(1).join(' ')
      const payload = await requestCommand(flags.server, 'clipboard', {
        action: 'write',
        text,
      })
      writeResult(payload)
      return 0
    }
    return writeHelp(['clipboard'])
  }

  if (command === 'state') {
    const action = rest[0]
    if (isHelpToken(action)) {
      return writeHelp(['state'])
    }
    if (action === 'save') {
      const name = rest[1] || 'default'
      const payload = await requestCommand(flags.server, 'state', {
        action: 'save',
        name,
      })
      writeResult(payload)
      return 0
    }
    if (action === 'load') {
      const stateValue = rest.slice(1).join(' ').trim()
      if (!stateValue) {
        return writeHelp(['state', 'load'])
      }

      try {
        const data = JSON.parse(stateValue)
        if (data && typeof data === 'object') {
          const payload = await requestCommand(flags.server, 'state', {
            action: 'load',
            data,
          })
          writeResult(payload)
          return 0
        }
      } catch {
        // Fall through to loading a saved state by name.
      }

      const payload = await requestCommand(flags.server, 'state', {
        action: 'load',
        name: stateValue,
      })
      writeResult(payload)
      return 0
    }
    return writeHelp(['state'])
  }

  if (command === 'network') {
    const action = rest[0]
    if (isHelpToken(action)) {
      return writeHelp(['network'])
    }
    if (!action) {
      return writeHelp(['network'])
    }

    if (action === 'route') {
      let routeArgs: { url: string; abort: boolean; body?: unknown }
      if (isHelpToken(rest[1])) {
        return writeHelp(['network', 'route'])
      }
      try {
        routeArgs = parseNetworkRouteArgs(rest.slice(1))
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`)
        return 1
      }

      if (!routeArgs.url) {
        return writeHelp(['network', 'route'])
      }

      const payload = await requestCommand(flags.server, 'network', {
        action: 'route',
        url: routeArgs.url,
        abort: routeArgs.abort,
        body: routeArgs.body,
      })
      writeResult(payload)
      return 0
    }

    if (action === 'unroute') {
      if (isHelpToken(rest[1])) {
        return writeHelp(['network', 'unroute'])
      }
      const url = rest[1] || ''
      const payload = await requestCommand(flags.server, 'network', {
        action: 'unroute',
        url: url || undefined,
      })
      writeResult(payload)
      return 0
    }

    if (action === 'requests') {
      if (isHelpToken(rest[1])) {
        return writeHelp(['network', 'requests'])
      }
      const payload = await requestCommand(flags.server, 'network', {
        action: 'requests',
        ...parseNetworkRequestsArgs(rest.slice(1)),
      })
      writeResult(payload)
      return 0
    }

    if (action === 'request') {
      const requestId = rest[1]
      if (isHelpToken(requestId)) {
        return writeHelp(['network', 'request'])
      }
      if (!requestId) {
        return writeHelp(['network', 'request'])
      }

      const payload = await requestCommand(flags.server, 'network', {
        action: 'request',
        requestId,
      })
      writeResult(payload)
      return 0
    }

    if (action === 'har') {
      const subaction = rest[1]
      if (isHelpToken(subaction)) {
        return writeHelp(['network', 'har'])
      }
      if (subaction === 'start') {
        const payload = await requestCommand(flags.server, 'network', {
          action: 'har',
          subaction: 'start',
        })
        writeResult(payload)
        return 0
      }

      if (subaction === 'stop') {
        const payload = await requestCommand(flags.server, 'network', {
          action: 'har',
          subaction: 'stop',
        })

        if (payload?.ok === false) {
          writeResult(payload)
          return 1
        }

        const result = isRecord(payload?.result)
          ? (payload.result as NetworkHarStopResult)
          : undefined
        const har =
          result && isRecord(result.har)
            ? result.har
            : await collectHarFromNetwork(
                flags.server,
                typeof result?.startedAt === 'string' ? result.startedAt : null,
              )
        const outputPath = rest[2] || null
        const savedPath = await writeHarFile(har, outputPath)
        writeResult({ ok: true, result: savedPath })
        return 0
      }

      return writeHelp(['network', 'har'])
    }

    return writeHelp(['network'])
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
