import type { BrowserLaunchConfig } from '../core/config.js'
import type { DetachedProcessHandle } from './server-control.js'
import type { ResponseFormat } from './response-format.js'

export interface CliFlags {
  json: boolean
  /** 是否显式传了 --json（默认 json 就是 true，需要区分"默认"和"显式要求 JSON"） */
  jsonExplicitlySet: boolean
  brief: boolean
  responseFormat: ResponseFormat
  responseFormatExplicitlySet: boolean
  server: string
  session: string
  workspace: string | null
  engine: 'chromium' | 'firefox' | 'webkit'
  webdriverUrl: string
  relayPort: number
  ipcPort: number
  serverExplicitlySet: boolean
  relayPortExplicitlySet: boolean
  ipcPortExplicitlySet: boolean
  extensionId: string | null
  autoConnect: boolean
  browserCommand: string | null
  browserArgs: string[]
  stdin: boolean
  file: string | null
  base64: boolean
  /** 只打印持久化的 token 而不打开浏览器（connect --print-token） */
  printToken: boolean
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
