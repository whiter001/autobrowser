import { createActionCommand, requestAndWrite, writeCommandError } from './shared.js'
import type { CommandRegistry } from './types.js'

const handleExtension = createActionCommand({
  helpPath: ['extension'],
  allowed: ['info', 'reload', 'reconnect'] as const,
  handle: async (rest, context, action) => {
    if (rest.length)
      return writeCommandError(`unexpected argument for extension ${action}: ${rest[0]}`)
    await requestAndWrite(context, 'extension', { action })
    return 0
  },
})

export const extensionCommandRegistry: CommandRegistry = {
  extension: handleExtension,
}
