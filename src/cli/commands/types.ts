import type { CommandResponse } from '../client.js'
import type { ScreenshotArgs } from '../parse.js'
import type { CliDependencies, CliFlags } from '../types.js'

export type CommandResultPayload =
  | CommandResponse
  | Record<string, unknown>
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined

export interface CommandContext {
  flags: CliFlags
  homeDir: string
  dependencies: CliDependencies
  writeHelp(pathParts?: string[]): 0
  writeResult(payload: CommandResultPayload): void
  requestCommand(baseUrl: string, command: string, args?: object): Promise<CommandResponse>
  openConnectFlow(
    status: Record<string, unknown> | null,
    allowRelayFallback: boolean,
  ): Promise<boolean>
  getStatus(baseUrl: string): Promise<Record<string, unknown>>
  resolveEvalScript(rest: string[]): Promise<string>
  getCdpUrl(baseUrl: string): Promise<string>
  extractScreenshotData(result: Record<string, unknown> | undefined): {
    data: Buffer
    mimeType: string
  }
  resolveScreenshotOutputPath(screenshotArgs: ScreenshotArgs): Promise<string>
  collectHarFromNetwork(baseUrl: string, startedAt: string | null): Promise<Record<string, unknown>>
  writeHarFile(har: unknown, outputPath: string | null): Promise<string>
}

export type CommandHandler = (rest: string[], context: CommandContext) => Promise<number | void>

export type CommandRegistry = Record<string, CommandHandler>
