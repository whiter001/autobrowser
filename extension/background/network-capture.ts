import type { ExtensionState, NetworkRequestRecord } from './types.js'

export const DEFAULT_HAR_MAX_REQUESTS = 1000
export const DEFAULT_HAR_MAX_BODY_BYTES = 256 * 1024
const HAR_CHECKPOINT_STORAGE_KEY = 'autobrowser.harCheckpoint'

export interface HarCapture {
  id: string
  tabId: number | null
  startedAt: string | null
  maxRequests: number | null
  maxBodyBytes: number | null
  includePattern: string | null
  excludePattern: string | null
  pending: Set<Promise<void>>
}

function getHarMaxRequests(state: ExtensionState): number | null {
  return state.network.harMaxRequests === null
    ? null
    : (state.network.harMaxRequests ?? DEFAULT_HAR_MAX_REQUESTS)
}

export function getHarMaxBodyBytes(state: ExtensionState): number | null {
  return state.network.harMaxBodyBytes === null
    ? null
    : (state.network.harMaxBodyBytes ?? DEFAULT_HAR_MAX_BODY_BYTES)
}

interface HarCaptureController {
  /** 当前 capture 会话；未录制时为 null */
  getCapture(): HarCapture | null
  /** 切换当前 capture 会话（startHar） */
  setCapture(session: HarCapture | null): void
  /** 对外的 captureId；legacy 录制状态没有真实 id，返回 null */
  getCaptureId(session: HarCapture | null): string | null
  createCapture(
    tabId: number | null,
    options?: { includePattern?: string; excludePattern?: string },
  ): HarCapture
  captureMatchesUrl(session: HarCapture, url: string): boolean
  /** 本次 capture 的导出窗口内的请求快照 */
  captureRequests(session: HarCapture | null): NetworkRequestRecord[]
  checkpointPayload(
    recording?: boolean,
    session?: HarCapture | null,
    requests?: NetworkRequestRecord[],
  ): Record<string, unknown>
  writeHarCheckpoint(payload?: Record<string, unknown>): Promise<void>
  scheduleHarCheckpoint(): void
  readHarCheckpoint(): Promise<Record<string, unknown> | null>
  /** 当前 SW 内最近一次 checkpoint 写入失败的原因 */
  getLastCheckpointError(): string | null
  clearCheckpointTimer(): void
}

/**
 * HAR 采集会话与 checkpoint 落盘：会话身份、导出窗口与断点续传都收敛在这里，
 * 网络域只负责在合适时机调用。
 */
export function createHarCaptureController({
  state,
  storageLocalGet,
  storageLocalSet,
}: {
  state: ExtensionState
  storageLocalGet: (key: string) => Promise<Record<string, unknown>>
  storageLocalSet: (items: Record<string, unknown>) => Promise<void>
}): HarCaptureController {
  let checkpointTimer: ReturnType<typeof setTimeout> | null = null
  let capture: HarCapture | null = state.network.harRecording ? createCapture(null) : null
  // Legacy recording state has no original ID; its synthetic internal identity is not public.
  const unidentifiedCapture = capture
  let checkpointWrites: Promise<void> = Promise.resolve()
  /** 当前 SW 内最近一次 checkpoint 写入失败的原因；status 用它解释「为什么 recover 可能拿不到数据」 */
  let lastCheckpointError: string | null = null

  function getCapture(): HarCapture | null {
    return capture
  }

  function setCapture(session: HarCapture | null): void {
    capture = session
  }

  function getCaptureId(session: HarCapture | null): string | null {
    return session && session !== unidentifiedCapture ? session.id : null
  }

  function createCapture(
    tabId: number | null,
    options: { includePattern?: string; excludePattern?: string } = {},
  ): HarCapture {
    return {
      id: crypto.randomUUID(),
      tabId,
      startedAt: state.network.harStartedAt,
      maxRequests: getHarMaxRequests(state),
      maxBodyBytes: getHarMaxBodyBytes(state),
      includePattern: options.includePattern || null,
      excludePattern: options.excludePattern || null,
      pending: new Set(),
    }
  }

  function captureMatchesUrl(session: HarCapture, url: string): boolean {
    if (session.includePattern && !url.includes(session.includePattern)) return false
    return !session.excludePattern || !url.includes(session.excludePattern)
  }

  function captureRequests(session: HarCapture | null): NetworkRequestRecord[] {
    const records = state.network.requests.filter((record) =>
      session
        ? (session.tabId === null || record.tabId === session.tabId) &&
          captureMatchesUrl(session, String(record.url || '')) &&
          (record.harCaptureId === session.id ||
            (record.harCaptureId === undefined &&
              (!session.startedAt || String(record.startedAt || '') >= session.startedAt)))
        : true,
    )
    const maxRequests = session?.maxRequests
    // maxRequests 只收敛本次 capture 的导出窗口：按全局插入顺序取窗口内最新 N 条。
    // 不裁剪全局缓冲，导出排序仍交给 buildHar。
    if (typeof maxRequests !== 'number') {
      return records
    }
    return maxRequests <= 0 ? [] : records.slice(-maxRequests)
  }

  function checkpointPayload(
    recording = state.network.harRecording,
    session = capture,
    requests = captureRequests(session),
  ): Record<string, unknown> {
    return {
      recording,
      captureId: getCaptureId(session),
      captureTabId: session?.tabId ?? null,
      includePattern: session?.includePattern ?? null,
      excludePattern: session?.excludePattern ?? null,
      startedAt: session?.startedAt ?? state.network.harStartedAt,
      maxRequests: session ? session.maxRequests : state.network.harMaxRequests,
      maxBodyBytes: session ? session.maxBodyBytes : state.network.harMaxBodyBytes,
      updatedAt: new Date().toISOString(),
      requests,
    }
  }

  async function writeHarCheckpoint(payload = checkpointPayload()): Promise<void> {
    // 串行落盘避免旧 stop 的慢写覆盖新 capture 的 checkpoint。
    const write = checkpointWrites.then(() =>
      storageLocalSet({
        [HAR_CHECKPOINT_STORAGE_KEY]: payload,
      }),
    )
    checkpointWrites = write.catch(() => {})
    try {
      await write
      lastCheckpointError = null
    } catch (error) {
      lastCheckpointError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  function scheduleHarCheckpoint(): void {
    if (!state.network.harRecording || checkpointTimer) return
    checkpointTimer = setTimeout(() => {
      checkpointTimer = null
      void writeHarCheckpoint().catch((error) => console.error('failed to checkpoint HAR', error))
    }, 500)
  }

  async function readHarCheckpoint(): Promise<Record<string, unknown> | null> {
    const result = await storageLocalGet(HAR_CHECKPOINT_STORAGE_KEY)
    const checkpoint = result?.[HAR_CHECKPOINT_STORAGE_KEY]
    return checkpoint && typeof checkpoint === 'object'
      ? (checkpoint as Record<string, unknown>)
      : null
  }

  function getLastCheckpointError(): string | null {
    return lastCheckpointError
  }

  function clearCheckpointTimer(): void {
    if (checkpointTimer) {
      clearTimeout(checkpointTimer)
      checkpointTimer = null
    }
  }

  return {
    getCapture,
    setCapture,
    getCaptureId,
    createCapture,
    captureMatchesUrl,
    captureRequests,
    checkpointPayload,
    writeHarCheckpoint,
    scheduleHarCheckpoint,
    readHarCheckpoint,
    getLastCheckpointError,
    clearCheckpointTimer,
  }
}
