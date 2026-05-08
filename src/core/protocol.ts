import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const APP_NAME = 'autobrowser'
export const DEFAULT_RELAY_PORT = 57978
export const DEFAULT_IPC_PORT = 57979
export const STATE_DIR_NAME = '.autobrowser'
export const CONFIG_FILE_NAME = 'config.json'
export const TOKEN_FILE_NAME = 'token'
export const STATE_FILE_NAME = 'state.json'
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export interface ResponseInit {
  headers?: Record<string, string>
  status?: number
}

export function getHomeDir(): string {
  return process.env.AUTOBROWSER_HOME || process.env.HOME || os.homedir()
}

export function getStateDir(homeDir: string = getHomeDir()): string {
  return path.join(homeDir, STATE_DIR_NAME)
}

export function getTokenPath(homeDir: string = getHomeDir()): string {
  return path.join(getStateDir(homeDir), TOKEN_FILE_NAME)
}

export function getStatePath(homeDir: string = getHomeDir()): string {
  return path.join(getStateDir(homeDir), STATE_FILE_NAME)
}

export function getConfigPath(homeDir: string = getHomeDir()): string {
  return path.join(getStateDir(homeDir), CONFIG_FILE_NAME)
}

export function createToken(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

export function createId(prefix: string = 'req'): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export async function ensureStateDir(homeDir: string = getHomeDir()): Promise<void> {
  await mkdir(getStateDir(homeDir), { recursive: true })
}

export async function readJsonFile<T>(
  filePath: string,
  fallback: T | null = null,
): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as T
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback
    }
    throw error
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (process.platform !== 'win32') {
    // 本地状态文件可能包含连接 token；权限收紧失败时直接报错，避免留下可被其他用户读取的凭据。
    try {
      await chmod(filePath, 0o600)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`failed to set private file permissions for ${filePath}: ${message}`, {
        cause: error,
      })
    }
  }
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers || {})
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8')
  }
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    ...init,
    headers,
  })
}

export async function parseJsonRequest<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text()
  if (!text.trim()) {
    return {} as T
  }
  return JSON.parse(text) as T
}

export function textResponse(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers || {})
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/plain; charset=utf-8')
  }
  return new Response(value, { ...init, headers })
}

export function htmlResponse(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers || {})
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8')
  }
  return new Response(value, { ...init, headers })
}

export function success<T>(
  result: T,
  meta: Record<string, unknown> = {},
): { ok: true; result: T; [key: string]: unknown } {
  return { ok: true, result, ...meta }
}

export function failure(
  message: string,
  meta: Record<string, unknown> = {},
): { ok: false; error: { message: string; [key: string]: unknown } } {
  return { ok: false, error: { message, ...meta } }
}

export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`)
    return response.ok
  } catch {
    return false
  }
}
