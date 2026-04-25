export const AGENT_ELEMENT_REF_ATTRIBUTE = 'data-autobrowser-ref'

const AGENT_ELEMENT_REF_PATTERN = /^@e(\d+)(?:#p(\d+))?$/i

export interface AgentElementRefInfo {
  ref: string
  pageEpoch: number | null
}

export function formatAgentElementRef(index: number, pageEpoch?: number | null): string {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error(`invalid agent element ref index: ${index}`)
  }

  const baseRef = `@e${index}`
  if (pageEpoch === undefined || pageEpoch === null) {
    return baseRef
  }

  if (!Number.isInteger(pageEpoch) || pageEpoch <= 0) {
    throw new Error(`invalid agent element page epoch: ${pageEpoch}`)
  }

  return `${baseRef}#p${pageEpoch}`
}

export function parseAgentElementRefInfo(
  selector: string | null | undefined,
): AgentElementRefInfo | null {
  const normalized = String(selector || '').trim()
  const match = AGENT_ELEMENT_REF_PATTERN.exec(normalized)
  if (!match) {
    return null
  }

  return {
    ref: `e${match[1]}`,
    pageEpoch: match[2] ? Number(match[2]) : null,
  }
}

export function parseAgentElementRef(selector: string | null | undefined): string | null {
  return parseAgentElementRefInfo(selector)?.ref || null
}

export function isAgentElementRef(selector: string | null | undefined): boolean {
  return parseAgentElementRef(selector) !== null
}

export function getAgentElementRefPageEpoch(selector: string | null | undefined): number | null {
  return parseAgentElementRefInfo(selector)?.pageEpoch ?? null
}

export function isStaleAgentElementRef(
  selector: string | null | undefined,
  currentPageEpoch: number,
): boolean {
  const pageEpoch = getAgentElementRefPageEpoch(selector)
  if (pageEpoch === null) {
    return false
  }

  return pageEpoch !== currentPageEpoch
}

export function resolveAgentSelector(selector: string | null | undefined): string {
  const normalized = String(selector || '').trim()
  const refInfo = parseAgentElementRefInfo(normalized)
  if (!refInfo) {
    return normalized
  }

  return `[${AGENT_ELEMENT_REF_ATTRIBUTE}="${refInfo.ref}"]`
}
