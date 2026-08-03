import { batchCommandRegistry } from './batch.js'
import { elementCommandRegistry } from './elements.js'
import { fillFormCommandRegistry } from './fillform.js'
import { pageCommandRegistry } from './page.js'
import { serverCommandRegistry } from './server.js'
import { stateCommandRegistry } from './state.js'
import { tabCommandRegistry } from './tabs.js'
import { handleMcpCommand } from '../mcp.js'
import type { CommandRegistry } from './types.js'

export const COMMAND_REGISTRY: CommandRegistry = {
  mcp: handleMcpCommand,
  ...batchCommandRegistry,
  ...fillFormCommandRegistry,
  ...serverCommandRegistry,
  ...tabCommandRegistry,
  ...elementCommandRegistry,
  ...pageCommandRegistry,
  ...stateCommandRegistry,
}
