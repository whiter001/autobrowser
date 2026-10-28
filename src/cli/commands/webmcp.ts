import { isRecord } from '../client.js'
import {
  createActionCommand,
  parseOrWriteError,
  requestAndWrite,
  writeCommandError,
} from './shared.js'
import type { CommandRegistry } from './types.js'

const WEBMCP_ACTIONS = ['list', 'call'] as const

const handleWebMcp = createActionCommand({
  helpPath: ['webmcp'],
  allowed: WEBMCP_ACTIONS,
  handle: async (rest, context, action) => {
    if (action === 'list') {
      if (rest.length) return writeCommandError(`unexpected argument for webmcp list: ${rest[0]}`)
      await requestAndWrite(context, 'webmcp', { action })
      return 0
    }

    const name = rest[0]
    if (!name) return writeCommandError('missing WebMCP tool name')
    let paramsText = '{}'
    if (rest[1] === '--params') {
      if (!rest[2]) return writeCommandError('missing value for --params')
      if (rest.length > 3) {
        return writeCommandError(`unexpected extra argument for webmcp call: ${rest[3]}`)
      }
      paramsText = rest[2]
    } else {
      paramsText = rest.slice(1).join(' ') || '{}'
    }
    const args = parseOrWriteError(() => JSON.parse(paramsText) as unknown)
    if (args === undefined) return 1
    if (!isRecord(args) || Array.isArray(args)) {
      return writeCommandError('WebMCP args must be a JSON object')
    }
    await requestAndWrite(context, 'webmcp', { action, name, args })
    return 0
  },
})

export const webmcpCommandRegistry: CommandRegistry = {
  webmcp: handleWebMcp,
}
