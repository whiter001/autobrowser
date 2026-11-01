import type { ExtensionInfo } from './extension-control.js'

/**
 * 读取扩展页面暴露的构建信息（构建时间、commit），用于诊断 CLI 与扩展版本不一致。
 */
export async function readExtensionBuildInfo(
  url: string,
  fetchBuildInfo: (url: string) => Promise<Response> = fetch,
): Promise<Pick<ExtensionInfo, 'buildTime' | 'commit'>> {
  const fallback = { buildTime: null, commit: null }
  try {
    const response = await fetchBuildInfo(url)
    if (!response.ok) return fallback
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fallback
    const { buildTime, commit } = data as Record<string, unknown>
    return {
      buildTime:
        typeof buildTime === 'string' &&
        Number.isFinite(Date.parse(buildTime)) &&
        new Date(buildTime).toISOString() === buildTime
          ? buildTime
          : null,
      commit: typeof commit === 'string' && /^[a-f\d]{4,64}$/i.test(commit) ? commit : null,
    }
  } catch {
    // 旧构建可能没有此文件；查询信息不能因此失败。
    return fallback
  }
}
