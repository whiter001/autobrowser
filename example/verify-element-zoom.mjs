import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const pageScript = fileURLToPath(new URL('./element-zoom.js', import.meta.url))
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-element-zoom-${process.pid}` }

const invoke = (args) => {
  const child = spawnSync(cli, args, {
    encoding: 'utf8',
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 45_000,
  })
  if (child.error) throw child.error

  let output
  try {
    output = JSON.parse(child.stdout)
  } catch {
    throw new Error(`CLI 未返回 JSON：${child.stdout || child.stderr}`)
  }
  if (child.status !== 0 || output.ok === false) {
    throw new Error(`${args.join(' ')} 失败：${JSON.stringify(output.error ?? output)}`)
  }
  return output
}

let tabHandle
let summary
let primaryError
let cleanupError

try {
  // 页面脚本会写入测试 DOM，因此只在独立临时标签中运行。
  tabHandle = invoke(['tab', 'new', 'about:blank']).result.tab?.handle
  if (!tabHandle) throw new Error('新建标签页未返回 handle')

  const result = invoke(['--tab', tabHandle, 'run', pageScript, '--timeout-ms', '30000']).result
    .value
  for (const check of ['layout-zoom', 'zoomed-click', 'restore-style-and-size']) {
    if (!result.checks?.includes(check)) throw new Error(`缺少局部缩放断言：${check}`)
  }
  summary = { ok: true, tab: tabHandle, ...result }
} catch (error) {
  primaryError = error
} finally {
  if (tabHandle) {
    try {
      invoke(['tab', 'close', tabHandle])
    } catch (error) {
      cleanupError = error
    }
  }
}

if (primaryError || cleanupError) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: primaryError ? String(primaryError.message ?? primaryError) : null,
        cleanupError: cleanupError ? String(cleanupError.message ?? cleanupError) : null,
        tab: tabHandle,
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
} else {
  console.log(JSON.stringify(summary, null, 2))
}
