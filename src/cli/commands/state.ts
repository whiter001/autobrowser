import { isRecord } from '../client.js'
import {
  parseNetworkHarStartArgs,
  parseNetworkRequestsArgs,
  parseNetworkRouteArgs,
  parseOptionalNumberArg,
  parsePaginationArgs,
} from '../parse.js'
import { buildNetworkRequestsJsonl } from '../network-export.js'
import { COMMAND_ACTIONS, isCommandAction, SET_RESETTABLE_VALUE_TYPES } from './actions.js'
import {
  createActionCommand,
  helpRequested,
  parseOrThrow,
  readAllowedArg,
  requestAndWrite,
  throwCommandError,
} from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

interface NetworkHarStopResult {
  har?: unknown
  recording?: boolean
  captureId?: string | null
  captureTabId?: number | null
  urls?: string[]
  requestCount?: number
  startedAt?: string
  stoppedAt?: string
  checkpoint?: { saved?: boolean; error?: string }
}

function parseNetworkTimeoutArgs(
  rest: string[],
  harStop = false,
): { timeoutMs?: number; captureId?: string; includeUrls?: boolean } {
  const result: { timeoutMs?: number; captureId?: string; includeUrls?: boolean } = {}
  const seen = new Set<string>()
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (seen.has(value)) throw new Error(`duplicate network option: ${value}`)
    seen.add(value)
    if (harStop && value === '--include-urls') {
      result.includeUrls = true
      continue
    }
    if (value === '--timeout-ms' || (harStop && value === '--capture-id')) {
      const argument = rest[index + 1]
      if (!argument?.trim() || argument.startsWith('--')) {
        throw new Error(`missing value for ${value}`)
      }
      if (value === '--capture-id') result.captureId = argument
      else {
        result.timeoutMs = parseOptionalNumberArg(argument, 'timeout ms', Number.NaN, {
          min: 1,
          integer: true,
        })
      }
      index += 1
      continue
    }
    throw new Error(`unsupported network option: ${value}`)
  }
  return result
}

interface NetworkHarStopArgs {
  outputPath: string | null
  options: { timeoutMs?: number; captureId?: string; includeUrls?: boolean }
}

/**
 * 解析 network har stop/recover 的参数。
 *
 * 输出路径是可选的位置参数，允许出现在选项前后；选项值（--capture-id/--timeout-ms）
 * 在消费时整体跳过，因此不会被误判成路径。位置参数最多一个：重复或多余都按用法错误处理，
 * 避免静默覆盖用户给的路径。
 */
function parseNetworkHarStopArgs(rest: string[], harStop: boolean): NetworkHarStopArgs {
  const args: NetworkHarStopArgs = { outputPath: null, options: {} }
  const seen = new Set<string>()

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]

    if (!value.startsWith('--')) {
      if (!value.trim()) throw new Error('missing value for HAR output path')
      if (args.outputPath !== null) throw new Error(`duplicate HAR output path: ${value}`)
      args.outputPath = value
      continue
    }

    if (seen.has(value)) throw new Error(`duplicate network option: ${value}`)
    seen.add(value)

    if (harStop && value === '--include-urls') {
      args.options.includeUrls = true
      continue
    }

    if (value === '--timeout-ms' || (harStop && value === '--capture-id')) {
      const argument = rest[index + 1]
      if (!argument?.trim() || argument.startsWith('--')) {
        throw new Error(`missing value for ${value}`)
      }
      if (value === '--capture-id') args.options.captureId = argument
      else {
        args.options.timeoutMs = parseOptionalNumberArg(argument, 'timeout ms', Number.NaN, {
          min: 1,
          integer: true,
        })
      }
      index += 1
      continue
    }

    throw new Error(`unsupported network option: ${value}`)
  }

  return args
}

const handleCookies = createActionCommand({
  helpPath: ['cookies'],
  allowed: COMMAND_ACTIONS.cookies.actions,
  handle: async (rest, context, action) => {
    if (action === 'list' || action === 'get') {
      const filters: Record<string, string> = {}
      for (let index = 0; index < rest.length; index += 1) {
        const value = rest[index]
        if (value === '--domain' || value === '--path') {
          const rawValue = rest[index + 1]
          if (rawValue === undefined) {
            return throwCommandError(`missing value for ${value}`)
          }
          filters[value.slice(2)] = rawValue
          index += 1
          continue
        }
        return throwCommandError(`unexpected cookies ${action} argument: ${value}`)
      }

      await requestAndWrite(context, 'cookies', { action: 'get', ...filters })
      return 0
    }

    if (action === 'clear') {
      await requestAndWrite(context, 'cookies', { action })
      return 0
    }

    if (action === 'delete') {
      const name = rest[0]
      if (!name) {
        return context.writeHelp(['cookies', 'delete'])
      }

      await requestAndWrite(context, 'cookies', { action, name })
      return 0
    }

    if (helpRequested(rest[0], context, ['cookies', 'set'])) {
      return 0
    }
    const [name, value, domain] = rest
    if (!name) {
      return context.writeHelp(['cookies', 'set'])
    }
    if (value === undefined) {
      return throwCommandError('missing value for cookies set')
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
  allowed: COMMAND_ACTIONS.storage.actions,
  handle: async (rest, context, action) => {
    // --session 只解析 -- 之前的选项，之后允许 key/value 使用同名字面量
    const separatorIndex = rest.indexOf('--')
    const optionArgs = separatorIndex < 0 ? rest : rest.slice(0, separatorIndex)
    const literalArgs = separatorIndex < 0 ? [] : rest.slice(separatorIndex + 1)
    const sessionOnly = optionArgs.includes('--session')
    const args = [...optionArgs.filter((value) => value !== '--session'), ...literalArgs]
    if (helpRequested(args[0], context, ['storage', action])) {
      return 0
    }
    if (action === 'set' && args.length === 1 && args[0]) {
      return throwCommandError('missing value for storage set')
    }
    const expectedCount = action === 'set' ? 2 : action === 'clear' ? 0 : 1
    const validCount = action === 'get' ? args.length <= 1 : args.length === expectedCount
    if (!validCount) {
      return throwCommandError(`storage ${action} expects ${expectedCount} argument(s)`)
    }

    if (action === 'get' || action === 'delete') {
      if (action === 'delete' && !args[0]) {
        return throwCommandError('missing key for storage delete')
      }
      await requestAndWrite(context, 'storage', {
        action,
        key: args[0],
        ...(sessionOnly ? { session: true } : {}),
      })
      return 0
    }

    if (action === 'clear') {
      await requestAndWrite(context, 'storage', {
        action,
        ...(sessionOnly ? { session: true } : {}),
      })
      return 0
    }

    const [key, value] = args
    if (!key) {
      return throwCommandError('missing key for storage set')
    }

    await requestAndWrite(context, 'storage', {
      action,
      key,
      value,
      ...(sessionOnly ? { session: true } : {}),
    })
    return 0
  },
})

async function handleSet(rest: string[], context: CommandContext): Promise<number | void> {
  const type = readAllowedArg(rest[0], context, ['set'], COMMAND_ACTIONS.set.actions)
  const subArgs = rest.slice(1)
  if (!type) {
    return 0
  }

  if (type === 'viewport') {
    const viewportArgs = parseOrThrow(() => ({
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

  if (type === 'auto-snapshot') {
    await requestAndWrite(context, 'set', {
      type: 'auto-snapshot',
      enabled: !['false', 'off', '0'].includes(subArgs[0] || ''),
    })
    return 0
  }

  if (type === 'focus') {
    // 缺省即开启；显式的 off/false/0 才关闭，与 auto-snapshot 的布尔写法保持一致
    await requestAndWrite(context, 'set', {
      type: 'focus',
      enabled: !['false', 'off', '0'].includes(subArgs[0] || ''),
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
    const geoArgs = parseOrThrow(() => ({
      latitude: parseOptionalNumberArg(subArgs[0], 'latitude', 0, { min: -90, max: 90 }),
      longitude: parseOptionalNumberArg(subArgs[1], 'longitude', 0, { min: -180, max: 180 }),
      accuracy: parseOptionalNumberArg(subArgs[2], 'accuracy', 1, { min: 0 }),
    }))

    await requestAndWrite(context, 'set', {
      type: 'geo',
      ...geoArgs,
    })
    return 0
  }

  if (type === 'permission') {
    const reset = subArgs.includes('--reset')
    const name = subArgs.filter((value) => value !== '--reset')[0]
    if (!name) {
      return context.writeHelp(['set', 'permission'])
    }

    await requestAndWrite(context, 'set', {
      type: 'permission',
      name,
      ...(reset ? { reset: true } : {}),
    })
    return 0
  }

  if (type === 'ua' || type === 'timezone' || type === 'locale') {
    // 空值（--reset 或不带参数）即恢复默认，与 CDP 空字符串语义一致
    const reset = subArgs.includes('--reset')
    const value = reset ? '' : subArgs.join(' ').trim()

    await requestAndWrite(context, 'set', {
      type,
      value,
    })
    return 0
  }

  if (type === 'device') {
    await requestAndWrite(context, 'set', {
      type,
      value: subArgs.includes('--reset') ? '' : subArgs[0] || '',
    })
    return 0
  }

  if ((SET_RESETTABLE_VALUE_TYPES as readonly string[]).includes(type)) {
    await requestAndWrite(context, 'set', {
      type,
      value: subArgs.includes('--reset') ? '' : subArgs[0] || '',
    })
    return 0
  }

  if (type === 'media-type' || subArgs[0] === 'print' || subArgs[0] === 'screen') {
    await requestAndWrite(context, 'set', {
      type: 'media-type',
      value: subArgs.includes('--reset') ? '' : subArgs[0] || '',
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
  allowed: COMMAND_ACTIONS.clipboard.actions,
  handle: async (rest, context, action) => {
    if (action === 'write') {
      if (helpRequested(rest[0], context, ['clipboard', 'write'])) {
        return 0
      }
      if (rest.length === 0) {
        return throwCommandError('missing text for clipboard write')
      }
    }
    await requestAndWrite(context, 'clipboard', {
      action,
      ...(action === 'write' ? { text: rest.join(' ') } : {}),
    })
    return 0
  },
})

const handleState = createActionCommand({
  helpPath: ['state'],
  allowed: COMMAND_ACTIONS.state.actions,
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
  const action = readAllowedArg(rest[0], context, ['network'], COMMAND_ACTIONS.network.actions)
  if (!action) {
    return 0
  }

  if (action === 'route') {
    if (helpRequested(rest[1], context, ['network', 'route'])) {
      return 0
    }

    if (isCommandAction('network.route', rest[1])) {
      const pagination = parseOrThrow(() => parsePaginationArgs(rest.slice(2)))
      await requestAndWrite(context, 'network', {
        action: 'route',
        subaction: 'list',
        ...pagination,
      })
      return 0
    }

    const routeArgs = parseOrThrow(() => parseNetworkRouteArgs(rest.slice(1)))

    if (!routeArgs.url) {
      return context.writeHelp(['network', 'route'])
    }

    await requestAndWrite(context, 'network', {
      action: 'route',
      url: routeArgs.url,
      abort: routeArgs.abort,
      body: routeArgs.body,
      status: routeArgs.status,
      contentType: routeArgs.contentType,
      headers: routeArgs.headers,
      removeHeaders: routeArgs.removeHeaders,
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

  if (action === 'export') {
    if (helpRequested(rest[1], context, ['network', 'export'])) {
      return 0
    }

    const outputPath = rest[1] && !rest[1].startsWith('--') ? rest[1] : null
    const filterArgs = outputPath ? rest.slice(2) : rest.slice(1)
    const filters = parseNetworkRequestsArgs(filterArgs)

    // requests 列表默认分页（pageSize 上限 200），导出要拉全量：逐页翻到 hasNextPage=false
    const allRequests: unknown[] = []
    let total = 0
    let pageIdx = 0
    let pageSize = 200
    for (;;) {
      const payload = await context.requestCommand(context.flags.server, 'network', {
        action: 'requests',
        ...filters,
        includeDetails: true,
        pageIdx,
        pageSize,
      })

      if (payload.ok === false) {
        context.writeResult(payload)
        return 1
      }

      const result = isRecord(payload.result) ? (payload.result as Record<string, unknown>) : null
      if (!result) {
        return throwCommandError('network export requires a structured request list')
      }

      const page = Array.isArray(result.requests) ? (result.requests as unknown[]) : []
      allRequests.push(...page)
      total =
        typeof result.total === 'number' && Number.isFinite(result.total)
          ? Math.floor(result.total)
          : allRequests.length

      const pagination = isRecord(result.pagination) ? result.pagination : null
      const hasNext = pagination?.hasNextPage === true

      // 正常由 hasNextPage 终止；无分页字段（旧版扩展）时用"短页"兜底终止
      if (!hasNext || page.length === 0 || page.length < pageSize) {
        break
      }
      pageIdx += 1
    }

    const { content, recordCount } = buildNetworkRequestsJsonl(
      { total, requests: allRequests },
      filters,
    )
    const tempDir = outputPath
      ? null
      : await mkdtemp(path.join(os.tmpdir(), 'autobrowser-network-'))
    const finalPath = outputPath || path.join(tempDir || '', `network-${Date.now()}.jsonl`)
    await writeFile(finalPath, content, 'utf8')

    if (context.flags.json) {
      context.writeResult({
        ok: true,
        result: {
          path: finalPath,
          format: 'jsonl',
          recordCount,
        },
      })
      return 0
    }

    process.stdout.write(`${finalPath}\n`)
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

    const timeoutArgs = parseOrThrow(() => parseNetworkTimeoutArgs(rest.slice(2)))
    await requestAndWrite(context, 'network', {
      action: 'request',
      requestId,
      ...timeoutArgs,
    })
    return 0
  }

  if (action === 'har') {
    const subaction = readAllowedArg(
      rest[1],
      context,
      ['network', 'har'],
      COMMAND_ACTIONS['network.har'].actions,
    )
    if (!subaction) {
      return 0
    }

    if (subaction === 'start') {
      if (helpRequested(rest[2], context, ['network', 'har', 'start'])) {
        return 0
      }

      await requestAndWrite(context, 'network', {
        action: 'har',
        subaction: 'start',
        ...parseNetworkHarStartArgs(rest.slice(2)),
      })
      return 0
    }

    if (subaction === 'status') {
      await requestAndWrite(context, 'network', { action: 'har', subaction: 'status' })
      return 0
    }

    if (subaction === 'stop' || subaction === 'recover') {
      const harStopArgs = parseOrThrow(() =>
        parseNetworkHarStopArgs(rest.slice(2), subaction === 'stop'),
      )
      const outputPath = harStopArgs.outputPath
      const timeoutArgs = harStopArgs.options
      if (timeoutArgs.captureId !== undefined) {
        // Use the same ambient --tab as stop. Never send a destructive request unless
        // the extension proves it understands capture identities before stopping.
        const status = await context.requestCommand(context.flags.server, 'network', {
          action: 'har',
          subaction: 'status',
          ...(timeoutArgs.timeoutMs !== undefined ? { timeoutMs: timeoutArgs.timeoutMs } : {}),
        })
        if (!status.ok) {
          context.writeResult(status)
          return 1
        }
        if (!isRecord(status.result) || status.result.captureId !== timeoutArgs.captureId) {
          return throwCommandError(
            'HAR status did not confirm the requested captureId; stop was not sent (extension may be outdated or captureId does not match)',
          )
        }
      }
      const payload = await context.requestCommand(context.flags.server, 'network', {
        action: 'har',
        subaction,
        ...timeoutArgs,
      })

      if (payload.ok === false) {
        context.writeResult(payload)
        return 1
      }

      const result = isRecord(payload.result) ? (payload.result as NetworkHarStopResult) : undefined
      if (timeoutArgs.captureId !== undefined && result?.captureId !== timeoutArgs.captureId) {
        return throwCommandError(
          'HAR stop did not confirm the requested captureId (capture may have changed); capture may already be stopped. Use network har recover to recover the capture.',
        )
      }
      if (timeoutArgs.includeUrls && !Array.isArray(result?.urls)) {
        return throwCommandError(
          '--include-urls requires an extension that returns capture URLs; capture may already be stopped. Use network har recover to recover the capture.',
        )
      }
      const har =
        result && isRecord(result.har)
          ? result.har
          : // 这里保留 CLI 侧重建兜底，兼容旧扩展版本或 stopHar 降级为只回元数据的场景。
            await context.collectHarFromNetwork(
              context.flags.server,
              typeof result?.startedAt === 'string' ? result.startedAt : null,
            )
      const harLog = isRecord(har) && isRecord(har.log) ? har.log : null
      const entries = harLog && Array.isArray(harLog.entries) ? harLog.entries : []
      const requestCount =
        typeof result?.requestCount === 'number' ? result.requestCount : entries.length
      const savedPath = await context.writeHarFile(har, outputPath)
      if (requestCount === 0) {
        process.stderr.write(
          `Warning: HAR contains 0 entries (capture tab: ${result?.captureTabId ?? 'unknown'}). ` +
            'Verify the target with tab list, then restart capture with --tab <handle>.\n',
        )
      }
      context.writeResult({
        ok: true,
        result: timeoutArgs.includeUrls
          ? { path: savedPath, captureId: result?.captureId ?? null, urls: result?.urls }
          : savedPath,
        meta: {
          har: {
            recovered: subaction === 'recover',
            captureId: result?.captureId ?? null,
            captureTabId: result?.captureTabId ?? null,
            requestCount,
            checkpoint: result?.checkpoint ?? null,
          },
        },
      })
      return 0
    }
  }

  return throwCommandError(`unsupported network action: ${action}`)
}

export const stateCommandRegistry: CommandRegistry = {
  cookies: handleCookies,
  storage: handleStorage,
  set: handleSet,
  clipboard: handleClipboard,
  state: handleState,
  network: handleNetwork,
}
