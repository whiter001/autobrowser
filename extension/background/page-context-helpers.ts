export function collapseWhitespace(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function splitWhitespaceTokens(value: unknown): string[] {
  const normalized = collapseWhitespace(value)
  return normalized ? normalized.split(/\s+/) : []
}

export function parsePageContextElementRefIndex(value: unknown): number | null {
  const match = /^e(\d+)$/.exec(collapseWhitespace(value))
  return match ? Number(match[1]) : null
}
