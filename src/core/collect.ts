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

export interface CollectItemMeta {
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

export interface CollectCheckpoint {
  version: 1
  spec: CollectSpec
  status: 'running' | 'completed' | 'failed'
  nextUrl: string
  nextPage: number
  items: CollectItem[]
  failures: CollectFailure[]
}

export function isCollectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

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

export function collectItemKey(item: Record<string, unknown>): string {
  const { _meta, ...data } = item
  void _meta
  return JSON.stringify(data)
}

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
