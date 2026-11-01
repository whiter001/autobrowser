import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import os from 'node:os'
import path from 'node:path'
import { buildHarPayload, compareHarRecords } from '../core/har.js'
import { isRecord, requestCommandRaw } from './client.js'

const JSON_INDENT = '  '

function* serializeJsonValue(
  value: unknown,
  depth: number = 0,
  seen: Set<object> = new Set<object>(),
): Generator<string> {
  if (value === null) {
    yield 'null'
    return
  }

  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    yield JSON.stringify(value)
    return
  }

  if (valueType === 'bigint') {
    throw new TypeError('Do not know how to serialize a BigInt')
  }

  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol') {
    yield 'null'
    return
  }

  const objectValue = value as Record<string, unknown>
  if (seen.has(objectValue)) {
    throw new TypeError('Converting circular structure to JSON')
  }

  seen.add(objectValue)
  try {
    if (Array.isArray(objectValue)) {
      if (objectValue.length === 0) {
        yield '[]'
        return
      }

      yield '[\n'
      for (let index = 0; index < objectValue.length; index += 1) {
        yield `${JSON_INDENT.repeat(depth + 1)}`
        const item = objectValue[index]
        yield* serializeJsonValue(
          item === undefined || typeof item === 'function' || typeof item === 'symbol'
            ? null
            : item,
          depth + 1,
          seen,
        )
        yield index < objectValue.length - 1 ? ',\n' : '\n'
      }

      yield `${JSON_INDENT.repeat(depth)}]`
      return
    }

    const entries = Object.entries(objectValue).filter(([, entryValue]) => {
      const entryType = typeof entryValue
      return entryValue !== undefined && entryType !== 'function' && entryType !== 'symbol'
    })

    if (entries.length === 0) {
      yield '{}'
      return
    }

    yield '{\n'
    for (let index = 0; index < entries.length; index += 1) {
      const [key, entryValue] = entries[index]!
      yield `${JSON_INDENT.repeat(depth + 1)}${JSON.stringify(key)}: `
      yield* serializeJsonValue(entryValue, depth + 1, seen)
      yield index < entries.length - 1 ? ',\n' : '\n'
    }

    yield `${JSON_INDENT.repeat(depth)}}`
  } finally {
    seen.delete(objectValue)
  }
}

function* serializeJsonDocument(value: unknown): Generator<string> {
  yield* serializeJsonValue(value)
  yield '\n'
}

async function mkTempHarDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'autobrowser-har-'))
}

export async function writeHarFile(har: unknown, outputPath: string | null): Promise<string> {
  const targetPath = outputPath || path.join(await mkTempHarDir(), 'network.har')
  await mkdir(path.dirname(targetPath), { recursive: true })
  await pipeline(Readable.from(serializeJsonDocument(har)), createWriteStream(targetPath, 'utf8'))
  return targetPath
}

interface NetworkRequestSummary {
  id?: string
  requestId?: string
  tabId?: number
  url?: string
  method?: string
  resourceType?: string
  status?: number
  statusText?: string
  startedAt?: string
  durationMs?: number
}

const HAR_MIME_TYPES: Record<string, string> = {
  Document: 'text/html',
  XHR: 'application/json',
  Fetch: 'application/json',
  Script: 'application/javascript',
  Stylesheet: 'text/css',
  Image: 'image/*',
  Font: 'font/woff2',
  Ping: 'text/plain',
  Manifest: 'application/json',
  Other: 'application/octet-stream',
}

function buildFallbackHarEntry(summary: NetworkRequestSummary): Record<string, unknown> {
  const resourceType = String(summary.resourceType || 'Other')
  const mimeType = HAR_MIME_TYPES[resourceType] || 'application/octet-stream'
  const startedDateTime =
    typeof summary.startedAt === 'string' ? summary.startedAt : new Date().toISOString()
  const durationMs = typeof summary.durationMs === 'number' ? summary.durationMs : 0

  return {
    startedDateTime,
    time: durationMs,
    request: {
      method: summary.method || 'GET',
      url: summary.url || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: Number(summary.status || 0),
      statusText: String(summary.statusText || ''),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: {
        size: 0,
        mimeType,
        text: '',
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: {
      send: 0,
      wait: durationMs,
      receive: 0,
    },
    pageref:
      summary.tabId === null || summary.tabId === undefined ? undefined : `tab-${summary.tabId}`,
  }
}

export async function collectHarFromNetwork(
  baseUrl: string,
  startedAt: string | null,
  token: string | null = null,
): Promise<Record<string, unknown>> {
  const requestListPayload = await requestCommandRaw(
    baseUrl,
    'network',
    {
      action: 'requests',
    },
    { token },
  )

  if (requestListPayload?.ok === false) {
    throw new Error(requestListPayload.error?.message || 'failed to read network requests')
  }

  const requestListResult = isRecord(requestListPayload?.result)
    ? (requestListPayload.result as Record<string, unknown>)
    : null
  const requestSummaries = Array.isArray(requestListResult?.requests)
    ? requestListResult.requests.filter(isRecord).map((request) => request as NetworkRequestSummary)
    : []

  const filteredSummaries = requestSummaries
    .filter((request) => !startedAt || String(request.startedAt || '') >= startedAt)
    .sort((left, right) => compareHarRecords(left, right))

  // 逐条回拉 harEntry 是 N+1 往返，用有界并发池提速；按原列表下标写入以保持输出顺序
  const entries: Record<string, unknown>[] = Array.from({ length: filteredSummaries.length })
  const HAR_DETAIL_CONCURRENCY = 8
  let nextIndex = 0

  const collectOne = (request: NetworkRequestSummary): Promise<Record<string, unknown>> => {
    const requestId = String(request.requestId || request.id || '')
    if (!requestId) {
      return Promise.resolve(buildFallbackHarEntry(request))
    }

    return requestCommandRaw(
      baseUrl,
      'network',
      {
        action: 'request',
        requestId,
      },
      { token },
    )
      .then((requestPayload) => {
        if (requestPayload?.ok === false) {
          return buildFallbackHarEntry(request)
        }

        const requestResult = isRecord(requestPayload?.result)
          ? (requestPayload.result as Record<string, unknown>)
          : null
        const harEntry = isRecord(requestResult?.harEntry) ? requestResult.harEntry : null

        return harEntry || buildFallbackHarEntry(request)
      })
      .catch(() => buildFallbackHarEntry(request))
  }

  const worker = async () => {
    while (nextIndex < filteredSummaries.length) {
      const index = nextIndex
      nextIndex += 1
      entries[index] = await collectOne(filteredSummaries[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HAR_DETAIL_CONCURRENCY, filteredSummaries.length) }, () =>
      worker(),
    ),
  )

  return buildHarPayload(entries)
}
