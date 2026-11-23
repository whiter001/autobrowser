import { resolveExtensionId } from '../../core/config.js'
import {
  getConfigPath,
  getHomeDir,
  getStatePath,
  getTokenPath,
  isPortInUse,
  readJsonFile,
} from '../../core/protocol.js'
import { compareBuilds, readCliBuildInfo } from '../build-info.js'
import { detectInvocationShell } from '../caller-identity.js'
import { readExtensionBuildInfo } from '../extension-build-info.js'
import { getStatus, isRecord } from '../client.js'
import { CLI_ERROR_CODES, CliUsageError } from '../cli-error.js'
import { getLocalControlBaseUrl, targetsLocalControlServer } from '../connection.js'
import { startBackgroundServer } from '../server-boot.js'
import { isHelpToken } from '../help.js'
import {
  isServerSnapshotStatus,
  isServerSnapshotOnPorts,
  readPersistedConnectionInfo,
  spawnDetachedProcess,
  stopBackgroundServer,
  waitForPortsToClose,
  type ServerSnapshotStatus,
} from '../server-control.js'
import { startServers } from '../../server.js'
import {
  createSession,
  deleteSessionData,
  listSessions,
  readSession,
  type SessionRecord,
} from '../../core/sessions.js'
import { getCommandDefaultAction, isCommandAction } from './actions.js'
import { throwCommandError } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

/** 优雅关闭时等待 state 持久化完成的兜底时长；超时则强制退出，避免 --serve 进程挂死 */
const SHUTDOWN_WATCHDOG_MS = 5_000

export function formatStatusSummary(status: Record<string, unknown>, brief = false): string {
  const lines: string[] = ['autobrowser status']
  if (typeof status.invocationShell === 'string') {
    lines.push(`invocation shell: ${status.invocationShell}`)
  }
  const relayPort = typeof status.relayPort === 'number' ? status.relayPort : null
  const ipcPort = typeof status.ipcPort === 'number' ? status.ipcPort : null
  const startedAt = typeof status.startedAt === 'string' ? status.startedAt : null
  const extensionConnected = Boolean(status.extensionConnected)
  const snapshot = isRecord(status.snapshot) ? status.snapshot : null
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs.filter(isRecord) : []
  const pageEpochs = isRecord(snapshot?.pageEpochs) ? snapshot.pageEpochs : {}
  const activeTabId =
    isRecord(snapshot) && typeof snapshot.activeTabId === 'number' ? snapshot.activeTabId : null
  const targetTabId =
    isRecord(snapshot) && typeof snapshot.targetTabId === 'number' ? snapshot.targetTabId : null

  if (relayPort !== null) {
    lines.push(`relay: http://127.0.0.1:${relayPort}`)
  }

  if (ipcPort !== null) {
    lines.push(`ipc: http://127.0.0.1:${ipcPort}`)
  }

  // 这一行只在本次 status 调用亲自拉起 relay 时出现：否则"我之前跑过 status"会让
  // 调用方误以为服务是之前启动的，排查旧进程/旧端口时判断错方向。
  if (status.serverAutoStarted === true) {
    lines.push('server: auto-started by this status command')
  }

  lines.push(`extension: ${extensionConnected ? 'connected' : 'waiting for extension'}`)

  // 版本错配会让"命令行为和我预期不一样"变得无法解释，所以在人工摘要里直接点名
  const versionSkew = isRecord(status.versionSkew) ? status.versionSkew : null
  if (versionSkew && versionSkew.consistent === false) {
    lines.push(
      versionSkew.reason === 'commit'
        ? `version: same ${String(versionSkew.cli)}, different commits`
        : `version: CLI ${String(versionSkew.cli)} != extension ${String(versionSkew.extension)}`,
    )
    if (typeof versionSkew.hint === 'string' && versionSkew.hint) {
      lines.push(`warning: ${versionSkew.hint}`)
    }
  }

  if (startedAt) {
    lines.push(`started: ${startedAt}`)
  }

  if (tabs.length > 0) {
    lines.push(`tabs: ${tabs.length}`)
  }

  const tabById = new Map<number, Record<string, unknown>>()
  for (const tab of tabs) {
    const tabId = typeof tab.id === 'number' ? tab.id : null
    if (tabId !== null) {
      tabById.set(tabId, tab)
    }
  }

  if (activeTabId !== null) {
    const activeTab = tabById.get(activeTabId)
    const activeHandle =
      typeof activeTab?.handle === 'string' ? activeTab.handle : `tab ${activeTabId}`
    const activeTitle =
      typeof activeTab?.title === 'string' && activeTab.title.trim() ? activeTab.title.trim() : ''
    lines.push(`active: ${activeHandle}${activeTitle ? ` - ${activeTitle}` : ''}`)
  }

  if (targetTabId !== null) {
    const targetTab = tabById.get(targetTabId)
    const targetHandle =
      typeof targetTab?.handle === 'string' ? targetTab.handle : `tab ${targetTabId}`
    const targetTitle =
      typeof targetTab?.title === 'string' && targetTab.title.trim() ? targetTab.title.trim() : ''
    lines.push(`target: ${targetHandle}${targetTitle ? ` - ${targetTitle}` : ''}`)
  }

  const pageEpochEntries = Object.entries(pageEpochs)
    .map(([tabId, epoch]) => [Number(tabId), epoch] as const)
    .filter(([tabId, epoch]) => Number.isInteger(tabId) && tabId > 0 && typeof epoch === 'number')
    .sort((left, right) => left[0] - right[0])

  // 服务重启后会恢复上一次的 pageEpochs，但当时那些标签未必还在。
  // 未连接或者标签已消失时逐条列出来，会让人误以为这些标签页仍然存在。
  const knownTabIds = new Set(tabById.keys())
  const liveEpochEntries = pageEpochEntries.filter(([tabId]) => knownTabIds.has(tabId))
  const staleEpochCount = pageEpochEntries.length - liveEpochEntries.length

  if (!extensionConnected && pageEpochEntries.length > 0) {
    lines.push(
      `page epochs: ${pageEpochEntries.length} restored from last session (extension offline)`,
    )
  } else if (liveEpochEntries.length > 0) {
    if (brief) {
      // brief 模式只给汇总，不逐行列出每个 tab 的 epoch（内部簿记，排查连接问题时无用）。
      const staleSuffix = staleEpochCount > 0 ? ` (+${staleEpochCount} stale)` : ''
      lines.push(`page epochs: ${liveEpochEntries.length} tabs${staleSuffix}`)
    } else {
      lines.push('page epochs:')
      for (const [tabId, epoch] of liveEpochEntries) {
        if (typeof epoch !== 'number') {
          continue
        }

        const tab = tabById.get(tabId)
        const handle = typeof tab?.handle === 'string' ? tab.handle : `tab ${tabId}`
        lines.push(`  ${handle} (${tabId}): ${Math.floor(epoch)}`)
      }
      if (staleEpochCount > 0) {
        lines.push(`  +${staleEpochCount} stale (tab closed or from previous session)`)
      }
    }
  } else if (staleEpochCount > 0) {
    lines.push(`page epochs: ${staleEpochCount} stale (tab closed or from previous session)`)
  }

  return `${lines.join('\n')}\n`
}

export function getRecordedCommandFromStatus(
  status: Record<string, unknown>,
): { command: string; args: Record<string, unknown> } | null {
  const snapshot = isRecord(status.snapshot) ? status.snapshot : null
  const lastCommand = isRecord(snapshot?.lastCommand) ? snapshot.lastCommand : null
  const command = typeof lastCommand?.command === 'string' ? lastCommand.command.trim() : ''

  if (!command) {
    return null
  }

  return {
    command,
    args:
      lastCommand && isRecord(lastCommand.args)
        ? (lastCommand.args as Record<string, unknown>)
        : {},
  }
}

function containsRedactedValue(value: unknown): boolean {
  if (value === '[redacted]') {
    return true
  }
  if (Array.isArray(value)) {
    return value.some(containsRedactedValue)
  }
  return isRecord(value) && Object.values(value).some(containsRedactedValue)
}

export async function buildCliConfigStatus(homeDir: string): Promise<Record<string, unknown>> {
  const config = await readJsonFile<Record<string, unknown> | null>(getConfigPath(homeDir), null)
  return {
    homeDir,
    paths: {
      config: getConfigPath(homeDir),
      state: getStatePath(homeDir),
      token: getTokenPath(homeDir),
    },
    config: config || {},
  }
}

async function handleHelp(rest: string[], context: CommandContext): Promise<number | void> {
  return context.writeHelp(rest)
}

interface BackgroundServerStartOutcome {
  kind: 'already-running' | 'started'
  status: ServerSnapshotStatus
}

/**
 * 在指定端口上拉起后台服务，并把所有失败结局统一翻成带恢复建议的 CLI 错误。
 *
 * 默认端口来自 flags，restart 需要覆盖成持久化/显式指定的端口，所以端口是参数而不是
 * 直接读 context.flags：两处各写一遍 spawn 选项很容易在重启时漏掉解析出的端口。
 */
async function startBackgroundServerOnPorts(
  context: CommandContext,
  ports: { relayPort: number; ipcPort: number },
): Promise<BackgroundServerStartOutcome> {
  const result = await startBackgroundServer({
    relayPort: ports.relayPort,
    ipcPort: ports.ipcPort,
    session: context.flags.session,
    resolveExtensionId: () => resolveExtensionId(context.homeDir, context.flags.extensionId),
    spawnCommand: context.dependencies.spawnDetachedProcess ?? spawnDetachedProcess,
  })

  switch (result.kind) {
    case 'already-running':
      return { kind: 'already-running', status: result.status }

    case 'started':
      return { kind: 'started', status: result.status }

    case 'spawn-failed':
      throwServerStartupError(
        result.error instanceof Error ? result.error.message : 'failed to start background server',
      )

    case 'exited-before-ready':
      throwServerStartupError(
        `Background server exited before becoming ready${
          result.exitInfo.code !== null ? ` (code ${result.exitInfo.code})` : ''
        }${result.exitInfo.signal ? ` (signal ${result.exitInfo.signal})` : ''}.`,
      )

    case 'not-ready':
      throwServerStartupError(
        `Failed to start background server on ${getLocalControlBaseUrl(ports.ipcPort)}`,
      )
  }
}

async function ensureBackgroundServer(
  context: CommandContext,
  options: {
    announceAlreadyRunning?: boolean
  } = {},
): Promise<{
  status: ServerSnapshotStatus
  started: boolean
} | null> {
  const outcome = await startBackgroundServerOnPorts(context, {
    relayPort: context.flags.relayPort,
    ipcPort: context.flags.ipcPort,
  })

  if (outcome.kind === 'already-running') {
    if (options.announceAlreadyRunning ?? true) {
      process.stdout.write('autobrowser server already running\n')
    }
    return { status: outcome.status, started: false }
  }

  process.stdout.write(
    `autobrowser server started in background\nrelay: http://127.0.0.1:${context.flags.relayPort}\nipc: ${getLocalControlBaseUrl(context.flags.ipcPort)}\n`,
  )
  return { status: outcome.status, started: true }
}

/**
 * 后台服务起不来是运行期失败而不是用法错误，给出"先看状态、再前台启动看报错"的下一步。
 */
function throwServerStartupError(message: string): never {
  throw new CliUsageError(message, {
    code: CLI_ERROR_CODES.FAILED,
    suggestedAction:
      "Run 'autobrowser status' to check the server state, then start it again; if it keeps failing, run 'autobrowser server --serve' in a foreground terminal to see the startup error.",
  })
}

interface PersistedServerTarget {
  token: string
  relayPort: number
  ipcPort: number
}

/**
 * stop/restart 的端口解析：以持久化 state 为默认，显式的 --relay-port/--ipc-port 覆盖之。
 *
 * 不能直接用 flags 的默认值：默认端口只是"没配置时用哪个"，而这里要操作的是记录在案的那个
 * 服务；拿默认端口去 stop 会在用户改过端口后打空。
 */
async function resolvePersistedServerTarget(
  context: CommandContext,
): Promise<PersistedServerTarget | null> {
  const persisted = await readPersistedConnectionInfo(
    context.flags.relayPort,
    context.flags.ipcPort,
    context.homeDir,
  )
  if (!persisted?.token) {
    return null
  }

  return {
    token: persisted.token,
    relayPort: context.flags.relayPortExplicitlySet ? context.flags.relayPort : persisted.relayPort,
    ipcPort: context.flags.ipcPortExplicitlySet ? context.flags.ipcPort : persisted.ipcPort,
  }
}

function throwServerShutdownTimeout(ports: number[], action: 'stop' | 'restart'): never {
  const portList = ports.join(', ')
  throw new CliUsageError(
    action === 'stop'
      ? `Background server accepted the shutdown request but ports ${portList} are still in use.`
      : `Restart aborted: the old server did not release port ${portList} in time.`,
    {
      code: CLI_ERROR_CODES.FAILED,
      suggestedAction:
        "Run 'autobrowser status' to check what is still listening; if another process took the port, stop it manually before retrying.",
    },
  )
}

async function stopServer(context: CommandContext): Promise<number | void> {
  const target = await resolvePersistedServerTarget(context)
  if (!target) {
    return throwCommandError('No persisted background server state found.')
  }

  try {
    // 只发 /shutdown 控制请求，绝不走普通命令通道：stop 不该依赖扩展连接，也不该
    // 因为服务不在而顺手拉起一个新的。
    await stopBackgroundServer(
      target.ipcPort,
      target.token,
      context.dependencies.findProcessIdByPort,
      context.dependencies.killProcess,
    )
  } catch (error) {
    return throwCommandError(error)
  }

  // 200 只代表接受关闭，进程退出是异步的。IPC 通常先关，relay 与进程可能还在收尾；
  // 只等 IPC 就返回，调用方马上替换文件/重启仍会撞上旧 relay。两个目标端口都释放才算停完。
  const ports = [target.ipcPort, target.relayPort]
  if (!(await waitForPortsToClose(ports))) {
    return throwServerShutdownTimeout(ports, 'stop')
  }

  process.stdout.write('autobrowser server stopped\n')
  return
}

async function restartServer(context: CommandContext): Promise<number | void> {
  const target = await resolvePersistedServerTarget(context)
  if (!target) {
    return throwCommandError('No persisted background server state found.')
  }

  // 直接探测 IPC 端口判断服务是否在跑，而不是走 getCommandStatus：后者会在本地服务不可达时
  // 自动拉起 relay，restart 就会把"先起一个新进程"当成重启的第一步，最后还报告成功。
  const current = await getStatus(`http://127.0.0.1:${target.ipcPort}`).catch(() => null)
  if (!isServerSnapshotStatus(current)) {
    return throwCommandError(
      new CliUsageError('No running background server found to restart.', {
        code: CLI_ERROR_CODES.FAILED,
        suggestedAction:
          "Run 'autobrowser server' to start one, or 'autobrowser status' to inspect the recorded connection state.",
      }),
    )
  }

  try {
    await stopBackgroundServer(
      target.ipcPort,
      target.token,
      context.dependencies.findProcessIdByPort,
      context.dependencies.killProcess,
    )
  } catch (error) {
    return throwCommandError(error)
  }

  // relay 和 IPC 必须都释放：只等 IPC 时，旧 relay 仍可能占着 relay 端口让新进程 bind 失败。
  const ports = [target.ipcPort, target.relayPort]
  if (!(await waitForPortsToClose(ports))) {
    return throwServerShutdownTimeout(ports, 'restart')
  }

  const outcome = await startBackgroundServerOnPorts(context, {
    relayPort: target.relayPort,
    ipcPort: target.ipcPort,
  })

  // 端口已释放却仍有同端口服务应答，说明旧进程没退干净；这种情况不能对外宣称重启成功。
  if (outcome.kind === 'already-running') {
    return throwCommandError(
      new CliUsageError(
        `Restart failed: a background server is still running on ${getLocalControlBaseUrl(target.ipcPort)}.`,
        {
          code: CLI_ERROR_CODES.FAILED,
          suggestedAction:
            "Run 'autobrowser status' to confirm the running server, then retry 'autobrowser server restart'.",
        },
      ),
    )
  }

  process.stdout.write(
    `autobrowser server restarted in background\nrelay: http://127.0.0.1:${target.relayPort}\nipc: ${getLocalControlBaseUrl(target.ipcPort)}\n`,
  )
  return
}

async function handleServer(rest: string[], context: CommandContext): Promise<number | void> {
  if (rest[0] === '--serve') {
    const [relayPortInUse, ipcPortInUse] = await Promise.all([
      isPortInUse(context.flags.relayPort),
      isPortInUse(context.flags.ipcPort),
    ])

    if (relayPortInUse) {
      return throwCommandError(`Server already running on port ${context.flags.relayPort}`)
    }

    if (ipcPortInUse) {
      return throwCommandError(`Server already running on port ${context.flags.ipcPort}`)
    }

    const extensionId = await resolveExtensionId(context.homeDir, context.flags.extensionId)
    let shutdownStarted = false
    const hardExit = (code: number): void => {
      if (shutdownStarted) {
        return
      }
      shutdownStarted = true
      process.exit(code)
    }

    const servers = await startServers({
      relayPort: context.flags.relayPort,
      ipcPort: context.flags.ipcPort,
      homeDir: context.homeDir,
      extensionId,
      onShutdown: () => {
        // 关闭流程已完成（连接断开、端口释放）：先落盘 state，再退出进程。
        // 由 setTimeout 兜底，即使持久化卡住（磁盘故障等）也保证进程不挂死。
        const watchdog = setTimeout(() => hardExit(0), SHUTDOWN_WATCHDOG_MS)
        if (watchdog.unref) {
          watchdog.unref()
        }
        servers.runtime
          .persist()
          .then(() => hardExit(0))
          .catch(() => hardExit(1))
      },
    })
    process.stdout.write(
      `autobrowser server started\nrelay: http://127.0.0.1:${servers.runtime.runtime.relayPort}\nipc: http://127.0.0.1:${servers.runtime.runtime.ipcPort}\n`,
    )

    const shutdown = (): void => {
      // 只触发关闭流程，不直接 process.exit：让 onShutdown 完成持久化后再退出，
      // 避免 SIGINT/SIGTERM 时丢 in-flight 的 state.json 写入；防重入由 performShutdown 的 flag 保证
      servers.stop()
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return new Promise(() => {})
  }

  if (isCommandAction('server', rest[0])) {
    const action = rest[0]

    if (isHelpToken(rest[1])) {
      return context.writeHelp(['server', action])
    }

    // stop/restart 都不吃位置参数；先拦住，避免把多余 token 静默忽略掉。
    if (rest.length > 1) {
      return throwCommandError(`unexpected argument for server ${action}: ${rest[1]}`)
    }

    return action === 'restart' ? await restartServer(context) : await stopServer(context)
  }

  if (isHelpToken(rest[0])) {
    return context.writeHelp(['server'])
  }

  const serverState = await ensureBackgroundServer(context)
  if (!serverState) {
    return 1
  }

  return serverState.started ? undefined : 0
}

async function handleConnect(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) {
    return context.writeHelp(['connect'])
  }

  if (context.flags.printToken) {
    // 只输出 token 本身，方便 `autobrowser connect --print-token | pbcopy` 这类用法；
    // 不启动服务、不打开浏览器，取值来源与命令请求一致（state.json 优先，其次 token 文件）。
    const persisted = await readPersistedConnectionInfo(
      context.flags.relayPort,
      context.flags.ipcPort,
      context.homeDir,
    )
    if (!persisted) {
      return throwCommandError(
        'no token found yet; run `autobrowser status` once to start the server and create one',
      )
    }
    process.stdout.write(`${persisted.token}\n`)
    return 0
  }

  if (context.flags.engine !== 'chromium') {
    const payload = await context.requestCommand(context.flags.server, 'status', {})
    context.writeResult(payload)
    return payload.ok === false ? 1 : 0
  }

  let status = await context.getStatus(context.flags.server).catch(() => null)
  const hasReachableServerStatus = Boolean(status && isServerSnapshotStatus(status))

  if (
    targetsLocalControlServer(context.flags.server, context.flags.ipcPort) &&
    !hasReachableServerStatus
  ) {
    const serverState = await ensureBackgroundServer(context, {
      announceAlreadyRunning: false,
    })
    if (!serverState) {
      return 1
    }
    status = { ...serverState.status }
  }

  await context.openConnectFlow(status, true)
  process.stdout.write(
    'autobrowser connect page opened; run `autobrowser status` to confirm the extension connection\n',
  )
  return 0
}

/**
 * 在 status 里附带 CLI↔扩展的构建对比；CLI 自身没有构建信息时原样返回，
 * 不为一次注定无结论的诊断额外请求扩展。
 */
async function attachVersionSkew(
  context: CommandContext,
  status: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cli = await readCliBuildInfo()
  if (!cli.version) {
    return status
  }
  // 读取扩展构建信息内部已吞掉请求失败，诊断不改变 status/doctor 的成败。
  const extension = await readExtensionBuildInfo(context, status)
  const versionSkew = compareBuilds(cli, extension)
  return versionSkew.consistent === null ? status : { ...status, versionSkew }
}

type DoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'skip'
interface DoctorCheck {
  name: 'runtime' | 'extension' | 'connection' | 'version' | 'target'
  status: DoctorCheckStatus
  message: string
  suggestedAction?: string
}

function formatDoctorSummary(checks: DoctorCheck[]): string {
  return checks
    .map((check) => {
      const line = `${check.name.padEnd(10)} ${check.status.padEnd(5)} ${check.message}`
      return check.suggestedAction ? `${line}\n  next: ${check.suggestedAction}` : line
    })
    .join('\n')
    .concat('\n')
}

function unavailableDoctorChecks(message: string): DoctorCheck[] {
  const action =
    "Run 'autobrowser status'; if the server does not start, run 'autobrowser server --serve' in a foreground terminal to inspect the error."
  return [
    {
      name: 'extension',
      status: 'fail',
      message: 'cannot inspect the extension while the local server is unavailable',
      suggestedAction: action,
    },
    { name: 'connection', status: 'fail', message, suggestedAction: action },
    { name: 'version', status: 'skip', message: 'extension version is unavailable' },
    { name: 'target', status: 'skip', message: 'browser target is unavailable' },
  ]
}

function connectedDoctorChecks(status: Record<string, unknown>): DoctorCheck[] {
  const snapshot = isRecord(status.snapshot) ? status.snapshot : null
  const extension = snapshot && isRecord(snapshot.extension) ? snapshot.extension : null
  const extensionId =
    extension && typeof extension.extensionId === 'string' ? extension.extensionId : null
  const relayPort = typeof status.relayPort === 'number' ? status.relayPort : null
  const checks: DoctorCheck[] = [
    {
      name: 'extension',
      status: 'ok',
      message: `connected${extensionId ? `, id=${extensionId}` : ''}`,
    },
    {
      name: 'connection',
      status: 'ok',
      message: `connected${relayPort ? ` (relay 127.0.0.1:${relayPort})` : ''}`,
    },
  ]

  const versionSkew = isRecord(status.versionSkew) ? status.versionSkew : null
  if (versionSkew?.consistent === false) {
    checks.push({
      name: 'version',
      status: 'warn',
      message:
        versionSkew.reason === 'commit'
          ? `same ${String(versionSkew.cli)}, different commits`
          : `CLI ${String(versionSkew.cli)} != extension ${String(versionSkew.extension)}`,
      ...(typeof versionSkew.hint === 'string' ? { suggestedAction: versionSkew.hint } : {}),
    })
  } else if (versionSkew?.consistent === true) {
    checks.push({
      name: 'version',
      status: 'ok',
      message: `CLI and extension ${String(versionSkew.cli)}`,
    })
  } else {
    checks.push({
      name: 'version',
      status: 'skip',
      message: 'CLI or extension build metadata is unavailable',
    })
  }

  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs.filter(isRecord) : []
  const targetTabId =
    snapshot && typeof snapshot.targetTabId === 'number'
      ? snapshot.targetTabId
      : snapshot && typeof snapshot.activeTabId === 'number'
        ? snapshot.activeTabId
        : null
  const target = tabs.find((tab) => tab.id === targetTabId)
  if (target) {
    const handle = typeof target.handle === 'string' ? target.handle : `tab ${targetTabId}`
    const title = typeof target.title === 'string' && target.title ? ` - ${target.title}` : ''
    checks.push({ name: 'target', status: 'ok', message: `${handle}${title}` })
  } else {
    checks.push({
      name: 'target',
      status: 'fail',
      message:
        targetTabId === null ? 'no active browser target' : `target tab ${targetTabId} is missing`,
      suggestedAction:
        "Run 'autobrowser tab list', then select a tab or run 'autobrowser open <url>'.",
    })
  }
  return checks
}

function disconnectedDoctorChecks(status: Record<string, unknown>): DoctorCheck[] {
  const action = "Run 'autobrowser connect' and reload or enable the extension in your browser."
  const relayPort = typeof status.relayPort === 'number' ? status.relayPort : null
  return [
    { name: 'extension', status: 'fail', message: 'not connected', suggestedAction: action },
    {
      name: 'connection',
      status: 'fail',
      message: `extension disconnected${relayPort ? ` (relay 127.0.0.1:${relayPort})` : ''}`,
      suggestedAction: action,
    },
    { name: 'version', status: 'skip', message: 'extension version is unavailable' },
    {
      name: 'target',
      status: 'fail',
      message: 'no usable target while the extension is disconnected',
      suggestedAction: `${action} Then run 'autobrowser tab list'.`,
    },
  ]
}

async function handleDoctor(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) return context.writeHelp(['doctor'])
  if (rest.length > 0) return throwCommandError(`unexpected argument for doctor: ${rest[0]}`)

  const runtimeName = process.versions.bun ? 'bun' : 'node'
  const runtimeVersion = process.versions.bun ?? process.version
  const runtimeCheck: DoctorCheck = {
    name: 'runtime',
    status: 'ok',
    message: `${runtimeName} ${runtimeVersion}`,
  }

  if (context.flags.engine !== 'chromium') {
    const payload = await context.requestCommand(context.flags.server, 'status', {})
    const connected = payload.ok && isRecord(payload.result) && payload.result.connected === true
    const checks: DoctorCheck[] = [
      runtimeCheck,
      {
        name: 'extension',
        status: 'skip',
        message: `${context.flags.engine} uses WebDriver instead of the Chromium extension`,
      },
      {
        name: 'connection',
        status: connected ? 'ok' : 'fail',
        message: connected
          ? `WebDriver session ${String((payload.result as Record<string, unknown>).sessionId)}`
          : payload.error?.message || 'WebDriver session is unavailable',
        ...(connected
          ? {}
          : { suggestedAction: `Check the ${context.flags.engine} WebDriver URL and retry.` }),
      },
      { name: 'version', status: 'skip', message: 'extension version does not apply to WebDriver' },
      {
        name: 'target',
        status: connected ? 'ok' : 'fail',
        message: connected ? 'WebDriver session is ready' : 'no usable WebDriver session',
      },
    ]
    const ok = connected
    if (context.flags.json && context.flags.jsonExplicitlySet) {
      context.writeResult({ ok, result: { checks } })
    } else {
      process.stdout.write(formatDoctorSummary(checks))
    }
    return ok ? 0 : 1
  }

  let status: Record<string, unknown> | null = null
  let statusError: string | null = null
  try {
    status = await attachVersionSkew(context, await context.getCommandStatus(context.flags.server))
  } catch (error) {
    statusError = error instanceof Error ? error.message : String(error)
  }
  const checks = [
    runtimeCheck,
    ...(statusError !== null
      ? unavailableDoctorChecks(statusError)
      : status?.extensionConnected === true
        ? connectedDoctorChecks(status)
        : disconnectedDoctorChecks(status ?? {})),
  ]
  const ok = checks.every((check) => check.status !== 'fail')
  if (context.flags.json && context.flags.jsonExplicitlySet) {
    context.writeResult({ ok, result: { checks } })
  } else {
    process.stdout.write(formatDoctorSummary(checks))
  }
  return ok ? 0 : 1
}

async function handleStatus(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) {
    return context.writeHelp(['status'])
  }

  if (context.flags.engine !== 'chromium') {
    const payload = await context.requestCommand(context.flags.server, 'status', {})
    if (payload.ok === false) {
      context.writeResult(payload)
      return 1
    }
    const invocationShell = await detectInvocationShell()
    if (!context.flags.json) {
      process.stdout.write(`invocation shell: ${invocationShell}\n`)
      context.writeResult(payload)
    } else {
      context.writeResult({ ...payload, invocationShell })
    }
    return 0
  }

  const serverStatus = await context.getCommandStatus(context.flags.server)
  const [statusWithVersionSkew, invocationShell] = await Promise.all([
    attachVersionSkew(context, serverStatus),
    detectInvocationShell(),
  ])
  const status = { ...statusWithVersionSkew, invocationShell }
  // status 默认给人读的摘要：json 默认就是 true，只有显式 --json 才输出原始对象，
  // 否则 --raw/--brief 这类「要文本」的用法反而会被默认值吞掉。
  if (!context.flags.json || !context.flags.jsonExplicitlySet) {
    process.stdout.write(formatStatusSummary(status, context.flags.brief))
    return 0
  }

  context.writeResult(status)
  return 0
}

async function handleReplay(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) {
    return context.writeHelp(['replay'])
  }

  const status = await context.getCommandStatus(context.flags.server)
  const lastCommand = getRecordedCommandFromStatus(status)

  if (!lastCommand) {
    return throwCommandError('No recorded command available to replay.')
  }

  if (containsRedactedValue(lastCommand.args)) {
    return throwCommandError(
      'The recorded command contains redacted arguments and cannot be replayed safely.',
    )
  }

  const payload = await context.requestCommand(
    context.flags.server,
    lastCommand.command,
    lastCommand.args,
  )
  context.writeResult(payload)
  return 0
}

async function handleConfig(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) {
    return context.writeHelp(['config'])
  }

  const configStatus = await buildCliConfigStatus(context.homeDir)
  context.writeResult({ ok: true, result: configStatus })
  return 0
}

async function stopCurrentSession(
  context: CommandContext,
): Promise<{ stopped: boolean; alreadyStopped: boolean }> {
  const connection = await readPersistedConnectionInfo(
    context.flags.relayPort,
    context.flags.ipcPort,
    context.homeDir,
  )
  if (!connection?.token) return { stopped: false, alreadyStopped: true }
  const status = await context.getStatus(`http://127.0.0.1:${connection.ipcPort}`).catch(() => null)
  if (!isServerSnapshotStatus(status)) return { stopped: false, alreadyStopped: true }
  await stopBackgroundServer(
    connection.ipcPort,
    connection.token,
    context.dependencies.findProcessIdByPort,
    context.dependencies.killProcess,
  )
  return { stopped: true, alreadyStopped: false }
}

async function stopSessionRecord(
  context: CommandContext,
  session: SessionRecord,
): Promise<{ name: string; stopped: boolean; alreadyStopped: boolean }> {
  const connection = await readPersistedConnectionInfo(
    session.relayPort,
    session.ipcPort,
    session.homeDir,
  )
  if (!connection?.token) return { name: session.name, stopped: false, alreadyStopped: true }
  const status = await context.getStatus(`http://127.0.0.1:${connection.ipcPort}`).catch(() => null)
  if (!isServerSnapshotStatus(status)) {
    return { name: session.name, stopped: false, alreadyStopped: true }
  }
  await stopBackgroundServer(
    connection.ipcPort,
    connection.token,
    context.dependencies.findProcessIdByPort,
    context.dependencies.killProcess,
  )
  return { name: session.name, stopped: true, alreadyStopped: false }
}

function requireSessionActionName(rest: string[], context: CommandContext): string | null {
  return rest[1] || context.flags.session || null
}

/**
 * 解析 session 动作要操作的会话名，并做这一组动作共用的前置校验。
 *
 * attach/detach/close-all/delete-data 都需要一个会话名：优先取位置参数，其次 --session；
 * delete-data 没有名字必须报错（默认会话不允许被删），其余动作回落到默认会话 'default'。
 * 多余参数也在这里拦一次，避免每个分支各写一遍。
 */
function resolveSessionTarget(
  rest: string[],
  context: CommandContext,
  action: string,
): { name: string } | { error: string } {
  const name =
    requireSessionActionName(rest, context) || (action === 'delete-data' ? null : 'default')
  if (!name) {
    return { error: `${action} requires a session name or --session <name>` }
  }
  if (rest.length > 2) {
    return { error: `unexpected extra argument for session ${action}: ${rest[2]}` }
  }
  return { name }
}

async function handleSession(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) return context.writeHelp(['session'])
  // switch 分支集合就是 session 的实现面，测试会拿它和 action 表核对。
  const sessionAction = rest[0] ?? getCommandDefaultAction('session')
  const baseHomeDir = getHomeDir()

  switch (sessionAction) {
    case 'list': {
      if (rest.length > 1) {
        return throwCommandError(`unexpected argument for session list: ${rest[1]}`)
      }
      const sessions = await listSessions(baseHomeDir)
      const items = []
      for (const session of sessions) {
        const status = await context
          .getStatus(`http://127.0.0.1:${session.ipcPort}`)
          .catch(() => null)
        const running = isServerSnapshotOnPorts(status, session.relayPort, session.ipcPort)
        const snapshot = running && isRecord(status.snapshot) ? status.snapshot : null
        items.push({
          ...session,
          running,
          extensionConnected: running && status.extensionConnected === true,
          targetTabId: typeof snapshot?.targetTabId === 'number' ? snapshot.targetTabId : null,
        })
      }
      context.writeResult({ ok: true, result: { sessions: items } })
      return 0
    }
    case 'create': {
      const name = rest[1]
      if (!name || rest.length > 2) {
        return throwCommandError(
          'usage: autobrowser session create <name> [--relay-port <n> --ipc-port <n>]',
        )
      }
      const session = await createSession(baseHomeDir, name, {
        ...(context.flags.relayPortExplicitlySet ? { relayPort: context.flags.relayPort } : {}),
        ...(context.flags.ipcPortExplicitlySet ? { ipcPort: context.flags.ipcPort } : {}),
      })
      context.writeResult({ ok: true, result: session })
      return 0
    }
    case 'kill-all': {
      if (rest.length > 1) {
        return throwCommandError(`unexpected argument for kill-all: ${rest[1]}`)
      }
      const sessions = await listSessions(baseHomeDir)
      const results = []
      if (!context.flags.session) {
        results.push({ name: 'default', ...(await stopCurrentSession(context)) })
      }
      for (const session of sessions) results.push(await stopSessionRecord(context, session))
      context.writeResult({ ok: true, result: { sessions: results } })
      return 0
    }
    // 这四个动作共享「先定会话名、再校验多余参数」的前置流程。
    case 'attach':
    case 'detach':
    case 'close-all':
    case 'delete-data': {
      const target = resolveSessionTarget(rest, context, sessionAction)
      if ('error' in target) {
        return throwCommandError(target.error)
      }
      const { name } = target

      if (sessionAction === 'attach') {
        if (context.flags.engine !== 'chromium') {
          const payload = await context.requestCommand(context.flags.server, 'status', {})
          context.writeResult(payload)
          return payload.ok === false ? 1 : 0
        }
        const server = await ensureBackgroundServer(context, { announceAlreadyRunning: false })
        if (!server) return 1
        await context.openConnectFlow({ ...server.status }, true)
        return 0
      }
      if (sessionAction === 'detach') {
        if (context.flags.engine !== 'chromium') {
          context.writeResult({
            ok: false,
            error: {
              code: 'BROWSER_CAPABILITY_UNSUPPORTED',
              message:
                'WebDriver has no relay to detach; use close-all to end the WebDriver session',
              details: { engine: context.flags.engine, action: 'detach' },
            },
          })
          return 1
        }
        const result = await stopCurrentSession(context)
        context.writeResult({ ok: true, result: { session: name, ...result } })
        return 0
      }
      if (sessionAction === 'close-all') {
        const payload = await context.requestCommand(context.flags.server, 'close', { all: true })
        context.writeResult(payload)
        return payload.ok === false ? 1 : 0
      }
      const session = await readSession(baseHomeDir, name).catch((error) => {
        if ((error as { code?: string }).code === 'SESSION_NOT_FOUND') return null
        throw error
      })
      if (session && context.flags.engine !== 'chromium') {
        const payload = await context.requestCommand(context.flags.server, 'close', { all: true })
        if (payload.ok === false) {
          context.writeResult(payload)
          return 1
        }
      }
      if (session) await stopSessionRecord(context, session)
      const result = await deleteSessionData(baseHomeDir, name)
      context.writeResult({ ok: true, result })
      return 0
    }
    default: {
      // 表里声明了 action 但还没有实现分支：不能静默当成功。
      if (isCommandAction('session', sessionAction)) {
        return throwCommandError(`session action is not implemented: ${sessionAction}`)
      }
      return throwCommandError(`unsupported session action: ${sessionAction}`)
    }
  }
}

export const serverCommandRegistry: CommandRegistry = {
  help: handleHelp,
  '--help': handleHelp,
  '-h': handleHelp,
  server: handleServer,
  connect: handleConnect,
  status: handleStatus,
  doctor: handleDoctor,
  replay: handleReplay,
  config: handleConfig,
  session: handleSession,
  attach: async (rest, context) => await handleSession(['attach', ...rest], context),
  detach: async (rest, context) => await handleSession(['detach', ...rest], context),
  'close-all': async (rest, context) => await handleSession(['close-all', ...rest], context),
  'kill-all': async (rest, context) => await handleSession(['kill-all', ...rest], context),
  'delete-data': async (rest, context) => await handleSession(['delete-data', ...rest], context),
}
