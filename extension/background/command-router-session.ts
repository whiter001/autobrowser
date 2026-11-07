import { createToolError } from '../../src/core/tool-error.js'
import {
  readBooleanArg,
  readHeadersArg,
  readNumberArg,
  readOptionalStringArg,
  readSavedStateArg,
  readStringArg,
  type CommandRunScope,
} from './command-router-context.js'
import type { ExtensionState, FrameSelector, SavedStateData, TabInput } from './types.js'

export interface SessionDomain {
  getDialogStatus: (tabId?: TabInput) => Record<string, unknown>
  handleDialog: (tabId: TabInput, accept: boolean, promptText?: string) => Promise<unknown>
  getDialogAutoAccept: () => boolean
  setDialogAutoAccept: (enabled: boolean) => { autoAccept: boolean }
  cookiesGet: (tabId: TabInput, filters?: { domain?: string; path?: string }) => Promise<unknown>
  cookiesSet: (tabId: TabInput, name: string, value: string, domain?: string) => Promise<unknown>
  cookiesClear: (tabId: TabInput) => Promise<unknown>
  cookiesDelete: (tabId: TabInput, name: string) => Promise<unknown>
  storageGet: (
    tabId: TabInput,
    key: string | null | undefined,
    frameSelector: FrameSelector,
    sessionOnly?: boolean,
  ) => Promise<unknown>
  storageSet: (
    tabId: TabInput,
    key: string,
    value: string,
    frameSelector: FrameSelector,
    sessionOnly?: boolean,
  ) => Promise<unknown>
  storageDelete: (
    tabId: TabInput,
    key: string,
    frameSelector: FrameSelector,
    sessionOnly?: boolean,
  ) => Promise<unknown>
  storageClear: (
    tabId: TabInput,
    frameSelector: FrameSelector,
    sessionOnly?: boolean,
  ) => Promise<unknown>
  setViewport: (
    tabId: TabInput,
    width: number,
    height: number,
    deviceScaleFactor?: number,
    mobile?: boolean,
  ) => Promise<unknown>
  setOffline: (tabId: TabInput, enabled: boolean) => Promise<unknown>
  setHeaders: (
    tabId: TabInput,
    headers: Array<{ name?: string; value?: unknown }> | Record<string, unknown> | null | undefined,
  ) => Promise<unknown>
  setGeo: (
    tabId: TabInput,
    latitude: number,
    longitude: number,
    accuracy?: number,
  ) => Promise<unknown>
  setMedia: (tabId: TabInput, media: string | null | undefined) => Promise<unknown>
  setMediaType: (tabId: TabInput, mediaType: string | null | undefined) => Promise<unknown>
  setMediaFeature: (
    tabId: TabInput,
    name: string,
    value: string | null | undefined,
  ) => Promise<unknown>
  setDevice: (tabId: TabInput, name: string | null | undefined) => Promise<unknown>
  setPermission: (tabId: TabInput, name: string, reset?: boolean) => Promise<unknown>
  setUserAgent: (tabId: TabInput, userAgent: string | null | undefined) => Promise<unknown>
  setTimezone: (tabId: TabInput, timezone: string | null | undefined) => Promise<unknown>
  setLocale: (tabId: TabInput, locale: string | null | undefined) => Promise<unknown>
  generatePdf: (tabId: TabInput) => Promise<unknown>
  clipboardRead: (tabId: TabInput) => Promise<unknown>
  clipboardWrite: (tabId: TabInput, text: string) => Promise<unknown>
  saveState: (tabId: TabInput, name: string) => Promise<unknown>
  loadState: (tabId: TabInput, stateData: SavedStateData) => Promise<unknown>
  loadStateByName: (tabId: TabInput, name: string) => Promise<unknown>
}

interface SessionCommandDependencies {
  state: ExtensionState
  session: SessionDomain
}

/** 会话域命令：对话框、Cookie/存储、仿真覆盖、剪贴板与页面状态存取 */
export function createSessionCommandHandler({ state, session }: SessionCommandDependencies) {
  async function handleSessionCommand(scope: CommandRunScope): Promise<unknown> {
    const { command, args, action, tabId, frameSelector } = scope
    switch (command) {
      case 'dialog': {
        const accept = readBooleanArg(args, 'accept', true)
        const promptText = readOptionalStringArg(args, 'promptText')
        if (action === 'status') {
          return session.getDialogStatus(tabId)
        }
        if (action === 'auto') {
          // 不带 enabled 时只查询当前值；默认值 true 与扩展重启后的初始状态一致
          if (args.enabled === undefined) {
            return {
              autoAccept: session.getDialogAutoAccept(),
              note: 'dialogAutoAccept is a runtime-only setting; it resets to true when the extension restarts',
            }
          }
          return session.setDialogAutoAccept(readBooleanArg(args, 'enabled', true))
        }
        return await session.handleDialog(tabId, accept, promptText)
      }
      case 'cookies': {
        const name = readStringArg(args, 'name', 'default')
        const value = readStringArg(args, 'value')
        const domain = readOptionalStringArg(args, 'domain')
        if (action === 'list' || action === 'get') {
          return await session.cookiesGet(tabId, {
            domain: readOptionalStringArg(args, 'domain'),
            path: readOptionalStringArg(args, 'path'),
          })
        }
        if (action === 'set') {
          return await session.cookiesSet(tabId, name, value, domain)
        }
        if (action === 'clear') {
          return await session.cookiesClear(tabId)
        }
        if (action === 'delete') {
          if (!name || name === 'default') {
            throw createToolError('INVALID_COMMAND_ARGS', 'cookies delete requires a cookie name', {
              details: { field: 'name', expected: 'non-empty cookie name', received: name },
            })
          }
          return await session.cookiesDelete(tabId, name)
        }
        throw new Error(`unsupported cookies action: ${action}`)
      }
      case 'storage': {
        const sessionOnly = readBooleanArg(args, 'session', false)
        const storageKey = readOptionalStringArg(args, 'key')
        const storageValue = readStringArg(args, 'value')
        if (action === 'get') {
          return await session.storageGet(tabId, storageKey, frameSelector, sessionOnly)
        }
        if (action === 'set') {
          return await session.storageSet(
            tabId,
            storageKey || '',
            storageValue,
            frameSelector,
            sessionOnly,
          )
        }
        if (action === 'delete') {
          if (!storageKey) {
            throw createToolError('INVALID_COMMAND_ARGS', 'storage delete requires a key', {
              details: { field: 'key', expected: 'non-empty storage key', received: storageKey },
            })
          }
          return await session.storageDelete(tabId, storageKey, frameSelector, sessionOnly)
        }
        if (action === 'clear') {
          return await session.storageClear(tabId, frameSelector, sessionOnly)
        }
        throw new Error(`unsupported storage action: ${action}`)
      }
      case 'set': {
        const viewportWidth = readNumberArg(args, 'width', 0)
        const viewportHeight = readNumberArg(args, 'height', 0)
        const deviceScaleFactor = readNumberArg(args, 'deviceScaleFactor', 1)
        const mobile = readBooleanArg(args, 'mobile', false)
        const enabled = readBooleanArg(args, 'enabled', true)
        const headers = readHeadersArg(args, 'headers')
        const latitude = readNumberArg(args, 'latitude', 0)
        const longitude = readNumberArg(args, 'longitude', 0)
        const accuracy = readNumberArg(args, 'accuracy', 1)
        const media = readOptionalStringArg(args, 'media')
        const value = readStringArg(args, 'value')
        const name = readStringArg(args, 'name', 'default')
        if (readStringArg(args, 'type') === 'viewport') {
          return await session.setViewport(
            tabId,
            viewportWidth,
            viewportHeight,
            deviceScaleFactor,
            mobile,
          )
        }
        if (readStringArg(args, 'type') === 'offline') {
          return await session.setOffline(tabId, enabled)
        }
        if (readStringArg(args, 'type') === 'auto-snapshot') {
          state.session.autoSnapshot = enabled
          return { autoSnapshot: enabled }
        }
        if (readStringArg(args, 'type') === 'headers') {
          return await session.setHeaders(tabId, headers)
        }
        if (readStringArg(args, 'type') === 'geo') {
          return await session.setGeo(tabId, latitude, longitude, accuracy)
        }
        if (readStringArg(args, 'type') === 'media') {
          return await session.setMedia(tabId, media)
        }
        if (readStringArg(args, 'type') === 'media-type') {
          return await session.setMediaType(tabId, value || null)
        }
        if (readStringArg(args, 'type') === 'reduced-motion') {
          return await session.setMediaFeature(tabId, 'prefers-reduced-motion', value || null)
        }
        if (readStringArg(args, 'type') === 'forced-colors') {
          return await session.setMediaFeature(tabId, 'forced-colors', value || null)
        }
        if (readStringArg(args, 'type') === 'contrast') {
          return await session.setMediaFeature(tabId, 'prefers-contrast', value || null)
        }
        if (readStringArg(args, 'type') === 'device') {
          return await session.setDevice(tabId, value || null)
        }
        if (readStringArg(args, 'type') === 'permission') {
          return await session.setPermission(tabId, name, readBooleanArg(args, 'reset', false))
        }
        if (readStringArg(args, 'type') === 'ua') {
          return await session.setUserAgent(tabId, value || null)
        }
        if (readStringArg(args, 'type') === 'timezone') {
          return await session.setTimezone(tabId, value || null)
        }
        if (readStringArg(args, 'type') === 'locale') {
          return await session.setLocale(tabId, value || null)
        }
        throw new Error(`unsupported set type: ${readStringArg(args, 'type')}`)
      }
      case 'pdf':
        return await session.generatePdf(tabId)
      case 'clipboard': {
        const text = readStringArg(args, 'text')
        if (action === 'read') {
          return await session.clipboardRead(tabId)
        }
        if (action === 'write') {
          return await session.clipboardWrite(tabId, text)
        }
        throw new Error(`unsupported clipboard action: ${action}`)
      }
      case 'state': {
        const name = readStringArg(args, 'name', 'default')
        const savedStateData = readSavedStateArg(args, 'data')
        if (action === 'save') {
          return await session.saveState(tabId, name)
        }
        if (action === 'load') {
          if (savedStateData) {
            return await session.loadState(tabId, savedStateData)
          }

          return await session.loadStateByName(tabId, name)
        }
        throw new Error(`unsupported state action: ${action}`)
      }
      default:
        throw new Error(`unsupported command: ${command}`)
    }
  }

  return { handleSessionCommand }
}
