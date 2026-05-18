import { isRecord } from './client.js'

export interface SnapshotFieldJsonlExportResult {
  content: string
  recordCount: number
}

export interface SnapshotFieldSelection {
  fields: string[]
}

interface FieldSource {
  kind: 'snapshot'
  ref: string | null
}

function normalizePageEpoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? (value as Record<string, unknown>) : null
}

function appendFieldRecord(
  records: Array<Record<string, unknown>>,
  pageEpoch: number | null,
  fieldPath: string,
  value: unknown,
  source: FieldSource,
  matchStrategy: string,
  selection: SnapshotFieldSelection | null,
): void {
  if (
    selection &&
    selection.fields.length > 0 &&
    !matchesFieldSelection(fieldPath, selection.fields)
  ) {
    return
  }

  if (value === undefined || value === null) {
    return
  }

  if (typeof value === 'string' && !value.trim()) {
    return
  }

  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return
  }

  records.push({
    kind: 'field',
    pageEpoch,
    fieldPath,
    value,
    source,
    matchStrategy,
  })
}

function matchesFieldSelection(fieldPath: string, fields: string[]): boolean {
  for (const rawSelector of fields) {
    const selector = String(rawSelector || '').trim()
    if (!selector) {
      continue
    }

    if (selector.endsWith('*')) {
      const prefix = selector.slice(0, -1)
      if (fieldPath.startsWith(prefix)) {
        return true
      }
      continue
    }

    if (fieldPath === selector) {
      return true
    }
  }

  return false
}

function appendElementFields(
  records: Array<Record<string, unknown>>,
  pageEpoch: number | null,
  values: unknown,
  kind: 'elements' | 'headings' | 'buttons' | 'frames',
  selection: SnapshotFieldSelection | null,
): void {
  if (!Array.isArray(values)) {
    return
  }

  for (const [index, value] of values.entries()) {
    const record = toRecord(value)
    if (!record) {
      continue
    }

    const source: FieldSource = {
      kind: 'snapshot',
      ref: typeof record.ref === 'string' ? record.ref : null,
    }

    if (kind === 'elements') {
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].name`,
        record.name,
        source,
        typeof record.role === 'string' ? 'role+name' : 'name',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].text`,
        record.text,
        source,
        typeof record.role === 'string' ? 'role+text' : 'text',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].href`,
        record.href,
        source,
        'href',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].placeholder`,
        record.placeholder,
        source,
        'placeholder',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].type`,
        record.type,
        source,
        'type',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].role`,
        record.role,
        source,
        'role',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].checked`,
        record.checked,
        source,
        'checked',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].disabled`,
        record.disabled,
        source,
        'disabled',
        selection,
      )
      continue
    }

    if (kind === 'headings' || kind === 'buttons') {
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].text`,
        record.text,
        source,
        `${kind.slice(0, -1)}-text`,
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].tag`,
        record.tag,
        source,
        `${kind.slice(0, -1)}-tag`,
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].name`,
        record.name,
        source,
        `${kind.slice(0, -1)}-name`,
        selection,
      )
      continue
    }

    if (kind === 'frames') {
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].name`,
        record.name,
        source,
        'frame-name',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].title`,
        record.title,
        source,
        'frame-title',
        selection,
      )
      appendFieldRecord(
        records,
        pageEpoch,
        `${kind}[${index}].src`,
        record.src,
        source,
        'frame-src',
        selection,
      )
    }
  }
}

export function buildSnapshotFieldJsonl(
  snapshot: Record<string, unknown>,
  selection: SnapshotFieldSelection | null = null,
): SnapshotFieldJsonlExportResult {
  const pageEpoch = normalizePageEpoch(snapshot.pageEpoch)
  const records: Array<Record<string, unknown>> = []
  const pageSource: FieldSource = {
    kind: 'snapshot',
    ref: null,
  }

  appendFieldRecord(
    records,
    pageEpoch,
    'page.title',
    snapshot.title,
    pageSource,
    'page-metadata',
    selection,
  )
  appendFieldRecord(
    records,
    pageEpoch,
    'page.url',
    snapshot.url,
    pageSource,
    'page-metadata',
    selection,
  )
  appendFieldRecord(
    records,
    pageEpoch,
    'page.readyState',
    snapshot.readyState,
    pageSource,
    'page-metadata',
    selection,
  )
  appendFieldRecord(
    records,
    pageEpoch,
    'page.text',
    snapshot.text,
    pageSource,
    'page-text',
    selection,
  )

  appendElementFields(records, pageEpoch, snapshot.elements, 'elements', selection)
  appendElementFields(records, pageEpoch, snapshot.frames, 'frames', selection)
  appendElementFields(records, pageEpoch, snapshot.headings, 'headings', selection)
  appendElementFields(records, pageEpoch, snapshot.buttons, 'buttons', selection)

  return {
    content: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    recordCount: records.length,
  }
}
