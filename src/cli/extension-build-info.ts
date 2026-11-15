import { normalizeBuildInfo, type CliBuildInfo } from './build-info.js'
import { isRecord, requestCommandRaw } from './client.js'
import { readPersistedConnectionInfo } from './server-control.js'
import type { CommandContext } from './commands/types.js'

/**
 * 扩展侧构建信息。relay 的 status 快照只有 manifest version，是未连接/旧扩展时唯一的兜底；
 * commit/buildTime 必须再向扩展要一次 'extension info'。
 */
export async function readExtensionBuildInfo(
  context: CommandContext,
  status: Record<string, unknown> | null,
): Promise<CliBuildInfo> {
  const snapshot = status && isRecord(status.snapshot) ? status.snapshot : null
  const extension = snapshot && isRecord(snapshot.extension) ? snapshot.extension : null
  const fallback = normalizeBuildInfo(extension)

  // 没连上或快照里没有扩展时不要发请求：诊断命令不能因为扩展离线而多一次失败等待。
  if (!extension || status?.extensionConnected !== true) {
    return fallback
  }

  try {
    const connection = await readPersistedConnectionInfo(
      context.flags.relayPort,
      context.flags.ipcPort,
      context.homeDir,
    )
    // 版本诊断不能触发自动拉起 relay、打开 connect 页或重放请求。
    const payload = await requestCommandRaw(
      context.flags.server,
      'extension',
      { action: 'info' },
      { token: connection?.token },
    )
    if (!payload.ok) {
      return fallback
    }
    const info = normalizeBuildInfo(payload.result)
    // 旧扩展的 info 响应可能缺字段：缺的部分退回快照里的 manifest 版本。
    return {
      version: info.version ?? fallback.version,
      commit: info.commit ?? fallback.commit,
      buildTime: info.buildTime ?? fallback.buildTime,
    }
  } catch {
    // 诊断请求失败只影响能否判断构建错配，不影响命令本身。
    return fallback
  }
}
