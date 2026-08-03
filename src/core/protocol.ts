import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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

/** 状态文件临时文件命名：<basename>.<pid>.<uuid>.tmp */
const TEMP_FILE_NAME_PATTERN = /^(state\.json|token|config\.json)\.[^/]+\.tmp$/
/** 启动清理时仅删除明显是上一次崩溃残留的临时文件（默认老于 5s），避免误删并发写入中的临时文件 */
export const STALE_TEMP_FILE_MAX_AGE_MS = 5_000

/**
 * 清理状态目录中由崩溃中断（如 SIGKILL）残留的临时文件。
 * writeJsonFile 先写 .tmp 再原子 rename；进程在两者之间被杀会留下 .tmp 残渣。
 * 带年龄守卫：只删除超过 maxAgeMs 未修改的文件，避免误删正在进行的并发写入。
 * @param homeDir 可选的家目录路径
 * @param maxAgeMs 文件保留最大年龄，默认 5 秒
 */
export async function cleanupStaleTempFiles(
  homeDir: string = getHomeDir(),
  maxAgeMs: number = STALE_TEMP_FILE_MAX_AGE_MS,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(getStateDir(homeDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }

  const cutoff = Date.now() - maxAgeMs
  const stalePaths: string[] = []

  for (const entry of entries) {
    if (!TEMP_FILE_NAME_PATTERN.test(entry)) {
      continue
    }

    const filePath = path.join(getStateDir(homeDir), entry)
    try {
      const fileStats = await stat(filePath)
      if (fileStats.mtimeMs < cutoff) {
        stalePaths.push(filePath)
      }
    } catch {
      // 文件可能已被并发清理，忽略
    }
  }

  await Promise.all(
    stalePaths.map(async (filePath) => {
      await rm(filePath, { force: true }).catch(() => {})
    }),
  )
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
      // 状态文件损坏（如进程中途被杀留下截断的 JSON）：回退默认值，但必须留痕
      console.error(
        `[autobrowser] failed to parse JSON file ${filePath}, falling back to default value:`,
        error.message,
      )
      return fallback
    }

    throw error
  }
}

/**
 * 将对象转换并写入为缩进后的 JSON 文件，并设置严格的权限 (0o600)。
 * 先写同目录临时文件再原子 rename，避免进程中途被杀留下截断的状态文件。
 */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  // 临时文件名带进程号和随机后缀，避免并发写同一路径时互相覆盖
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    if (process.platform !== 'win32') {
      // 本地状态文件可能包含连接 token；权限收紧失败时直接报错，避免留下可被其他用户读取的凭据。
      // 必须在 rename 之前收紧临时文件权限，避免目标文件出现权限窗口期。
      try {
        await chmod(tempPath, 0o600)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`failed to set private file permissions for ${filePath}: ${message}`, {
          cause: error,
        })
      }
    }
    await rename(tempPath, filePath)
  } catch (error) {
    // rename 失败时清理临时文件，避免在状态目录里堆积 .tmp 垃圾
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
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
