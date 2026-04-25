import { elementCommandRegistry } from './elements.js'
import { pageCommandRegistry } from './page.js'
import { serverCommandRegistry } from './server.js'
import { stateCommandRegistry } from './state.js'
import { tabCommandRegistry } from './tabs.js'
import type { CommandRegistry } from './types.js'

export const COMMAND_REGISTRY: CommandRegistry = {
  ...serverCommandRegistry,
  ...tabCommandRegistry,
  ...elementCommandRegistry,
  ...pageCommandRegistry,
  ...stateCommandRegistry,
}
