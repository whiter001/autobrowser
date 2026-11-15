import { compareBuilds, readCliBuildInfo, type CliBuildInfo } from '../build-info.js'
import { readExtensionBuildInfo } from '../extension-build-info.js'
import { isHelpToken } from '../help.js'
import type { CommandHandler, CommandRegistry } from './types.js'

function formatBuildLine(label: string, info: CliBuildInfo): string {
  const version = info.version ?? 'unknown'
  const commit = info.commit ? ` (${info.commit})` : ''
  const built = info.buildTime ? ` built ${info.buildTime}` : ''
  return `${label} ${version}${commit}${built}`
}

const handleVersion: CommandHandler = async (rest, context) => {
  if (isHelpToken(rest[0])) {
    return context.writeHelp(['version'])
  }

  const cli = await readCliBuildInfo()
  // 只读已有 relay 的状态，不为了打版本号把服务拉起来
  const status = await context.getStatus(context.flags.server).catch(() => null)
  const extension = await readExtensionBuildInfo(context, status)
  const versionSkew = compareBuilds(cli, extension)

  // 与 status 一致：默认给人读的文本，显式 --json 才输出原始对象
  if (context.flags.json && context.flags.jsonExplicitlySet) {
    context.writeResult({ ok: true, result: { cli, extension, versionSkew } })
    return 0
  }

  process.stdout.write(`${formatBuildLine('autobrowser', cli)}\n`)
  if (!extension.version && status?.extensionConnected !== true) {
    process.stdout.write('extension not connected\n')
  } else {
    process.stdout.write(`${formatBuildLine('extension', extension)}\n`)
  }
  if (versionSkew.hint) {
    process.stdout.write(`warning: ${versionSkew.hint}\n`)
  }
  return 0
}

export const versionCommandRegistry: CommandRegistry = {
  version: handleVersion,
}
