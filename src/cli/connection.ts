import { CommandRequestError, isRecord, type CommandResponse } from './client.js'

export interface ConnectionTarget {
  token: string
  relayPort: number
  ipcPort: number
}

export function getLocalControlBaseUrl(ipcPort: number): string {
  return `http://127.0.0.1:${ipcPort}`
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

export function targetsLocalControlServer(baseUrl: string, ipcPort: number): boolean {
  try {
    const url = new URL(baseUrl)
    const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'))

    return url.protocol === 'http:' && isLoopbackHostname(url.hostname) && port === ipcPort
  } catch {
    return false
  }
}

export function isServerConnectionError(error: unknown): boolean {
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

type CommandConnectionFailure = 'not-sent' | 'unknown'

const RESET_CONNECTION_PATTERNS = [
  'econnreset',
  'epipe',
  'socket hang up',
  'socket closed',
  'connection closed',
  'connection terminated',
  'server closed',
]

export function classifyCommandConnectionError(error: unknown): CommandConnectionFailure | null {
  if (!(error instanceof CommandRequestError)) return null
  if (error.phase === 'response') return 'unknown'

  const messages: string[] = []
  const codes: string[] = []
  const seen = new Set<unknown>()
  let cause: unknown = error.cause
  while (cause !== undefined && !seen.has(cause)) {
    seen.add(cause)
    messages.push(String(isRecord(cause) ? (cause.message ?? '') : cause).toLowerCase())
    if (!isRecord(cause)) break
    if (typeof cause.code === 'string') codes.push(cause.code.toUpperCase())
    cause = cause.cause
  }

  // reset 证据优先；仅无其他 code 冲突的结构化拒绝连接能证明未送达。
  // 纯文本及 DNS/路由错误均不能排除请求已写入，不能据此自动重放。
  if (messages.some((message) => RESET_CONNECTION_PATTERNS.some((p) => message.includes(p)))) {
    return 'unknown'
  }
  return codes.length > 0 && codes.every((code) => code === 'ECONNREFUSED') ? 'not-sent' : 'unknown'
}

/** 不确定执行结果时的稳定报错：不重试，并指明先查命令状态与页面再决定是否重来。 */
export function buildCommandExecutionUnknownResponse(
  command: string,
  originalMessage: string,
): CommandResponse {
  const message =
    `autobrowser lost the connection to the control server while sending "${command}"; ` +
    'the command may already have run in the browser, so it was not retried automatically.\n' +
    'Inspect the current page first (for example `autobrowser snapshot` or `autobrowser status`), ' +
    'then decide whether running the command again is safe.'

  return {
    ok: false,
    error: {
      message,
      code: 'COMMAND_EXECUTION_UNKNOWN',
      details: { command, originalMessage },
      suggestedAction:
        "Run 'autobrowser command list' (or 'autobrowser command status <id>') to check whether the command is still pending, then 'autobrowser status' and 'autobrowser snapshot' to inspect the browser before retrying. Do not blindly replay side-effecting commands such as click, fill, goto or form submissions.",
    },
  }
}

export interface ConnectionRecoveryHints {
  localTarget: boolean
  serverStartAttempted: boolean
  serverStarted: boolean
  connectPageAttempted: boolean
  connectPageOpened: boolean
}

export function createConnectionRecoveryHints(localTarget: boolean): ConnectionRecoveryHints {
  return {
    localTarget,
    serverStartAttempted: false,
    serverStarted: false,
    connectPageAttempted: false,
    connectPageOpened: false,
  }
}

export function formatConnectionRecoveryMessage(
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
