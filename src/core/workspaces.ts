export type WorkspaceAttachmentMode = 'owned' | 'readonly'

export interface WorkspaceRecord {
  id: string
  createdAt: string
  lastActiveAt: string
  targetTabId: number | null
}

export interface WorkspaceAttachment {
  tabId: number
  workspaceId: string
  mode: WorkspaceAttachmentMode
  attachedAt: string
  lastActiveAt: string
  leaseExpiresAt: string
}

export interface WorkspaceState {
  workspaces: Map<string, WorkspaceRecord>
  attachments: Map<number, WorkspaceAttachment>
}

export const DEFAULT_WORKSPACE_LEASE_MS = 60 * 60 * 1000

export function createWorkspaceState(): WorkspaceState {
  return { workspaces: new Map(), attachments: new Map() }
}

export function normalizeWorkspaceId(value: string): string {
  const id = value.trim()
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    throw new Error(
      'invalid workspace id: expected 1-64 letters, digits, underscores or hyphens, starting with a letter',
    )
  }
  return id
}

const READONLY_COMMANDS = new Set([
  'actions',
  'console',
  'errors',
  'get',
  'is',
  'media',
  'search',
  'snapshot',
  'wait',
])

/** readonly attachment 只允许明确的页面观察命令；eval/CDP 等可写能力不能借只读名称绕过。 */
export function isWorkspaceReadonlyCommand(
  command: string,
  args: Record<string, unknown>,
): boolean {
  if (!READONLY_COMMANDS.has(command)) return false
  if (command === 'actions') return args.action !== 'clear'
  if (command === 'media') return args.resolve !== true
  return true
}
