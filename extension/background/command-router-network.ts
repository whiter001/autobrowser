import { getPageEpoch } from './targeting.js'
import {
  readObjectArg,
  readOptionalStringArg,
  readStringArg,
  readStringArrayArg,
  type CommandRunScope,
} from './command-router-context.js'
import type { CommandArgs, ExtensionState, TabInput } from './types.js'

interface NetworkRouteCommandOptions {
  abort?: boolean
  body?: unknown
  status?: number
  contentType?: string
  headers?: Record<string, string>
  removeHeaders?: string[]
}

export interface NetworkDomain {
  routeRequest: (
    tabId: TabInput,
    url: string,
    options: NetworkRouteCommandOptions,
  ) => Promise<unknown>
  unrouteRequest: (tabId: TabInput, url: string) => Promise<unknown>
  listRoutes: () => unknown
  listRequests: (args: CommandArgs) => unknown
  getRequestDetail: (requestId: string, tabId?: number | null) => unknown
  startHar: (
    tabId: TabInput,
    options?: {
      maxRequests?: number | null
      maxBodyBytes?: number | null
      includePattern?: string
      excludePattern?: string
    },
  ) => Promise<unknown>
  stopHar: (options?: { captureId?: string; includeUrls?: boolean }) => Promise<unknown>
  getHarStatus: () => Promise<unknown>
  recoverHar: () => Promise<unknown>
}

export interface NetworkCommandDependencies {
  state: ExtensionState
  network: NetworkDomain
}

/** 网络域命令：路由拦截、请求查询与 HAR 采集 */
export function createNetworkCommandHandler({ state, network }: NetworkCommandDependencies) {
  async function handleNetworkCommand(scope: CommandRunScope): Promise<unknown> {
    const { args, action, subaction, tabId, url, requestId, queryTargetTabId } = scope
    if (action === 'route') {
      if (subaction === 'list') {
        return network.listRoutes()
      }
      const removeHeaders = readStringArrayArg(args, 'removeHeaders')
      return await network.routeRequest(tabId, url, {
        abort: args.abort === true,
        body: args.body,
        status: typeof args.status === 'number' ? args.status : undefined,
        contentType: readOptionalStringArg(args, 'contentType'),
        headers: readObjectArg(args, 'headers') as Record<string, string> | undefined,
        removeHeaders: removeHeaders.length > 0 ? removeHeaders : undefined,
      })
    }
    if (action === 'unroute') {
      return await network.unrouteRequest(tabId, readStringArg(args, 'url'))
    }
    if (action === 'requests') {
      const targetTabId = queryTargetTabId
      return network.listRequests({
        ...args,
        ...(args.allTabs === true || targetTabId === null ? {} : { tabId: targetTabId }),
        ...(args.allEpochs === true
          ? {}
          : args.allTabs === true
            ? { currentEpochs: Object.fromEntries(state.targeting.pageEpochs) }
            : targetTabId === null
              ? {}
              : { pageEpoch: getPageEpoch(state, targetTabId) }),
      })
    }
    if (action === 'request') {
      return network.getRequestDetail(requestId, queryTargetTabId)
    }
    if (action === 'har') {
      if (subaction === 'start') {
        return await network.startHar(tabId, {
          maxRequests:
            typeof args.maxRequests === 'number' || args.maxRequests === null
              ? (args.maxRequests as number | null)
              : undefined,
          maxBodyBytes:
            typeof args.maxBodyBytes === 'number' || args.maxBodyBytes === null
              ? (args.maxBodyBytes as number | null)
              : undefined,
          includePattern: readOptionalStringArg(args, 'includePattern'),
          excludePattern: readOptionalStringArg(args, 'excludePattern'),
        })
      }
      if (subaction === 'stop') {
        return await network.stopHar({
          captureId: typeof args.captureId === 'string' ? args.captureId : undefined,
          includeUrls: typeof args.includeUrls === 'boolean' ? args.includeUrls : undefined,
        })
      }
      if (subaction === 'status') {
        return await network.getHarStatus()
      }
      if (subaction === 'recover') {
        return await network.recoverHar()
      }
      throw new Error(`unsupported network har action: ${subaction}`)
    }
    throw new Error(`unsupported network action: ${action}`)
  }

  return { handleNetworkCommand }
}
