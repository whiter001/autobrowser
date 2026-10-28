import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  getConfigPath,
  getStateDir,
  isPortInUse,
  isValidPort,
  readJsonFile,
  writeJsonFile,
} from './protocol.js'

const SESSION_FILE_NAME = 'session.json'
const FIRST_SESSION_PORT = 58000

export interface SessionRecord {
  name: string
  homeDir: string
  profileDir: string
  relayPort: number
  ipcPort: number
  createdAt: string
}

interface SessionError extends Error {
  code?: string
  suggestedAction?: string
}

function sessionError(message: string, code: string, suggestedAction?: string): SessionError {
  const error = new Error(message) as SessionError
  error.code = code
  if (suggestedAction) error.suggestedAction = suggestedAction
  return error
}

export function normalizeSessionName(name: string | null | undefined): string {
  const normalized = typeof name === 'string' ? name.trim() : ''
  if (!normalized || normalized === 'default') return ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    throw sessionError(
      'session name must start with an alphanumeric character and contain only letters, numbers, dot, underscore or hyphen (max 64 chars)',
      'INVALID_SESSION_NAME',
    )
  }
  return normalized
}

function getSessionsRoot(baseHomeDir: string): string {
  return path.join(getStateDir(baseHomeDir), 'sessions')
}

function getSessionDir(baseHomeDir: string, name: string): string {
  return path.join(getSessionsRoot(baseHomeDir), name)
}

function buildRecord(
  baseHomeDir: string,
  name: string,
  relayPort: number,
  ipcPort: number,
  createdAt: string,
): SessionRecord {
  const sessionDir = getSessionDir(baseHomeDir, name)
  return {
    name,
    homeDir: path.join(sessionDir, 'home'),
    profileDir: path.join(sessionDir, 'profile'),
    relayPort,
    ipcPort,
    createdAt,
  }
}

export async function readSession(baseHomeDir: string, nameInput: string): Promise<SessionRecord> {
  const name = normalizeSessionName(nameInput)
  if (!name) throw sessionError('a named session is required', 'SESSION_NOT_FOUND')
  const record = await readJsonFile<Record<string, unknown> | null>(
    path.join(getSessionDir(baseHomeDir, name), SESSION_FILE_NAME),
    null,
  )
  if (
    !record ||
    record.name !== name ||
    !isValidPort(Number(record.relayPort)) ||
    !isValidPort(Number(record.ipcPort)) ||
    Number(record.relayPort) === Number(record.ipcPort)
  ) {
    throw sessionError(
      `session not found: ${name}`,
      'SESSION_NOT_FOUND',
      `Run session create ${name} first.`,
    )
  }
  return buildRecord(
    baseHomeDir,
    name,
    Number(record.relayPort),
    Number(record.ipcPort),
    typeof record.createdAt === 'string' ? record.createdAt : '',
  )
}

export async function listSessions(baseHomeDir: string): Promise<SessionRecord[]> {
  let entries
  try {
    entries = await readdir(getSessionsRoot(baseHomeDir), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const sessions: SessionRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      sessions.push(await readSession(baseHomeDir, entry.name))
    } catch {
      // 临时目录或未写完的会话不参与生命周期操作，避免误删未知目录。
    }
  }
  return sessions.sort((left, right) => left.name.localeCompare(right.name))
}

export async function createSession(
  baseHomeDir: string,
  nameInput: string,
  options: {
    relayPort?: number
    ipcPort?: number
    portInUse?: (port: number) => Promise<boolean>
  } = {},
): Promise<SessionRecord> {
  const name = normalizeSessionName(nameInput)
  if (!name) throw sessionError('session name is required', 'INVALID_SESSION_NAME')
  const existing = await listSessions(baseHomeDir)
  if (existing.some((session) => session.name === name)) {
    throw sessionError(`session already exists: ${name}`, 'SESSION_EXISTS')
  }
  const usedPorts = new Set(existing.flatMap((session) => [session.relayPort, session.ipcPort]))
  const portInUse = options.portInUse || isPortInUse
  const available = async (port: number): Promise<boolean> =>
    isValidPort(port) && !usedPorts.has(port) && !(await portInUse(port))

  let relayPort = options.relayPort
  let ipcPort = options.ipcPort
  if (relayPort !== undefined && !(await available(relayPort))) {
    throw sessionError(`relay port is unavailable: ${relayPort}`, 'SESSION_PORT_UNAVAILABLE')
  }
  if (ipcPort !== undefined && !(await available(ipcPort))) {
    throw sessionError(`IPC port is unavailable: ${ipcPort}`, 'SESSION_PORT_UNAVAILABLE')
  }
  if (relayPort !== undefined && relayPort === ipcPort) {
    throw sessionError('relay and IPC ports must be different', 'SESSION_PORT_UNAVAILABLE')
  }
  if (relayPort !== undefined) usedPorts.add(relayPort)
  if (ipcPort !== undefined) usedPorts.add(ipcPort)

  let candidate = FIRST_SESSION_PORT
  while (relayPort === undefined || ipcPort === undefined) {
    if (candidate > 65535) {
      throw sessionError('no free session ports are available', 'SESSION_PORT_UNAVAILABLE')
    }
    if (relayPort === undefined && (await available(candidate))) {
      relayPort = candidate
      usedPorts.add(candidate)
      candidate += 1
      continue
    }
    if (ipcPort === undefined && (await available(candidate))) {
      ipcPort = candidate
      usedPorts.add(candidate)
      candidate += 1
      continue
    }
    candidate += 1
  }
  if (relayPort === ipcPort) {
    throw sessionError('relay and IPC ports must be different', 'SESSION_PORT_UNAVAILABLE')
  }

  const sessionDir = getSessionDir(baseHomeDir, name)
  await mkdir(getSessionsRoot(baseHomeDir), { recursive: true })
  try {
    await mkdir(sessionDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw sessionError(`session already exists: ${name}`, 'SESSION_EXISTS')
    }
    throw error
  }
  const record = buildRecord(baseHomeDir, name, relayPort, ipcPort, new Date().toISOString())
  try {
    await writeJsonFile(path.join(sessionDir, SESSION_FILE_NAME), record)
    await writeJsonFile(getConfigPath(record.homeDir), {
      browserArgs: [`--user-data-dir=${record.profileDir}`],
    })
  } catch (error) {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return record
}

export async function deleteSessionData(
  baseHomeDir: string,
  nameInput: string,
  removeDirectory: (directory: string) => Promise<void> = async (directory) =>
    await rm(directory, { recursive: true }),
): Promise<{ name: string; deleted: boolean; alreadyClean: boolean }> {
  const name = normalizeSessionName(nameInput)
  if (!name) {
    throw sessionError(
      'delete-data requires an explicit named session; the default session is never deleted',
      'INVALID_SESSION_NAME',
    )
  }
  try {
    await removeDirectory(getSessionDir(baseHomeDir, name))
    return { name, deleted: true, alreadyClean: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { name, deleted: false, alreadyClean: true }
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw sessionError(
        `session data is locked by a running browser or another process: ${name}`,
        'SESSION_DATA_LOCKED',
        'Close the browser using this profile, then retry session delete-data.',
      )
    }
    throw error
  }
}
