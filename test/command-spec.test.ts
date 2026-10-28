import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import {
  COMMAND_SPECS,
  commandSupportsFrameTarget,
  commandSupportsTabTarget,
  getCommandSpec,
  validateCommandArgs,
} from '../src/core/command-spec.js'

const NON_AMBIENT_ROUTER_COMMANDS = new Set([
  'open',
  'batch',
  'script',
  'status',
  'tab.close',
  'tab.list',
  'tab.new',
  'tab.select',
  'downloads',
  'target',
  'command',
])

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function extractRouterCommands(source: string): string[] {
  return uniqueSorted([...source.matchAll(/case '([^']+)'/g)].map((match) => match[1]))
}

function extractCliForwardedCommands(source: string): string[] {
  const matches = source.matchAll(
    /(?:requestAndWrite\(context,\s*|context\.requestCommand\(context\.flags\.server,\s*|command:\s*)['"]([^'"]+)['"]/g,
  )
  return uniqueSorted([...matches].map((match) => match[1]))
}

async function readWorkspaceFile(relativePath: string): Promise<string> {
  return await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

async function readCliCommandSources(): Promise<string[]> {
  const commandsDir = new URL('../src/cli/commands/', import.meta.url)
  const entries = await readdir(commandsDir)
  return await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.ts') && !['index.ts', 'types.ts'].includes(entry))
      .map(async (entry) => await readFile(new URL(entry, commandsDir), 'utf8')),
  )
}

describe('command specs', () => {
  test('exposes target capabilities for page commands', () => {
    expect(commandSupportsTabTarget('click')).toBe(true)
    expect(commandSupportsFrameTarget('click')).toBe(true)
    expect(commandSupportsTabTarget('frame')).toBe(true)
    expect(commandSupportsFrameTarget('frame')).toBe(false)
    expect(commandSupportsTabTarget('feed')).toBe(true)
    expect(commandSupportsFrameTarget('feed')).toBe(true)
    expect(commandSupportsTabTarget('cdp')).toBe(true)
    expect(commandSupportsFrameTarget('cdp')).toBe(false)
    expect(commandSupportsFrameTarget('drop')).toBe(true)
    expect(commandSupportsFrameTarget('mousemove')).toBe(false)
    expect(commandSupportsFrameTarget('locator')).toBe(true)
    expect(commandSupportsFrameTarget('highlight')).toBe(true)
  })

  test('does not apply ambient page targets to tab management commands', () => {
    expect(getCommandSpec('tab.new')).toBeUndefined()
    expect(commandSupportsTabTarget('tab.select')).toBe(false)
    expect(commandSupportsFrameTarget('tab.close')).toBe(false)
  })

  test('keeps command names unique', () => {
    const names = COMMAND_SPECS.map((spec) => spec.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('keeps targetable command specs aligned with the extension router', async () => {
    const routerSource = await readWorkspaceFile('extension/background/command-router.ts')
    const routerCommands = extractRouterCommands(routerSource)
    const targetableRouterCommands = routerCommands.filter(
      (command) => !NON_AMBIENT_ROUTER_COMMANDS.has(command),
    )

    expect(COMMAND_SPECS.map((spec) => spec.name).sort()).toEqual(targetableRouterCommands)
  })

  test('keeps CLI forwarded commands supported by the extension router', async () => {
    const routerSource = await readWorkspaceFile('extension/background/command-router.ts')
    const routerCommands = new Set(extractRouterCommands(routerSource))
    const cliCommands = uniqueSorted(
      (await readCliCommandSources()).flatMap((source) => extractCliForwardedCommands(source)),
    )
    const missingRouterCommands = cliCommands.filter((command) => !routerCommands.has(command))

    expect(missingRouterCommands).toEqual([])
  })

  test('validates common command argument shapes', () => {
    expect(() => validateCommandArgs('goto', { url: 123 })).toThrow(
      'invalid command arguments for goto: url must be a string',
    )
    expect(() => validateCommandArgs('feed', { selector: 123 })).toThrow(
      'invalid command arguments for feed: selector must be a string',
    )
    expect(() => validateCommandArgs('feed', { limit: -1 })).toThrow(
      'invalid command arguments for feed: limit must be a non-negative integer',
    )
    expect(() => validateCommandArgs('feed', { dedupe: 'time' })).toThrow(
      'invalid command arguments for feed: dedupe must be url, text, or none',
    )
    expect(() =>
      validateCommandArgs('batch', { steps: [{ command: 'goto', args: { url: 123 } }] }),
    ).toThrow(
      'invalid command arguments for batch: step 1: invalid command arguments for goto: url must be a string',
    )
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'goto', args: { url: 'https://example.com' } }],
        continueOnError: 'yes',
      }),
    ).toThrow('invalid command arguments for batch: continueOnError must be a boolean')
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'goto', args: { url: 'https://example.com' } }],
        retries: -1,
      }),
    ).toThrow('invalid command arguments for batch: retries must be a non-negative integer')
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'goto', args: { url: 'https://example.com' } }],
        retryDelayMs: -1,
      }),
    ).toThrow('invalid command arguments for batch: retryDelayMs must be a non-negative number')
    expect(() => validateCommandArgs('goto', { url: 'https://example.com' })).not.toThrow()
  })

  test('validates batch when conditions and step metadata', () => {
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'snapshot', when: { step: 1 } }],
      }),
    ).toThrow(
      'invalid command arguments for batch: step 1: when must declare exactly one of equals, truthy, or exists',
    )
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'snapshot', when: { step: 1, path: 5, truthy: true } }],
      }),
    ).toThrow('invalid command arguments for batch: step 1: when.path must be a string')
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'snapshot', when: { step: 0, path: 'x', truthy: true } }],
      }),
    ).toThrow(
      'invalid command arguments for batch: step 1: when.step must be a step id string or a positive integer',
    )
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'snapshot', when: { step: 1, truthy: 'yes' } }],
      }),
    ).toThrow('invalid command arguments for batch: step 1: when.truthy must be a boolean')
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'snapshot', id: 123 }],
      }),
    ).toThrow('invalid command arguments for batch: step 1: id must be a non-empty string')
    expect(() =>
      validateCommandArgs('batch', {
        steps: [{ command: 'snapshot', skipRemainingOnFailure: 'yes' }],
      }),
    ).toThrow(
      'invalid command arguments for batch: step 1: skipRemainingOnFailure must be a boolean',
    )
    expect(() =>
      validateCommandArgs('batch', {
        steps: [
          { command: 'snapshot' },
          { command: 'snapshot' },
          { command: 'snapshot', when: { step: 3, path: 'x', truthy: true } },
        ],
      }),
    ).toThrow(
      'invalid command arguments for batch: step 3: when.step must reference an earlier step: 3',
    )
    expect(() =>
      validateCommandArgs('batch', {
        steps: [
          { command: 'snapshot', id: 'snap' },
          { command: 'snapshot', when: { step: 'snap', path: 'snapshotId', truthy: true } },
        ],
      }),
    ).not.toThrow()
  })

  test('validates script command arguments', () => {
    expect(() =>
      validateCommandArgs('script', { action: 'add', source: 'window.x = 1' }),
    ).not.toThrow()
    expect(() => validateCommandArgs('script', { action: 'list' })).not.toThrow()
    expect(() => validateCommandArgs('script', { action: 'remove', id: 'script_1' })).not.toThrow()
    expect(() => validateCommandArgs('script', { action: 'remove', all: true })).not.toThrow()
    expect(() => validateCommandArgs('script', { action: 'add' })).toThrow(
      'invalid command arguments for script: source must be a non-empty string',
    )
    expect(() => validateCommandArgs('script', { action: 'remove', all: 'yes' })).toThrow(
      'invalid command arguments for script: all must be a boolean',
    )
    expect(() => validateCommandArgs('script', { action: 'run' })).toThrow(
      'invalid command arguments for script: unsupported action',
    )
  })

  test('validates fillform fields', () => {
    expect(() =>
      validateCommandArgs('fillform', {
        fields: [
          { selector: '#a', value: '1' },
          { selector: '#b', value: '2' },
        ],
      }),
    ).not.toThrow()
    expect(() =>
      validateCommandArgs('fillform', { fields: [{ selector: '#a', value: '' }] }),
    ).not.toThrow()

    expect(() => validateCommandArgs('fillform', {})).toThrow(
      'invalid command arguments for fillform: fields must be an array',
    )
    expect(() => validateCommandArgs('fillform', { fields: 'x' })).toThrow(
      'invalid command arguments for fillform: fields must be an array',
    )
    expect(() => validateCommandArgs('fillform', { fields: [] })).toThrow(
      'invalid command arguments for fillform: fields must contain 1 to 50 items',
    )
    expect(() =>
      validateCommandArgs('fillform', {
        fields: Array.from({ length: 51 }, () => ({ selector: '#a', value: 'x' })),
      }),
    ).toThrow('invalid command arguments for fillform: fields must contain 1 to 50 items')
    expect(() => validateCommandArgs('fillform', { fields: ['#a'] })).toThrow(
      'invalid command arguments for fillform: fields[0] must be an object',
    )
    expect(() => validateCommandArgs('fillform', { fields: [{ value: 'x' }] })).toThrow(
      'invalid command arguments for fillform: fields[0].selector must be a non-empty string',
    )
    expect(() =>
      validateCommandArgs('fillform', { fields: [{ selector: ' ', value: 'x' }] }),
    ).toThrow(
      'invalid command arguments for fillform: fields[0].selector must be a non-empty string',
    )
    expect(() =>
      validateCommandArgs('fillform', { fields: [{ selector: '#a', value: 42 }] }),
    ).toThrow('invalid command arguments for fillform: fields[0].value must be a string')
  })

  test('covers the remaining command schema gaps', () => {
    expect(() => validateCommandArgs('close', { all: 'yes' })).toThrow(
      'invalid command arguments for close: all must be a boolean',
    )
    expect(() => validateCommandArgs('dialog', { action: 'dismiss' })).toThrow(
      'invalid command arguments for dialog: unsupported action',
    )
    expect(() => validateCommandArgs('scroll', { selector: 123 })).toThrow(
      'invalid command arguments for scroll: selector must be a string',
    )
    expect(() => validateCommandArgs('upload', { selector: '#file', files: [] })).toThrow(
      'invalid command arguments for upload: files must not be empty',
    )
    expect(() => validateCommandArgs('find', { strategy: 'role', query: 'button' })).toThrow(
      'invalid command arguments for find: role must be a non-empty string',
    )
    expect(() => validateCommandArgs('window', { action: 'close' })).toThrow(
      'invalid command arguments for window: unsupported action',
    )
    expect(() => validateCommandArgs('dialog', { action: 'auto' })).not.toThrow()
    expect(() => validateCommandArgs('dialog', { action: 'auto', enabled: false })).not.toThrow()
    expect(() => validateCommandArgs('downloads', { action: 'list' })).not.toThrow()
    expect(() => validateCommandArgs('downloads', { action: 'clear' })).not.toThrow()
    expect(() =>
      validateCommandArgs('downloads', { action: 'list', pageIdx: 1, pageSize: 50 }),
    ).not.toThrow()
    expect(() => validateCommandArgs('downloads', { action: 'list', pageIdx: -1 })).toThrow(
      'invalid command arguments for downloads: pageIdx must be a non-negative integer',
    )
    expect(() => validateCommandArgs('downloads', { action: 'list', pageSize: -1 })).toThrow(
      'invalid command arguments for downloads: pageSize must be a non-negative integer',
    )
    expect(() =>
      validateCommandArgs('find', {
        strategy: 'text',
        query: 'submit',
        action: 'fill',
        value: 'ok',
      }),
    ).not.toThrow()
  })

  test('accepts empty content values while keeping locators required', () => {
    // 清空字段/剪贴板/存储是合法语义：空串与纯空白都必须能通过参数校验
    expect(() => validateCommandArgs('fill', { selector: '#a', value: '' })).not.toThrow()
    expect(() => validateCommandArgs('fill', { selector: '#a', value: '   ' })).not.toThrow()
    expect(() => validateCommandArgs('type', { selector: '#a', value: '' })).not.toThrow()
    expect(() => validateCommandArgs('type', { selector: '#a', value: ' ' })).not.toThrow()
    expect(() => validateCommandArgs('select', { selector: '#a', value: '' })).not.toThrow()
    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', action: 'fill', value: '' }),
    ).not.toThrow()
    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', action: 'type', value: '  ' }),
    ).not.toThrow()
    expect(() =>
      validateCommandArgs('storage', { action: 'set', key: 'k', value: '' }),
    ).not.toThrow()
    expect(() =>
      validateCommandArgs('cookies', { action: 'set', name: 'n', value: '' }),
    ).not.toThrow()
    expect(() => validateCommandArgs('clipboard', { action: 'write', text: '' })).not.toThrow()
    expect(() => validateCommandArgs('keyboard', { action: 'type', text: '' })).not.toThrow()

    // 参数缺失与定位符仍按原契约报错
    expect(() => validateCommandArgs('fill', { selector: '#a' })).toThrow(
      'invalid command arguments for fill: value must be a non-empty string',
    )
    expect(() => validateCommandArgs('fill', { selector: ' ', value: 'x' })).toThrow(
      'invalid command arguments for fill: selector must be a non-empty string',
    )
    expect(() => validateCommandArgs('fill', { value: 'x' })).toThrow(
      'invalid command arguments for fill: selector must be a non-empty string',
    )
    expect(() => validateCommandArgs('select', { selector: '#a', value: 42 })).toThrow(
      'invalid command arguments for select: value must be a string',
    )
    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', action: 'fill' }),
    ).toThrow('invalid command arguments for find: value must be a non-empty string')
    expect(() => validateCommandArgs('keyboard', { action: 'type' })).toThrow(
      'invalid command arguments for keyboard: text must be a non-empty string',
    )
    expect(() => validateCommandArgs('cookies', { action: 'set', name: '', value: 'x' })).toThrow(
      'invalid command arguments for cookies: name must be a non-empty string',
    )
  })

  test('requires explicit state write content while preserving empty strings', () => {
    for (const [command, args, field] of [
      ['cookies', { action: 'set', name: 'n' }, 'value'],
      ['storage', { action: 'set', key: 'k' }, 'value'],
      ['clipboard', { action: 'write' }, 'text'],
    ] as const) {
      expect(() => validateCommandArgs(command, args)).toThrow(field)
      for (const value of [undefined, null, 42]) {
        expect(() => validateCommandArgs(command, { ...args, [field]: value })).toThrow(field)
      }
      for (const value of ['', '   ']) {
        expect(() => validateCommandArgs(command, { ...args, [field]: value })).not.toThrow()
      }
    }
    for (const [command, field] of [
      ['cookies', 'name'],
      ['storage', 'key'],
    ] as const) {
      expect(() => validateCommandArgs(command, { action: 'set', value: '' })).toThrow(field)
      for (const value of [undefined, null, '', '   ', 42]) {
        expect(() =>
          validateCommandArgs(command, { action: 'set', value: '', [field]: value }),
        ).toThrow(field)
      }
    }
  })

  test('keeps non-write state shapes optional and rejects data-only storage writes', () => {
    for (const command of ['cookies', 'storage']) {
      for (const action of ['get', 'list', 'clear', 'delete']) {
        expect(() => validateCommandArgs(command, { action })).not.toThrow()
        expect(() => validateCommandArgs(command, { action, value: '' })).not.toThrow()
      }
    }
    expect(() => validateCommandArgs('clipboard', { action: 'read' })).not.toThrow()
    expect(() => validateCommandArgs('clipboard', { action: 'read', text: '' })).not.toThrow()
    for (const data of [{ k: 'v' }, []]) {
      expect(() => validateCommandArgs('storage', { action: 'set', data })).toThrow('key')
      expect(() => validateCommandArgs('storage', { action: 'set', key: 'k', data })).toThrow(
        'value',
      )
      expect(() =>
        validateCommandArgs('storage', { action: 'set', key: 'k', value: '', data }),
      ).not.toThrow()
    }
  })

  test('allows empty keyboard content only for text actions, never keys', () => {
    for (const action of ['type', 'inserttext', 'keydown', 'keyup']) {
      expect(() => validateCommandArgs('keyboard', { action })).toThrow()
      expect(() => validateCommandArgs('keyboard', { action, text: 'Enter' })).not.toThrow()
      for (const text of ['', '   ']) {
        const validate = () => validateCommandArgs('keyboard', { action, text })
        if (action === 'type' || action === 'inserttext') expect(validate).not.toThrow()
        else expect(validate).toThrow('text must be a non-empty string')
      }
    }
  })

  test('allows clearing every network route without a url', () => {
    expect(() => validateCommandArgs('network', { action: 'unroute' })).not.toThrow()
    expect(() => validateCommandArgs('network', { action: 'unroute', url: '**/api' })).not.toThrow()
    expect(() => validateCommandArgs('network', { action: 'route' })).toThrow(
      'invalid command arguments for network: url must be a non-empty string',
    )
  })

  test('validates extended find strategies, position, and candidates', () => {
    for (const strategy of ['placeholder', 'alt', 'title', 'test-id', 'exact-name']) {
      expect(() => validateCommandArgs('find', { strategy, query: 'x' })).not.toThrow()
    }

    expect(() => validateCommandArgs('find', { strategy: 'foo', query: 'x' })).toThrow(
      'invalid command arguments for find: strategy must be role, text, label, placeholder, alt, title, test-id, or exact-name',
    )

    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', position: 'middle' }),
    ).toThrow('invalid command arguments for find: position must be first, last, or nth=N')
    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', position: 'nth=0' }),
    ).toThrow('invalid command arguments for find: position must be first, last, or nth=N')
    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', position: 'last' }),
    ).not.toThrow()
    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', position: 'nth=2' }),
    ).not.toThrow()

    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', candidates: 0 }),
    ).toThrow('invalid command arguments for find: candidates must be a positive integer')
    expect(() =>
      validateCommandArgs('find', { strategy: 'text', query: 'x', candidates: 3 }),
    ).not.toThrow()

    expect(() =>
      validateCommandArgs('find', {
        strategy: 'text',
        query: 'x',
        candidates: 3,
        position: 'last',
      }),
    ).toThrow('invalid command arguments for find: candidates cannot be combined with position')
    expect(() =>
      validateCommandArgs('find', {
        strategy: 'text',
        query: 'x',
        candidates: 3,
        action: 'click',
      }),
    ).toThrow('invalid command arguments for find: candidates only supports the locate action')
    expect(() =>
      validateCommandArgs('find', {
        strategy: 'text',
        query: 'x',
        candidates: 3,
        action: 'locate',
      }),
    ).not.toThrow()
  })

  test('validates diagnostics and automatic snapshot commands', () => {
    expect(commandSupportsTabTarget('actions')).toBe(true)
    expect(commandSupportsTabTarget('tracing')).toBe(true)
    expect(commandSupportsFrameTarget('tracing')).toBe(false)
    expect(() => validateCommandArgs('actions', { action: 'list' })).not.toThrow()
    expect(() => validateCommandArgs('tracing', { action: 'start' })).not.toThrow()
    expect(() => validateCommandArgs('tracing', { action: 'record' })).toThrow('unsupported action')
    expect(() =>
      validateCommandArgs('video', { action: 'start', maxDurationMs: 1000 }),
    ).not.toThrow()
    expect(() => validateCommandArgs('video', { action: 'chapter', title: 'One' })).not.toThrow()
    expect(() => validateCommandArgs('video', { action: 'chapter' })).toThrow(
      'title must be a non-empty string',
    )
    expect(() => validateCommandArgs('set', { type: 'auto-snapshot', enabled: true })).not.toThrow()
  })

  test('validates element eval, locator and highlight options', () => {
    expect(() =>
      validateCommandArgs('eval', { script: 'el => el.textContent', element: '@e1' }),
    ).not.toThrow()
    expect(() => validateCommandArgs('locator', { selector: '@e1' })).not.toThrow()
    expect(() => validateCommandArgs('highlight', { selector: '@e1' })).not.toThrow()
    expect(() => validateCommandArgs('highlight', { hide: true })).not.toThrow()
    expect(() => validateCommandArgs('highlight', {})).toThrow(
      'selector is required unless hide is set',
    )
    expect(() => validateCommandArgs('highlight', { hide: true, style: '1px solid red' })).toThrow(
      'style cannot be combined with hide',
    )
  })

  test('validates coordinate mouse and drop payloads', () => {
    expect(() => validateCommandArgs('mousemove', { x: 10, y: 20 })).not.toThrow()
    expect(() => validateCommandArgs('mousedown', { button: 'right' })).not.toThrow()
    expect(() => validateCommandArgs('mouseup', {})).not.toThrow()
    expect(() => validateCommandArgs('mousewheel', { deltaX: 0, deltaY: 100 })).not.toThrow()
    expect(() => validateCommandArgs('mousedown', { button: 'middle-right' })).toThrow(
      'unsupported mouse button',
    )
    expect(() => validateCommandArgs('mousemove', { x: NaN, y: 0 })).toThrow(
      'x must be a finite number',
    )
    expect(() =>
      validateCommandArgs('drop', {
        selector: '#drop',
        data: { 'text/plain': 'hello' },
        files: [{ name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YQ==' }],
      }),
    ).not.toThrow()
    expect(() => validateCommandArgs('drop', { selector: '#drop' })).toThrow(
      'drop requires data or files',
    )
    expect(() =>
      validateCommandArgs('drop', { selector: '#drop', data: { 'text/plain': 1 } }),
    ).toThrow('data values must be strings')
    expect(() =>
      validateCommandArgs('drop', {
        selector: '#drop',
        files: [{ name: 'bad', mimeType: 'text/plain', dataBase64: 'not base64' }],
      }),
    ).toThrow('dataBase64 is invalid')
  })

  test('validates tab-scoped CDP methods and object params', () => {
    expect(() =>
      validateCommandArgs('cdp', {
        method: 'Runtime.evaluate',
        params: { expression: 'document.title', returnByValue: true },
      }),
    ).not.toThrow()
    for (const method of [
      'Browser.close',
      'Target.attachToTarget',
      'SystemInfo.getInfo',
      'Debugger.disable',
      'runtime.evaluate',
      'Runtime',
    ])
      expect(() => validateCommandArgs('cdp', { method })).toThrow(
        'invalid command arguments for cdp: method must be a tab-scoped CDP method',
      )
    expect(() => validateCommandArgs('cdp', { method: 'Runtime.evaluate', params: [] })).toThrow(
      'invalid command arguments for cdp: params must be an object',
    )
  })

  test('validates WebMCP actions and object arguments', () => {
    expect(commandSupportsTabTarget('webmcp')).toBe(true)
    expect(commandSupportsFrameTarget('webmcp')).toBe(true)
    expect(() => validateCommandArgs('webmcp', { action: 'list' })).not.toThrow()
    expect(() =>
      validateCommandArgs('webmcp', { action: 'call', name: 'lookup', args: { id: 1 } }),
    ).not.toThrow()
    expect(() => validateCommandArgs('webmcp', { action: 'call', name: 'lookup' })).not.toThrow()
    expect(() => validateCommandArgs('webmcp', { action: 'call' })).toThrow(
      'name must be a non-empty string',
    )
    expect(() =>
      validateCommandArgs('webmcp', { action: 'call', name: 'lookup', args: [] }),
    ).toThrow('args must be an object')
  })

  test('validates media emulation values and device resets', () => {
    for (const [type, value] of [
      ['media-type', 'print'],
      ['reduced-motion', 'reduce'],
      ['forced-colors', 'active'],
      ['contrast', 'more'],
      ['device', 'iphone-15'],
    ])
      expect(() => validateCommandArgs('set', { type, value })).not.toThrow()
    expect(() => validateCommandArgs('set', { type: 'media-type', value: 'speech' })).toThrow(
      'media type must be print or screen',
    )
    expect(() => validateCommandArgs('set', { type: 'reduced-motion', value: 'always' })).toThrow(
      'unsupported reduced-motion value',
    )
    expect(() => validateCommandArgs('set', { type: 'device', value: '' })).not.toThrow()
  })

  test('validates search command arguments', () => {
    expect(() => validateCommandArgs('search', {})).toThrow(
      'invalid command arguments for search: query must be a non-empty string',
    )
    expect(() => validateCommandArgs('search', { query: 'Sign in' })).not.toThrow()
    expect(() => validateCommandArgs('search', { query: 'Sign in', context: -1 })).toThrow(
      'invalid command arguments for search: context must be a non-negative integer',
    )
    expect(() => validateCommandArgs('search', { query: 'Sign in', limit: 2.5 })).toThrow(
      'invalid command arguments for search: limit must be a non-negative integer',
    )
    expect(() => validateCommandArgs('search', { query: 'Sign in', limit: 20 })).not.toThrow()
    expect(() => validateCommandArgs('search', { query: '/foo[/' })).toThrow(
      'invalid command arguments for search: invalid search regex: /foo[/',
    )
    expect(() => validateCommandArgs('search', { query: '/foo/i' })).not.toThrow()
  })
})
