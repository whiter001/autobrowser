import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  getHomeDir,
  getStatePath,
  getTokenPath,
  isPortInUse,
  readJsonFile,
} from '../core/protocol.js'
import { getStatus } from './client.js'

const execFileAsync = promisify(execFile)

export interface DetachedProcessHandle {
  pid?: number
  unref(): void
  kill?(signal?: NodeJS.Signals | number): boolean
  waitForExit?: () => Promise<{ code: number | null; signal: string | null }>
}

export interface ServerSnapshotStatus {
  token: string
  relayPort: number
  ipcPort: number
  startedAt?: string
  extensionConnected?: boolean
}

export interface PersistedConnectionInfo {
  token: string
  relayPort: number
  ipcPort: number
}

export function isServerSnapshotStatus(value: unknown): value is ServerSnapshotStatus {
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

export function isServerSnapshotOnPorts(
  value: unknown,
  relayPort: number,
  ipcPort: number,
): value is ServerSnapshotStatus {
  return isServerSnapshotStatus(value) && value.relayPort === relayPort && value.ipcPort === ipcPort
}

export function killDetachedProcess(handle: DetachedProcessHandle | null | undefined): void {
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

export async function spawnDetachedProcess(
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

export async function waitForServerStatus(
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

export async function stopBackgroundServer(
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

export function buildServerLaunchArgs(
  ports: {
    relayPort: number
    ipcPort: number
  },
  extensionId: string,
): string[] {
  return [
    process.argv[1],
    'server',
    '--serve',
    '--relay-port',
    String(ports.relayPort),
    '--ipc-port',
    String(ports.ipcPort),
    '--extension-id',
    extensionId,
  ]
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

export async function readPersistedConnectionInfo(
  fallbackRelayPort: number,
  fallbackIpcPort: number,
): Promise<PersistedConnectionInfo | null> {
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

export { normalizeSavedPort }
