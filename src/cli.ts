import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
  return !['title', 'url'].includes(attr)
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
  autobrowser fill <selector> <value>
  autobrowser press <key>
  autobrowser hover <selector>
  autobrowser focus <selector>
  autobrowser select <selector> <value>
  autobrowser check <selector>
  autobrowser uncheck <selector>
  autobrowser scroll [selector] [deltaX] [deltaY]
  autobrowser drag <startSelector> [endSelector]
  autobrowser upload <selector> <files...>
  autobrowser back
  autobrowser forward
  autobrowser reload
  autobrowser window new
  autobrowser frame <selector|top>
  autobrowser is <visible|enabled|checked|disabled> <selector>
  autobrowser get <text|html|value|title|url|count|attr|box> [selector]
  autobrowser dialog accept|dismiss [promptText]
  autobrowser wait <selector|url|text|time|load|networkidle> [value] [timeout]
  autobrowser cookies get|set|clear
  autobrowser storage get|set|clear [key] [value]
  autobrowser console
  autobrowser errors
  autobrowser set viewport|offline|headers|geo|media
  autobrowser pdf
  autobrowser clipboard read|write [text]
  autobrowser state save [name]
  autobrowser state load [name|json]
  autobrowser screenshot
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
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number | void> {
  const { flags, args } = parseCli(argv)
  const [command, ...rest] = args

  function writeResult(payload: CommandResponse | Record<string, unknown>): void {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
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
    await openUrl(`http://127.0.0.1:${flags.relayPort}/connect`)
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
    const payload = await requestCommand(flags.server, command, {})
    writeResult(payload)
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

  if (command === 'reload') {
    const payload = await requestCommand(flags.server, 'reload', {})
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
    writeResult(payload)
    return 0
  }

  if (command === 'get') {
    const attr = rest[0] || 'text'
    const selector = rest[1]
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
    const type = rest[0]
    const value = rest[1]
    const timeout = Number(rest[2] || 30000)

    const waitArgs: WaitArgs = { timeout }

    if (type === 'time' || type === 'ms') {
      waitArgs.type = 'time'
      waitArgs.ms = Number(value) || timeout
    } else if (type === 'selector') {
      waitArgs.type = 'selector'
      waitArgs.selector = value
      waitArgs.timeout = timeout
    } else if (type === 'url') {
      waitArgs.type = 'url'
      waitArgs.url = value
      waitArgs.timeout = timeout
    } else if (type === 'text') {
      waitArgs.type = 'text'
      waitArgs.text = value
      waitArgs.timeout = timeout
    } else if (type === 'load') {
      waitArgs.type = 'load'
      waitArgs.timeout = timeout
    } else if (type === 'networkidle') {
      waitArgs.type = 'networkidle'
      waitArgs.timeout = timeout
    } else if (!isNaN(Number(type))) {
      waitArgs.type = 'time'
      waitArgs.ms = Number(type)
    } else {
      process.stderr.write('unknown wait type: use time/selector/url/text/load/networkidle\n')
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
