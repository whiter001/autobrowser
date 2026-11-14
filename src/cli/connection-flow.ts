import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveConnectLaunchConfig, resolveExtensionId } from '../core/config.js'
import { getExtensionUrl } from '../core/extension.js'
import { DEFAULT_RELAY_PORT, getTokenPath, writeJsonFile } from '../core/protocol.js'
import { BrowserProfileLockError, openUrl } from './browser-launch.js'
import { startBackgroundServer } from './server-boot.js'
import {
  commandSupportsFrameTarget,
  commandSupportsTabTarget,
  validateCommandArgs,
} from '../core/command-spec.js'
import {
  getStatus,
  isRecord,
  requestCommandRaw,
  shouldTriggerAutoConnect,
  type CommandResponse,
} from './client.js'
import {
  buildCommandExecutionUnknownResponse,
  classifyCommandConnectionError,
  createConnectionRecoveryHints,
  formatConnectionRecoveryMessage,
  isServerConnectionError,
  targetsLocalControlServer,
  type ConnectionRecoveryHints,
  type ConnectionTarget,
} from './connection.js'
import {
  isServerSnapshotStatus,
  normalizeSavedPort,
  readPersistedConnectionInfo,
  spawnDetachedProcess,
  type ServerSnapshotStatus,
} from './server-control.js'
import type { CliDependencies, CliFlags } from './types.js'
import type { createWebDriverCommandHandler } from './webdriver.js'

interface ConnectionFlowOptions {
  flags: CliFlags
  homeDir: string
  dependencies: CliDependencies
  webDriverCommand: ReturnType<typeof createWebDriverCommandHandler> | null
}

interface ConnectionFlow {
  resolveConnectionTarget(
    status: Record<string, unknown> | ServerSnapshotStatus | null,
  ): Promise<ConnectionTarget>
  openConnectFlow(
    status: Record<string, unknown> | ServerSnapshotStatus | null,
    allowRelayFallback: boolean,
    recoveryHints?: ConnectionRecoveryHints | null,
  ): Promise<boolean>
  getCommandStatus(baseUrl: string): Promise<Record<string, unknown>>
  getCdpUrl(baseUrl: string): Promise<string>
  resolveCommandToken(): Promise<string | null>
  requestCommand(baseUrl: string, command: string, args?: object): Promise<CommandResponse>
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

// 把一次 CLI 调用的连接/重连/命令请求状态收敛在工厂闭包里：
// flags 与 homeDir 在 bootstrap 后不再变化，connectPageOpened / commandToken 是跨命令共享的可变状态，
// 放在模块级会污染同一进程内的多次 main() 调用（测试里会直接复用）。
export function createConnectionFlow(options: ConnectionFlowOptions): ConnectionFlow {
  const { flags, homeDir, dependencies, webDriverCommand } = options
  const launchUrl = dependencies.openUrl ?? openUrl
  let connectPageOpened = false
  let commandToken: string | null | undefined

  // 带 token 打开才能看到凭证面板；没有 token 时页面是脱敏版本，只提示从哪里取。
  const openRelayConnectPage = async (relayPort: number, token: string | null): Promise<void> => {
    const query = token ? `?token=${encodeURIComponent(token)}` : ''
    await launchUrl(`http://127.0.0.1:${relayPort}/connect${query}`, null)
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
      await openRelayConnectPage(target.relayPort, target.token || null)
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

      // 浏览器启动失败必须留痕：否则 --browser-command 写错也只会静默打开回退页，
      // 用户会以为"扩展页已经打开了"。回退本身保留，只是不再无声。
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `warning: failed to open the extension connect page (${reason}); opened the relay connect page instead\n`,
      )

      if (recoveryHints) {
        recoveryHints.connectPageAttempted = true
      }
      await openRelayConnectPage(target.relayPort, target.token || null)
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
    const result = await startBackgroundServer({
      relayPort: flags.relayPort,
      ipcPort: flags.ipcPort,
      session: flags.session,
      resolveExtensionId: () => resolveExtensionId(homeDir, flags.extensionId),
      spawnCommand: dependencies.spawnDetachedProcess ?? spawnDetachedProcess,
      onStartAttempt: () => {
        if (recoveryHints) {
          recoveryHints.serverStartAttempted = true
        }
      },
    })

    if (result.kind === 'already-running') {
      return { status: result.status, started: false }
    }

    if (result.kind !== 'started') {
      return null
    }

    if (recoveryHints) {
      recoveryHints.serverStarted = true
    }

    return { status: result.status, started: true }
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

  async function requestCommandInternal(
    baseUrl: string,
    command: string,
    args: object = {},
  ): Promise<CommandResponse> {
    const requestArgs: Record<string, unknown> = { ...args }
    // handler 显式写了 responseFormat（例如 eval --output 默认走 detailed）时不能被
    // 根级 flags 的默认值覆盖；只有没设置时才补默认值。
    if (
      ['snapshot', 'search', 'eval'].includes(command) &&
      requestArgs.responseFormat === undefined
    ) {
      requestArgs.responseFormat = flags.responseFormat
    }
    if (command === 'tab.list' && flags.responseFormatExplicitlySet) {
      requestArgs.responseFormat = flags.responseFormat
    }
    if (commandSupportsTabTarget(command) && requestArgs.tabId === undefined && flags.tab) {
      requestArgs.tabId = flags.tab
    }
    if (commandSupportsFrameTarget(command) && requestArgs.frame === undefined && flags.frame) {
      requestArgs.frame = flags.frame
    }
    if (flags.workspace && requestArgs.workspace === undefined) {
      requestArgs.workspace = flags.workspace
    }
    // workspace 模式默认允许扩展自动认领已有标签；--no-auto-attach 显式关闭
    if (flags.workspace && flags.autoAttach === false && requestArgs.autoAttach === undefined) {
      requestArgs.autoAttach = false
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

  /**
   * eval 大结果落盘：把完整 result 写成 2 空格缩进的 JSON（末尾换行），只回小型摘要。
   * 放在连接层而不是 CLI handler，是因为 MCP 的 eval 复用同一条请求路径；
   * output 是客户端侧的落盘选项，不参与扩展参数校验，也不会发给 relay。
   */
  async function writeEvalResultToFile(
    payload: CommandResponse,
    outputPath: string,
  ): Promise<CommandResponse> {
    if (payload.ok === false) {
      return payload
    }

    const content = `${JSON.stringify(payload.result ?? null, null, 2)}\n`
    await writeFile(outputPath, content, 'utf8')

    // 扩展会把命令级 meta（目标标签页、对话框/仿真状态等）挂在对象结果里；
    // 正文被移到文件后，这些执行上下文仍要留在返回值上。
    const meta = isRecord(payload.result) ? payload.result.meta : undefined

    return {
      ...payload,
      result: {
        path: outputPath,
        format: 'json',
        bytes: Buffer.byteLength(content, 'utf8'),
        ...(meta !== undefined ? { meta } : {}),
      },
    }
  }

  async function requestCommand(
    baseUrl: string,
    command: string,
    args: object = {},
  ): Promise<CommandResponse> {
    const requestArgs: Record<string, unknown> = { ...args }
    let outputPath: string | null = null

    if (command === 'eval' && requestArgs.output !== undefined) {
      const output = requestArgs.output
      if (typeof output !== 'string' || !output.trim()) {
        return createInvalidCommandArgsResponse(
          new Error('invalid command arguments for eval: output must be a non-empty string'),
        )
      }
      outputPath = path.resolve(output)
      delete requestArgs.output
    }

    const payload = await requestCommandInternal(baseUrl, command, requestArgs)
    return outputPath ? await writeEvalResultToFile(payload, outputPath) : payload
  }

  return {
    resolveConnectionTarget,
    openConnectFlow,
    getCommandStatus,
    getCdpUrl: getCdpUrlForCommand,
    resolveCommandToken,
    requestCommand,
  }
}
