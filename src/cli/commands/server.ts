import { resolveExtensionId } from '../../core/config.js'
import { isPortInUse } from '../../core/protocol.js'
import { isHelpToken } from '../help.js'
import {
  buildServerLaunchArgs,
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
    if (await isPortInUse(context.flags.relayPort)) {
      process.stderr.write(`Server already running on port ${context.flags.relayPort}\n`)
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

  if (
    targetsLocalControlServer(context.flags.server, context.flags.ipcPort) &&
    !isServerSnapshotOnPorts(status, context.flags.relayPort, context.flags.ipcPort)
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

  const status = await context.getStatus(context.flags.server)
  context.writeResult(status)
  return 0
}

export const serverCommandRegistry: CommandRegistry = {
  help: handleHelp,
  '--help': handleHelp,
  '-h': handleHelp,
  server: handleServer,
  connect: handleConnect,
  status: handleStatus,
}
