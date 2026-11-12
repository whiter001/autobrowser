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
  /** 单次查询与整体兜底超时（毫秒），默认 5 秒；Windows 需覆盖 PowerShell 启动成本 */
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
  'cmd',
  'powershell',
  'pwsh',
])

const NODE_NAMES = new Set(['node', 'bun'])

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
// 这类进程一律不算调用方，避免把 autobrowser 自己当成 workspace 主人。
function isAutobrowserProcess(info: ProcessInfo): boolean {
  const name = normalizeName(info.name)
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
  const timeoutMs = options.timeoutMs ?? 5000
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
