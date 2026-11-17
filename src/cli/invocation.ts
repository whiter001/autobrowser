import { getHomeDir } from '../core/protocol.js'
import { readSession } from '../core/sessions.js'
import { normalizeWorkspaceId } from '../core/workspaces.js'
import { resolveAutomaticWorkspaceId } from './caller-identity.js'
import { CliUsageError } from './cli-error.js'
import { parseCli } from './flags.js'
import { isHelpToken } from './help.js'
import type { CliFlags } from './types.js'

interface Invocation {
  flags: CliFlags
  args: string[]
  homeDir: string
}

export interface InvocationDependencies {
  /** 注入自动 workspace 身份解析，便于测试断言本地帮助路径不做进程枚举 */
  resolveAutomaticWorkspaceId?: () => Promise<string>
}

const LOCAL_ONLY_COMMANDS = new Set(['help', '--help', '-h', 'version'])

/**
 * 纯本地帮助/版本路径：不需要 relay，也就不需要 workspace 身份。
 * 各命令的 help 旗标同样由 handler 自己识别（`snapshot --help` 只打印帮助），因此一并算本地路径。
 */
function isLocalOnlyInvocation(args: string[]): boolean {
  const [command, ...rest] = args
  if (!command) return true
  if (LOCAL_ONLY_COMMANDS.has(command)) return true
  return isHelpToken(rest[0])
}

// --session 既支持全局 flag，也支持 `session attach|detach|close-all <name>` 的位置参数写法。
// 位置参数形式必须提前折叠进 flags.session，否则后面的端口/homeDir 覆写逻辑会漏掉会话。
export async function resolveInvocation(
  argv: string[],
  dependencies: InvocationDependencies = {},
): Promise<Invocation> {
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

  // workspace 解析优先级：显式 --workspace > 非 off 的 AUTOBROWSER_WORKSPACE > 默认 auto。
  // --no-workspace 和 env=off 都退回无 workspace 的共享模式；显式 --workspace 仍覆盖 off。
  if (flags.noWorkspace && flags.workspace) {
    throw new CliUsageError('--no-workspace cannot be combined with --workspace', {
      suggestedAction:
        'Drop --no-workspace to use that workspace, or drop --workspace to keep the shared browser target.',
    })
  }

  const envWorkspace = process.env.AUTOBROWSER_WORKSPACE?.trim() ?? ''
  const envDisablesWorkspace = envWorkspace.toLowerCase() === 'off'

  let requestedWorkspace = ''
  // 仅"默认 auto"在 WebDriver 引擎下静默跳过；显式配置仍按旧行为报错，避免用户以为已隔离
  let workspaceFromDefault = false
  if (flags.workspace) {
    requestedWorkspace = flags.workspace
  } else if (envDisablesWorkspace || flags.noWorkspace) {
    requestedWorkspace = ''
  } else if (envWorkspace) {
    requestedWorkspace = envWorkspace
  } else {
    requestedWorkspace = 'auto'
    workspaceFromDefault = command !== 'workspace'
  }

  if (requestedWorkspace) {
    if (flags.engine !== 'chromium') {
      if (!workspaceFromDefault) {
        throw new Error('workspace mode is only supported by the Chromium extension')
      }
    } else if (requestedWorkspace === 'auto') {
      // 本地 help/version 免解析：显式 --workspace / env 仍按原路径规范化，冲突与非法 id 校验不受影响。
      if (!isLocalOnlyInvocation(args)) {
        const resolveWorkspaceId =
          dependencies.resolveAutomaticWorkspaceId ?? resolveAutomaticWorkspaceId
        flags.workspace = await resolveWorkspaceId()
      }
    } else {
      flags.workspace = normalizeWorkspaceId(requestedWorkspace)
    }
  }

  return { flags, args, homeDir }
}
