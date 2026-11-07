import { isRecord } from './client.js'
import type { ResponseFormat } from './response-format.js'

function concisePagination(result: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(result.pagination)) return result
  const pagination = result.pagination
  return {
    ...result,
    pagination: {
      hasMore: pagination.hasMore === true || pagination.hasNextPage === true,
      ...(typeof pagination.nextCursor === 'string' ? { nextCursor: pagination.nextCursor } : {}),
    },
  }
}

function pickFields(value: unknown, fields: readonly string[]): Record<string, unknown> | unknown {
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    if (value[field] !== undefined && value[field] !== null) result[field] = value[field]
  }
  return result
}

function omitNullFields(value: unknown): unknown {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).filter(([_key, field]) => field !== null && field !== undefined),
  )
}

const CONCISE_NETWORK_REQUEST_FIELDS = [
  'ref',
  'method',
  'url',
  'status',
  'resourceType',
  'durationMs',
  'errorText',
] as const

function conciseNetworkRequest(value: unknown): Record<string, unknown> | unknown {
  const summary = pickFields(value, CONCISE_NETWORK_REQUEST_FIELDS)
  if (!isRecord(summary)) return summary
  if (summary.resourceType !== undefined) {
    summary.type = summary.resourceType
    delete summary.resourceType
  }
  return summary
}

function boundBody(value: string, maxBytes = 16_384): { text: string; truncated: boolean } {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maxBytes) return { text: value, truncated: false }
  let text = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > maxBytes) break
    text += character
    bytes += characterBytes
  }
  return { text, truncated: true }
}

function conciseNetworkDetail(result: Record<string, unknown>): Record<string, unknown> {
  const request = isRecord(result.request) ? result.request : null
  if (!request) return result
  const summary = conciseNetworkRequest(request)
  if (!isRecord(summary)) return result
  let truncated = false
  for (const [field, body, truncatedField] of [
    ['requestBody', request.requestBody ?? request.postData, 'requestBodyTruncated'],
    ['responseBody', request.responseBody, 'responseBodyTruncated'],
  ] as const) {
    if (typeof body !== 'string') continue
    const bounded = boundBody(body)
    summary[field] = bounded.text
    if (bounded.truncated) summary[truncatedField] = true
    truncated ||= bounded.truncated
  }
  for (const field of [
    'responseMimeType',
    'requestBodyTruncated',
    'responseBodyTruncated',
    'requestBodyBytes',
    'responseBodyBytes',
  ]) {
    if (summary[field] === undefined && request[field] !== undefined && request[field] !== null) {
      summary[field] = request[field]
    }
  }
  return {
    request: summary,
    ...(truncated
      ? {
          truncated: true,
          suggestedAction:
            'Bodies are limited to 16KiB in concise mode; use response_format=detailed only when the full body is required.',
        }
      : {}),
  }
}

/** concise 是逐命令白名单投影；detailed 原样返回，作为调试与兼容出口。 */
export function presentCommandResult(
  command: string,
  value: unknown,
  format: ResponseFormat,
): unknown {
  if (format === 'detailed' || !isRecord(value)) return value

  if (command === 'network') {
    if (Array.isArray(value.requests)) {
      return concisePagination({
        ...value,
        requests: value.requests.map(conciseNetworkRequest),
      })
    }
    if (value.request) return conciseNetworkDetail(value)
    if (Array.isArray(value.routes)) return concisePagination(value)
    return value
  }

  if ((command === 'tab.list' || command === 'tab') && Array.isArray(value.tabs)) {
    return concisePagination({
      ...value,
      tabs: value.tabs.map((tab) =>
        pickFields(tab, ['handle', 'title', 'url', 'active', 'pinned', 'status']),
      ),
    })
  }

  if (command === 'downloads' && Array.isArray(value.downloads)) {
    return concisePagination({
      ...value,
      downloads: value.downloads.map((download) =>
        pickFields(download, ['id', 'filename', 'state', 'bytesReceived', 'totalBytes', 'error']),
      ),
    })
  }

  if (command === 'snapshot') {
    const projected = { ...value }
    for (const field of ['elements', 'buttons', 'frames', 'headings']) {
      if (Array.isArray(projected[field])) projected[field] = projected[field].map(omitNullFields)
    }
    return projected
  }

  if (
    (command === 'console' && Array.isArray(value.messages)) ||
    (command === 'errors' && Array.isArray(value.errors)) ||
    (command === 'actions' && Array.isArray(value.actions)) ||
    (command === 'command' && Array.isArray(value.commands))
  ) {
    return concisePagination(value)
  }

  return value
}

export function presentCommandResponse(
  command: string,
  payload: unknown,
  format: ResponseFormat,
): unknown {
  if (!isRecord(payload) || payload.ok !== true || payload.result === undefined) return payload
  const result = presentCommandResult(command, payload.result, format)
  if (format === 'concise' && isRecord(payload.meta)) {
    const meta = { ...payload.meta }
    delete meta.tabId
    delete meta.url
    delete meta.title
    delete meta.target
    return { ...payload, result, meta }
  }
  return { ...payload, result }
}
