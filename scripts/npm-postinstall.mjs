// npm 全局安装后的 Windows 启动器修正。
//
// npm 会按 bin 字段生成三个 shim：autobrowser（sh）、autobrowser.cmd、autobrowser.ps1。
// 其中 autobrowser.cmd 用 %* 转发参数，而 PowerShell 调用 .cmd 时会先剥掉参数里的双引号，
// cmd.exe 再把裸露的 & | ^ < > 当成命令分隔符，于是 URL 查询串和 eval 源码会被拆成多条命令。
// 这不是 .cmd 内容能补救的：参数在批处理脚本体执行之前就已经被切碎了。
//
// .ps1 与 sh shim 没有这个问题——PowerShell 直接把参数数组交给进程，不经过 cmd.exe；
// cmd.exe 用户也没问题，cmd.exe 自己的解析会保护引号里的 & 。
//
// 所以这里把 npm 生成的 .cmd 改名成 .bat：
//   - PowerShell 解析同名命令时优先命中 autobrowser.ps1；
//   - cmd.exe 按 PATHEXT（.COM;.EXE;.BAT;.CMD）优先命中 autobrowser.bat；
//   - 危险的 autobrowser.cmd 不再存在，显式调用会直接报找不到命令，而不是静默改写参数。
//
// 脚本用纯 Node 写成，不依赖 bun：npm 安装时 bun 未必已经在 PATH 里，而 autobrowser
// 的可执行文件本身又要求 bun，这个修正步骤不该反过来把安装卡死。

import { readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

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
 * Windows 上 npm 把可执行文件直接放在 prefix 根目录，其他平台是 prefix/bin；
 * 这里只处理 Windows，因此返回 prefix 本身。
 */
export function resolveGlobalBinDir(env, platform) {
  if (platform !== 'win32') return null
  const prefix = env.npm_config_prefix
  if (!prefix) return null
  return prefix
}

/**
 * 判断一份 .cmd 内容是不是 npm 为本包生成的 shim。
 * 只认本包可执行文件路径片段，避免误伤同名但属于别的包的启动器。
 */
export function looksLikePackageCmdShim(content, marker = PACKAGE_BIN_MARKER) {
  if (!content) return false
  const normalized = content.replace(/\//g, '\\')
  return normalized.toLowerCase().includes(marker.toLowerCase())
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
export async function applyCmdShimRename(binDir, { cmdPath, batPath, cmdContent }) {
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

  const cmdPath = binDir ? `${binDir}\\${CMD_SHIM_NAME}` : null
  const batPath = binDir ? `${binDir}\\${BAT_SHIM_NAME}` : null
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
    await applyCmdShimRename(plan.binDir, { cmdPath, batPath, cmdContent })
  } catch (error) {
    logger.error?.(
      '[autobrowser] 修正 Windows 启动器失败：',
      error instanceof Error ? error.message : error,
    )
    return { applied: false, reason: 'write-failed' }
  }

  logger.log?.(
    `[autobrowser] 已把 npm 生成的 ${CMD_SHIM_NAME} 改名为 ${BAT_SHIM_NAME}：` +
      'cmd.exe 会解析 .cmd 并剥离参数引号，含 & | ^ 的参数会被拆开；.bat 与 .ps1 没有这个问题。',
  )
  return { applied: true, reason: plan.reason }
}

// 直接执行时（npm postinstall）才做修正，被 import 时只导出函数。
// 用 pathToFileURL 比较，手拼 file:// 在 Windows 上会少一个斜杠而永远不相等。
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await fixWindowsCmdShim()
}
