import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const pageScript = fileURLToPath(new URL('./verify-page.js', import.meta.url))
const workspace = `example-cli-smoke-${process.pid}`
const env = { ...process.env, AUTOBROWSER_WORKSPACE: workspace }

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

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
let primaryError
let cleanupError

try {
  const version = invoke(['version', '--json']).result
  assert(version.versionSkew?.consistent, 'CLI 与扩展版本或 commit 不一致')

  const status = invoke(['status', '--json'])
  assert(status.extensionConnected, 'Chrome 扩展未连接')

  const created = invoke(['tab', 'new', 'about:blank']).result
  tabHandle = created.tab?.handle
  assert(tabHandle, '新建标签页未返回 handle')

  const runResult = invoke(['--tab', tabHandle, 'run', pageScript, '--timeout-ms', '30000']).result
    .value
  assert(runResult.name === 'from-autobrowser', 'run 返回的输入值不正确')
  assert(runResult.counter === '1', 'run 返回的计数器不正确')
  assert(runResult.checks?.length === 3, 'run 的页面断言未全部执行')

  const counter = invoke([
    '--tab',
    tabHandle,
    'eval',
    '--expr',
    'document.querySelector("#counter").textContent',
  ]).result
  assert(counter === '1', 'run 结束后通过 eval 读取的状态不正确')

  console.log(
    JSON.stringify(
      {
        ok: true,
        cli: version.cli,
        extension: version.extension,
        tab: tabHandle,
        checks: ['version', 'connection', 'tab-new', ...runResult.checks, 'eval'],
      },
      null,
      2,
    ),
  )
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
}
