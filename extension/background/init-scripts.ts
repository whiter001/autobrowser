import type { ExtensionState, InitScriptRecord } from './types.js'

type SendDebuggerCommand = <TResult = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
) => Promise<TResult>

/** 只依赖读/写两个动作：生产接 chrome.storage.local，测试塞内存实现 */
export interface InitScriptStorage {
  get: <T extends Record<string, unknown> = Record<string, unknown>>(
    keys: string | string[] | null,
  ) => Promise<T>
  set: (items: Record<string, unknown>) => Promise<void>
}

interface InitScriptDomainDependencies {
  state: ExtensionState
  sendRawDebuggerCommand: SendDebuggerCommand
  // 缺省时退化为纯内存（旧行为），便于单测与不支持 storage.session 的环境
  storage?: InitScriptStorage
}

/** list/add 返回值里的源码预览：压平空白并截断，避免把整段脚本塞进每个响应 */
const SOURCE_PREVIEW_MAX_LENGTH = 120

export const INIT_SCRIPTS_STORAGE_KEY = 'autobrowser.initScripts'
const STORAGE_VERSION = 1

interface PersistedInitScript {
  id: string
  source: string
  createdAt: string
}

function createInitScriptId(): string {
  return `script_${crypto.randomUUID().replaceAll('-', '')}`
}

function previewInitScriptSource(source: string): string {
  const flattened = source.replace(/\s+/g, ' ').trim()
  return flattened.length > SOURCE_PREVIEW_MAX_LENGTH
    ? `${flattened.slice(0, SOURCE_PREVIEW_MAX_LENGTH)}…`
    : flattened
}

function summarizeInitScript(record: InitScriptRecord): Record<string, unknown> {
  return {
    id: record.id,
    preview: previewInitScriptSource(record.source),
    sourceLength: record.source.length,
    createdAt: record.createdAt,
    registeredTabs: Array.from(record.identifiersByTab.keys()),
  }
}

/** 落盘数据一律重新校验：storage 里的内容可能来自旧版本或被外部改写 */
function parsePersistedScripts(raw: unknown): PersistedInitScript[] {
  if (!raw || typeof raw !== 'object') {
    return []
  }
  const record = raw as { version?: unknown; scripts?: unknown }
  if (record.version !== STORAGE_VERSION || !Array.isArray(record.scripts)) {
    return []
  }
  return record.scripts.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return []
    }
    const candidate = item as Record<string, unknown>
    const { id, source, createdAt } = candidate
    if (typeof id !== 'string' || !id || typeof source !== 'string' || !source) {
      return []
    }
    return [{ id, source, createdAt: typeof createdAt === 'string' ? createdAt : '' }]
  })
}

/**
 * 创建注入脚本域：注册/移除在页面加载前执行的初始化脚本。
 */
export function createInitScriptDomain({
  state,
  sendRawDebuggerCommand,
  storage,
}: InitScriptDomainDependencies) {
  let hydratePromise: Promise<void> | null = null

  /**
   * 从 storage.local 还原脚本清单。MV3 service worker 被回收、扩展被重载后内存态全丢，
   * 没有这一步 replayForTab 就再也不会注册任何脚本，表现为"重连后 script list 为空"。
   * identifier 属于旧 CDP 会话，恢复时一律丢弃，交给重新 attach 的 replay 重建。
   */
  function ensureHydrated(): Promise<void> {
    if (!storage) {
      return Promise.resolve()
    }
    hydratePromise ??= (async () => {
      try {
        const stored = await storage.get<Record<string, unknown>>([INIT_SCRIPTS_STORAGE_KEY])
        const restored = parsePersistedScripts(stored[INIT_SCRIPTS_STORAGE_KEY])
        const existingIds = new Set(state.initScripts.map((script) => script.id))
        for (const script of restored) {
          if (existingIds.has(script.id)) {
            continue
          }
          state.initScripts.push({ ...script, identifiersByTab: new Map() })
        }
      } catch (error) {
        // 还原失败不该让命令直接失败：最坏退化成本次会话不记得旧脚本
        console.warn('failed to restore init scripts from storage', error)
      }
    })()
    return hydratePromise
  }

  async function persist(): Promise<void> {
    if (!storage) {
      return
    }
    const scripts: PersistedInitScript[] = state.initScripts.map(({ id, source, createdAt }) => ({
      id,
      source,
      createdAt,
    }))
    try {
      await storage.set({ [INIT_SCRIPTS_STORAGE_KEY]: { version: STORAGE_VERSION, scripts } })
    } catch (error) {
      // 持久化失败时本次注册仍然有效，只是跨重启/重载不再恢复
      console.warn('failed to persist init scripts to storage', error)
    }
  }

  async function registerOnTab(tabId: number, record: InitScriptRecord): Promise<void> {
    const result = await sendRawDebuggerCommand<{ identifier?: string }>(
      tabId,
      'Page.addScriptToEvaluateOnNewDocument',
      { source: record.source },
    )
    if (typeof result?.identifier === 'string' && result.identifier) {
      record.identifiersByTab.set(tabId, result.identifier)
    }
  }

  async function addScript(source: string): Promise<Record<string, unknown>> {
    await ensureHydrated()
    const record: InitScriptRecord = {
      id: createInitScriptId(),
      source,
      createdAt: new Date().toISOString(),
      identifiersByTab: new Map(),
    }
    state.initScripts.push(record)
    // 先落盘再注册：注册可能失败，配置本身必须留下来
    await persist()
    // 已 attach 的 tab 立即注册；之后新 attach 的 tab 由 replayForTab 补齐
    const attachedTabs = Array.from(state.targeting.attachedTabs)
    const results = await Promise.allSettled(
      attachedTabs.map((tabId) => registerOnTab(tabId, record)),
    )
    // allSettled 会吞掉失败，旧实现于是出现"ok: true + registeredTabs: []"这种看不出
    // 到底有没有生效的响应。注册失败明细与"只保存了配置"的语义都必须显式交出来。
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              tabId: attachedTabs[index],
              message:
                result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
          ]
        : [],
    )
    const warnings: string[] = []
    if (attachedTabs.length === 0) {
      warnings.push(
        'no tab is attached to the extension: the script is stored as configuration only and is registered on no tab; ' +
          'it will be registered when a tab attaches, and it only runs on the next document load',
      )
    }
    if (failures.length > 0) {
      warnings.push(
        String(failures.length) +
          ' attached tab(s) failed to register: the script will not run there until the tab is re-attached',
      )
    }
    return {
      script: summarizeInitScript(record),
      scripts: state.initScripts.map(summarizeInitScript),
      registration: {
        // addScriptToEvaluateOnNewDocument 只影响之后加载的文档，当前页面不会立刻注入
        appliesTo: 'next-document-load',
        attachedTabs,
        failures,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    }
  }

  async function listScripts(): Promise<Record<string, unknown>> {
    await ensureHydrated()
    return { scripts: state.initScripts.map(summarizeInitScript) }
  }

  async function removeScripts(record: InitScriptRecord): Promise<void> {
    await Promise.allSettled(
      Array.from(record.identifiersByTab.entries()).map(async ([tabId, identifier]) => {
        // tab 已 detach 时旧会话的 identifier 随之失效，无需也无法再移除
        if (!state.targeting.attachedTabs.has(tabId)) {
          return
        }
        await sendRawDebuggerCommand(tabId, 'Page.removeScriptToEvaluateOnNewDocument', {
          identifier,
        })
      }),
    )
    record.identifiersByTab.clear()
  }

  async function removeScript(id: string): Promise<Record<string, unknown>> {
    await ensureHydrated()
    const record = state.initScripts.find((script) => script.id === id)
    if (!record) {
      throw new Error(`init script not found: ${id}`)
    }

    await removeScripts(record)
    state.initScripts = state.initScripts.filter((script) => script.id !== id)
    await persist()
    return {
      removed: id,
      scripts: state.initScripts.map(summarizeInitScript),
    }
  }

  async function removeAllScripts(): Promise<Record<string, unknown>> {
    await ensureHydrated()
    const removed = state.initScripts.map((script) => script.id)
    await Promise.all(state.initScripts.map((record) => removeScripts(record)))
    state.initScripts = []
    await persist()
    return { removed, scripts: [] }
  }

  /** debugger attach（含重连）后把已注册脚本在新 CDP 会话上重新注册一遍，否则导航后不再注入 */
  async function replayForTab(tabId: number): Promise<void> {
    // attach 通常发生在 SW 刚被唤醒时，先把持久化的脚本捞回来再重放
    await ensureHydrated()
    if (state.initScripts.length === 0) {
      return
    }

    await Promise.allSettled(state.initScripts.map((record) => registerOnTab(tabId, record)))
  }

  return {
    addScript,
    listScripts,
    removeScript,
    removeAllScripts,
    replayForTab,
  }
}
