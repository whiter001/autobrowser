import { createHash } from 'node:crypto'

export interface FeedCollectSpec {
  selector?: string
  limit?: number
  dedupe?: 'url' | 'text' | 'none'
  maxScrolls?: number
  pauseMs?: number
  stallRounds?: number
  nextSelector?: string
  waitTimeoutMs?: number
}

export interface NetworkCollectSpec {
  urlPattern: string
  itemsPath: string
  nextPath?: string
}

export interface CollectSpec {
  name: string
  mode: 'feed' | 'network'
  startUrl?: string
  output: string
  maxPages?: number
  feed?: FeedCollectSpec
  network?: NetworkCollectSpec
}

interface CollectItemMeta {
  task: string
  mode: 'feed' | 'network'
  page: number
  sourceUrl: string
  requestId?: string
  pageEpoch?: number
}

export interface CollectItem extends Record<string, unknown> {
  _meta: CollectItemMeta
}

export interface CollectFailure {
  at: string
  page: number
  sourceUrl: string
  message: string
  code: string
}

export type CollectStatus = 'running' | 'completed' | 'failed'

interface CollectCheckpointBase {
  spec: CollectSpec
  status: CollectStatus
  nextUrl: string
  nextPage: number
  failures: CollectFailure[]
}

/**
 * v1 检查点：全部条目都存在 checkpoint 里，每翻一页就要整份重写 checkpoint 与输出文件。
 * 只用于识别旧 checkpoint 并做一次性迁移，新任务不再产出这种结构。
 */
export interface CollectCheckpointV1 extends CollectCheckpointBase {
  version: 1
  items: CollectItem[]
}

/**
 * v2 检查点：条目只写进输出 JSONL，checkpoint 只保留游标、计数与失败记录。
 * 追加式输出让每页的落盘成本与已有数据量无关，checkpoint 也始终保持很小。
 */
export interface CollectCheckpointV2 extends CollectCheckpointBase {
  version: 2
  itemCount: number
  warnings?: string[]
}

export type CollectCheckpoint = CollectCheckpointV1 | CollectCheckpointV2

/**
 * 判断值是否是普通对象。collect 的输入来自用户提供的 JSON，需要先收窄再取字段。
 */
export function isCollectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 按 `a.b.0.c` 形式读取 JSON 路径，数字段按数组下标处理。
 * 取不到时返回 undefined 而不是抛错，让调用方用默认值兜底。
 */
export function readJsonPath(value: unknown, path: string): unknown {
  const parts = path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  let current = value
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0) return undefined
      current = current[index]
      continue
    }
    if (!isCollectRecord(current)) return undefined
    current = current[part]
  }
  return current
}

/**
 * 生成条目去重键：剔除 _meta 后序列化。
 * _meta 里是采集位置等易变信息，参与哈希会让同一内容被反复写入。
 */
export function collectItemKey(item: Record<string, unknown>): string {
  const { _meta, ...data } = item
  void _meta
  return JSON.stringify(data)
}

/**
 * 生成条目去重指纹：对剔除 _meta 后的内容做 SHA-256。
 *
 * 运行期只保留这些指纹，条目本身只存在于输出 JSONL 里；
 * 指纹长度固定，条目再多也不会把 checkpoint 或内存里的键集合撑大。
 */
export function collectItemHash(item: Record<string, unknown>): string {
  return createHash('sha256').update(collectItemKey(item)).digest('hex')
}

/**
 * 校验并规范化 collect spec（名称、模式、输出、翻页上限），保证写进 checkpoint 前字段完整。
 */
export function normalizeCollectSpec(value: unknown): CollectSpec {
  if (!isCollectRecord(value)) throw new Error('collect spec must be a JSON object')
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const mode = value.mode
  const output = typeof value.output === 'string' ? value.output.trim() : ''
  if (!name) throw new Error('collect spec name is required')
  if (mode !== 'feed' && mode !== 'network')
    throw new Error('collect spec mode must be feed or network')
  if (!output) throw new Error('collect spec output is required')
  const maxPages = value.maxPages === undefined ? 1 : Number(value.maxPages)
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new Error('collect spec maxPages must be an integer between 1 and 1000')
  }
  const spec: CollectSpec = {
    name,
    mode,
    output,
    maxPages,
    ...(typeof value.startUrl === 'string' && value.startUrl.trim()
      ? { startUrl: value.startUrl.trim() }
      : {}),
  }
  if (mode === 'feed') {
    if (value.feed !== undefined && !isCollectRecord(value.feed)) {
      throw new Error('collect spec feed must be an object')
    }
    spec.feed = (value.feed || {}) as FeedCollectSpec
  } else {
    if (!isCollectRecord(value.network)) throw new Error('collect spec network must be an object')
    const urlPattern =
      typeof value.network.urlPattern === 'string' ? value.network.urlPattern.trim() : ''
    const itemsPath =
      typeof value.network.itemsPath === 'string' ? value.network.itemsPath.trim() : ''
    if (!urlPattern) throw new Error('network urlPattern is required')
    if (!itemsPath) throw new Error('network itemsPath is required')
    spec.network = {
      urlPattern,
      itemsPath,
      ...(typeof value.network.nextPath === 'string' && value.network.nextPath.trim()
        ? { nextPath: value.network.nextPath.trim() }
        : {}),
    }
  }
  return spec
}
