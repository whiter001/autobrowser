import { spawnSync } from 'node:child_process'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-checkbox-${process.pid}` }
const pageUrl = 'https://www.antdv.com/components/checkbox-cn'
// antd 的原生 input 是透明覆盖层（opacity:0），可见性等待用外层 .ant-checkbox
const wrapperSelector = '.ant-checkbox'
const inputSelector = '.ant-checkbox-input'

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

// check / uncheck 返回 { found, checked }；is checked 直接返回布尔值
const readChecked = (tabHandle) => invoke(['--tab', tabHandle, 'is', 'checked', inputSelector])

let tabHandle
let summary
let primaryError
let cleanupError

try {
  tabHandle = invoke(['tab', 'new', 'about:blank']).result.tab?.handle
  assert(tabHandle, '新建标签页未返回 handle')

  invoke(['--tab', tabHandle, 'goto', pageUrl, '--wait-until', 'domcontentloaded'])
  invoke(['--tab', tabHandle, 'wait', wrapperSelector, '--timeout-ms', '20000'])

  const initial = readChecked(tabHandle)
  assert(typeof initial === 'boolean', `初始状态读取失败：${JSON.stringify(initial)}`)

  const checked = invoke(['--tab', tabHandle, 'check', inputSelector]).result
  assert(checked.found === true, `check 未命中元素：${JSON.stringify(checked)}`)
  const checkedState = readChecked(tabHandle)
  assert(
    checked.checked === checkedState && checkedState === true,
    `勾选后返回值与实际状态不一致：${JSON.stringify({ checked, checkedState })}`,
  )

  const unchecked = invoke(['--tab', tabHandle, 'uncheck', inputSelector]).result
  assert(unchecked.found === true, `uncheck 未命中元素：${JSON.stringify(unchecked)}`)
  const uncheckedState = readChecked(tabHandle)
  assert(
    unchecked.checked === uncheckedState && uncheckedState === false,
    `取消勾选后返回值与实际状态不一致：${JSON.stringify({ unchecked, uncheckedState })}`,
  )

  summary = {
    ok: true,
    tab: tabHandle,
    checks: ['check-returns-settled-state', 'uncheck-returns-settled-state'],
    initial,
    checked: checked.checked,
    checkedState,
    unchecked: unchecked.checked,
    uncheckedState,
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
