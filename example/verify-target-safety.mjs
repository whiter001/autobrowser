import { spawnSync } from 'node:child_process'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-target-safety-${process.pid}` }
const ownedTabs = new Set()

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const invoke = (args, input) => {
  const child = spawnSync(cli, args, {
    encoding: 'utf8',
    env,
    input,
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

const findTab = (handle) =>
  invoke(['tab', 'list', '--limit', '100']).result.tabs.find((tab) => tab.handle === handle)

let summary
let primaryError
let cleanupError

try {
  const original = invoke(['tab', 'new', 'about:blank']).result.tab?.handle
  assert(original, '原始测试标签未返回 handle')
  ownedTabs.add(original)

  invoke(
    ['--tab', original, 'run', '--stdin'],
    `async (page) => {
      await page.setContent('<title>target safety fixture</title><main data-fixture="preserved">safe</main>')
      return await page.title()
    }`,
  )
  const originalUrl = invoke(['--tab', original, 'get', 'url']).result.value

  const detached = invoke(['tab', 'detach', original]).result
  assert(detached.detached === true, 'detach 未确认成功')
  const detachedTab = findTab(original)
  assert(
    detachedTab?.workspace === null && detachedTab?.attachment === null,
    'detach 后仍绑定 workspace',
  )
  assert(detachedTab?.url === originalUrl, 'detach 改变了原页面 URL')

  const opened = invoke(['--no-auto-attach', 'open', 'about:blank']).result
  const independent = opened.meta?.target?.handle ?? `t${opened.tabId}`
  assert(independent && independent !== original, '--no-auto-attach 未创建独立标签')
  assert(opened.meta?.autoAttached !== true, '--no-auto-attach 仍自动认领了标签')
  ownedTabs.add(independent)
  assert(findTab(original)?.url === originalUrl, 'open 导航了已 detach 的原始标签')

  invoke(['tab', 'attach', original])
  const preserved = invoke([
    '--tab',
    original,
    'eval',
    '--expr',
    'document.querySelector("main")?.dataset.fixture',
  ]).result
  assert(preserved === 'preserved', 'detach/attach 后原页面 DOM 状态未保留')

  summary = {
    ok: true,
    original,
    independent,
    checks: ['no-auto-attach-new-tab', 'detach-preserves-url-and-dom', 'explicit-reattach'],
  }
} catch (error) {
  primaryError = error
} finally {
  for (const handle of ownedTabs) {
    try {
      const tab = findTab(handle)
      if (!tab) continue
      if (tab.workspace === null) invoke(['tab', 'attach', handle])
      invoke(['tab', 'close', handle])
    } catch (error) {
      cleanupError ??= error
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
        ownedTabs: [...ownedTabs],
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
} else {
  console.log(JSON.stringify(summary, null, 2))
}
