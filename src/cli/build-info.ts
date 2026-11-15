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
  /** 错配维度：版本号不同或同版本不同 commit；一致或无从判断时为 null */
  reason: 'version' | 'commit' | null
  cli: string | null
  extension: string | null
  hint: string | null
}

/** 构建时写进 dist/ 的信息；`bun src/cli.ts` 这种开发直跑没有该文件，字段全部为 null */
const BUILD_INFO_PATH = path.join(import.meta.dir, 'build-info.json')

export const EMPTY_BUILD_INFO: CliBuildInfo = { version: null, commit: null, buildTime: null }

let cached: Promise<CliBuildInfo> | null = null

/**
 * 把磁盘/扩展返回的原始对象收敛成诊断用构建信息。任何字段类型或格式不对都退化为 null：
 * 这些值只用于提示错配，不能因为旧构建写了脏数据让命令失败。
 */
export function normalizeBuildInfo(raw: unknown): CliBuildInfo {
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
      return normalizeBuildInfo(JSON.parse(await readFile(BUILD_INFO_PATH, 'utf8')))
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

const REBUILD_ADVICE =
  "Rebuild and reload the extension ('bun run build:chrome' then 'extension reload'), or upgrade the CLI, before trusting version-specific behavior."

/**
 * CLI 与扩展是否来自同一次构建。版本号同源（package.json → manifest），版本不同说明
 * 一侧没升级；同版本但 commit 不同说明只重建/重载了其中一侧，行为差异同样无法解释。
 * buildTime 只体现"什么时候构建"，两次构建时间必然不同，绝不能参与相等判断。
 */
export function compareBuilds(cli: CliBuildInfo, extension: CliBuildInfo): VersionSkew {
  if (!cli.version || !extension.version) {
    return {
      consistent: null,
      reason: null,
      cli: cli.version,
      extension: extension.version,
      hint: null,
    }
  }
  if (cli.version !== extension.version) {
    return {
      consistent: false,
      reason: 'version',
      cli: cli.version,
      extension: extension.version,
      hint: `CLI is ${cli.version} but the loaded extension is ${extension.version}. ${REBUILD_ADVICE}`,
    }
  }
  // 只有两侧都拿到了 commit 才能下结论；旧构建缺 commit 时只能认为版本一致。
  if (cli.commit && extension.commit && cli.commit !== extension.commit) {
    return {
      consistent: false,
      reason: 'commit',
      cli: cli.version,
      extension: extension.version,
      hint:
        `CLI and extension are both ${cli.version} but built from different commits ` +
        `(CLI ${cli.commit}, extension ${extension.commit}). ${REBUILD_ADVICE}`,
    }
  }
  return {
    consistent: true,
    reason: null,
    cli: cli.version,
    extension: extension.version,
    hint: null,
  }
}
