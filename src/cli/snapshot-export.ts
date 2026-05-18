import { isRecord } from './client.js'

export interface SnapshotJsonlExportResult {
  content: string
  recordCount: number
}

function inferMatchStrategy(record: Record<string, unknown>, kind: string): string {
  if (kind === 'page') {
    return 'page-metadata'
  }

  if (kind === 'frame') {
    return 'frame-name-or-title'
  }

  if (kind === 'heading') {
    return 'heading-text'
  }

  if (kind === 'button') {
    return 'button-text'
  }

  if (typeof record.role === 'string' && typeof record.name === 'string') {
    return 'role+name'
  }

  if (typeof record.role === 'string') {
    return 'role'
  }

  if (typeof record.href === 'string') {
    return 'link-href'
  }

  if (typeof record.text === 'string' && record.text.trim()) {
    return 'text'
  }

  return 'tag'
}

function normalizePageEpoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? (value as Record<string, unknown>) : null
}

function appendSnapshotGroupRecords(
  records: Array<Record<string, unknown>>,
  kind: string,
  values: unknown,
  pageEpoch: number | null,
): void {
  if (!Array.isArray(values)) {
    return
  }

  for (const value of values) {
    const record = toRecord(value)
    if (!record) {
      continue
    }

    records.push({
      kind,
      pageEpoch,
      source: {
        kind: 'snapshot',
        ref: typeof record.ref === 'string' ? record.ref : null,
      },
      matchStrategy: inferMatchStrategy(record, kind),
      ...record,
    })
  }
}

export function buildSnapshotJsonl(snapshot: Record<string, unknown>): SnapshotJsonlExportResult {
  const pageEpoch = normalizePageEpoch(snapshot.pageEpoch)
  const records: Array<Record<string, unknown>> = [
    {
      kind: 'page',
      pageEpoch,
      title: typeof snapshot.title === 'string' ? snapshot.title : '',
      url: typeof snapshot.url === 'string' ? snapshot.url : '',
      readyState: typeof snapshot.readyState === 'string' ? snapshot.readyState : '',
      text: typeof snapshot.text === 'string' ? snapshot.text : '',
      source: {
        kind: 'snapshot',
        ref: null,
      },
      matchStrategy: inferMatchStrategy({}, 'page'),
    },
  ]

  appendSnapshotGroupRecords(records, 'element', snapshot.elements, pageEpoch)
  appendSnapshotGroupRecords(records, 'frame', snapshot.frames, pageEpoch)
  appendSnapshotGroupRecords(records, 'heading', snapshot.headings, pageEpoch)
  appendSnapshotGroupRecords(records, 'button', snapshot.buttons, pageEpoch)

  return {
    content: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    recordCount: records.length,
  }
}