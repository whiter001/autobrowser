/// <reference types="bun-types" />
/// <reference types="node" />
/// <reference lib="dom" />

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { getExtensionUrl } from './core/extension.js'
import { DEFAULT_IPC_PORT, DEFAULT_RELAY_PORT, isPortInUse } from './core/protocol.js'
import { startServers } from './server.js'

const execFileAsync = promisify(execFile)

interface CliFlags {
  json: boolean
  server: string
  relayPort: number
  ipcPort: number
  stdin: boolean
  file: string | null
  base64: boolean
}

interface ParsedCli {
  flags: CliFlags
  args: string[]
}

function parseCli(argv: string[]): ParsedCli {
  const flags: CliFlags = {
    json: false,
    server: `http://127.0.0.1:${DEFAULT_IPC_PORT}`,
    relayPort: DEFAULT_RELAY_PORT,
    ipcPort: DEFAULT_IPC_PORT,
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

function parseNetworkRouteArgs(rest: string[]): { url: string; abort: boolean; body?: unknown } {
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

function extractScreenshotData(result: Record<string, unknown> | undefined): { data: Buffer; mimeType: string } {
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

function printHelp(): string {
  return `autobrowser

Usage:
  autobrowser server
  autobrowser status
  autobrowser connect
  autobrowser tab list
  autobrowser tab new <url>
  autobrowser goto <url>
  autobrowser open <url>
  autobrowser eval [--stdin|--file path|--base64] <script>
  autobrowser click <selector>
  autobrowser dblclick <selector>
  autobrowser fill <selector> <value>
  autobrowser type <selector> <value>
  autobrowser press <key>
  autobrowser keyboard type <text>
  autobrowser keyboard inserttext <text>
  autobrowser keyboard keydown <key>
  autobrowser keyboard keyup <key>
  autobrowser hover <selector>
  autobrowser focus <selector>
  autobrowser select <selector> <value>
  autobrowser check <selector>
  autobrowser uncheck <selector>
  autobrowser scroll [selector] [deltaX] [deltaY]
  autobrowser scrollintoview <selector>
  autobrowser drag <startSelector> [endSelector]
  autobrowser upload <selector> <files...>
  autobrowser back
  autobrowser forward
  autobrowser reload
  autobrowser close [all]
  autobrowser window new
  autobrowser frame <selector|top>
  autobrowser is <visible|enabled|checked|disabled|focused> <selector>
  autobrowser get <text|html|value|title|url|cdp-url|count|attr|box|styles> [selector]
  autobrowser dialog accept|dismiss [promptText]
  autobrowser dialog status
  autobrowser wait <selector|ms> [--state visible|hidden] [--timeout <ms>]
  autobrowser wait --text <text>
  autobrowser wait --url <pattern>
  autobrowser wait --load [networkidle]
  autobrowser wait --fn <expression>
  autobrowser cookies get|set|clear
  autobrowser storage get|set|clear [key] [value]
  autobrowser console
  autobrowser errors
  autobrowser set viewport|offline|headers|geo|media
  autobrowser pdf
  autobrowser clipboard read|write [text]
  autobrowser state save [name]
  autobrowser state load [name|json]
  autobrowser network route <url> [--abort] [--body <json>]
  autobrowser network unroute [url]
  autobrowser network requests [--filter <text>] [--type <xhr,fetch>] [--method <POST>] [--status <2xx>]
  autobrowser network request <requestId>
  autobrowser network har start
  autobrowser network har stop [output.har]
  autobrowser screenshot [path] [--full] [--annotate] [--screenshot-dir <dir>] [--screenshot-format png|jpeg] [--screenshot-quality <n>]
  autobrowser snapshot

Flags:
  --json        output JSON
  --server URL  target server base URL, default http://127.0.0.1:47979
  --stdin       read command body from stdin
  --file PATH   read command body from file
  --base64      decode command body from base64
`
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

async function openUrl(url: string): Promise<void> {
  const platform = process.platform
  if (platform === 'darwin') {
    await execFileAsync('open', [url])
    return
  }

  if (platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', url])
    return
  }

  await execFileAsync('xdg-open', [url])
}

interface CommandResponse {
  ok: boolean
  result?: unknown
  error?: { message: string; code?: string }
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number | void> {
  const { flags, args } = parseCli(argv)
  const [command, ...rest] = args

  function writeResult(payload: CommandResponse | Record<string, unknown> | string | number | boolean | bigint | null | undefined): void {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
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
      process.exitCode = 1
      return
    }

    const result = p?.result ?? payload
    if (typeof result === 'string') {
      process.stdout.write(result.endsWith('\n') ? result : `${result}\n`)
      return
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(printHelp())
    return 0
  }

  if (command === 'server') {
    if (await isPortInUse(flags.relayPort)) {
      process.stderr.write('Server already running on port ' + flags.relayPort + '\n')
      process.exit(1)
    }
    const servers = await startServers({
      relayPort: flags.relayPort,
      ipcPort: flags.ipcPort,
    })
    process.stdout.write(
      `autobrowser server started\nrelay: http://127.0.0.1:${servers.runtime.runtime.relayPort}\nipc: http://127.0.0.1:${servers.runtime.runtime.ipcPort}\n`,
    )

    const shutdown = async () => {
      await servers.stop()
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return new Promise(() => {})
  }

  if (command === 'connect') {
    const status = await getStatus(flags.server).catch(() => null)
    if (!status) {
      await openUrl(`http://127.0.0.1:${flags.relayPort}/connect`)
      return 0
    }

    const token = typeof status.token === 'string' ? status.token : ''
    const relayPort = Number(status.relayPort || flags.relayPort)
    if (!token) {
      await openUrl(`http://127.0.0.1:${relayPort}/connect`)
      return 0
    }

    try {
      await openUrl(
        getExtensionUrl('/connect.html', {
          token,
          relayPort,
          ipcPort: Number(status.ipcPort || flags.ipcPort),
        }),
      )
    } catch {
      await openUrl(`http://127.0.0.1:${relayPort}/connect`)
    }
    return 0
  }

  if (command === 'status') {
    const status = await getStatus(flags.server)
    writeResult(status)
    return 0
  }

  if (command === 'tab') {
    const [subcommand, ...tabArgs] = rest
    if (subcommand === 'list') {
      const payload = await requestCommand(flags.server, 'tab.list', {})
      writeResult(payload)
      return 0
    }

    if (subcommand === 'new') {
      const url = tabArgs[0] || 'about:blank'
      const payload = await requestCommand(flags.server, 'tab.new', { url })
      writeResult(payload)
      return 0
    }
  }

  if (command === 'open' || command === 'goto') {
    const url = rest[0]
    if (!url) {
      process.stderr.write('missing url\n')
      return 1
    }

    const payload = await requestCommand(flags.server, 'goto', { url })
    writeResult(payload)
    return 0
  }

  if (command === 'eval') {
    const script = await resolveEvalScript(flags, rest)
    const payload = await requestCommand(flags.server, 'eval', { script })
    writeResult(payload)
    return 0
  }

  if (command === 'click') {
    const selector = rest[0]
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }

    const payload = await requestCommand(flags.server, 'click', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'dblclick') {
    const selector = rest[0]
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }

    const payload = await requestCommand(flags.server, 'dblclick', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'fill') {
    const selector = rest[0]
    const value = rest.slice(1).join(' ')
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
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
      const payload = await requestCommand(flags.server, command, {})
      writeResult(payload)
      return 0
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

    const { data, mimeType } = extractScreenshotData(payload.result as Record<string, unknown> | undefined)
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
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }
    const payload = await requestCommand(flags.server, 'hover', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'press') {
    const key = rest[0]
    if (!key) {
      process.stderr.write('missing key\n')
      return 1
    }
    const payload = await requestCommand(flags.server, 'press', { key })
    writeResult(payload)
    return 0
  }

  if (command === 'focus') {
    const selector = rest[0]
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }
    const payload = await requestCommand(flags.server, 'focus', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'select') {
    const selector = rest[0]
    const value = rest[1]
    if (!selector || value === undefined) {
      process.stderr.write('missing selector or value\n')
      return 1
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
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }
    const payload = await requestCommand(flags.server, 'check', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'uncheck') {
    const selector = rest[0]
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }
    const payload = await requestCommand(flags.server, 'uncheck', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'scroll') {
    const selector = rest[0]
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
    if (!start) {
      process.stderr.write('missing start selector\n')
      return 1
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
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }
    if (!files || files.length === 0) {
      process.stderr.write('missing files\n')
      return 1
    }
    const payload = await requestCommand(flags.server, 'upload', {
      selector,
      files,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'back') {
    const payload = await requestCommand(flags.server, 'back', {})
    writeResult(payload)
    return 0
  }

  if (command === 'forward') {
    const payload = await requestCommand(flags.server, 'forward', {})
    writeResult(payload)
    return 0
  }

  if (command === 'type') {
    const selector = rest[0]
    const value = rest.slice(1).join(' ')
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
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
    if (!action || !['type', 'inserttext', 'keydown', 'keyup'].includes(action)) {
      process.stderr.write('usage: keyboard type|inserttext|keydown|keyup <text>\n')
      return 1
    }

    const payload = await requestCommand(flags.server, 'keyboard', {
      action,
      text: value,
    })
    writeResult(payload)
    return 0
  }

  if (command === 'reload') {
    const payload = await requestCommand(flags.server, 'reload', {})
    writeResult(payload)
    return 0
  }

  if (command === 'close' || command === 'quit' || command === 'exit') {
    const all = rest[0] === 'all' || rest[0] === '--all'
    const payload = await requestCommand(flags.server, 'close', { all })
    writeResult(payload)
    return 0
  }

  if (command === 'window') {
    const action = rest[0]
    if (action === 'new') {
      const payload = await requestCommand(flags.server, 'window', {
        action: 'new',
      })
      writeResult(payload)
      return 0
    }
    process.stderr.write('unknown window action, use: window new\n')
    return 1
  }

  if (command === 'frame') {
    const selector = rest[0]
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }
    const payload = await requestCommand(flags.server, 'frame', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'scrollintoview') {
    const selector = rest[0]
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
    }

    const payload = await requestCommand(flags.server, 'scrollintoview', { selector })
    writeResult(payload)
    return 0
  }

  if (command === 'is') {
    const state = rest[0] || 'visible'
    const selector = rest[1]
    if (!selector) {
      process.stderr.write('missing selector\n')
      return 1
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
    if (action === 'status') {
      const payload = await requestCommand(flags.server, 'dialog', {
        action: 'status',
      })
      writeResult(payload)
      return 0
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
        process.stderr.write('usage: cookies set <name> <value> [domain]\n')
        return 1
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
    process.stderr.write('usage: cookies get|set|clear\n')
    return 1
  }

  if (command === 'storage') {
    const action = rest[0]
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
        process.stderr.write('usage: storage set <key> <value>\n')
        return 1
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
    process.stderr.write('usage: storage get|set|clear\n')
    return 1
  }

  if (command === 'console') {
    const payload = await requestCommand(flags.server, 'console', {})
    writeResult(payload)
    return 0
  }

  if (command === 'errors') {
    const payload = await requestCommand(flags.server, 'errors', {})
    writeResult(payload)
    return 0
  }

  if (command === 'set') {
    const type = rest[0]
    const subArgs = rest.slice(1)

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
    process.stderr.write(
      'usage: set viewport <w> <h>|offline|headers <json>|geo <lat> <lng>|media <scheme>\n',
    )
    return 1
  }

  if (command === 'pdf') {
    const payload = await requestCommand(flags.server, 'pdf', {})
    writeResult(payload)
    return 0
  }

  if (command === 'clipboard') {
    const action = rest[0]
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
    process.stderr.write('usage: clipboard read|write <text>\n')
    return 1
  }

  if (command === 'state') {
    const action = rest[0]
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
        process.stderr.write('usage: state save|load <json>\n')
        return 1
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
    process.stderr.write('usage: state save|load <json>\n')
    return 1
  }

  if (command === 'network') {
    const action = rest[0]

    if (action === 'route') {
      let routeArgs: { url: string; abort: boolean; body?: unknown }
      try {
        routeArgs = parseNetworkRouteArgs(rest.slice(1))
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`)
        return 1
      }

      if (!routeArgs.url) {
        process.stderr.write('usage: network route <url> [--abort] [--body <json>]\n')
        return 1
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
      const url = rest[1] || ''
      const payload = await requestCommand(flags.server, 'network', {
        action: 'unroute',
        url: url || undefined,
      })
      writeResult(payload)
      return 0
    }

    if (action === 'requests') {
      const payload = await requestCommand(flags.server, 'network', {
        action: 'requests',
        ...parseNetworkRequestsArgs(rest.slice(1)),
      })
      writeResult(payload)
      return 0
    }

    if (action === 'request') {
      const requestId = rest[1]
      if (!requestId) {
        process.stderr.write('usage: network request <requestId>\n')
        return 1
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

        const result = payload?.result as { har?: unknown; startedAt?: string; stoppedAt?: string } | undefined
        const har = result?.har || payload
        const outputPath = rest[2] || null
        const savedPath = await writeHarFile(har, outputPath)
        writeResult({ ok: true, result: savedPath })
        return 0
      }

      process.stderr.write('usage: network har start|stop [output.har]\n')
      return 1
    }

    process.stderr.write('usage: network route|unroute|requests|request|har\n')
    return 1
  }

  process.stderr.write(`${printHelp()}\n`)
  return 1
}

if (import.meta.main) {
  main().then((code) => {
    if (typeof code === 'number') {
      process.exitCode = code
    }
  })
}
