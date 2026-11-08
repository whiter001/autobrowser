import { describe, expect, test } from 'bun:test'
import { COMMAND_GROUP_NAMES, COMMAND_LOADERS } from '../src/cli/commands/index.js'

/**
 * 各实现模块导出的注册表。测试用它校验「命令名声明」与「实现」不会漂移：
 * 懒加载之后命令名集中写在 index.ts，一旦与实现不同步就会静默失效。
 */
const GROUP_REGISTRIES: Record<string, () => Promise<Record<string, unknown>>> = {
  batch: async () => (await import('../src/cli/commands/batch.js')).batchCommandRegistry,
  collect: async () => (await import('../src/cli/commands/collect.js')).collectCommandRegistry,
  diagnostics: async () =>
    (await import('../src/cli/commands/diagnostics.js')).diagnosticsCommandRegistry,
  elements: async () => (await import('../src/cli/commands/elements.js')).elementCommandRegistry,
  extension: async () =>
    (await import('../src/cli/commands/extension.js')).extensionCommandRegistry,
  fillform: async () => (await import('../src/cli/commands/fillform.js')).fillFormCommandRegistry,
  media: async () => (await import('../src/cli/commands/media.js')).mediaCommandRegistry,
  page: async () => (await import('../src/cli/commands/page.js')).pageCommandRegistry,
  server: async () => (await import('../src/cli/commands/server.js')).serverCommandRegistry,
  skill: async () => (await import('../src/cli/commands/skill.js')).skillCommandRegistry,
  state: async () => (await import('../src/cli/commands/state.js')).stateCommandRegistry,
  tabs: async () => (await import('../src/cli/commands/tabs.js')).tabCommandRegistry,
  version: async () => (await import('../src/cli/commands/version.js')).versionCommandRegistry,
  webmcp: async () => (await import('../src/cli/commands/webmcp.js')).webmcpCommandRegistry,
  mcp: async () => ({ mcp: (await import('../src/cli/mcp.js')).handleMcpCommand }),
}

describe('命令注册表', () => {
  test('声明的命令集合与各实现模块导出的注册表键完全一致', async () => {
    const implemented = new Set<string>()
    for (const [group, load] of Object.entries(GROUP_REGISTRIES)) {
      const registry = await load()
      for (const name of Object.keys(registry)) {
        expect(implemented.has(name)).toBe(false)
        implemented.add(name)
        expect(COMMAND_LOADERS[name]).toBeDefined()
      }
      expect(COMMAND_GROUP_NAMES).toContain(group)
    }

    const declared = new Set(Object.keys(COMMAND_LOADERS))
    expect(declared.size).toBe(implemented.size)
    for (const name of implemented) {
      expect(declared.has(name)).toBe(true)
    }
  })

  test('每个命令都能加载出可调用的 handler', async () => {
    for (const [name, load] of Object.entries(COMMAND_LOADERS)) {
      const handler = await load()
      expect(typeof handler).toBe('function')
      expect(name.length).toBeGreaterThan(0)
    }
  })

  test('mcp 命令在注册表中且与实现一致', async () => {
    const handler = await COMMAND_LOADERS.mcp!()
    expect(typeof handler).toBe('function')
    const { handleMcpCommand } = await import('../src/cli/mcp.js')
    expect(handler).toBe(handleMcpCommand)
  })

  test('未知命令不会命中任何加载器', () => {
    expect(COMMAND_LOADERS.definitelyNotACommand).toBeUndefined()
  })
})
