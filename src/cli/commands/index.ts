import { batchCommandRegistry } from './batch.js'
import { collectCommandRegistry } from './collect.js'
import { elementCommandRegistry } from './elements.js'
import { diagnosticsCommandRegistry } from './diagnostics.js'
import { extensionCommandRegistry } from './extension.js'
import { fillFormCommandRegistry } from './fillform.js'
import { mediaCommandRegistry } from './media.js'
import { pageCommandRegistry } from './page.js'
import { serverCommandRegistry } from './server.js'
import { skillCommandRegistry } from './skill.js'
import { stateCommandRegistry } from './state.js'
import { tabCommandRegistry } from './tabs.js'
import { webmcpCommandRegistry } from './webmcp.js'
import { handleMcpCommand } from '../mcp.js'
import type { CommandRegistry } from './types.js'

export const COMMAND_REGISTRY: CommandRegistry = {
  mcp: handleMcpCommand,
  ...batchCommandRegistry,
  ...collectCommandRegistry,
  ...extensionCommandRegistry,
  ...fillFormCommandRegistry,
  ...serverCommandRegistry,
  ...skillCommandRegistry,
  ...tabCommandRegistry,
  ...elementCommandRegistry,
  ...mediaCommandRegistry,
  ...pageCommandRegistry,
  ...diagnosticsCommandRegistry,
  ...webmcpCommandRegistry,
  ...stateCommandRegistry,
}
