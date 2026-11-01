import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildSystemOpenCommand,
  detectBrowserProfileLock,
  parseWindowsNetstatListeningPid,
} from '../src/cli.js'
import {
  parseFindArgs,
  parseNetworkHarStartArgs,
  parseNetworkRequestsArgs,
  parseNetworkRouteArgs,
  parseScreenshotArgs,
  parseSearchArgs,
  parseWaitArgs,
} from '../src/cli/parse.js'
import { runCli } from './command-line-test-utils.js'

describe('cli helpers', () => {
  test('uses rundll32 on windows for system url opens', () => {
    expect(
      buildSystemOpenCommand(
        'win32',
        'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=a&relayPort=1&ipcPort=2',
      ),
    ).toEqual({
      command: 'rundll32',
      args: [
        'url.dll,FileProtocolHandler',
        'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=a&relayPort=1&ipcPort=2',
      ],
    })
  })

  test('detects browser profile lock signatures in stderr', () => {
    expect(detectBrowserProfileLock('Opening in existing browser session.\n')).toBe(true)
    expect(detectBrowserProfileLock('ERROR: profile is already in use')).toBe(true)
    expect(detectBrowserProfileLock('user data directory is already in use')).toBe(true)
    expect(detectBrowserProfileLock('')).toBe(false)
    expect(detectBrowserProfileLock('DevTools listening on ws://127.0.0.1:9222')).toBe(false)
  })

  test('parses the exact listening pid from netstat output', () => {
    const stdout = [
      '  TCP    0.0.0.0:57978    0.0.0.0:0     LISTENING       12345',
      '  TCP    0.0.0.0:579780   0.0.0.0:0     LISTENING       54321',
    ].join('\n')

    expect(parseWindowsNetstatListeningPid(stdout, 57978)).toBe(12345)
  })

  test('parses wait time aliases as milliseconds', () => {
    expect(parseWaitArgs(['time', '3'])).toMatchObject({
      type: 'time',
      ms: 3,
      timeout: 30000,
    })

    expect(parseWaitArgs(['3'])).toMatchObject({
      type: 'time',
      ms: 3,
      timeout: 30000,
    })
  })

  test('rejects invalid wait durations', () => {
    expect(() => parseWaitArgs(['--timeout', 'soon'])).toThrow('invalid timeout')
    expect(() => parseWaitArgs(['--ms', ''])).toThrow('invalid ms')
    expect(() => parseWaitArgs(['time'])).toThrow('missing wait time value')
  })

  test('parses --gone as a text-gone wait modifier', () => {
    expect(parseWaitArgs(['--text', 'Loading', '--gone'])).toMatchObject({
      type: 'text',
      text: 'Loading',
      gone: true,
    })
  })

  test('rejects --gone without a text wait', () => {
    expect(() => parseWaitArgs(['#spinner', '--gone'])).toThrow('--gone requires --text')
  })

  test('treats find content values by presence so clearing a field is expressible', () => {
    expect(parseFindArgs(['text', 'Search', 'fill', ''])).toMatchObject({
      strategy: 'text',
      query: 'Search',
      action: 'fill',
      value: '',
    })
    expect(parseFindArgs(['label', 'Email', 'type', ' '])).toMatchObject({
      strategy: 'label',
      query: 'Email',
      action: 'type',
      value: ' ',
    })
    expect(parseFindArgs(['role', 'button', 'fill', 'a b c'])).toMatchObject({
      strategy: 'role',
      role: 'button',
      action: 'fill',
      value: 'a b c',
    })
    // 定位符与参数缺失仍然报错
    expect(() => parseFindArgs(['text', 'Search', 'fill'])).toThrow('missing value for find fill')
    expect(() => parseFindArgs(['text'])).toThrow('missing text value')
    expect(() => parseFindArgs(['text', 'Search', 'fill', '', '--position', 'middle'])).toThrow(
      'unsupported find position',
    )
  })

  test('parses screenshot element targets from flags and positionals', () => {
    expect(parseScreenshotArgs(['--element', '#card'])).toMatchObject({
      element: '#card',
      path: null,
    })
    expect(parseScreenshotArgs(['@e3#p1'])).toMatchObject({
      element: '@e3#p1',
      path: null,
    })
    expect(parseScreenshotArgs(['out.png', '#card'])).toMatchObject({
      path: 'out.png',
      element: '#card',
    })
  })

  test('rejects screenshot element targets combined with --full', () => {
    expect(() => parseScreenshotArgs(['--element', '#card', '--full'])).toThrow(
      'cannot be combined',
    )
  })

  test('documents wait durations as milliseconds in help output', async () => {
    const result = await runCli(['help', 'wait'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stdout).toContain('time <ms>')
    expect(result.stdout).toContain('fixed duration in milliseconds')
    expect(result.stdout).toContain('--ms <ms> wait a fixed duration in milliseconds')
  })

  test('documents root server ports in help output', async () => {
    const result = await runCli(['help'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stdout).toContain('--relay-port <port>')
    expect(result.stdout).toContain('--ipc-port <port>')
    expect(result.stdout).toContain('--tab <tN|id>')
    expect(result.stdout).toContain('--frame <@fN|selector>')
    expect(result.stdout).toContain('--extension-id <id>')
    expect(result.stdout).toContain('--browser-command <command>')
    expect(result.stdout).toContain('--browser-arg <arg>')
  })

  test('documents tab, find, and get help output', async () => {
    const tabHelp = await runCli(['help', 'tab'])
    expect(tabHelp.exitCode).toBe(0)
    expect(tabHelp.stdout).toContain('autobrowser tab new [url]')
    expect(tabHelp.stdout).toContain('autobrowser tab close [tN]')

    const findHelp = await runCli(['help', 'find'])
    expect(findHelp.exitCode).toBe(0)
    expect(findHelp.stdout).toContain(
      'autobrowser find <role|text|label|placeholder|alt|title|test-id|exact-name> <query> [locate|click|fill|type|hover|focus|check|uncheck|text] [value]',
    )
    expect(findHelp.stdout).toContain('--name <name>')
    expect(findHelp.stdout).toContain('--exact')
    expect(findHelp.stdout).toContain('--position <first|last|nth=N>')
    expect(findHelp.stdout).toContain('--candidates <n>')

    const getHelp = await runCli(['help', 'get'])
    expect(getHelp.exitCode).toBe(0)
    expect(getHelp.stdout).toContain('autobrowser get <attribute> [selector]')
    expect(getHelp.stdout).toContain(
      'title, url, and cdp-url read the current page and ignore selector',
    )
    expect(getHelp.stdout).toContain('other attribute names are passed through to the page element')
  })

  test('documents search help output', async () => {
    const result = await runCli(['help', 'search'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'autobrowser search <query|/regex/flags> [--context <n>] [--limit <n>]',
    )
    expect(result.stdout).toContain('--context <n>')
    expect(result.stdout).toContain('--limit <n>')
  })

  test('documents eval help for timeout and complex script input', async () => {
    const result = await runCli(['help', 'eval'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stdout).toContain(
      'autobrowser eval [--stdin|--file <path>|--base64] [--timeout-ms <ms>] [--max-result-bytes <n>] [--element <selector>] [--expr] <script>',
    )
    expect(result.stdout).toContain('--max-result-bytes <n>')
    expect(result.stdout).toContain('--element <selector>')
    expect(result.stdout).toContain('--expr <script>')
    expect(result.stdout).toContain('--timeout-ms <ms>')
    expect(result.stdout).toContain('--file <path>  read complex or multiline script source')
    expect(result.stdout).toContain('--stdin  read complex or multiline script source')
    expect(result.stdout).toContain('split work into smaller browser commands or script steps')
  })

  test('routes eval source, timeout and optional result size limit', async () => {
    const script = 'JSON.stringify({ marker: "document", title: document.title })'
    const result = await runCli([
      'eval',
      '--expr',
      script,
      '--timeout-ms',
      '5000',
      '--max-result-bytes',
      '1024',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'eval',
      args: { script, timeoutMs: 5000, maxResultBytes: 1024 },
    })

    const missing = await runCli(['eval', '--expr'])
    expect(missing.exitCode).toBe(1)
    expect(missing.fetchCalls).toHaveLength(0)
    expect(missing.stderr).toContain('missing value for --expr')
  })

  test('routes CDP JSON params and rejects non-object payloads', async () => {
    const positional = await runCli([
      'cdp',
      'Runtime.evaluate',
      '{"expression":"6 * 7","returnByValue":true}',
    ])
    expect(positional.exitCode).toBe(0)
    expect(positional.fetchCalls[0].body).toEqual({
      command: 'cdp',
      args: { method: 'Runtime.evaluate', params: { expression: '6 * 7', returnByValue: true } },
    })

    const flagged = await runCli(['cdp', 'Page.getLayoutMetrics', '--params', '{}'])
    expect(flagged.exitCode).toBe(0)
    expect(flagged.fetchCalls[0].body?.args).toEqual({
      method: 'Page.getLayoutMetrics',
      params: {},
    })

    const invalid = await runCli(['cdp', 'Runtime.evaluate', '[]'])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.fetchCalls).toHaveLength(0)
    expect(invalid.stderr).toContain('CDP params must be a JSON object')
  })

  test('routes WebMCP discovery and object args with strict input validation', async () => {
    const listed = await runCli(['webmcp', 'list'])
    expect(listed.fetchCalls[0].body).toEqual({ command: 'webmcp', args: { action: 'list' } })
    const called = await runCli(['webmcp', 'call', 'lookup', '--params', '{"id":42}'])
    expect(called.fetchCalls[0].body).toEqual({
      command: 'webmcp',
      args: { action: 'call', name: 'lookup', args: { id: 42 } },
    })
    const invalid = await runCli(['webmcp', 'call', 'lookup', '[]'])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.fetchCalls).toHaveLength(0)
    expect(invalid.stderr).toContain('WebMCP args must be a JSON object')
  })

  test('routes feed collect with virtual-list limits and dedupe options', async () => {
    const result = await runCli([
      'feed',
      'collect',
      'article',
      '--limit',
      '30',
      '--dedupe',
      'url',
      '--max-scrolls',
      '10',
      '--pause-ms',
      '100',
      '--stall-rounds',
      '2',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'feed',
      args: {
        selector: 'article',
        limit: 30,
        dedupe: 'url',
        maxScrolls: 10,
        pauseMs: 100,
        stallRounds: 2,
      },
    })
  })

  test('collect run executes a network-first spec and writes JSONL through the CLI', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-collect-cli-'))
    const specPath = path.join(directory, 'task.json')
    await writeFile(
      specPath,
      JSON.stringify({
        name: 'cli-api',
        mode: 'network',
        startUrl: 'https://example.com',
        output: 'items.jsonl',
        network: { urlPattern: '/api/items', itemsPath: 'data.items' },
      }),
    )
    const result = await runCli(['collect', 'run', specPath], undefined, {
      fetchImpl: async (_url, init = {}) => {
        const { command, args } = JSON.parse(String(init.body))
        if (command === 'goto') return Response.json({ ok: true, result: { url: args.url } })
        if (command === 'network' && args.action === 'requests') {
          return Response.json({ ok: true, result: { requests: [{ id: 'r1' }] } })
        }
        if (command === 'network' && args.action === 'request') {
          return Response.json({
            ok: true,
            result: {
              request: {
                responseBody: JSON.stringify({ data: { items: [{ id: 42 }] } }),
                pageEpoch: 2,
              },
            },
          })
        }
        throw new Error(`unexpected command ${command}`)
      },
    })
    expect(result.exitCode).toBe(0)
    const item = JSON.parse((await readFile(path.join(directory, 'items.jsonl'), 'utf8')).trim())
    expect(item).toMatchObject({ id: 42, _meta: { task: 'cli-api', mode: 'network' } })
    expect(JSON.parse(result.stdout).result).toMatchObject({ status: 'completed', itemCount: 1 })
  })

  test('routes coordinate mouse commands and file/text drops', async () => {
    const move = await runCli(['mousemove', '15', '25'])
    expect(move.fetchCalls[0].body).toEqual({ command: 'mousemove', args: { x: 15, y: 25 } })
    const down = await runCli(['mousedown', 'right'])
    expect(down.fetchCalls[0].body).toEqual({ command: 'mousedown', args: { button: 'right' } })
    const wheel = await runCli(['mousewheel', '0', '100'])
    expect(wheel.fetchCalls[0].body).toEqual({
      command: 'mousewheel',
      args: { deltaX: 0, deltaY: 100 },
    })
    const up = await runCli(['mouseup'])
    expect(up.fetchCalls[0].body).toEqual({ command: 'mouseup', args: { button: 'left' } })

    const textDrop = await runCli(['drop', '#target', '--data', 'text/plain=hello'])
    expect(textDrop.fetchCalls[0].body).toEqual({
      command: 'drop',
      args: { selector: '#target', data: { 'text/plain': 'hello' }, files: [] },
    })
    const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-drop-'))
    const filePath = path.join(dir, 'note.txt')
    await writeFile(filePath, 'file contents')
    const fileDrop = await runCli(['drop', '#target', `--path=${filePath}`])
    expect(fileDrop.fetchCalls[0].body?.args?.files).toEqual([
      {
        name: 'note.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from('file contents').toString('base64'),
      },
    ])
  })

  test('routes element eval, locator and highlight commands', async () => {
    const evalResult = await runCli(['eval', '--element', '@e1', '--expr', 'el => el.textContent'])
    expect(evalResult.fetchCalls[0].body).toEqual({
      command: 'eval',
      args: { script: 'el => el.textContent', element: '@e1' },
    })
    const locator = await runCli(['generate-locator', '@e1'])
    expect(locator.fetchCalls[0].body).toEqual({ command: 'locator', args: { selector: '@e1' } })
    const highlight = await runCli(['highlight', '@e1', '--style', '2px dashed red'])
    expect(highlight.fetchCalls[0].body).toEqual({
      command: 'highlight',
      args: { selector: '@e1', style: '2px dashed red' },
    })
    const clear = await runCli(['highlight', '--hide'])
    expect(clear.fetchCalls[0].body).toEqual({ command: 'highlight', args: { hide: true } })
  })

  test('routes media features and device presets with independent resets', async () => {
    const cases: [string[], { type: string; value: string }][] = [
      [['set', 'media-type', 'print'], { type: 'media-type', value: 'print' }],
      [['set', 'reduced-motion', 'reduce'], { type: 'reduced-motion', value: 'reduce' }],
      [['set', 'forced-colors', '--reset'], { type: 'forced-colors', value: '' }],
      [['set', 'contrast', 'more'], { type: 'contrast', value: 'more' }],
      [['set', 'device', 'iphone-15'], { type: 'device', value: 'iphone-15' }],
      [['set', 'device', '--reset'], { type: 'device', value: '' }],
    ]

    for (const [args, expected] of cases) {
      const result = await runCli(args)
      expect(result.exitCode).toBe(0)
      expect(result.fetchCalls[0].body).toEqual({ command: 'set', args: expected })
    }
  })

  test('routes tracing, action log and automatic snapshot controls', async () => {
    const start = await runCli(['tracing', 'start'])
    expect(start.fetchCalls[0].body).toEqual({ command: 'tracing', args: { action: 'start' } })
    const actions = await runCli(['actions', 'clear'])
    expect(actions.fetchCalls[0].body).toEqual({ command: 'actions', args: { action: 'clear' } })
    const automatic = await runCli(['set', 'auto-snapshot', 'on'])
    expect(automatic.fetchCalls[0].body).toEqual({
      command: 'set',
      args: { type: 'auto-snapshot', enabled: true },
    })

    const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-trace-cli-'))
    const output = path.join(dir, 'trace.json')
    const stopped = await runCli(['tracing', 'stop', output], {
      ok: true,
      result: { recording: false, data: '{"events":[]}', base64Encoded: false, bytes: 12 },
    })
    expect(stopped.exitCode).toBe(0)
    expect(JSON.parse(stopped.stdout).result.path).toBe(output)
    expect(await readFile(output, 'utf8')).toBe('{"events":[]}')
  })

  test('routes video lifecycle and writes WebM with chapter sidecar', async () => {
    const started = await runCli(['video', 'start', '--max-duration-ms', '1000'])
    expect(started.fetchCalls[0].body).toEqual({
      command: 'video',
      args: { action: 'start', maxDurationMs: 1000 },
    })
    const chapter = await runCli([
      'video',
      'chapter',
      'One',
      '--description',
      'Details',
      '--duration',
      '500',
    ])
    expect(chapter.fetchCalls[0].body?.args).toEqual({
      action: 'chapter',
      title: 'One',
      description: 'Details',
      durationMs: 500,
    })
    const callouts = await runCli([
      'video',
      'show-actions',
      '--duration',
      '600',
      '--highlight-style',
      '2px solid red',
    ])
    expect(callouts.fetchCalls[0].body?.args).toEqual({
      action: 'show-actions',
      durationMs: 600,
      highlightStyle: '2px solid red',
    })

    const dir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-video-cli-'))
    const output = path.join(dir, 'capture.webm')
    const stopped = await runCli(['video', 'stop', output], {
      ok: true,
      result: {
        recording: false,
        data: Buffer.from('video').toString('base64'),
        bytes: 5,
        chapters: [{ title: 'One' }],
      },
    })
    expect(stopped.exitCode).toBe(0)
    expect(JSON.parse(stopped.stdout).result.path).toBe(output)
    expect(JSON.parse(stopped.stdout).result.chaptersPath).toBe(
      path.join(dir, 'capture.chapters.json'),
    )
    expect((await readFile(output)).toString()).toBe('video')
    expect(JSON.parse(await readFile(path.join(dir, 'capture.chapters.json'), 'utf8'))).toEqual([
      { title: 'One' },
    ])
  })

  test('documents configurable HAR limits in help output', async () => {
    const result = await runCli(['help', 'network', 'har', 'start'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--har-max-requests <n>')
    expect(result.stdout).toContain('--har-max-body-bytes <n>')
    expect(result.stdout).toContain('--har-unlimited')
  })

  test('parses HAR capture limits for network har start', () => {
    expect(parseNetworkHarStartArgs(['--har-unlimited'])).toEqual({
      maxRequests: null,
      maxBodyBytes: null,
    })

    expect(
      parseNetworkHarStartArgs([
        '--har-max-requests',
        '5000',
        '--har-max-body-bytes',
        '1048576',
        '--include-pattern',
        'video.twimg.com',
        '--exclude-pattern',
        '/audio/',
      ]),
    ).toEqual({
      maxRequests: 5000,
      maxBodyBytes: 1048576,
      includePattern: 'video.twimg.com',
      excludePattern: '/audio/',
    })
  })

  test('parses search arguments with defaults', () => {
    expect(parseSearchArgs(['Sign in'])).toEqual({ query: 'Sign in', context: 3, limit: 20 })
    expect(parseSearchArgs(['/foo/i', '--context', '5', '--limit', '2'])).toEqual({
      query: '/foo/i',
      context: 5,
      limit: 2,
    })
    expect(() => parseSearchArgs([])).toThrow('missing search query')
    expect(() => parseSearchArgs(['x', '--bogus'])).toThrow('unsupported search option: --bogus')
    expect(() => parseSearchArgs(['x', 'extra'])).toThrow('unexpected extra search argument: extra')
  })

  test('rejects unsupported network request filter flags', () => {
    // '--filtter' 是故意拼错的 flag，用于验证未知选项会被拒绝
    expect(() => parseNetworkRequestsArgs(['--filtter', 'api'])).toThrow(
      'unsupported network option: --filtter',
    )
  })

  test('rejects unknown global flags before the command name', async () => {
    // '--selecor' 是故意拼错的 flag；放在命令名前必须直接报错而不是被当成命令/位置参数
    const result = await runCli(['--selecor', '#submit', 'click'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('unsupported global option: --selecor')
    expect(result.stderr).toContain('--tab')
    expect(result.stderr).toContain('--ipc-port')
  })

  test('rejects unsupported network har start flags', () => {
    expect(() => parseNetworkHarStartArgs(['--har-max-request', '10'])).toThrow(
      'unsupported network option: --har-max-request',
    )
    expect(() => parseNetworkHarStartArgs(['extra'])).toThrow(
      'unexpected extra network argument: extra',
    )
  })

  test('rejects unsupported network har start flags before dispatching commands', async () => {
    const result = await runCli(['network', 'har', 'start', '--har-max-request', '10'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('unsupported network option: --har-max-request')
  })

  test('rejects unsupported network route arguments', () => {
    expect(() => parseNetworkRouteArgs(['**/api/*', '--bogus'])).toThrow(
      'unsupported network option: --bogus',
    )
    expect(() => parseNetworkRouteArgs(['**/api/*', '**/other/*'])).toThrow(
      'unexpected extra network argument: **/other/*',
    )
  })

  test('rejects unsupported wait --load values', () => {
    expect(parseWaitArgs(['--load'])).toMatchObject({ type: 'networkidle' })
    expect(parseWaitArgs(['--load', 'load'])).toMatchObject({ type: 'load' })
    expect(parseWaitArgs(['--load', 'networkidle'])).toMatchObject({ type: 'networkidle' })
    expect(() => parseWaitArgs(['--load', 'interactive'])).toThrow(
      'unsupported --load value: interactive',
    )
  })

  test('rejects missing global flag values before dispatching commands', async () => {
    const result = await runCli(['click', '--tab'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('missing value for --tab')
  })

  test('rejects invalid global port values before dispatching commands', async () => {
    for (const portValue of ['not-a-port', '0', '65536']) {
      const result = await runCli(['--ipc-port', portValue, 'status'])

      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(result.stderr).toContain('invalid --ipc-port')
    }
  })

  test('rejects invalid numeric command values before dispatching commands', async () => {
    const cases = [
      { argv: ['wait', '--ms', 'soon'], message: 'invalid ms' },
      {
        argv: ['screenshot', '--screenshot-quality', '101'],
        message: 'invalid screenshot quality',
      },
      { argv: ['set', 'viewport', 'wide'], message: 'invalid viewport width' },
      { argv: ['set', 'geo', '91', '0'], message: 'invalid latitude' },
      { argv: ['scroll', '#main', 'left'], message: 'invalid scroll deltaX' },
    ]

    for (const testCase of cases) {
      const result = await runCli(testCase.argv)

      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(result.stderr).toContain(testCase.message)
    }
  })

  test('rejects usage errors instead of silently succeeding', async () => {
    const cases = [
      { argv: ['click'], message: 'missing value for click' },
      { argv: ['cookies', 'invalid-action'], message: 'unsupported cookies action' },
      { argv: ['click', '#field', 'extra'], message: 'unexpected extra argument' },
      { argv: ['back', 'extra'], message: 'unexpected argument for back' },
      { argv: ['screenshot', '--formt', 'jpeg'], message: 'unsupported screenshot option' },
      { argv: ['wait', '#field', '--bogus'], message: 'unsupported wait option' },
      {
        argv: ['wait', '--text', 'a', '--url', 'b'],
        message: 'wait modes cannot be combined',
      },
      { argv: ['tab', 'list', '--filter'], message: 'missing value for --filter' },
      { argv: ['reload', '--wait-until'], message: 'reload --wait-until must be' },
      {
        argv: ['eval', '--file', 'script.js', '--stdin'],
        message: '--stdin, --file, and --base64 cannot be combined',
      },
    ]

    for (const testCase of cases) {
      const result = await runCli(testCase.argv)
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(result.stderr).toContain(testCase.message)
    }
  })

  test('passes flag-shaped text literally after a separator', async () => {
    const typed = await runCli(['type', '#field', '--', '--submit'])
    expect(typed.exitCode).toBe(0)
    expect(typed.fetchCalls[0].body).toEqual({
      command: 'type',
      args: { selector: '#field', value: '--submit' },
    })

    const stored = await runCli(['storage', 'set', 'flag', '--', '--session'])
    expect(stored.exitCode).toBe(0)
    expect(stored.fetchCalls[0].body).toEqual({
      command: 'storage',
      args: { action: 'set', key: 'flag', value: '--session' },
    })
  })

  test('rejects unsupported network request flags before dispatching commands', async () => {
    const result = await runCli(['network', 'requests', '--filtter', 'api'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toContain('unsupported network option: --filtter')
  })

  test('forwards console and errors pagination flags to the extension', async () => {
    const consoleResult = await runCli(['console', '--page-idx', '2', '--page-size', '10'])
    expect(consoleResult.exitCode).toBe(0)
    expect(consoleResult.fetchCalls[0].body).toEqual({
      command: 'console',
      args: { action: 'list', pageIdx: 2, pageSize: 10 },
    })

    const errorsResult = await runCli(['errors', '--page-idx', '0', '--page-size', '25'])
    expect(errorsResult.exitCode).toBe(0)
    expect(errorsResult.fetchCalls[0].body).toEqual({
      command: 'errors',
      args: { action: 'list', pageIdx: 0, pageSize: 25 },
    })

    // 不带分页参数时仍显式传 list，便于扩展区分 clear
    const bareErrors = await runCli(['errors'])
    expect(bareErrors.fetchCalls[0].body).toEqual({ command: 'errors', args: { action: 'list' } })
  })

  test('accepts the page alias and routes current-epoch log clearing', async () => {
    const paged = await runCli(['console', '--page', '3', '--all-epochs'])
    expect(paged.fetchCalls[0].body).toEqual({
      command: 'console',
      args: { action: 'list', pageIdx: 3, allEpochs: true },
    })
    const cleared = await runCli(['errors', 'clear'])
    expect(cleared.fetchCalls[0].body).toEqual({
      command: 'errors',
      args: { action: 'clear' },
    })
  })

  test('routes explicit recovery controls without page commands', async () => {
    const target = await runCli(['target', 'clear'])
    expect(target.fetchCalls[0].body).toEqual({
      command: 'target',
      args: { action: 'clear' },
    })
    const cancel = await runCli(['command', 'cancel', 'cmd_1'])
    expect(cancel.fetchCalls[0].body).toEqual({
      command: 'command',
      args: { action: 'cancel', commandId: 'cmd_1' },
    })
  })

  test('forwards network requests pagination flags and rejects out-of-range values', async () => {
    const result = await runCli([
      'network',
      'requests',
      '--filter',
      '/api/',
      '--page-idx',
      '1',
      '--page-size',
      '100',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: { action: 'requests', filter: '/api/', pageIdx: 1, pageSize: 100 },
    })

    const oversized = await runCli(['console', '--page-size', '201'])
    expect(oversized.exitCode).toBe(1)
    expect(oversized.fetchCalls).toHaveLength(0)
    expect(oversized.stderr).toContain('invalid page size')

    const negative = await runCli(['console', '--page-idx', '-1'])
    expect(negative.exitCode).toBe(1)
    expect(negative.fetchCalls).toHaveLength(0)
    expect(negative.stderr).toContain('invalid page idx')
  })

  test('routes HAR start limits and capture filters to the extension', async () => {
    const result = await runCli([
      'network',
      'har',
      'start',
      '--har-unlimited',
      '--exclude-pattern',
      '/audio/',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'har',
        subaction: 'start',
        maxRequests: null,
        maxBodyBytes: null,
        excludePattern: '/audio/',
      },
    })
  })
})
