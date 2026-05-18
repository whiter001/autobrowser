import { isRecord } from './client.js'

export interface NetworkRequestsJsonlExportResult {
  content: string
  recordCount: number
}

const PAGINATION_KEYS = new Set([
  'page',
  'offset',
  'cursor',
  'after',
  'before',
  'limit',
  'pageSize',
  'per_page',
  'next',
])

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {}
  }

  const headers: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(value)) {
    headers[name.toLowerCase()] = String(headerValue ?? '')
  }

  return headers
}

function normalizeUrlPagination(urlValue: unknown): Record<string, unknown> | null {
  if (typeof urlValue !== 'string' || !urlValue.trim()) {
    return null
  }

  try {
    const url = new URL(urlValue)
    const query: Record<string, string> = {}

    for (const [name, value] of url.searchParams.entries()) {
      if (PAGINATION_KEYS.has(name)) {
        query[name] = value
      }
    }

    if (Object.keys(query).length === 0) {
      return null
    }

    return {
      source: 'query',
      query,
    }
  } catch {
    return null
  }
}

function normalizeHeaderPagination(headers: unknown): Record<string, unknown> | null {
  const normalized = normalizeHeaders(headers)
  const hints: Record<string, string> = {}

  if (normalized.link) {
    hints.link = normalized.link
  }
  if (normalized['x-next-page']) {
    hints.nextPage = normalized['x-next-page']
  }
  if (normalized['x-next-cursor']) {
    hints.nextCursor = normalized['x-next-cursor']
  }
  if (normalized['x-page']) {
    hints.page = normalized['x-page']
  }
  if (normalized['x-offset']) {
    hints.offset = normalized['x-offset']
  }

  return Object.keys(hints).length > 0
    ? {
        source: 'response-headers',
        ...hints,
      }
    : null
}

function normalizeBodyPreview(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  return value
}

function normalizePageEpoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? (value as Record<string, unknown>) : null
}

export function buildNetworkRequestsJsonl(
  result: Record<string, unknown>,
  filters: Record<string, unknown> = {},
): NetworkRequestsJsonlExportResult {
  const requests = Array.isArray(result.requests) ? result.requests : []
  const total = typeof result.total === 'number' && Number.isFinite(result.total)
    ? Math.floor(result.total)
    : requests.length
  const pageEpoch = normalizePageEpoch(result.pageEpoch)
  const records: Array<Record<string, unknown>> = [
    {
      kind: 'requests',
      total,
      pageEpoch,
      filters,
    },
  ]

  for (const value of requests) {
    const record = toRecord(value)
    if (!record) {
      continue
    }

    const pagination = normalizeUrlPagination(record.url) || normalizeHeaderPagination(record.responseHeaders)

    records.push({
      kind: 'request',
      pageEpoch,
      ...record,
      ...(pagination ? { pagination } : {}),
      requestBody: normalizeBodyPreview(record.requestBody),
      responseBody: normalizeBodyPreview(record.responseBody),
    })
  }

  return {
    content: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    recordCount: records.length,
  }
}