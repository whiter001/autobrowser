import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 随构建产物一起落盘的诊断元数据；CLI 与扩展共用同一结构，方便版本错配时直接对比 */
export interface BuildInfo {
  version: string
  buildTime: string
  commit: string | null
}

/** 版本号只从 package.json 取：CLI 与扩展的 manifest 必须同源，避免两边各写一份 */
export async function readPackageVersion(rootDir: string): Promise<string> {
  const { version } = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')) as {
    version: string
  }
  return version
}

/**
 * 读取短 git commit。发布到 npm 的包没有 .git，压缩包构建也可能缺少 git；
 * commit 只用于诊断同版本不同构建，取不到时返回 null，不能让构建失败。
 */
export function readGitCommit(rootDir: string): string | null {
  if (!existsSync(path.join(rootDir, '.git'))) {
    return null
  }
  try {
    return (
      execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim() || null
    )
  } catch {
    return null
  }
}

/** 构建时元数据；buildTime 由各构建脚本各自生成，CLI 与扩展不要求相等 */
export async function createBuildInfo(rootDir: string): Promise<BuildInfo> {
  return {
    version: await readPackageVersion(rootDir),
    buildTime: new Date().toISOString(),
    commit: readGitCommit(rootDir),
  }
}

/**
 * Chrome manifest.version 只接受数字段，无法表达 commit；version_name 是浏览器扩展页的
 * 展示标签，用它把「哪个版本、哪次构建」写进可读身份，同版本不同 commit 时一眼可辨。
 */
export function formatBuildVersionName(
  version: string,
  buildTime: string,
  commit: string | null,
): string {
  // ISO 时间转 UTC 紧凑格式：2026-11-15T02:13:16.789Z → 20261115T021316Z
  const stamp = new Date(buildTime)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
  return `${version}-dev.${stamp}${commit ? `+${commit}` : ''}`
}

/** 两个构建脚本共用同一写入格式，保证 dist/ 与 chrome/ 的 build-info.json 结构一致 */
export async function writeBuildInfoFile(dir: string, info: BuildInfo): Promise<void> {
  await writeFile(path.join(dir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8')
}
