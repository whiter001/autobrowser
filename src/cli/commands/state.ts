import { isRecord } from '../client.js'
import {
  parseNetworkRequestsArgs,
  parseNetworkRouteArgs,
  parseOptionalNumberArg,
} from '../parse.js'
import {
  createActionCommand,
  helpRequested,
  parseOrWriteError,
  readAllowedArg,
  requestAndWrite,
  writeCommandError,
} from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

interface NetworkHarStopResult {
  har?: unknown
  recording?: boolean
  requestCount?: number
  startedAt?: string
  stoppedAt?: string
}

const COOKIE_ACTIONS = ['get', 'set', 'clear'] as const
const STORAGE_ACTIONS = ['get', 'set', 'clear'] as const
const SET_ACTIONS = ['viewport', 'offline', 'headers', 'geo', 'media'] as const
const CLIPBOARD_ACTIONS = ['read', 'write'] as const
const STATE_ACTIONS = ['save', 'load'] as const
const NETWORK_ACTIONS = ['route', 'unroute', 'requests', 'request', 'har'] as const
const NETWORK_HAR_ACTIONS = ['start', 'stop'] as const

const handleCookies = createActionCommand({
  helpPath: ['cookies'],
  allowed: COOKIE_ACTIONS,
  handle: async (rest, context, action) => {
    if (action === 'get' || action === 'clear') {
      await requestAndWrite(context, 'cookies', { action })
      return 0
    }

    const [name, value, domain] = rest
    if (!name || !value) {
      return context.writeHelp(['cookies', 'set'])
    }

    await requestAndWrite(context, 'cookies', {
      action,
      name,
      value,
      domain,
    })
    return 0
  },
})

const handleStorage = createActionCommand({
  helpPath: ['storage'],
  allowed: STORAGE_ACTIONS,
  handle: async (rest, context, action) => {
    if (action === 'get') {
      await requestAndWrite(context, 'storage', {
        action,
        key: rest[0],
      })
      return 0
    }

    if (action === 'clear') {
      await requestAndWrite(context, 'storage', { action })
      return 0
    }

    const [key, value] = rest
    if (!key || value === undefined) {
      return context.writeHelp(['storage', 'set'])
    }

    await requestAndWrite(context, 'storage', {
      action,
      key,
      value,
    })
    return 0
  },
})

async function handleSet(rest: string[], context: CommandContext): Promise<number | void> {
  const type = readAllowedArg(rest[0], context, ['set'], SET_ACTIONS)
  const subArgs = rest.slice(1)
  if (!type) {
    return 0
  }

  if (type === 'viewport') {
    const viewportArgs = parseOrWriteError(() => ({
      width: parseOptionalNumberArg(subArgs[0], 'viewport width', 1280, {
        min: 1,
        integer: true,
      }),
      height: parseOptionalNumberArg(subArgs[1], 'viewport height', 720, {
        min: 1,
        integer: true,
      }),
      deviceScaleFactor: parseOptionalNumberArg(subArgs[2], 'device scale factor', 1, {
        min: 0,
      }),
      mobile: subArgs[3] === 'mobile',
    }))
    if (!viewportArgs) {
      return 1
    }

    await requestAndWrite(context, 'set', {
      type: 'viewport',
      ...viewportArgs,
    })
    return 0
  }

  if (type === 'offline') {
    await requestAndWrite(context, 'set', {
      type: 'offline',
      enabled: subArgs[0] !== 'false',
    })
    return 0
  }

  if (type === 'headers') {
    const headers = subArgs
      .join(' ')
      .split(',')
      .map((header) => {
        const [name, ...valueParts] = header.split(':')
        return { name: name.trim(), value: valueParts.join(':').trim() }
      })
      .filter((header) => header.name)
    await requestAndWrite(context, 'set', {
      type: 'headers',
      headers,
    })
    return 0
  }

  if (type === 'geo') {
    const geoArgs = parseOrWriteError(() => ({
      latitude: parseOptionalNumberArg(subArgs[0], 'latitude', 0, { min: -90, max: 90 }),
      longitude: parseOptionalNumberArg(subArgs[1], 'longitude', 0, { min: -180, max: 180 }),
      accuracy: parseOptionalNumberArg(subArgs[2], 'accuracy', 1, { min: 0 }),
    }))
    if (!geoArgs) {
      return 1
    }

    await requestAndWrite(context, 'set', {
      type: 'geo',
      ...geoArgs,
    })
    return 0
  }

  await requestAndWrite(context, 'set', {
    type: 'media',
    media: subArgs[0] || '',
  })
  return 0
}

const handleClipboard = createActionCommand({
  helpPath: ['clipboard'],
  allowed: CLIPBOARD_ACTIONS,
  handle: async (rest, context, action) => {
    await requestAndWrite(context, 'clipboard', {
      action,
      ...(action === 'write' ? { text: rest.join(' ') } : {}),
    })
    return 0
  },
})

const handleState = createActionCommand({
  helpPath: ['state'],
  allowed: STATE_ACTIONS,
  handle: async (rest, context, action) => {
    if (action === 'save') {
      await requestAndWrite(context, 'state', {
        action,
        name: rest[0] || 'default',
      })
      return 0
    }

    const stateValue = rest.join(' ').trim()
    if (!stateValue) {
      return context.writeHelp(['state', 'load'])
    }

    try {
      const data = JSON.parse(stateValue)
      if (data && typeof data === 'object') {
        await requestAndWrite(context, 'state', {
          action,
          data,
        })
        return 0
      }
    } catch {
      // Fall through to loading a saved state by name.
    }

    await requestAndWrite(context, 'state', {
      action,
      name: stateValue,
    })
    return 0
  },
})

async function handleNetwork(rest: string[], context: CommandContext): Promise<number | void> {
  const action = readAllowedArg(rest[0], context, ['network'], NETWORK_ACTIONS)
  if (!action) {
    return 0
  }

  if (action === 'route') {
    if (helpRequested(rest[1], context, ['network', 'route'])) {
      return 0
    }

    const routeArgs = parseOrWriteError(() => parseNetworkRouteArgs(rest.slice(1)))
    if (!routeArgs) {
      return 1
    }

    if (!routeArgs.url) {
      return context.writeHelp(['network', 'route'])
    }

    await requestAndWrite(context, 'network', {
      action: 'route',
      url: routeArgs.url,
      abort: routeArgs.abort,
      body: routeArgs.body,
    })
    return 0
  }

  if (action === 'unroute') {
    if (helpRequested(rest[1], context, ['network', 'unroute'])) {
      return 0
    }

    await requestAndWrite(context, 'network', {
      action: 'unroute',
      url: rest[1] || undefined,
    })
    return 0
  }

  if (action === 'requests') {
    if (helpRequested(rest[1], context, ['network', 'requests'])) {
      return 0
    }

    await requestAndWrite(context, 'network', {
      action: 'requests',
      ...parseNetworkRequestsArgs(rest.slice(1)),
    })
    return 0
  }

  if (action === 'request') {
    const requestId = rest[1]
    if (helpRequested(requestId, context, ['network', 'request'])) {
      return 0
    }

    if (!requestId) {
      return context.writeHelp(['network', 'request'])
    }

    await requestAndWrite(context, 'network', {
      action: 'request',
      requestId,
    })
    return 0
  }

  if (action === 'har') {
    const subaction = readAllowedArg(rest[1], context, ['network', 'har'], NETWORK_HAR_ACTIONS)
    if (!subaction) {
      return 0
    }

    if (subaction === 'start') {
      await requestAndWrite(context, 'network', {
        action: 'har',
        subaction: 'start',
      })
      return 0
    }

    if (subaction === 'stop') {
      const payload = await context.requestCommand(context.flags.server, 'network', {
        action: 'har',
        subaction: 'stop',
      })

      if (payload.ok === false) {
        context.writeResult(payload)
        return 1
      }

      const result = isRecord(payload.result) ? (payload.result as NetworkHarStopResult) : undefined
      const har =
        result && isRecord(result.har)
          ? result.har
          : // 这里保留 CLI 侧重建兜底，兼容旧扩展版本或 stopHar 降级为只回元数据的场景。
            await context.collectHarFromNetwork(
              context.flags.server,
              typeof result?.startedAt === 'string' ? result.startedAt : null,
            )
      const savedPath = await context.writeHarFile(har, rest[2] || null)
      context.writeResult({ ok: true, result: savedPath })
      return 0
    }
  }

  return writeCommandError(`unsupported network action: ${action}`)
}

export const stateCommandRegistry: CommandRegistry = {
  cookies: handleCookies,
  storage: handleStorage,
  set: handleSet,
  clipboard: handleClipboard,
  state: handleState,
  network: handleNetwork,
}
