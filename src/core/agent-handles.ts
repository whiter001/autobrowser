import { resolveAgentSelector } from './agent-selectors.js'

export const AGENT_FRAME_REF_ATTRIBUTE = 'data-autobrowser-frame'

const AGENT_TAB_HANDLE_PATTERN = /^t(\d+)$/i
const AGENT_FRAME_REF_PATTERN = /^@f(\d+)(?:#p(\d+))?$/i

export interface AgentFrameRefInfo {
  ref: string
  pageEpoch: number | null
}

export function formatAgentTabHandle(index: number): string {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error(`invalid agent tab handle index: ${index}`)
  }

  return `t${index}`
}

export function parseAgentTabHandle(value: string | null | undefined): string | null {
  const match = AGENT_TAB_HANDLE_PATTERN.exec(String(value || '').trim())
  if (!match) {
    return null
  }

  return `t${match[1]}`
}

export function isAgentTabHandle(value: string | null | undefined): boolean {
  return parseAgentTabHandle(value) !== null
}

export function formatAgentFrameRef(index: number, pageEpoch?: number | null): string {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error(`invalid agent frame ref index: ${index}`)
  }

  const baseRef = `@f${index}`
  if (pageEpoch === undefined || pageEpoch === null) {
    return baseRef
  }

  if (!Number.isInteger(pageEpoch) || pageEpoch <= 0) {
    throw new Error(`invalid agent frame page epoch: ${pageEpoch}`)
  }

  return `${baseRef}#p${pageEpoch}`
}

export function parseAgentFrameRefInfo(value: string | null | undefined): AgentFrameRefInfo | null {
  const match = AGENT_FRAME_REF_PATTERN.exec(String(value || '').trim())
  if (!match) {
    return null
  }

  return {
    ref: `f${match[1]}`,
    pageEpoch: match[2] ? Number(match[2]) : null,
  }
}

export function parseAgentFrameRef(value: string | null | undefined): string | null {
  return parseAgentFrameRefInfo(value)?.ref || null
}

export function isAgentFrameRef(value: string | null | undefined): boolean {
  return parseAgentFrameRef(value) !== null
}

export function getAgentFrameRefPageEpoch(value: string | null | undefined): number | null {
  return parseAgentFrameRefInfo(value)?.pageEpoch ?? null
}

export function isStaleAgentFrameRef(
  value: string | null | undefined,
  currentPageEpoch: number,
): boolean {
  const pageEpoch = getAgentFrameRefPageEpoch(value)
  if (pageEpoch === null) {
    return false
  }

  return pageEpoch !== currentPageEpoch
}

export function resolveAgentFrameSelector(value: string | null | undefined): string {
  const frameRef = parseAgentFrameRefInfo(value)
  if (!frameRef) {
    return resolveAgentSelector(value)
  }

  return `[${AGENT_FRAME_REF_ATTRIBUTE}="${frameRef.ref}"]`
}
