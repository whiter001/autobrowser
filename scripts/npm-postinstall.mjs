// 全局安装优先用 Go 原生启动器替换 npm shim，避免 shell 再次解析参数。
// 仅缺少预编译产物等不适用情况回退到旧 Windows 修正；复制失败必须明确报错。
// 使用纯 Node，不要求 npm 安装期间已经有 Bun。
import { chmod, copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * npm 生成的 .cmd 里指向本包可执行文件的路径片段，用来确认这个 shim 确实属于本包。
 * 取 bin 目标路径而不是包名：包名带 scope 时形态不稳定，bin 目标才是稳定标识。
 */
export const PACKAGE_BIN_MARKER = 'dist\\autobrowser.js'

/** npm 为 bin 字段生成的 Windows 启动器文件名。 */
export const CMD_SHIM_NAME = 'autobrowser.cmd'

/** cmd.exe 的 PATHEXT 里 .BAT 排在 .CMD 前面，.bat 会优先于 .cmd 被解析。 */
export const BAT_SHIM_NAME = 'autobrowser.bat'

/**
 * 解析 npm 全局可执行文件目录。
 *
 * Windows 上 npm 把可执行文件直接放在 prefix 根目录，其他平台是 prefix/bin。
 *
 * npm 的 parseField 对 path 类型已经做过 resolve，正常情况下这里是绝对路径；
 * 但这里再做一次 resolve 兜底——postinstall 的 cwd 是包安装目录，万一某个 npm
 * 版本或调用方传进来相对路径，不解析就会把 shim 写到包目录里而不是全局 bin 目录。
 */
export function resolveGlobalBinDir(env, platform) {
  const prefix = env.npm_config_prefix
  if (!prefix) return null
  return platform === 'win32' ? path.resolve(prefix) : path.resolve(prefix, 'bin')
}

/**
 * 判断一份 .cmd 内容是不是 npm 为本包生成的 shim。
 *
 * npm 的 shim 里本包可执行文件总是以「<包目录>\dist\autobrowser.js」结尾，后面紧跟
 * 空白、引号或行尾。用路径段边界匹配，避免把 dist\autobrowser.js.backup 或嵌套在
 * 更长文件名里的同名片段误认成本包 shim。
 */
export function looksLikePackageCmdShim(content, marker = PACKAGE_BIN_MARKER) {
  if (!content) return false
  const normalized = content.replace(/\//g, '\\').toLowerCase()
  const m = marker.toLowerCase()
  let idx = normalized.indexOf(m)
  while (idx !== -1) {
    const after = normalized[idx + m.length]
    // marker 后面必须是路径结束（空白、引号、行尾），不能是 .backup 这类后缀。
    if (after === undefined || /[\s"'`]/.test(after)) return true
    idx = normalized.indexOf(m, idx + 1)
  }
  return false
}

/**
 * 决定要不要动某个 .cmd，以及怎么动。返回 skip 时不做任何写入。
 *
 * 只有同时满足下面两条才会改名：
 *   - 这次是全局安装（npm_config_global），本地安装不该动全局目录；
 *   - 目标 .cmd 确实是 npm 为本包生成的 shim。
 */
export function planCmdShimRename({
  platform,
  env,
  cmdContent,
  cmdExists,
  marker = PACKAGE_BIN_MARKER,
}) {
  if (platform !== 'win32') return { action: 'skip', reason: 'not-windows' }
  if (env.npm_config_global !== 'true') return { action: 'skip', reason: 'not-global-install' }
  const binDir = resolveGlobalBinDir(env, platform)
  if (!binDir) return { action: 'skip', reason: 'no-global-prefix' }
  if (!cmdExists) return { action: 'skip', reason: 'no-cmd-shim' }
  if (!looksLikePackageCmdShim(cmdContent, marker))
    return { action: 'skip', reason: 'foreign-cmd-shim' }
  return { action: 'rename', reason: 'npm-cmd-shim-mangles-args', binDir }
}

/**
 * 执行改名：先把 .cmd 的内容原样写到 .bat，再删掉 .cmd。
 * 两步分开是为了在写 .bat 失败时保留 .cmd，不至于让 cmd.exe 用户直接没有入口。
 */
export async function applyCmdShimRename({ cmdPath, batPath, cmdContent }) {
  await writeFile(batPath, cmdContent, 'utf8')
  await rm(cmdPath, { force: true })
}

/**
 * 修正流程入口。只处理 Windows 全局安装，其余情况静默跳过。
 * 任何一步失败都不应该让 npm 安装失败，因此这里吞掉异常并返回失败原因。
 */
export async function fixWindowsCmdShim({
  platform = process.platform,
  env = process.env,
  binDir = resolveGlobalBinDir(env, platform),
  marker = PACKAGE_BIN_MARKER,
  logger = console,
} = {}) {
  if (platform !== 'win32') return { applied: false, reason: 'not-windows' }

  const cmdPath = binDir ? path.join(binDir, CMD_SHIM_NAME) : null
  const batPath = binDir ? path.join(binDir, BAT_SHIM_NAME) : null
  if (!cmdPath || !batPath) return { applied: false, reason: 'no-global-prefix' }

  let cmdContent = ''
  let cmdExists = false
  try {
    cmdContent = await readFile(cmdPath, 'utf8')
    cmdExists = true
  } catch {
    cmdExists = false
  }

  const plan = planCmdShimRename({ platform, env, cmdContent, cmdExists, marker })
  if (plan.action !== 'rename') return { applied: false, reason: plan.reason }

  try {
    await applyCmdShimRename({ cmdPath, batPath, cmdContent })
  } catch (error) {
    logger.error?.(
      '[autobrowser] 修正 Windows 启动器失败：',
      error instanceof Error ? error.message : error,
    )
    return { applied: false, reason: 'write-failed' }
  }

  logger.log?.(
    `[autobrowser] 已把 npm 生成的 ${CMD_SHIM_NAME} 改名为 ${BAT_SHIM_NAME}：` +
      'PowerShell 调用 .cmd 时会先剥掉参数里的双引号，cmd.exe 再把裸露的 & | ^ 当成命令分隔符；.bat 与 .ps1 没有这个问题。',
  )
  return { applied: true, reason: plan.reason }
}

export function launcherFileName(platform, arch) {
  const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform]
  if (!goos || !['x64', 'arm64'].includes(arch)) return null
  return `autobrowser-${goos}-${arch}${platform === 'win32' ? '.exe' : ''}`
}

export async function installNativeLauncher({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  logger = console,
} = {}) {
  if (env.npm_config_global !== 'true') return { applied: false, reason: 'not-global-install' }
  const name = launcherFileName(platform, arch)
  if (!name) return { applied: false, reason: 'unsupported-platform' }
  const binDir = resolveGlobalBinDir(env, platform)
  if (!binDir) return { applied: false, reason: 'no-global-prefix' }
  const source = path.join(packageDir, 'launchers', name)
  const target = path.join(binDir, platform === 'win32' ? 'autobrowser.exe' : 'autobrowser')
  const temporary = `${target}.${process.pid}.tmp`
  try {
    try {
      if (!(await stat(source)).isFile()) throw new Error(`Launcher is not a file: ${source}`)
    } catch (error) {
      if (error.code === 'ENOENT') return { applied: false, reason: 'missing-launcher' }
      throw error
    }
    // 先写临时文件再替换，不能沿 POSIX npm symlink 覆盖包内 dist JS。
    await copyFile(source, temporary)
    await chmod(temporary, 0o755)
    await rename(temporary, target)
    const obsolete = ['autobrowser.cmd', 'autobrowser.bat', 'autobrowser.ps1', 'autobrowser.sh']
    if (platform === 'win32') obsolete.push('autobrowser')
    for (const shim of obsolete) await rm(path.join(binDir, shim), { force: true })
    logger.log?.(`[autobrowser] 已安装 Go 原生启动器：${target}（运行时仍需 Bun）`)
    return { applied: true, reason: 'native-launcher-installed' }
  } catch (error) {
    logger.error?.(
      `[autobrowser] 原生启动器安装失败：${source} -> ${target}；未回退到 shim。请检查目录权限，旧入口可能仍存在：`,
      error instanceof Error ? error.message : error,
    )
    return { applied: false, reason: 'native-install-failed' }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function installNpmLauncher(options = {}) {
  const native = await installNativeLauncher(options)
  if (native.applied || native.reason === 'native-install-failed') return native
  const fallback = await fixWindowsCmdShim(options)
  return { ...fallback, nativeReason: native.reason }
}

// 用 pathToFileURL 比较，避免 Windows file URL 斜杠差异。
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await installNpmLauncher()
}
