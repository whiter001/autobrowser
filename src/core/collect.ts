interface FeedCollectSpec {
  selector?: string
  limit?: number
  dedupe?: 'url' | 'text' | 'none'
  maxScrolls?: number
  pauseMs?: number
  stallRounds?: number
  nextSelector?: string
  waitTimeoutMs?: number
}

interface NetworkCollectSpec {
  urlPattern: string
  itemsPath: string
  nextPath?: string
}

interface CollectSpec {
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

interface CollectFailure {
  at: string
  page: number
  sourceUrl: string
  message: string
  code: string
}

export interface CollectCheckpoint {
  version: 1
  spec: CollectSpec
  status: 'running' | 'completed' | 'failed'
  nextUrl: string
  nextPage: number
  items: CollectItem[]
  failures: CollectFailure[]
}

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
