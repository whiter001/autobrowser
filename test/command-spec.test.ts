import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import {
  COMMAND_SPECS,
  commandSupportsFrameTarget,
  commandSupportsTabTarget,
  getCommandSpec,
} from '../src/core/command-spec.js'

const NON_AMBIENT_ROUTER_COMMANDS = new Set([
  'open',
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
})
