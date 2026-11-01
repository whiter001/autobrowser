/// <reference types="bun" />
/// <reference types="node" />
/// <reference lib="dom" />

import { readFile } from 'node:fs/promises'
import { resolveConnectLaunchConfig, resolveExtensionId } from './core/config.js'
import { getExtensionUrl } from './core/extension.js'
import { validateCommandArgs } from './core/command-spec.js'
import { commandSupportsFrameTarget, commandSupportsTabTarget } from './core/command-spec.js'
import { DEFAULT_RELAY_PORT, getHomeDir, getTokenPath, writeJsonFile } from './core/protocol.js'
import { readSession } from './core/sessions.js'
import { createWebDriverCommandHandler } from './cli/webdriver.js'
import { printHelp } from './cli/help.js'
import {
  getStatus,
  isRecord,
  requestCommandRaw,
  shouldTriggerAutoConnect,
  type CommandResponse,
} from './cli/client.js'
import { writeResult as baseWriteResult } from './cli/output.js'
import {
  buildServerLaunchArgs,
  isServerSnapshotOnPorts,
  type ServerSnapshotStatus,
  isServerSnapshotStatus,
  killDetachedProcess,
  normalizeSavedPort,
  parseWindowsNetstatListeningPid,
  readPersistedConnectionInfo,
  spawnDetachedProcess,
  waitForServerStatus,
} from './cli/server-control.js'
import { COMMAND_REGISTRY } from './cli/commands/index.js'
import { type CommandContext } from './cli/commands/types.js'
import { type CliDependencies, type CliFlags } from './cli/types.js'
import { parseCli } from './cli/flags.js'
import {
  BrowserProfileLockError,
  buildSystemOpenCommand,
  detectBrowserProfileLock,
  openUrl,
} from './cli/browser-launch.js'
import {
  buildCommandExecutionUnknownResponse,
  classifyCommandConnectionError,
  createConnectionRecoveryHints,
  formatConnectionRecoveryMessage,
  getLocalControlBaseUrl,
  isServerConnectionError,
  targetsLocalControlServer,
  type ConnectionRecoveryHints,
  type ConnectionTarget,
} from './cli/connection.js'
import { collectHarFromNetwork, writeHarFile } from './cli/har.js'
import { extractScreenshotData, resolveScreenshotOutputPath } from './cli/screenshot.js'

function writeHelp(pathParts: string[] = []): 0 {
  const normalized = printHelp(pathParts).replace(/\r\n?/g, '\n')
  for (const line of normalized.split('\n')) {
    process.stdout.write(`${line}\n`)
  }
  return 0
}

function createInvalidCommandArgsResponse(error: unknown): CommandResponse {
  const message = error instanceof Error ? error.message : String(error)
  const validationError = error as { code?: string; details?: unknown }

  return {
    ok: false,
    error: {
      message,
      code: validationError.code || 'INVALID_COMMAND_ARGS',
      ...(typeof validationError.details !== 'undefined'
        ? { details: validationError.details }
        : {}),
    },
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return ''
  }

  let content = ''
  for await (const chunk of process.stdin) {
    content += chunk
  }

  return content
}

async function resolveEvalScript(flags: CliFlags, rest: string[]): Promise<string> {
  if (flags.file) {
    return await readFile(flags.file, 'utf8')
  }

  if (flags.base64) {
    const raw = rest.join(' ').trim()
    return Buffer.from(raw, 'base64').toString('utf8')
  }

  if (flags.stdin) {
    return await readStdin()
  }

  if (rest.length > 0) {
    return rest.join(' ')
  }

  return await readStdin()
}

async function runMain(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number | void> {
  const { flags, args } = parseCli(argv)
  const [command, ...rest] = args
  if (
    command === 'session' &&
    ['attach', 'detach', 'close-all'].includes(rest[0] || '') &&
    rest[1]
  ) {
    if (flags.session && flags.session !== rest[1]) {
      throw new Error(`session argument ${rest[1]} conflicts with --session ${flags.session}`)
    }
    flags.session = rest[1]
  }
  const baseHomeDir = getHomeDir()
  let homeDir = baseHomeDir
  if (flags.session && command !== 'delete-data') {
    const session = await readSession(baseHomeDir, flags.session)
    homeDir = session.homeDir
    if (!flags.relayPortExplicitlySet) flags.relayPort = session.relayPort
    if (!flags.ipcPortExplicitlySet) flags.ipcPort = session.ipcPort
    if (!flags.serverExplicitlySet && !flags.ipcPortExplicitlySet) {
      flags.server = `http://127.0.0.1:${session.ipcPort}`
    }
  }
  const webDriverCommand =
    flags.engine === 'chromium'
      ? null
      : createWebDriverCommandHandler({
          engine: flags.engine,
          driverUrl:
            flags.webdriverUrl ||
            (flags.engine === 'firefox' ? 'http://127.0.0.1:4444' : 'http://127.0.0.1:4723'),
          homeDir,
        })
  const launchUrl = dependencies.openUrl ?? openUrl
  let connectPageOpened = false
  let commandToken: string | null | undefined

  const openRelayConnectPage = async (relayPort: number): Promise<void> => {
    await launchUrl(`http://127.0.0.1:${relayPort}/connect`, null)
  }

  async function resolveConnectionTarget(
    status: Record<string, unknown> | ServerSnapshotStatus | null,
  ): Promise<ConnectionTarget> {
    const serverStatus = isServerSnapshotStatus(status) ? status : null
    const persistedConnectionInfo = await readPersistedConnectionInfo(
      flags.relayPort,
      flags.ipcPort,
      homeDir,
    )

    const token =
      typeof serverStatus?.token === 'string' && serverStatus.token
        ? serverStatus.token
        : persistedConnectionInfo?.token || ''

    if (token) {
      commandToken = token
    }

    const relayPort = normalizeSavedPort(
      serverStatus?.relayPort ?? persistedConnectionInfo?.relayPort,
      flags.relayPort,
    )
    const ipcPort = normalizeSavedPort(
      serverStatus?.ipcPort ?? persistedConnectionInfo?.ipcPort,
      flags.ipcPort,
    )

    return {
      token,
      relayPort,
      ipcPort,
    }
  }

  async function openExtensionConnectPage(target: ConnectionTarget): Promise<void> {
    const { browserConfig, extensionId } = await resolveConnectLaunchConfig(homeDir, {
      extensionId: flags.extensionId,
      browserCommand: flags.browserCommand,
      browserArgs: flags.browserArgs,
    })

    await launchUrl(
      getExtensionUrl(
        '/connect.html',
        {
          token: target.token,
          relayPort: target.relayPort,
          ipcPort: target.ipcPort,
        },
        extensionId,
      ),
      browserConfig,
    )
  }

  async function openConnectFlow(
    status: Record<string, unknown> | ServerSnapshotStatus | null,
    allowRelayFallback: boolean,
    recoveryHints: ConnectionRecoveryHints | null = null,
  ): Promise<boolean> {
    const target = await resolveConnectionTarget(status)

    if (!target.token) {
      if (!allowRelayFallback) {
        return false
      }

      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openRelayConnectPage(target.relayPort)
      if (recoveryHints) {
        recoveryHints.connectPageOpened = true
      }
      return true
    }

    try {
      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openExtensionConnectPage(target)
      if (recoveryHints) {
        recoveryHints.connectPageOpened = true
      }
      return true
    } catch (error) {
      // profile 锁问题回退到 relay 页没有意义（浏览器根本没起来），直接抛给上层给建议
      if (!allowRelayFallback || error instanceof BrowserProfileLockError) {
        throw error
      }

      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openRelayConnectPage(target.relayPort)
      if (recoveryHints) {
        recoveryHints.connectPageOpened = true
      }
      return true
    }
  }

  async function ensureBackgroundServerStatus(
    recoveryHints: ConnectionRecoveryHints | null = null,
  ): Promise<{
    status: ServerSnapshotStatus
    started: boolean
  } | null> {
    const controlBaseUrl = getLocalControlBaseUrl(flags.ipcPort)
    const existingStatus = await getStatus(controlBaseUrl).catch(() => null)

    if (isServerSnapshotOnPorts(existingStatus, flags.relayPort, flags.ipcPort)) {
      return {
        status: existingStatus,
        started: false,
      }
    }

    if (recoveryHints) {
      recoveryHints.serverStartAttempted = true
    }

    const extensionId = await resolveExtensionId(homeDir, flags.extensionId)
    const spawnCommand = dependencies.spawnDetachedProcess ?? spawnDetachedProcess
    let backgroundProcess

    try {
      backgroundProcess = await spawnCommand(
        'bun',
        buildServerLaunchArgs(
          {
            relayPort: flags.relayPort,
            ipcPort: flags.ipcPort,
          },
          extensionId,
          flags.session,
        ),
      )
    } catch {
      return null
    }

    const readyAbortController = new AbortController()
    const readyResult = backgroundProcess.waitForExit
      ? await Promise.race([
          waitForServerStatus(
            controlBaseUrl,
            flags.relayPort,
            flags.ipcPort,
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
          status: await waitForServerStatus(controlBaseUrl, flags.relayPort, flags.ipcPort),
        }

    if (readyResult.kind === 'exit') {
      return null
    }

    if (!readyResult.status) {
      killDetachedProcess(backgroundProcess)
      return null
    }

    if (recoveryHints) {
      recoveryHints.serverStarted = true
    }

    return {
      status: readyResult.status,
      started: true,
    }
  }

  async function assistCommandConnection(
    baseUrl: string,
    recoveryHints: ConnectionRecoveryHints,
  ): Promise<boolean> {
    let status: Record<string, unknown> | ServerSnapshotStatus | null = await getStatus(
      baseUrl,
    ).catch(() => null)

    if (!isServerSnapshotStatus(status) && targetsLocalControlServer(baseUrl, flags.ipcPort)) {
      const serverState = await ensureBackgroundServerStatus(recoveryHints)
      status = serverState?.status || null
    }

    if (!isServerSnapshotStatus(status)) {
      return false
    }

    if (status.extensionConnected === false) {
      try {
        const opened = await openConnectFlow(status, true, recoveryHints)
        if (opened) {
          connectPageOpened = true
        }
        return opened
      } catch {
        return false
      }
    }

    return true
  }

  async function triggerAutoConnect(
    baseUrl: string,
    force: boolean = false,
    recoveryHints: ConnectionRecoveryHints | null = null,
  ): Promise<boolean> {
    if ((!flags.autoConnect && !force) || connectPageOpened) {
      return false
    }

    const status = await getStatus(baseUrl).catch(() => null)
    if (!status || status.extensionConnected !== false) {
      return false
    }

    const target = await resolveConnectionTarget(status)
    if (!target.token) {
      return false
    }

    try {
      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openExtensionConnectPage(target)
      connectPageOpened = true
      if (recoveryHints) {
        recoveryHints.connectPageOpened = true
      }
      return true
    } catch (error) {
      console.warn('failed to proactively open extension connect page', error)
      return false
    }
  }

  const createConnectionErrorBuilder =
    (baseUrl: string, recoveryHints: ConnectionRecoveryHints) =>
    (problem: 'server-unreachable' | 'extension-disconnected', message: string): string =>
      formatConnectionRecoveryMessage(baseUrl, message, {
        problem,
        recoveryHints: {
          ...recoveryHints,
          connectPageOpened: recoveryHints.connectPageOpened || connectPageOpened,
        },
      })

  async function getCommandStatus(
    baseUrl: string,
    recoveryHints: ConnectionRecoveryHints = createConnectionRecoveryHints(
      targetsLocalControlServer(baseUrl, flags.ipcPort),
    ),
  ): Promise<Record<string, unknown>> {
    const buildConnectionError = createConnectionErrorBuilder(baseUrl, recoveryHints)

    try {
      return await getStatus(baseUrl)
    } catch (error) {
      if (!isServerConnectionError(error)) {
        throw error
      }

      if (!recoveryHints.localTarget) {
        throw new Error(
          buildConnectionError(
            'server-unreachable',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }

      const serverState = await ensureBackgroundServerStatus(recoveryHints)
      if (!serverState) {
        throw new Error(
          buildConnectionError(
            'server-unreachable',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }

      try {
        return await getStatus(baseUrl)
      } catch (retryError) {
        if (!isServerConnectionError(retryError)) {
          throw retryError
        }

        throw new Error(
          buildConnectionError(
            'server-unreachable',
            retryError instanceof Error ? retryError.message : String(retryError),
          ),
        )
      }
    }
  }

  async function getCdpUrlForCommand(baseUrl: string): Promise<string> {
    const recoveryHints = createConnectionRecoveryHints(
      targetsLocalControlServer(baseUrl, flags.ipcPort),
    )
    const status = await getCommandStatus(baseUrl, recoveryHints)
    const relayPort = Number(status.relayPort || DEFAULT_RELAY_PORT)
    const token = typeof status.token === 'string' ? status.token : ''

    if (!token) {
      const buildConnectionError = createConnectionErrorBuilder(baseUrl, recoveryHints)
      throw new Error(buildConnectionError('extension-disconnected', 'missing token'))
    }

    return `ws://127.0.0.1:${relayPort}/ws?token=${encodeURIComponent(token)}`
  }

  async function resolveCommandToken(): Promise<string | null> {
    if (commandToken !== undefined) {
      return commandToken
    }

    const persistedConnectionInfo = await readPersistedConnectionInfo(
      flags.relayPort,
      flags.ipcPort,
      homeDir,
    )
    commandToken = persistedConnectionInfo?.token || null
    return commandToken
  }

  async function requestCommandWithToken(
    baseUrl: string,
    command: string,
    args: Record<string, unknown>,
  ): Promise<CommandResponse> {
    const token = await resolveCommandToken()
    const payload = await requestCommandRaw(baseUrl, command, args, { token })
    if (payload.ok !== false || payload.error?.code !== 'UNAUTHORIZED') {
      return payload
    }

    const status = await getStatus(baseUrl).catch(() => null)
    const target = await resolveConnectionTarget(status)
    if (!target.token || target.token === token) {
      return payload
    }

    commandToken = target.token
    try {
      await writeJsonFile(getTokenPath(homeDir), { token: target.token })
    } catch {
      // 令牌写盘失败不应阻断本次重试；下一次运行仍可重新读取状态重新发现。
    }

    return await requestCommandRaw(baseUrl, command, args, { token: target.token })
  }

  async function requestCommand(
    baseUrl: string,
    command: string,
    args: object = {},
  ): Promise<CommandResponse> {
    const requestArgs: Record<string, unknown> = { ...args }
    if (commandSupportsTabTarget(command) && requestArgs.tabId === undefined && flags.tab) {
      requestArgs.tabId = flags.tab
    }
    if (commandSupportsFrameTarget(command) && requestArgs.frame === undefined && flags.frame) {
      requestArgs.frame = flags.frame
    }

    try {
      validateCommandArgs(command, requestArgs)
    } catch (error) {
      return createInvalidCommandArgsResponse(error)
    }

    if (webDriverCommand) return await webDriverCommand(command, requestArgs)

    if (flags.autoConnect && !connectPageOpened) {
      await triggerAutoConnect(baseUrl)
    }

    const recoveryHints = createConnectionRecoveryHints(
      targetsLocalControlServer(baseUrl, flags.ipcPort),
    )
    const buildConnectionError = createConnectionErrorBuilder(baseUrl, recoveryHints)

    const withConnectionHelp = (payload: CommandResponse): CommandResponse => {
      if (payload.ok !== false) {
        return payload
      }

      return {
        ...payload,
        error: {
          ...payload.error,
          message: buildConnectionError(
            'extension-disconnected',
            payload.error?.message || 'no extension is connected',
          ),
        },
      }
    }

    let payload: CommandResponse

    try {
      payload = await requestCommandWithToken(baseUrl, command, requestArgs)
    } catch (error) {
      const failure = classifyCommandConnectionError(error)
      if (!failure) {
        throw error
      }

      // 只有"明确没送达"的才自动重放；不确定的一律不重试，避免副作用被执行两次。
      if (failure === 'unknown') {
        return buildCommandExecutionUnknownResponse(
          command,
          error instanceof Error ? error.message : String(error),
        )
      }

      const recovered = await assistCommandConnection(baseUrl, recoveryHints)
      if (!recovered) {
        throw new Error(
          buildConnectionError(
            'server-unreachable',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }

      try {
        payload = await requestCommandWithToken(baseUrl, command, requestArgs)
      } catch (retryError) {
        const retryFailure = classifyCommandConnectionError(retryError)
        if (!retryFailure) {
          throw retryError
        }

        if (retryFailure === 'unknown') {
          return buildCommandExecutionUnknownResponse(
            command,
            retryError instanceof Error ? retryError.message : String(retryError),
          )
        }

        throw new Error(
          buildConnectionError(
            'server-unreachable',
            retryError instanceof Error ? retryError.message : String(retryError),
          ),
        )
      }
    }

    if (shouldTriggerAutoConnect(payload)) {
      const opened = await triggerAutoConnect(baseUrl, true, recoveryHints)
      if (opened) {
        try {
          const retriedPayload = await requestCommandWithToken(baseUrl, command, requestArgs)
          return shouldTriggerAutoConnect(retriedPayload)
            ? withConnectionHelp(retriedPayload)
            : retriedPayload
        } catch (error) {
          const failure = classifyCommandConnectionError(error)
          if (!failure) {
            throw error
          }

          if (failure === 'unknown') {
            return buildCommandExecutionUnknownResponse(
              command,
              error instanceof Error ? error.message : String(error),
            )
          }

          throw new Error(
            buildConnectionError(
              'server-unreachable',
              error instanceof Error ? error.message : String(error),
            ),
          )
        }
      }

      return withConnectionHelp(payload)
    }

    return payload
  }

  let lastResponseFailed = false
  const writeResult = (
    payload:
      | CommandResponse
      | Record<string, unknown>
      | string
      | number
      | boolean
      | bigint
      | null
      | undefined,
  ): void => {
    baseWriteResult(payload, { json: flags.json })
    // 只看已写出的顶层响应；后续成功可恢复早期失败，batch 内部步骤不影响聚合结果。
    if (isRecord(payload) && typeof payload.ok === 'boolean') {
      lastResponseFailed = payload.ok === false
    }
  }

  const context: CommandContext = {
    flags,
    homeDir,
    dependencies,
    writeHelp,
    writeResult,
    requestCommand,
    openConnectFlow,
    getStatus,
    getCommandStatus,
    resolveEvalScript: async (evalRest) => await resolveEvalScript(flags, evalRest),
    getCdpUrl: getCdpUrlForCommand,
    extractScreenshotData,
    resolveScreenshotOutputPath,
    collectHarFromNetwork: async (baseUrl, startedAt) =>
      await collectHarFromNetwork(baseUrl, startedAt, await resolveCommandToken()),
    writeHarFile,
  }

  if (!command) {
    return writeHelp()
  }

  const handler = COMMAND_REGISTRY[command]
  if (handler) {
    const code = await handler(rest, context)
    if (typeof code === 'number' && code !== 0) return code
    return lastResponseFailed ? 1 : code
  }

  process.stderr.write(`${printHelp()}\n`)
  return 1
}

export async function main(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number | void> {
  try {
    return await runMain(argv, dependencies)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      if (typeof code === 'number') {
        process.exitCode = code
      }
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

export { parseWindowsNetstatListeningPid }
export { BrowserProfileLockError, buildSystemOpenCommand, detectBrowserProfileLock }
