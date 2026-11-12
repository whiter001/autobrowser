import { getHomeDir } from '../core/protocol.js'
import { readSession } from '../core/sessions.js'
import { normalizeWorkspaceId } from '../core/workspaces.js'
import { resolveAutomaticWorkspaceId } from './caller-identity.js'
import { parseCli } from './flags.js'
import type { CliFlags } from './types.js'

interface Invocation {
  flags: CliFlags
  args: string[]
  homeDir: string
}

// --session 既支持全局 flag，也支持 `session attach|detach|close-all <name>` 的位置参数写法。
// 位置参数形式必须提前折叠进 flags.session，否则后面的端口/homeDir 覆写逻辑会漏掉会话。
export async function resolveInvocation(argv: string[]): Promise<Invocation> {
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

  const requestedWorkspace =
    flags.workspace ||
    process.env.AUTOBROWSER_WORKSPACE?.trim() ||
    (command === 'workspace' ? 'auto' : '')
  if (requestedWorkspace) {
    if (flags.engine !== 'chromium') {
      throw new Error('workspace mode is only supported by the Chromium extension')
    }
    flags.workspace =
      requestedWorkspace === 'auto'
        ? await resolveAutomaticWorkspaceId()
        : normalizeWorkspaceId(requestedWorkspace)
  }

  return { flags, args, homeDir }
}
