import { resolveExtensionId } from '../../core/config.js'
import {
  getConfigPath,
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
import type { CommandContext, CommandRegistry } from './types.js'

export function formatStatusSummary(status: Record<string, unknown>): string {
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
      ),
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'failed to start background server'}\n`,
    )
    return null
  }

  const readyResult = backgroundProcess.waitForExit
    ? await Promise.race([
        waitForServerStatus(controlBaseUrl, context.flags.relayPort, context.flags.ipcPort).then(
          (status) => ({
            kind: 'ready' as const,
            status,
          }),
        ),
        backgroundProcess.waitForExit().then((exitInfo) => ({
          kind: 'exit' as const,
          exitInfo,
        })),
      ])
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
    const servers = await startServers({
      relayPort: context.flags.relayPort,
      ipcPort: context.flags.ipcPort,
      extensionId,
    })
    process.stdout.write(
      `autobrowser server started\nrelay: http://127.0.0.1:${servers.runtime.runtime.relayPort}\nipc: http://127.0.0.1:${servers.runtime.runtime.ipcPort}\n`,
    )

    const shutdown = () => {
      servers.stop()
      process.exit(0)
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
    )

    if (!persistedConnectionInfo?.token) {
      process.stderr.write('No persisted background server state found.\n')
      return 1
    }

    try {
      await stopBackgroundServer(
        persistedConnectionInfo.ipcPort,
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

  const status = await context.getCommandStatus(context.flags.server)
  if (!context.flags.json) {
    process.stdout.write(formatStatusSummary(status))
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

export const serverCommandRegistry: CommandRegistry = {
  help: handleHelp,
  '--help': handleHelp,
  '-h': handleHelp,
  server: handleServer,
  connect: handleConnect,
  status: handleStatus,
  replay: handleReplay,
  config: handleConfig,
}
