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
    expect(() =>
      validateCommandArgs('find', {
        strategy: 'text',
        query: 'submit',
        action: 'fill',
        value: 'ok',
      }),
    ).not.toThrow()
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
