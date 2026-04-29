export interface HarSortableRecord {
  id?: string | null
  requestId?: string | null
  startedAt?: string | null
}

export interface HarPayload extends Record<string, unknown> {
  log: {
    version: string
    creator: {
      name: string
      version: string
    }
    entries: Array<Record<string, unknown>>
  }
}

export const HAR_LOG_VERSION = '1.2'
export const HAR_CREATOR = {
  name: 'autobrowser',
  version: '0.1.0',
} as const

export function compareHarRecords(left: HarSortableRecord, right: HarSortableRecord): number {
  const leftStartedAt = Date.parse(String(left.startedAt || '')) || 0
  const rightStartedAt = Date.parse(String(right.startedAt || '')) || 0

  if (leftStartedAt !== rightStartedAt) {
    return leftStartedAt - rightStartedAt
  }

  const leftId = String(left.id || left.requestId || '')
  const rightId = String(right.id || right.requestId || '')
  return leftId.localeCompare(rightId)
}

export function buildHarPayload(entries: Array<Record<string, unknown>>): HarPayload {
  return {
    log: {
      version: HAR_LOG_VERSION,
      creator: HAR_CREATOR,
      entries,
    },
  }
}
