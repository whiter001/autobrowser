import { isRecord } from '../client.js'
import { createActionCommand, parseOrThrow, requestAndWrite, throwCommandError } from './shared.js'
import { COMMAND_ACTIONS } from './actions.js'
import type { CommandRegistry } from './types.js'

const handleWebMcp = createActionCommand({
  helpPath: ['webmcp'],
  allowed: COMMAND_ACTIONS.webmcp.actions,
  handle: async (rest, context, action) => {
    if (action === 'list') {
      if (rest.length) return throwCommandError(`unexpected argument for webmcp list: ${rest[0]}`)
      await requestAndWrite(context, 'webmcp', { action })
      return 0
    }

    const name = rest[0]
    if (!name) return throwCommandError('missing WebMCP tool name')
    let paramsText = '{}'
    if (rest[1] === '--params') {
      if (!rest[2]) return throwCommandError('missing value for --params')
      if (rest.length > 3) {
        return throwCommandError(`unexpected extra argument for webmcp call: ${rest[3]}`)
      }
      paramsText = rest[2]
    } else {
      paramsText = rest.slice(1).join(' ') || '{}'
    }
    const args = parseOrThrow(() => JSON.parse(paramsText) as unknown)
    if (!isRecord(args) || Array.isArray(args)) {
      return throwCommandError('WebMCP args must be a JSON object')
    }
    await requestAndWrite(context, 'webmcp', { action, name, args })
    return 0
  },
})

export const webmcpCommandRegistry: CommandRegistry = {
  webmcp: handleWebMcp,
}
