export declare const PACKAGE_BIN_MARKER: string
export declare const CMD_SHIM_NAME: string
export declare const BAT_SHIM_NAME: string

export type ShimFixPlan =
  | {
      action: 'skip'
      reason:
        | 'not-windows'
        | 'not-global-install'
        | 'no-global-prefix'
        | 'no-cmd-shim'
        | 'foreign-cmd-shim'
    }
  | { action: 'rename'; reason: 'npm-cmd-shim-mangles-args'; binDir: string }

export type ShimFixResult = { applied: boolean; reason: string }

export declare function resolveGlobalBinDir(
  env: Record<string, string | undefined>,
  platform: string,
): string | null

export declare function looksLikePackageCmdShim(content: string, marker?: string): boolean

export declare function planCmdShimRename(input: {
  platform: string
  env: Record<string, string | undefined>
  cmdContent: string
  cmdExists: boolean
  marker?: string
}): ShimFixPlan

export declare function applyCmdShimRename(input: {
  cmdPath: string
  batPath: string
  cmdContent: string
}): Promise<void>

export declare function fixWindowsCmdShim(input?: {
  platform?: string
  env?: Record<string, string | undefined>
  binDir?: string | null
  marker?: string
  logger?: { log?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
}): Promise<ShimFixResult>
