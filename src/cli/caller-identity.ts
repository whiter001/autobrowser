import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 自动识别当前调用的 workspace 身份。
 *
 * 思路：向上遍历进程树，找到离 autobrowser 最近的、可信的（非 shell、非 autobrowser
 * 自身）祖先进程，把它的 PID + 启动时间 + 终端标识哈希成一个稳定的 ws_<hex> 身份。
 * PID 可能复用，所以必须靠启动时间区分；shell 和 autobrowser 自身不能当身份，否则
 * 每次执行都被当成不同调用方。AI 宿主或测试可用 AUTOBROWSER_CALLER_ID 直接注入身份。
 */

/** 进程查询不可用时抛出，错误码固定，便于调用方按契约分支处理。 */
export const WORKSPACE_IDENTITY_UNAVAILABLE = 'WORKSPACE_IDENTITY_UNAVAILABLE'

export class WorkspaceIdentityError extends Error {
  readonly code = WORKSPACE_IDENTITY_UNAVAILABLE
  readonly suggestedAction: string

  constructor(message: string, suggestedAction: string) {
    super(message)
    this.name = 'WorkspaceIdentityError'
    this.suggestedAction = suggestedAction
  }
}

export interface ProcessInfo {
  pid: number
  ppid: number
  /** 标准化后的进程启动时间，区分 PID 复用 */
  startTime: string
  name: string
  commandLine: string
}

/** 按 PID 查进程信息：查不到返回 null，查询失败抛 WorkspaceIdentityError。 */
export type ProcessQuery = (pid: number) => Promise<ProcessInfo | null>

export interface ResolveWorkspaceIdOptions {
  /** 注入进程查询，便于测试；不传则按平台选用真实查询 */
  queryProcess?: ProcessQuery
  getCurrentPid?: () => number
  getEnv?: () => NodeJS.ProcessEnv
  /** 覆盖 AUTOBROWSER_CALLER_ID 注入，便于测试 */
  callerId?: string
  /** 单次查询与整体兜底超时（毫秒）；默认按平台取 defaultIdentityTimeoutMs() */
  timeoutMs?: number
}

const SHELL_NAMES = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'ksh',
  'dash',
  'tcsh',
  'csh',
  'elvish',
  // env 只是每次调用临时经过的包装器，不能比后面的真实宿主优先成为身份
  'env',
  'cmd',
  'powershell',
  'pwsh',
])

const NODE_NAMES = new Set(['node', 'bun'])

// 原生启动器把真正的 bun 进程当作子进程，自身在每次调用中都是新进程。
// 命名来自 scripts/launcher-go 与 scripts/link-bun：installed 名是 autobrowser(.exe)，
// 发布产物是 autobrowser-<os>-<arch>(.exe)，两种情况都必须跳过，否则身份会随调用漂移。
const LAUNCHER_NAME_PATTERN = /^autobrowser(-[a-z0-9]+)*$/

// Windows 枚举 Win32_Process 冷启动常超过 5s，默认预算需要覆盖这段固定成本。
const POSIX_DEFAULT_TIMEOUT_MS = 5000
const WINDOWS_DEFAULT_TIMEOUT_MS = 15_000

/** 自动身份解析的默认预算；显式 options.timeoutMs 仍优先。 */
export function defaultIdentityTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? WINDOWS_DEFAULT_TIMEOUT_MS : POSIX_DEFAULT_TIMEOUT_MS
}

function normalizeName(name: string): string {
  return name
    .replace(/^.*[/\\]/, '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
}

function isShellProcess(info: ProcessInfo): boolean {
  return SHELL_NAMES.has(normalizeName(info.name))
}

// autobrowser 本体（含 relay 进程）由 node/bun 拉起，命令里带 autobrowser 字样；
// 原生启动器则是固定名字的独立可执行文件。两类进程都不算调用方，
// 避免把 autobrowser 自己（或每次新建的启动器）当成 workspace 主人。
function isAutobrowserProcess(info: ProcessInfo): boolean {
  const name = normalizeName(info.name)
  if (LAUNCHER_NAME_PATTERN.test(name)) {
    return true
  }
  if (!NODE_NAMES.has(name)) {
    return false
  }
  return /autobrowser|src[\\/]cli|dist[\\/]autobrowser/i.test(info.commandLine)
}

function buildWindowsQuery(timeoutMs: number): ProcessQuery {
  let processesPromise: Promise<Map<number, ProcessInfo>> | null = null
  return async (pid) => {
    // 一次取回进程表比逐层启动 PowerShell 或逐层 CIM 查询更稳定；祖先遍历共享同一快照。
    processesPromise ??= (async () => {
      const command =
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ConvertTo-Json -Compress'
      try {
        const result = await execFileAsync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', command],
          { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        )
        return parseWindowsProcessTable(result.stdout)
      } catch (error) {
        throw new WorkspaceIdentityError(
          `process table query failed: ${error instanceof Error ? error.message : String(error)}`,
          'Ensure PowerShell is available and that querying Win32_Process is permitted, or set AUTOBROWSER_CALLER_ID to a stable caller identifier.',
        )
      }
    })()
    return (await processesPromise).get(pid) ?? null
  }
}

function parseWindowsProcessTable(stdout: string): Map<number, ProcessInfo> {
  const trimmed = stdout.trim()
  const parsed = trimmed ? (JSON.parse(trimmed) as unknown) : []
  const records = Array.isArray(parsed) ? parsed : [parsed]
  const processes = new Map<number, ProcessInfo>()
  for (const value of records) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const pid = Number(record.ProcessId)
    const ppid = Number(record.ParentProcessId)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    processes.set(pid, {
      pid,
      ppid,
      startTime: typeof record.CreationDate === 'string' ? record.CreationDate : '',
      name: typeof record.Name === 'string' ? record.Name : '',
      commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : '',
    })
  }
  return processes
}

function buildPosixQuery(timeoutMs: number): ProcessQuery {
  return async (pid) => {
    let stdout: string
    try {
      const result = await execFileAsync(
        'ps',
        ['-o', 'pid=,ppid=,lstart=,comm=,args=', '-p', String(pid)],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      )
      stdout = result.stdout
    } catch (error) {
      throw new WorkspaceIdentityError(
        `process query failed for pid ${pid}: ${error instanceof Error ? error.message : String(error)}`,
        'Ensure "ps" is available and that process enumeration is permitted, or set AUTOBROWSER_CALLER_ID to a stable caller identifier.',
      )
    }
    return parsePosixProcess(stdout)
  }
}

// ps 的 lstart 固定为 5 个字段（星期 月 日 时:分:秒 年），其后才是 comm 与完整 args。
function parsePosixProcess(stdout: string): ProcessInfo | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }

  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 7) {
    return null
  }

  const parsedPid = Number(tokens[0])
  const ppid = Number(tokens[1])
  const startTime = tokens.slice(2, 7).join(' ')
  const name = tokens[7] ?? ''
  const commandLine = tokens.slice(8).join(' ')
  if (!Number.isInteger(parsedPid) || !Number.isInteger(ppid)) {
    return null
  }
  return { pid: parsedPid, ppid, startTime, name, commandLine }
}

async function findTrustedAncestor(
  startPid: number,
  queryProcess: ProcessQuery,
): Promise<ProcessInfo> {
  const visited = new Set<number>()
  let currentPid = startPid

  while (Number.isInteger(currentPid) && currentPid > 0 && !visited.has(currentPid)) {
    visited.add(currentPid)
    const info = await queryProcess(currentPid).catch((error) => {
      if (error instanceof WorkspaceIdentityError) {
        throw error
      }
      throw new WorkspaceIdentityError(
        `failed to resolve workspace identity: ${error instanceof Error ? error.message : String(error)}`,
        'Set AUTOBROWSER_CALLER_ID to a stable caller identifier, or ensure process enumeration works on this host.',
      )
    })
    // 链路断裂（进程已退出）或到达 init/system 这种根进程，都不能当调用方
    if (!info || info.pid <= 1) {
      break
    }
    if (info.pid === startPid || isAutobrowserProcess(info) || isShellProcess(info)) {
      currentPid = info.ppid
      continue
    }
    return info
  }

  throw new WorkspaceIdentityError(
    'no trusted non-shell ancestor process found for the current invocation',
    'Run autobrowser from a supported host (IDE, terminal multiplexer, or AI agent process), or set AUTOBROWSER_CALLER_ID to a stable caller identifier.',
  )
}

// 终端标识从当前进程环境取，不读取其它进程的环境（避免触碰可能的秘密文件）。
function collectTerminalIdentifier(env: NodeJS.ProcessEnv): string {
  const candidates = [
    env.WT_SESSION,
    env.TERM_SESSION_ID,
    env.TMUX,
    env.WINDOWID,
    env.TERMINAL_EMULATOR,
    env.TERM_PROGRAM,
  ]
  return candidates
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('|')
}

function hashToWorkspaceId(material: string): string {
  const hex = createHash('sha256').update(material, 'utf8').digest('hex')
  return `ws_${hex.slice(0, 32)}`
}

async function withOverallTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new WorkspaceIdentityError(
          `workspace identity resolution timed out after ${timeoutMs}ms`,
          'Set AUTOBROWSER_CALLER_ID to a stable caller identifier, or check why process enumeration is slow on this host.',
        ),
      )
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function processStartTimestamp(startTime: string): number {
  // Windows PowerShell 5.1 的 ConvertTo-Json 使用 /Date(...)/，不同于 ps 的日期字符串。
  const windowsDate = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(startTime)
  return windowsDate ? Number(windowsDate[1]) : Date.parse(startTime)
}

/** 仅为本次调用提供诊断，不读取默认 shell 配置，也不参与 workspace 身份解析。 */
export async function detectInvocationShell(
  options: Pick<ResolveWorkspaceIdOptions, 'queryProcess' | 'getCurrentPid' | 'timeoutMs'> = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? defaultIdentityTimeoutMs()
  const queryProcess =
    options.queryProcess ??
    (process.platform === 'win32' ? buildWindowsQuery(timeoutMs) : buildPosixQuery(timeoutMs))

  try {
    return await withOverallTimeout(
      (async () => {
        const startPid = options.getCurrentPid?.() ?? process.pid
        let pid = startPid
        let childStartedAt: number | undefined
        const visited = new Set<number>()

        // 只沿当前进程的父链查找；用于读进程表的 powershell 是子进程，不会被认作 shell。
        while (Number.isInteger(pid) && pid > 1 && !visited.has(pid)) {
          visited.add(pid)
          const info = await queryProcess(pid)
          if (!info) break

          const startedAt = processStartTimestamp(info.startTime)
          // 时间无效时无法验证父链；比子进程更新的父 PID 可能已复用。
          if (
            !Number.isFinite(startedAt) ||
            (childStartedAt !== undefined && startedAt > childStartedAt)
          ) {
            break
          }

          const name = normalizeName(info.name)
          if (pid !== startPid && ((name !== 'env' && SHELL_NAMES.has(name)) || name === 'nu')) {
            return name
          }
          pid = info.ppid
          childStartedAt = startedAt
        }
        return 'unknown'
      })(),
      timeoutMs,
    )
  } catch {
    return 'unknown'
  }
}

/**
 * 解析当前自动调用的 workspace 身份。
 *
 * 返回 ws_<至少 16 位稳定十六进制哈希>。AUTOBROWSER_CALLER_ID 非空时直接用它作为身份；
 * 否则遍历进程树识别可信非 shell 祖先并哈希。查询失败或找不到可信祖先时抛
 * WorkspaceIdentityError（code=WORKSPACE_IDENTITY_UNAVAILABLE）。
 */
export async function resolveAutomaticWorkspaceId(
  options: ResolveWorkspaceIdOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? defaultIdentityTimeoutMs()
  const env = options.getEnv ? options.getEnv() : process.env
  const explicitCallerId = options.callerId ?? env.AUTOBROWSER_CALLER_ID

  // 显式注入的调用方身份直接作为稳定材料，AI 宿主与测试都是这个路径
  if (typeof explicitCallerId === 'string' && explicitCallerId.length > 0) {
    return hashToWorkspaceId(`caller:${explicitCallerId}`)
  }

  const getCurrentPid = options.getCurrentPid ?? (() => process.pid)
  const queryProcess =
    options.queryProcess ??
    (process.platform === 'win32' ? buildWindowsQuery(timeoutMs) : buildPosixQuery(timeoutMs))

  const terminalId = collectTerminalIdentifier(env)

  // 整体兜底超时，确保任何单次查询挂死都不会让解析卡住
  return await withOverallTimeout(
    (async () => {
      const startPid = getCurrentPid()
      const caller = await findTrustedAncestor(startPid, queryProcess)
      const material = `${caller.pid}|${caller.startTime}|${terminalId}`
      return hashToWorkspaceId(`tree:${material}`)
    })(),
    timeoutMs,
  )
}
