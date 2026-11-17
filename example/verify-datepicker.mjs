import { spawnSync } from 'node:child_process'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-datepicker-${process.pid}` }
const pageUrl = 'https://www.antdv.com/components/date-picker-cn'
const inputSelector = '.ant-picker input'
const expectedDate = '2026-11-18'

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
let summary
let primaryError
let cleanupError

try {
  tabHandle = invoke(['tab', 'new', 'about:blank']).result.tab?.handle
  assert(tabHandle, '新建标签页未返回 handle')
  invoke(['--tab', tabHandle, 'goto', pageUrl, '--wait-until', 'domcontentloaded'])
  invoke(['--tab', tabHandle, 'wait', '.ant-picker', '--timeout-ms', '20000'])

  // DatePicker 支持文本录入，但需要真实逐键输入，不能用 fill 模拟。
  invoke(['--tab', tabHandle, 'click', inputSelector])
  invoke(['--tab', tabHandle, 'type', inputSelector, expectedDate])
  invoke(['--tab', tabHandle, 'press', 'Enter'])
  const value = invoke(['--tab', tabHandle, 'get', 'value', inputSelector]).result?.value
  assert(value === expectedDate, `手动输入日期未保留：${JSON.stringify({ expectedDate, value })}`)

  summary = {
    ok: true,
    tab: tabHandle,
    checks: ['date-picker-type-and-enter'],
    typedDate: expectedDate,
    value,
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
