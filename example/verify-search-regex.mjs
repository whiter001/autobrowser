import { spawnSync } from 'node:child_process'

const cli = process.platform === 'win32' ? 'autobrowser.exe' : 'autobrowser'
const env = { ...process.env, AUTOBROWSER_WORKSPACE: `example-search-regex-${process.pid}` }

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

const lines = [
  String.raw`Order #A-123 quote "double" 'single'`,
  String.raw`Path C:\temp\new-file.json`,
  String.raw`/api/v1/items?id=42`,
  String.raw`Price 12.50 USD`,
  String.raw`程序员的反脆弱`,
  String.raw`unrelated line`,
]
const pageSource = `async (page) => { await page.setContent(${JSON.stringify(`<pre>${lines.join('\n')}</pre>`)}) }`

let tabHandle
let summary
let primaryError
let cleanupError

try {
  tabHandle = invoke(['tab', 'new', 'about:blank']).result.tab?.handle
  if (!tabHandle) throw new Error('新建标签页未返回 handle')
  invoke(['--tab', tabHandle, 'run', '--stdin'], pageSource)

  // String.raw 保留反斜杠，参数数组避免 shell 再解释引号和转义。
  const cases = [
    {
      name: 'quotes-captures-backslashes',
      query: String.raw`/Order\s+#([A-Z])-(\d{3})\s+quote\s+"double"\s+'single'/`,
      expected: 'Order #A-123',
    },
    {
      name: 'windows-path',
      query: String.raw`/C:\\temp\\new-file\.json/`,
      expected: 'new-file.json',
    },
    {
      name: 'escaped-slashes-and-query',
      query: String.raw`/\/api\/v\d+\/items\?id=\d+/`,
      expected: '/api/v1/items?id=42',
    },
    {
      name: 'lookaheads-and-decimal',
      query: String.raw`/(?=.*\bUSD\b)(?=.*\d+\.\d{2}).*/`,
      expected: 'Price 12.50 USD',
    },
    {
      name: 'unicode-flag',
      query: String.raw`/反脆弱/u`,
      expected: '程序员的反脆弱',
    },
  ]

  const results = []
  for (const testCase of cases) {
    const result = invoke([
      '--tab',
      tabHandle,
      'search',
      testCase.query,
      '--context',
      '0',
      '--limit',
      '10',
    ]).result
    const matchedText = result.windows
      .flatMap((window) => window.lines.map((line) => line.text))
      .join('\n')
    assert(
      result.totalMatches >= 1 && matchedText.includes(testCase.expected),
      `${testCase.name} 未正确匹配：${JSON.stringify({ query: testCase.query, result })}`,
    )
    results.push({ name: testCase.name, query: testCase.query, totalMatches: result.totalMatches })
  }

  summary = { ok: true, tab: tabHandle, checks: cases.map((testCase) => testCase.name), results }
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
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
