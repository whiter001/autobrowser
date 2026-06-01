import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
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

/**
 * 获取用户家目录路径。
 * 优先级：AUTOBROWSER_HOME > HOME > os.homedir()。
 * @returns 家目录绝对路径
 */
export function getHomeDir(): string {
  return process.env.AUTOBROWSER_HOME || process.env.HOME || os.homedir()
}

/**
 * 获取 .autobrowser 状态目录的路径。
 * @param homeDir 可选的家目录路径
 * @returns 状态目录绝对路径
 */
export function getStateDir(homeDir: string = getHomeDir()): string {
  return path.join(homeDir, STATE_DIR_NAME)
}

/**
 * 获取 token 文件的完整路径。
 * @param homeDir 可选的家目录路径
 * @returns token 文件绝对路径
 */
export function getTokenPath(homeDir: string = getHomeDir()): string {
  return path.join(getStateDir(homeDir), TOKEN_FILE_NAME)
}

/**
 * 获取 state.json 状态文件的完整路径。
 * @param homeDir 可选的家目录路径
 * @returns 状态文件绝对路径
 */
export function getStatePath(homeDir: string = getHomeDir()): string {
  return path.join(getStateDir(homeDir), STATE_FILE_NAME)
}

/**
 * 获取 config.json 配置文件路径。
 * @param homeDir 可选的家目录路径
 * @returns 配置文件绝对路径
 */
export function getConfigPath(homeDir: string = getHomeDir()): string {
  return path.join(getStateDir(homeDir), CONFIG_FILE_NAME)
}

/**
 * 生成一个新的连接 token (UUID)。
 */
export function createToken(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/**
 * 生成一个带前缀的唯一请求/资源 ID。
 * @param prefix ID 前缀，默认为 'req'
 */
export function createId(prefix: string = 'req'): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * 校验端口号是否有效。
 */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * 确保 .autobrowser 状态目录存在。
 */
export async function ensureStateDir(homeDir: string = getHomeDir()): Promise<void> {
  await mkdir(getStateDir(homeDir), { recursive: true })
}

/**
 * 从文件系统中读取并解析 JSON 文件。
 * @param filePath 文件路径
 * @param fallback 读取失败或文件不存在时的回退值
 */
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

    if (error instanceof SyntaxError) {
      return fallback
    }

    throw error
  }
}

/**
 * 将对象转换并写入为缩进后的 JSON 文件，并设置严格的权限 (0o600)。
 */
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

/**
 * 创建一个 JSON 响应。
 */
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

/**
 * 从请求主体中解析 JSON 数据，为空时返回空对象。
 */
export async function parseJsonRequest<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text()
  if (!text.trim()) {
    return {} as T
  }
  return JSON.parse(text) as T
}

/**
 * 创建一个纯文本响应。
 */
export function textResponse(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers || {})
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/plain; charset=utf-8')
  }
  return new Response(value, { ...init, headers })
}

/**
 * 创建一个 HTML 响应。
 */
export function htmlResponse(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers || {})
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8')
  }
  return new Response(value, { ...init, headers })
}

/**
 * 返回标准化的成功响应格式。
 */
export function success<T>(
  result: T,
  meta: Record<string, unknown> = {},
): { ok: true; result: T; [key: string]: unknown } {
  return { ok: true, result, ...meta }
}

/**
 * 返回标准化的失败响应格式。
 */
export function failure(
  message: string,
  meta: Record<string, unknown> = {},
): { ok: false; error: { message: string; [key: string]: unknown } } {
  return { ok: false, error: { message, ...meta } }
}

/**
 * 检查指定端口是否正在被占用。
 */
export async function isPortInUse(port: number): Promise<boolean> {
  if (!isValidPort(port)) {
    return false
  }

  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false

    const finish = (result: boolean): void => {
      if (settled) {
        return
      }

      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}
