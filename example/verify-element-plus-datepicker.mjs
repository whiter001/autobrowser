import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-element-plus-date-${process.pid}` }
const pageUrl = 'https://element-plus.org/zh-CN/component/date-picker'
const panelScript = fileURLToPath(new URL('./element-plus-date-panel.js', import.meta.url))
const inputSelector = '.el-date-editor input'

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const invoke = (args, input) => {
  const child = spawnSync(cli, args, {
    env,
    input,
    encoding: 'utf8',
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
  tabHandle = invoke(['tab', 'new', 'about:blank']).result.tab?.handle
  assert(tabHandle, '新建标签页未返回 handle')
  invoke(['--tab', tabHandle, 'goto', pageUrl, '--wait-until', 'domcontentloaded'])
  invoke(['--tab', tabHandle, 'wait', '.el-date-editor', '--timeout-ms', '20000'])

  const typedDate = '2026-11-18'
  invoke(['--tab', tabHandle, 'click', inputSelector])
  invoke(['--tab', tabHandle, 'type', inputSelector, typedDate])
  invoke(['--tab', tabHandle, 'press', 'Enter'])
  const typedValue = invoke(['--tab', tabHandle, 'get', 'value', inputSelector]).result?.value
  assert(
    typedValue === typedDate,
    `文本输入日期不正确：${JSON.stringify({ typedDate, typedValue })}`,
  )

  // 文本输入和面板选择分开验证，避免 Enter 后面板关闭过渡影响下一次操作。
  invoke(['--tab', tabHandle, 'goto', pageUrl, '--wait-until', 'domcontentloaded'])
  invoke(['--tab', tabHandle, 'wait', '.el-date-editor', '--timeout-ms', '20000'])
  const panelDate = '2026-11-19'
  const panelValue = invoke(['--tab', tabHandle, 'run', panelScript, '--timeout-ms', '30000'])
    .result?.value
  assert(
    panelValue === panelDate,
    `面板选择日期不正确：${JSON.stringify({ panelDate, panelValue })}`,
  )

  summary = {
    ok: true,
    tab: tabHandle,
    checks: ['date-picker-type-and-enter', 'visible-panel-cell-selection'],
    typed: { expected: typedDate, value: typedValue },
    panel: { expected: panelDate, value: panelValue },
  }
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
