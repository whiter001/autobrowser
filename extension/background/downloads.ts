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

/** chrome.downloads.onChanged 的 DownloadDelta：字段是 { current, previous } 结构，这里只取 current */
interface DownloadDeltaLike {
  id?: number
  url?: { current?: string }
  filename?: { current?: string }
  state?: { current?: string }
  bytesReceived?: { current?: number }
  totalBytes?: { current?: number }
  danger?: { current?: string }
  endTime?: { current?: string | null }
  error?: { current?: string | null }
}

export interface DownloadsDomain {
  /** chrome.downloads.onCreated 回调：新增或合并一条记录 */
  handleCreated: (item: DownloadItemLike) => void
  /** chrome.downloads.onChanged 回调：按 id 合并 delta 到已有记录 */
  handleChanged: (delta: DownloadDeltaLike) => void
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

export function createDownloadsDomain(state: ExtensionState): DownloadsDomain {
  function upsertDownload(record: DownloadRecord): void {
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
    // FIFO 淘汰最旧的记录
    if (state.session.downloads.length > DOWNLOADS_BUFFER_MAX) {
      state.session.downloads.splice(0, state.session.downloads.length - DOWNLOADS_BUFFER_MAX)
    }
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

  function handleChanged(delta: DownloadDeltaLike): void {
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
    const bytesReceived = asNumber(delta.bytesReceived?.current)
    const totalBytes = asNumber(delta.totalBytes?.current)
    const danger = asString(delta.danger?.current)
    const endTime = delta.endTime?.current
    const error = delta.error?.current

    if (url !== null) patch.url = url
    if (filename !== null) patch.filename = filename
    if (stateValue !== null) patch.state = stateValue
    if (bytesReceived !== null) patch.bytesReceived = bytesReceived
    if (totalBytes !== null) patch.totalBytes = totalBytes
    if (danger !== null) patch.danger = danger
    // endTime/error 的 current 可能是显式 null（如 error 清空），undefined 才是缺省
    if (endTime !== undefined) patch.endTime = endTime === null ? null : endTime
    if (error !== undefined) patch.error = error === null ? null : error

    upsertDownload({ ...base, ...patch })
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
    return { cleared }
  }

  function registerChromeListeners(): void {
    // manifest 未声明 downloads 权限时（如旧版构建）静默跳过，避免启动报错
    if (!chrome.downloads) {
      return
    }
    chrome.downloads.onCreated.addListener((item) => handleCreated(item))
    chrome.downloads.onChanged.addListener((delta) => handleChanged(delta))
  }

  return {
    handleCreated,
    handleChanged,
    listDownloads,
    clearDownloads,
    registerChromeListeners,
  }
}
