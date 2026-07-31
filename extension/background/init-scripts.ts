import type { ExtensionState, InitScriptRecord } from './types.js'

type SendDebuggerCommand = <TResult = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
) => Promise<TResult>

interface InitScriptDomainDependencies {
  state: ExtensionState
  sendRawDebuggerCommand: SendDebuggerCommand
}

/** list/add 返回值里的源码预览：压平空白并截断，避免把整段脚本塞进每个响应 */
const SOURCE_PREVIEW_MAX_LENGTH = 120

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

export function createInitScriptDomain({
  state,
  sendRawDebuggerCommand,
}: InitScriptDomainDependencies) {
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
    const record: InitScriptRecord = {
      id: createInitScriptId(),
      source,
      createdAt: new Date().toISOString(),
      identifiersByTab: new Map(),
    }
    state.initScripts.push(record)
    // 已 attach 的 tab 立即注册；之后新 attach 的 tab 由 replayForTab 补齐
    await Promise.allSettled(
      Array.from(state.targeting.attachedTabs).map((tabId) => registerOnTab(tabId, record)),
    )
    return {
      script: summarizeInitScript(record),
      scripts: state.initScripts.map(summarizeInitScript),
    }
  }

  function listScripts(): Record<string, unknown> {
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
    const record = state.initScripts.find((script) => script.id === id)
    if (!record) {
      throw new Error(`init script not found: ${id}`)
    }

    await removeScripts(record)
    state.initScripts = state.initScripts.filter((script) => script.id !== id)
    return {
      removed: id,
      scripts: state.initScripts.map(summarizeInitScript),
    }
  }

  async function removeAllScripts(): Promise<Record<string, unknown>> {
    const removed = state.initScripts.map((script) => script.id)
    await Promise.all(state.initScripts.map((record) => removeScripts(record)))
    state.initScripts = []
    return { removed, scripts: [] }
  }

  /** debugger attach（含重连）后把已注册脚本在新 CDP 会话上重新注册一遍，否则导航后不再注入 */
  async function replayForTab(tabId: number): Promise<void> {
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
