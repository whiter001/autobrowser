import type { TabInput, TabWithId } from './types.js'

export const TRACING_MAX_BYTES = 32 * 1024 * 1024
const TRACING_COMPLETION_TIMEOUT_MS = 10_000
const encoder = new TextEncoder()

interface TracingDependencies {
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
}

interface ActiveTrace {
  startedAt: string
  completion?: {
    resolve: (stream: string) => void
    reject: (error: Error) => void
  }
}

function tracingError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

function readCompletion(
  active: ActiveTrace,
  method: string,
  params: unknown,
): { stream?: string; timeout: Promise<never> } | null {
  if (!active.completion) return null
  if (method === 'Tracing.tracingComplete') {
    const stream = (params as { stream?: string }).stream
    if (stream) active.completion.resolve(stream)
    else
      active.completion.reject(tracingError('Tracing completed without a stream', 'TRACING_ERROR'))
  }
  return null
}

export function createTracingDomain(
  { getTargetTab, sendDebuggerCommand }: TracingDependencies,
  maxBytes = TRACING_MAX_BYTES,
) {
  const activeTraces = new Map<number, ActiveTrace>()

  async function start(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    if (activeTraces.has(tab.id)) throw tracingError('Tracing is already active', 'TRACING_ACTIVE')
    const startedAt = new Date().toISOString()
    try {
      await sendDebuggerCommand(tab.id, 'Tracing.start', {
        categories: 'devtools.timeline',
        transferMode: 'ReturnAsStream',
      })
    } catch (error) {
      activeTraces.delete(tab.id)
      throw error
    }
    activeTraces.set(tab.id, { startedAt })
    return { recording: true, startedAt }
  }

  async function status(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    const active = activeTraces.get(tab.id)
    return { recording: Boolean(active), startedAt: active?.startedAt || null }
  }

  async function stop(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    const active = activeTraces.get(tab.id)
    if (!active) throw tracingError('Tracing has not been started', 'TRACING_NOT_STARTED')
    let stream = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const completed = new Promise<string>((resolve, reject) => {
        active.completion = { resolve, reject }
        timer = setTimeout(
          () => reject(tracingError('Tracing completion timed out', 'TRACING_TIMEOUT')),
          TRACING_COMPLETION_TIMEOUT_MS,
        )
      })
      await sendDebuggerCommand(tab.id, 'Tracing.end')
      stream = await completed
      const chunks: string[] = []
      let base64Encoded = false
      let bytes = 0
      for (;;) {
        const part = await sendDebuggerCommand<{
          data?: string
          eof?: boolean
          base64Encoded?: boolean
        }>(tab.id, 'IO.read', { handle: stream })
        const data = part.data || ''
        base64Encoded ||= part.base64Encoded === true
        bytes += part.base64Encoded
          ? Math.floor((data.length * 3) / 4)
          : encoder.encode(data).byteLength
        if (bytes > maxBytes)
          throw tracingError('Trace exceeds the configured size limit', 'RESPONSE_TOO_LARGE')
        chunks.push(data)
        if (part.eof) break
      }
      let data = chunks.join('')
      if (base64Encoded) {
        let binary = ''
        for (const chunk of chunks) binary += atob(chunk)
        data = btoa(binary)
      }
      return {
        recording: false,
        startedAt: active.startedAt,
        stoppedAt: new Date().toISOString(),
        data,
        base64Encoded,
        bytes,
        mimeType: 'application/json',
      }
    } finally {
      clearTimeout(timer)
      activeTraces.delete(tab.id)
      if (stream) await sendDebuggerCommand(tab.id, 'IO.close', { handle: stream }).catch(() => {})
    }
  }

  return {
    start,
    status,
    stop,
    handleEvent(source: { tabId?: number }, method: string, params: unknown): void {
      if (typeof source.tabId !== 'number') return
      const active = activeTraces.get(source.tabId)
      if (active) readCompletion(active, method, params)
    },
    handleDetach(tabId: number): void {
      const active = activeTraces.get(tabId)
      active?.completion?.reject(
        tracingError('Debugger detached during tracing', 'TRACING_DETACHED'),
      )
      activeTraces.delete(tabId)
    },
  }
}
