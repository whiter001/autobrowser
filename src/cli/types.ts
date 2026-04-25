import type { BrowserLaunchConfig } from '../core/config.js'
import type { DetachedProcessHandle } from './server-control.js'

export interface CliFlags {
  json: boolean
  server: string
  relayPort: number
  ipcPort: number
  extensionId: string | null
  autoConnect: boolean
  browserCommand: string | null
  browserArgs: string[]
  stdin: boolean
  file: string | null
  base64: boolean
  tab: string | null
  frame: string | null
}

export interface ParsedCli {
  flags: CliFlags
  args: string[]
}

export interface CliDependencies {
  openUrl?: (url: string, browserConfig: BrowserLaunchConfig | null) => Promise<void>
  spawnDetachedProcess?: (
    command: string,
    args: string[],
  ) => DetachedProcessHandle | Promise<DetachedProcessHandle>
  findProcessIdByPort?: (port: number) => Promise<number | null>
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean
}
