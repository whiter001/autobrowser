import type { DownloadRecord, ExtensionState } from './types.js'
import { paginateList } from './pagination.js'

/** downloads 缓冲的绝对上限（FIFO 淘汰），避免长时间运行内存无界增长 */
const DOWNLOADS_BUFFER_MAX = 200

interface DownloadItemLike {
  id?: number
  url?: string
  filename?: string
  state?: string
  bytesReceived?: number
  totalBytes?: number
  danger?: string
  startTime?: string
  endTime?: string | null
  error?: string | null
}

/** chrome.downloads.onChanged 的 DownloadDelta：字段是 { current, previous } 结构，这里只取 current。
 * Chrome 从不在 DownloadDelta 里下发 bytesReceived，进度只能靠 chrome.downloads.search 快照补齐。 */
interface DownloadDeltaLike {
  id?: number
  url?: { current?: string }
  filename?: { current?: string }
  state?: { current?: string }
  totalBytes?: { current?: number }
  danger?: { current?: string }
  endTime?: { current?: string | null }
  error?: { current?: string | null }
}

export interface DownloadsDomainOptions {
  /** 终态刷新用的快照查询，默认走 chrome.downloads.search；测试可注入 */
  searchDownloads?: (query: { id: number }) => Promise<DownloadItemLike[]>
}

export interface DownloadsDomain {
  /** chrome.downloads.onCreated 回调：新增或合并一条记录 */
  handleCreated: (item: DownloadItemLike) => void
  /** chrome.downloads.onChanged 回调：按 id 合并 delta，并在完成/中断时异步刷新进度快照 */
  handleChanged: (delta: DownloadDeltaLike) => Promise<void>
  /** list（默认 subaction）：复用 paginateList 分页 */
  listDownloads: (
    pageIdx?: number,
    pageSize?: number,
  ) => {
    downloads: DownloadRecord[]
    total: number
    pagination: ReturnType<typeof paginateList>['pagination']
  }
  clearDownloads: () => { cleared: number }
  /** 注册 chrome.downloads.onCreated/onChanged 监听（依赖 manifest 的 downloads 权限） */
  registerChromeListeners: () => void
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

const defaultSearchDownloads = async (query: { id: number }): Promise<DownloadItemLike[]> => {
  // 无 downloads 权限（未声明权限的构建）时静默降级为无快照
  if (typeof chrome === 'undefined' || typeof chrome.downloads?.search !== 'function') {
    return []
  }
  return (await chrome.downloads.search(query)) as DownloadItemLike[]
}

/** 快照作废后的补偿查询次数上限，防止持续有 delta 时无限重查 */
const SNAPSHOT_RETRY_LIMIT = 2

export function createDownloadsDomain(
  state: ExtensionState,
  options: DownloadsDomainOptions = {},
): DownloadsDomain {
  const searchDownloads = options.searchDownloads || defaultSearchDownloads
  /** 只保留缓冲内 id 的写入 token；全局递增，FIFO 回收后同 id 重建也不会出现 ABA */
  const revisions = new Map<number, number>()
  let writeToken = 0
  /** clear 的代次：清空后到达的旧快照一律作废，避免写进重新出现的同 id 记录 */
  let clearEpoch = 0

  function upsertDownload(record: DownloadRecord): void {
    revisions.set(record.id, ++writeToken)
    const existingIndex = state.session.downloads.findIndex((item) => item.id === record.id)
    if (existingIndex !== -1) {
      // 按 id 合并：onChanged 的 delta 只覆盖出现的字段，不重置其它字段
      state.session.downloads[existingIndex] = {
        ...state.session.downloads[existingIndex],
        ...record,
      }
      return
    }

    state.session.downloads.push(record)
    // FIFO 淘汰最旧的记录，版本表同步回收，避免长期运行后无界增长
    if (state.session.downloads.length > DOWNLOADS_BUFFER_MAX) {
      const removed = state.session.downloads.splice(
        0,
        state.session.downloads.length - DOWNLOADS_BUFFER_MAX,
      )
      for (const item of removed) revisions.delete(item.id)
    }
  }

  /**
   * 完成/中断后用 search 快照补齐 delta 里没有的进度字段。
   * 查询期间若又来了 delta，旧快照整份作废（状态变了，进度也随之失效），
   * 改为在预算内重新查询一次，避免 bytesReceived 永久停在 0。
   */
  async function refreshDownloadSnapshot(
    id: number,
    revision: number,
    epoch: number,
    attempt = 0,
  ): Promise<void> {
    let items: DownloadItemLike[]
    try {
      items = await searchDownloads({ id })
    } catch {
      // 快照拿不到只是缺进度字段，delta 已合并的状态仍然可用
      return
    }

    if (epoch !== clearEpoch) {
      // 查询期间缓冲被 clear，旧快照无处可写
      return
    }

    if ((revisions.get(id) ?? 0) !== revision) {
      const stillBuffered = state.session.downloads.some((entry) => entry.id === id)
      if (attempt < SNAPSHOT_RETRY_LIMIT && stillBuffered) {
        await refreshDownloadSnapshot(id, revisions.get(id) ?? 0, epoch, attempt + 1)
      }
      return
    }

    const current = state.session.downloads.find((entry) => entry.id === id)
    const item = items.find((candidate) => asNumber(candidate?.id) === id)
    if (!current || !item) {
      return
    }

    const patch: Partial<DownloadRecord> = {}
    const url = asString(item.url)
    const filename = asString(item.filename)
    const bytesReceived = asNumber(item.bytesReceived)
    const totalBytes = asNumber(item.totalBytes)
    const danger = asString(item.danger)
    const startTime = asString(item.startTime)
    const stateValue = asString(item.state)
    if (url !== null) patch.url = url
    if (filename !== null) patch.filename = filename
    if (bytesReceived !== null) patch.bytesReceived = bytesReceived
    if (totalBytes !== null) patch.totalBytes = totalBytes
    if (danger !== null) patch.danger = danger
    if (startTime !== null) patch.startTime = startTime
    // 快照只允许推进到终态，不能把已经完成/中断的记录退回 in_progress
    if (stateValue !== null && stateValue !== 'in_progress') patch.state = stateValue
    if (item.endTime != null) patch.endTime = asString(item.endTime)
    if (item.error != null) patch.error = asString(item.error)

    // 按 id 原地合并，保留缓冲顺序与分页位置
    upsertDownload({ ...current, ...patch })
  }

  function handleCreated(item: DownloadItemLike): void {
    const id = asNumber(item.id)
    if (id === null) {
      return
    }

    upsertDownload({
      id,
      url: asString(item.url) ?? '',
      filename: asString(item.filename) ?? '',
      state: asString(item.state) ?? 'in_progress',
      bytesReceived: asNumber(item.bytesReceived) ?? 0,
      totalBytes: asNumber(item.totalBytes) ?? 0,
      danger: asString(item.danger) ?? '',
      startTime: asString(item.startTime) ?? new Date().toISOString(),
      ...(item.endTime != null ? { endTime: asString(item.endTime) } : {}),
      ...(item.error != null ? { error: asString(item.error) } : {}),
    })
  }

  async function handleChanged(delta: DownloadDeltaLike): Promise<void> {
    const id = asNumber(delta.id)
    if (id === null) {
      return
    }

    // onChanged 可能先于 onCreated 到达（监听器注册晚于下载开始），
    // 此时用 delta 能提供的最小骨架建一条记录，避免下载完全不可见
    const existing = state.session.downloads.find((item) => item.id === id)
    const base: DownloadRecord = existing ?? {
      id,
      url: '',
      filename: '',
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: 0,
      danger: '',
      startTime: new Date().toISOString(),
    }

    const patch: Partial<DownloadRecord> = {}
    const url = asString(delta.url?.current)
    const filename = asString(delta.filename?.current)
    const stateValue = asString(delta.state?.current)
    const totalBytes = asNumber(delta.totalBytes?.current)
    const danger = asString(delta.danger?.current)
    const endTime = delta.endTime?.current
    const error = delta.error?.current

    if (url !== null) patch.url = url
    if (filename !== null) patch.filename = filename
    if (stateValue !== null) patch.state = stateValue
    if (totalBytes !== null) patch.totalBytes = totalBytes
    if (danger !== null) patch.danger = danger
    // endTime/error 的 current 可能是显式 null（如 error 清空），undefined 才是缺省
    if (endTime !== undefined) patch.endTime = endTime === null ? null : endTime
    if (error !== undefined) patch.error = error === null ? null : error

    upsertDownload({ ...base, ...patch })

    // 终态时刷新一次快照，拿到 delta 不提供的 bytesReceived/totalBytes 等进度
    if (patch.state === 'complete' || patch.state === 'interrupted') {
      await refreshDownloadSnapshot(id, revisions.get(id) ?? 0, clearEpoch)
    }
  }

  function listDownloads(pageIdx?: number, pageSize?: number) {
    const { items, pagination } = paginateList(state.session.downloads, pageIdx, pageSize)
    return {
      downloads: items,
      total: state.session.downloads.length,
      pagination,
    }
  }

  function clearDownloads(): { cleared: number } {
    const cleared = state.session.downloads.length
    state.session.downloads = []
    // 版本表随缓冲一起回收，并推进 clear 代次让在途快照失效
    revisions.clear()
    clearEpoch += 1
    return { cleared }
  }

  function registerChromeListeners(): void {
    // manifest 未声明 downloads 权限时（如旧版构建）静默跳过，避免启动报错
    if (!chrome.downloads) {
      return
    }
    chrome.downloads.onCreated.addListener((item) => handleCreated(item))
    chrome.downloads.onChanged.addListener((delta) => {
      void handleChanged(delta)
    })
  }

  return {
    handleCreated,
    handleChanged,
    listDownloads,
    clearDownloads,
    registerChromeListeners,
  }
}
