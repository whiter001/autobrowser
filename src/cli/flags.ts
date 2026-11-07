import { DEFAULT_IPC_PORT, DEFAULT_RELAY_PORT, isValidPort } from '../core/protocol.js'
import { type CliFlags, type ParsedCli } from './types.js'

const SUPPORTED_GLOBAL_FLAGS = [
  '--json',
  '--raw',
  '--brief',
  '--stdin',
  '--base64',
  '--print-token',
  '--tab',
  '--frame',
  '--file',
  '--server',
  '--session',
  '--engine',
  '--webdriver-url',
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

export function parseCli(argv: string[]): ParsedCli {
  const flags: CliFlags = {
    json: true,
    jsonExplicitlySet: false,
    brief: false,
    server: `http://127.0.0.1:${DEFAULT_IPC_PORT}`,
    session: '',
    engine: 'chromium',
    webdriverUrl: '',
    relayPort: DEFAULT_RELAY_PORT,
    ipcPort: DEFAULT_IPC_PORT,
    serverExplicitlySet: false,
    relayPortExplicitlySet: false,
    ipcPortExplicitlySet: false,
    extensionId: null,
    autoConnect: false,
    browserCommand: null,
    browserArgs: [],
    stdin: false,
    file: null,
    base64: false,
    printToken: false,
    tab: null,
    frame: null,
  }

  const args: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') {
      args.push(...argv.slice(index))
      break
    }
    if (value === '--json') {
      flags.json = true
      flags.jsonExplicitlySet = true
      continue
    }

    if (value === '--raw') {
      flags.json = false
      continue
    }

    if (value === '--brief') {
      flags.json = false
      flags.brief = true
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

    if (value === '--print-token') {
      flags.printToken = true
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
      flags.serverExplicitlySet = true
      index += 1
      continue
    }

    if (value === '--session' && args.length === 0) {
      flags.session = readFlagValue(argv, index, value)
      index += 1
      continue
    }

    if (value === '--engine' && args.length === 0) {
      const engine = readFlagValue(argv, index, value)
      if (engine !== 'chromium' && engine !== 'firefox' && engine !== 'webkit') {
        throw new Error('--engine must be chromium, firefox or webkit')
      }
      flags.engine = engine
      index += 1
      continue
    }

    if (value === '--webdriver-url' && args.length === 0) {
      flags.webdriverUrl = readFlagValue(argv, index, value)
      index += 1
      continue
    }

    if (value === '--relay-port') {
      flags.relayPort = parsePortFlag(readFlagValue(argv, index, value), value)
      flags.relayPortExplicitlySet = true
      index += 1
      continue
    }

    if (value === '--ipc-port') {
      flags.ipcPort = parsePortFlag(readFlagValue(argv, index, value), value)
      flags.ipcPortExplicitlySet = true
      if (!flags.serverExplicitlySet) {
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

    // --version 是 version 命令的速记：放在命令名前时直接当成命令名，
    // 不再走"未知全局参数"分支（此前 autobrowser --version 会直接报错）
    if (args.length === 0 && value === '--version') {
      args.push('version')
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

  const inputSources = [flags.stdin, flags.file !== null, flags.base64].filter(Boolean).length
  if (inputSources > 1) {
    throw new Error('--stdin, --file, and --base64 cannot be combined')
  }

  return { flags, args }
}
