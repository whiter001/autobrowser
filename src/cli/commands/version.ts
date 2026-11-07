import { compareVersions, readCliBuildInfo } from '../build-info.js'
import { isHelpToken } from '../help.js'
import { isRecord } from '../client.js'
import type { CommandHandler, CommandRegistry } from './types.js'

/** 从 status 快照里取扩展 manifest 版本；没连上或旧 relay 不带该字段时为 null */
function readExtensionVersion(status: Record<string, unknown> | null): string | null {
  if (!status || !isRecord(status.snapshot)) {
    return null
  }
  const extension = status.snapshot.extension
  if (!isRecord(extension)) {
    return null
  }
  return typeof extension.version === 'string' && extension.version ? extension.version : null
}

const handleVersion: CommandHandler = async (rest, context) => {
  if (isHelpToken(rest[0])) {
    return context.writeHelp(['version'])
  }

  const cli = await readCliBuildInfo()
  // 只读已有 relay 的状态，不为了打版本号把服务拉起来
  const status = await context.getStatus(context.flags.server).catch(() => null)
  const extensionVersion = readExtensionVersion(status)
  const versionSkew = compareVersions(cli.version, extensionVersion)

  // 与 status 一致：默认给人读的文本，显式 --json 才输出原始对象
  if (context.flags.json && context.flags.jsonExplicitlySet) {
    context.writeResult({
      ok: true,
      result: { cli, extension: { version: extensionVersion }, versionSkew },
    })
    return 0
  }

  const cliVersion = cli.version ?? 'unknown'
  const commit = cli.commit ? ` (${cli.commit})` : ''
  const built = cli.buildTime ? ` built ${cli.buildTime}` : ''
  process.stdout.write(`autobrowser ${cliVersion}${commit}${built}\n`)
  process.stdout.write(
    `extension ${extensionVersion ?? 'not connected'}` +
      (extensionVersion ? ` (manifest version; 'extension info' has commit/buildTime)` : '') +
      '\n',
  )
  if (versionSkew.hint) {
    process.stdout.write(`warning: ${versionSkew.hint}\n`)
  }
  return 0
}

export const versionCommandRegistry: CommandRegistry = {
  version: handleVersion,
}
