import { resolveExtensionId } from '../../core/config.js'
import {
  getConfigPath,
  getHomeDir,
  getStatePath,
  getTokenPath,
  isPortInUse,
  readJsonFile,
} from '../../core/protocol.js'
import { isRecord } from '../client.js'
import { isHelpToken } from '../help.js'
import {
  buildServerLaunchArgs,
  isServerSnapshotStatus,
  isServerSnapshotOnPorts,
  killDetachedProcess,
  readPersistedConnectionInfo,
  spawnDetachedProcess,
  stopBackgroundServer,
  waitForServerStatus,
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
import type { CommandContext, CommandRegistry } from './types.js'

/** 优雅关闭时等待 state 持久化完成的兜底时长；超时则强制退出，避免 --serve 进程挂死 */
const SHUTDOWN_WATCHDOG_MS = 5_000

export function formatStatusSummary(status: Record<string, unknown>, brief = false): string {
  const lines: string[] = ['autobrowser status']
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

  lines.push(`extension: ${extensionConnected ? 'connected' : 'waiting for extension'}`)

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

  if (pageEpochEntries.length > 0) {
    if (brief) {
      // brief 模式只给汇总，不逐行列出每个 tab 的 epoch（内部簿记，排查连接问题时无用）。
      lines.push(`page epochs: ${pageEpochEntries.length} tabs`)
    } else {
      lines.push('page epochs:')
      for (const [tabId, epoch] of pageEpochEntries) {
        if (typeof epoch !== 'number') {
          continue
        }

        const tab = tabById.get(tabId)
        const handle = typeof tab?.handle === 'string' ? tab.handle : `tab ${tabId}`
        lines.push(`  ${handle} (${tabId}): ${Math.floor(epoch)}`)
      }
    }
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

function getLocalControlBaseUrl(ipcPort: number): string {
  return `http://127.0.0.1:${ipcPort}`
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function targetsLocalControlServer(baseUrl: string, ipcPort: number): boolean {
  try {
    const url = new URL(baseUrl)
    const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'))

    return url.protocol === 'http:' && isLoopbackHostname(url.hostname) && port === ipcPort
  } catch {
    return false
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
  const controlBaseUrl = getLocalControlBaseUrl(context.flags.ipcPort)
  const existingStatus = await context.getStatus(controlBaseUrl).catch(() => null)

  if (isServerSnapshotOnPorts(existingStatus, context.flags.relayPort, context.flags.ipcPort)) {
    if (options.announceAlreadyRunning ?? true) {
      process.stdout.write('autobrowser server already running\n')
    }
    return {
      status: existingStatus,
      started: false,
    }
  }

  const extensionId = await resolveExtensionId(context.homeDir, context.flags.extensionId)
  const spawnCommand = context.dependencies.spawnDetachedProcess ?? spawnDetachedProcess
  let backgroundProcess

  try {
    backgroundProcess = await spawnCommand(
      'bun',
      buildServerLaunchArgs(
        {
          relayPort: context.flags.relayPort,
          ipcPort: context.flags.ipcPort,
        },
        extensionId,
        context.flags.session,
      ),
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'failed to start background server'}\n`,
    )
    return null
  }

  const readyAbortController = new AbortController()
  const readyResult = backgroundProcess.waitForExit
    ? await Promise.race([
        waitForServerStatus(
          controlBaseUrl,
          context.flags.relayPort,
          context.flags.ipcPort,
          undefined,
          undefined,
          readyAbortController.signal,
        ).then((status) => ({
          kind: 'ready' as const,
          status,
        })),
        backgroundProcess.waitForExit().then((exitInfo) => ({
          kind: 'exit' as const,
          exitInfo,
        })),
      ]).finally(() => readyAbortController.abort())
    : {
        kind: 'ready' as const,
        status: await waitForServerStatus(
          controlBaseUrl,
          context.flags.relayPort,
          context.flags.ipcPort,
        ),
      }

  if (readyResult.kind === 'exit') {
    process.stderr.write(
      `Background server exited before becoming ready${
        readyResult.exitInfo.code !== null ? ` (code ${readyResult.exitInfo.code})` : ''
      }${readyResult.exitInfo.signal ? ` (signal ${readyResult.exitInfo.signal})` : ''}.\n`,
    )
    return null
  }

  if (!readyResult.status) {
    killDetachedProcess(backgroundProcess)
    process.stderr.write(`Failed to start background server on ${controlBaseUrl}\n`)
    return null
  }

  process.stdout.write(
    `autobrowser server started in background\nrelay: http://127.0.0.1:${context.flags.relayPort}\nipc: ${controlBaseUrl}\n`,
  )
  return {
    status: readyResult.status,
    started: true,
  }
}

async function handleServer(rest: string[], context: CommandContext): Promise<number | void> {
  if (rest[0] === '--serve') {
    const [relayPortInUse, ipcPortInUse] = await Promise.all([
      isPortInUse(context.flags.relayPort),
      isPortInUse(context.flags.ipcPort),
    ])

    if (relayPortInUse) {
      process.stderr.write(`Server already running on port ${context.flags.relayPort}\n`)
      return 1
    }

    if (ipcPortInUse) {
      process.stderr.write(`Server already running on port ${context.flags.ipcPort}\n`)
      return 1
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

  if (rest[0] === 'stop') {
    if (isHelpToken(rest[1])) {
      return context.writeHelp(['server', 'stop'])
    }

    const persistedConnectionInfo = await readPersistedConnectionInfo(
      context.flags.relayPort,
      context.flags.ipcPort,
      context.homeDir,
    )

    if (!persistedConnectionInfo?.token) {
      process.stderr.write('No persisted background server state found.\n')
      return 1
    }

    try {
      await stopBackgroundServer(
        context.flags.ipcPortExplicitlySet
          ? context.flags.ipcPort
          : persistedConnectionInfo.ipcPort,
        persistedConnectionInfo.token,
        context.dependencies.findProcessIdByPort,
        context.dependencies.killProcess,
      )
      process.stdout.write('autobrowser server stopped\n')
      return
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'failed to stop background server'}\n`,
      )
      return 1
    }
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
  return 0
}

async function handleStatus(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) {
    return context.writeHelp(['status'])
  }

  if (context.flags.engine !== 'chromium') {
    const payload = await context.requestCommand(context.flags.server, 'status', {})
    context.writeResult(payload)
    return payload.ok === false ? 1 : 0
  }

  const status = await context.getCommandStatus(context.flags.server)
  if (!context.flags.json) {
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
    process.stderr.write('No recorded command available to replay.\n')
    return 1
  }

  if (containsRedactedValue(lastCommand.args)) {
    process.stderr.write(
      'The recorded command contains redacted arguments and cannot be replayed safely.\n',
    )
    return 1
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

async function handleSession(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) return context.writeHelp(['session'])
  const action = rest[0] || 'list'
  const baseHomeDir = getHomeDir()

  if (action === 'list') {
    if (rest.length > 1) {
      process.stderr.write(`unexpected argument for session list: ${rest[1]}\n`)
      return 1
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

  if (action === 'create') {
    const name = rest[1]
    if (!name || rest.length > 2) {
      process.stderr.write(
        'usage: autobrowser session create <name> [--relay-port <n> --ipc-port <n>]\n',
      )
      return 1
    }
    const session = await createSession(baseHomeDir, name, {
      ...(context.flags.relayPortExplicitlySet ? { relayPort: context.flags.relayPort } : {}),
      ...(context.flags.ipcPortExplicitlySet ? { ipcPort: context.flags.ipcPort } : {}),
    })
    context.writeResult({ ok: true, result: session })
    return 0
  }

  if (action === 'kill-all') {
    if (rest.length > 1) {
      process.stderr.write(`unexpected argument for kill-all: ${rest[1]}\n`)
      return 1
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

  const name =
    requireSessionActionName(rest, context) || (action === 'delete-data' ? null : 'default')
  if (!name) {
    process.stderr.write(`${action} requires a session name or --session <name>\n`)
    return 1
  }
  if (rest.length > 2) {
    process.stderr.write(`unexpected extra argument for session ${action}: ${rest[2]}\n`)
    return 1
  }

  if (action === 'attach') {
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
  if (action === 'detach') {
    if (context.flags.engine !== 'chromium') {
      context.writeResult({
        ok: false,
        error: {
          code: 'BROWSER_CAPABILITY_UNSUPPORTED',
          message: 'WebDriver has no relay to detach; use close-all to end the WebDriver session',
          details: { engine: context.flags.engine, action: 'detach' },
        },
      })
      return 1
    }
    const result = await stopCurrentSession(context)
    context.writeResult({ ok: true, result: { session: name, ...result } })
    return 0
  }
  if (action === 'close-all') {
    const payload = await context.requestCommand(context.flags.server, 'close', { all: true })
    context.writeResult(payload)
    return payload.ok === false ? 1 : 0
  }
  if (action === 'delete-data') {
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

  process.stderr.write(`unsupported session action: ${action}\n`)
  return 1
}

export const serverCommandRegistry: CommandRegistry = {
  help: handleHelp,
  '--help': handleHelp,
  '-h': handleHelp,
  server: handleServer,
  connect: handleConnect,
  status: handleStatus,
  replay: handleReplay,
  config: handleConfig,
  session: handleSession,
  attach: async (rest, context) => await handleSession(['attach', ...rest], context),
  detach: async (rest, context) => await handleSession(['detach', ...rest], context),
  'close-all': async (rest, context) => await handleSession(['close-all', ...rest], context),
  'kill-all': async (rest, context) => await handleSession(['kill-all', ...rest], context),
  'delete-data': async (rest, context) => await handleSession(['delete-data', ...rest], context),
}
