import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface CliBuildInfo {
  version: string | null
  commit: string | null
  buildTime: string | null
}

export interface VersionSkew {
  /** true 一致 / false 错配 / null 无从判断（没有扩展或缺少版本字段） */
  consistent: boolean | null
  cli: string | null
  extension: string | null
  hint: string | null
}

/** 构建时写进 dist/ 的信息；`bun src/cli.ts` 这种开发直跑没有该文件，字段全部为 null */
const BUILD_INFO_PATH = path.join(import.meta.dir, 'build-info.json')

const EMPTY_BUILD_INFO: CliBuildInfo = { version: null, commit: null, buildTime: null }

let cached: Promise<CliBuildInfo> | null = null

function parseBuildInfo(raw: unknown): CliBuildInfo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return EMPTY_BUILD_INFO
  }
  const { version, commit, buildTime } = raw as Record<string, unknown>
  return {
    version: typeof version === 'string' && version ? version : null,
    commit: typeof commit === 'string' && /^[a-f\d]{4,64}$/i.test(commit) ? commit : null,
    buildTime:
      typeof buildTime === 'string' &&
      Number.isFinite(Date.parse(buildTime)) &&
      new Date(buildTime).toISOString() === buildTime
        ? buildTime
        : null,
  }
}

/**
 * 读取随 dist 一起安装的构建信息。只用于诊断（版本错配、"扩展是不是没重载"），
 * 不参与能力协商；读取失败一律退化为 null，不能因为诊断信息缺失让命令失败。
 */
export async function readCliBuildInfo(): Promise<CliBuildInfo> {
  cached ??= (async () => {
    try {
      return parseBuildInfo(JSON.parse(await readFile(BUILD_INFO_PATH, 'utf8')))
    } catch {
      return EMPTY_BUILD_INFO
    }
  })()
  return await cached
}

/** 仅测试用：重置记忆化结果 */
export function resetCliBuildInfoCache(): void {
  cached = null
}

/**
 * CLI 与扩展的版本是否一致。版本号同源（package.json → manifest），不一致基本只有两种原因：
 * 扩展是旧的没重载，或者 CLI 是旧的。两者都不该继续猜能力，先对齐版本。
 */
export function compareVersions(
  cliVersion: string | null,
  extensionVersion: string | null,
): VersionSkew {
  if (!cliVersion || !extensionVersion) {
    return { consistent: null, cli: cliVersion, extension: extensionVersion, hint: null }
  }
  if (cliVersion === extensionVersion) {
    return { consistent: true, cli: cliVersion, extension: extensionVersion, hint: null }
  }
  return {
    consistent: false,
    cli: cliVersion,
    extension: extensionVersion,
    hint:
      `CLI is ${cliVersion} but the loaded extension is ${extensionVersion}. ` +
      "Rebuild and reload the extension ('bun run build:chrome' then 'extension reload'), or upgrade the CLI, before trusting version-specific behavior.",
  }
}
