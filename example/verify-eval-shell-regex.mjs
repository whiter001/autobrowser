import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-eval-shell-regex-${process.pid}` }
const bashScript = fileURLToPath(new URL('./eval-regex.sh', import.meta.url))
const pwshScript = fileURLToPath(new URL('./eval-regex.ps1', import.meta.url))

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

const assertResult = (shell, output) => {
  if (output.status !== 0) throw new Error(`${shell} 退出码 ${output.status}：${output.stderr}`)
  const payload = JSON.parse(output.stdout)
  if (!payload.ok) throw new Error(`${shell} eval 失败：${JSON.stringify(payload.error)}`)
  const result = payload.result
  for (const name of ['quotes', 'windowsPath', 'api', 'price', 'unicode']) {
    if (result[name]?.length !== 1) {
      throw new Error(`${shell} 的 ${name} 匹配数量不正确：${JSON.stringify(result)}`)
    }
  }
  return { shell, checks: Object.keys(result), result }
}

let tabHandle
let summary
let primaryError
let cleanupError

try {
  tabHandle = invoke(['tab', 'new', 'about:blank']).result.tab?.handle
  if (!tabHandle) throw new Error('新建标签页未返回 handle')

  const lines = [
    String.raw`Order #A-123 quote "double" 'single'`,
    String.raw`Path C:\temp\new-file.json`,
    String.raw`/api/v1/items?id=42`,
    String.raw`Price 12.50 USD`,
    String.raw`程序员的反脆弱`,
  ]
  invoke(
    ['--tab', tabHandle, 'run', '--stdin'],
    `async (page) => { await page.setContent(${JSON.stringify(`<pre>${lines.join('\n')}</pre>`)}) }`,
  )

  const results = [
    assertResult('bash', spawnSync('bash', [bashScript, tabHandle], { env, encoding: 'utf8' })),
  ]
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-File', pwshScript, tabHandle], {
    env,
    encoding: 'utf8',
  })
  if (pwsh.error?.code === 'ENOENT') {
    results.push({ shell: 'pwsh', skipped: 'pwsh 不在 PATH 中' })
  } else {
    results.push(assertResult('pwsh', pwsh))
  }
  summary = { ok: true, tab: tabHandle, results }
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
