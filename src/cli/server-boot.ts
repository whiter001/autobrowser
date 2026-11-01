import { getStatus } from './client.js'
import { getLocalControlBaseUrl } from './connection.js'
import {
  buildServerLaunchArgs,
  isServerSnapshotOnPorts,
  killDetachedProcess,
  waitForServerStatus,
  type DetachedProcessHandle,
  type ServerSnapshotStatus,
} from './server-control.js'

interface BackgroundServerStartOptions {
  relayPort: number
  ipcPort: number
  session: string
  /** 延迟到确认需要启动时才解析扩展 ID：端口已被占用时解析失败的异常不该影响 already-running 分支 */
  resolveExtensionId: () => Promise<string>
  spawnCommand: (
    command: string,
    args: string[],
  ) => DetachedProcessHandle | Promise<DetachedProcessHandle>
  /** 在真正尝试拉起进程前回调，供调用方标记 recovery hints */
  onStartAttempt?: () => void
}

type BackgroundServerStartResult =
  | { kind: 'already-running'; status: ServerSnapshotStatus }
  | { kind: 'started'; status: ServerSnapshotStatus }
  | { kind: 'spawn-failed'; error: unknown }
  | { kind: 'exited-before-ready'; exitInfo: { code: number | null; signal: string | null } }
  | { kind: 'not-ready' }

// 后台 server 的启动流程只有一份实现：CLI 的自动恢复和 `server start` 命令对"已经在跑 / 拉不起来"
// 的叫法不同，把提示文案留给调用方，这里只负责拉起进程并判定结局。
export async function startBackgroundServer(
  options: BackgroundServerStartOptions,
): Promise<BackgroundServerStartResult> {
  const controlBaseUrl = getLocalControlBaseUrl(options.ipcPort)
  const existingStatus = await getStatus(controlBaseUrl).catch(() => null)

  if (isServerSnapshotOnPorts(existingStatus, options.relayPort, options.ipcPort)) {
    return { kind: 'already-running', status: existingStatus }
  }

  options.onStartAttempt?.()

  const extensionId = await options.resolveExtensionId()
  let backgroundProcess: DetachedProcessHandle

  try {
    backgroundProcess = await options.spawnCommand(
      'bun',
      buildServerLaunchArgs(
        {
          relayPort: options.relayPort,
          ipcPort: options.ipcPort,
        },
        extensionId,
        options.session,
      ),
    )
  } catch (error) {
    return { kind: 'spawn-failed', error }
  }

  // 等 ready 与等进程退出的竞速：进程瞬间崩溃时 waitForServerStatus 会一直等到超时，
  // 用 waitForExit 提前收尾；两者都结束后仍要 abort 掉轮询，避免悬挂的定时器拖住进程。
  const readyAbortController = new AbortController()
  const readyResult = backgroundProcess.waitForExit
    ? await Promise.race([
        waitForServerStatus(
          controlBaseUrl,
          options.relayPort,
          options.ipcPort,
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
        status: await waitForServerStatus(controlBaseUrl, options.relayPort, options.ipcPort),
      }

  if (readyResult.kind === 'exit') {
    return { kind: 'exited-before-ready', exitInfo: readyResult.exitInfo }
  }

  if (!readyResult.status) {
    killDetachedProcess(backgroundProcess)
    return { kind: 'not-ready' }
  }

  return { kind: 'started', status: readyResult.status }
}
