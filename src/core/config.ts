import { getExtensionId } from './extension.js'
import { getConfigPath, getHomeDir, readJsonFile, writeJsonFile } from './protocol.js'

export interface BrowserLaunchConfig {
  command: string
  args: string[]
}

export interface CliConfig {
  extensionId?: string
  browserCommand?: string
  browserArgs?: string[]
}

export interface ResolveConnectLaunchOptions {
  extensionId?: string | null
  browserCommand?: string | null
  browserArgs?: string[]
}

export interface ResolvedConnectLaunchConfig {
  extensionId: string
  browserConfig: BrowserLaunchConfig | null
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((item) => normalizeString(item)).filter((item) => item.length > 0)
}

function normalizeExtensionIdCandidate(value: unknown): string {
  return normalizeString(value)
}

function isValidExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value)
}

function normalizeBrowserLaunchConfig(command: unknown, args: unknown): BrowserLaunchConfig | null {
  const normalizedCommand = normalizeString(command)
  if (!normalizedCommand) {
    return null
  }

  return {
    command: normalizedCommand,
    args: normalizeStringArray(args),
  }
}

function normalizeCliConfig(value: unknown): CliConfig {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const record = value as Record<string, unknown>
  const config: CliConfig = {}

  const extensionId = normalizeExtensionIdCandidate(record.extensionId)
  if (isValidExtensionId(extensionId)) {
    config.extensionId = extensionId
  }

  const browserConfig = normalizeBrowserLaunchConfig(record.browserCommand, record.browserArgs)
  if (browserConfig) {
    config.browserCommand = browserConfig.command
    config.browserArgs = browserConfig.args
  }

  return config
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function readRawCliConfig(homeDir: string): Promise<Record<string, unknown>> {
  try {
    const rawConfig = await readJsonFile<Record<string, unknown> | null>(
      getConfigPath(homeDir),
      null,
    )
    return rawConfig && typeof rawConfig === 'object' ? { ...rawConfig } : {}
  } catch {
    return {}
  }
}

async function writeCliConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
  try {
    await writeJsonFile(getConfigPath(homeDir), config)
  } catch {
    return
  }
}

function applyCliConfigUpdates(
  config: Record<string, unknown>,
  updates: {
    extensionId?: string | null
    browserCommand?: string | null
    browserArgs?: string[] | null
  },
): boolean {
  let changed = false

  if ('extensionId' in updates) {
    const extensionId = normalizeExtensionIdCandidate(updates.extensionId)
    if (extensionId) {
      if (config.extensionId !== extensionId) {
        config.extensionId = extensionId
        changed = true
      }
    } else if ('extensionId' in config) {
      delete config.extensionId
      changed = true
    }
  }

  if ('browserCommand' in updates) {
    const browserCommand = normalizeString(updates.browserCommand)
    if (browserCommand) {
      if (config.browserCommand !== browserCommand) {
        config.browserCommand = browserCommand
        changed = true
      }
    } else if ('browserCommand' in config) {
      delete config.browserCommand
      changed = true
    }
  }

  if ('browserArgs' in updates) {
    const browserArgs = Array.isArray(updates.browserArgs)
      ? normalizeStringArray(updates.browserArgs)
      : []
    const currentArgs = Array.isArray(config.browserArgs)
      ? normalizeStringArray(config.browserArgs)
      : []

    if (browserArgs.length > 0) {
      if (!areStringArraysEqual(currentArgs, browserArgs)) {
        config.browserArgs = browserArgs
        changed = true
      }
    } else if ('browserArgs' in config) {
      delete config.browserArgs
      changed = true
    }
  }

  return changed
}

export async function readCliConfig(homeDir: string = getHomeDir()): Promise<CliConfig> {
  const rawConfig = await readRawCliConfig(homeDir)
  return normalizeCliConfig(rawConfig)
}

async function mergeCliConfig(
  homeDir: string,
  updates: {
    extensionId?: string | null
    browserCommand?: string | null
    browserArgs?: string[] | null
  },
): Promise<void> {
  const nextConfig = await readRawCliConfig(homeDir)

  if (!applyCliConfigUpdates(nextConfig, updates)) {
    return
  }

  await writeCliConfig(homeDir, nextConfig)
}

export async function resolveConnectLaunchConfig(
  homeDir: string = getHomeDir(),
  options: ResolveConnectLaunchOptions = {},
): Promise<ResolvedConnectLaunchConfig> {
  const rawConfig = await readRawCliConfig(homeDir)
  const config = normalizeCliConfig(rawConfig)
  const nextConfig = { ...rawConfig }

  const explicitExtensionId = normalizeExtensionIdCandidate(options.extensionId)
  const envExtensionId = normalizeExtensionIdCandidate(process.env.AUTOBROWSER_EXTENSION_ID)
  const extensionId = isValidExtensionId(explicitExtensionId)
    ? explicitExtensionId
    : config.extensionId || (isValidExtensionId(envExtensionId) ? envExtensionId : getExtensionId())

  let shouldWrite = applyCliConfigUpdates(nextConfig, { extensionId })

  const explicitBrowserCommand = normalizeString(options.browserCommand)
  const browserConfig = explicitBrowserCommand
    ? {
        command: explicitBrowserCommand,
        args: normalizeStringArray(options.browserArgs),
      }
    : normalizeBrowserLaunchConfig(config.browserCommand, config.browserArgs)

  if (browserConfig) {
    shouldWrite =
      applyCliConfigUpdates(nextConfig, {
        browserCommand: browserConfig.command,
        browserArgs: browserConfig.args,
      }) || shouldWrite
  }

  if (shouldWrite) {
    // connect 流程里会同时用到扩展 ID 和浏览器启动配置，这里合并成一次持久化，减少热路径上的重复读写。
    await writeCliConfig(homeDir, nextConfig)
  }

  return {
    extensionId,
    browserConfig,
  }
}

export async function resolveExtensionId(
  homeDir: string = getHomeDir(),
  explicitExtensionId?: string | null,
): Promise<string> {
  const config = await readCliConfig(homeDir)
  const explicitId = normalizeExtensionIdCandidate(explicitExtensionId)
  if (isValidExtensionId(explicitId)) {
    await mergeCliConfig(homeDir, { extensionId: explicitId })
    return explicitId
  }

  if (config.extensionId) {
    return config.extensionId
  }

  const envExtensionId = normalizeExtensionIdCandidate(process.env.AUTOBROWSER_EXTENSION_ID)
  if (isValidExtensionId(envExtensionId)) {
    await mergeCliConfig(homeDir, { extensionId: envExtensionId })
    return envExtensionId
  }

  const fallbackExtensionId = getExtensionId()
  await mergeCliConfig(homeDir, { extensionId: fallbackExtensionId })
  return fallbackExtensionId
}

export async function resolveBrowserLaunchConfig(
  homeDir: string = getHomeDir(),
  explicitBrowserCommand?: string | null,
  explicitBrowserArgs: string[] = [],
): Promise<BrowserLaunchConfig | null> {
  const config = await readCliConfig(homeDir)
  const explicitCommand = normalizeString(explicitBrowserCommand)
  if (explicitCommand) {
    const browserConfig = {
      command: explicitCommand,
      args: normalizeStringArray(explicitBrowserArgs),
    }
    await mergeCliConfig(homeDir, {
      browserCommand: browserConfig.command,
      browserArgs: browserConfig.args,
    })
    return browserConfig
  }

  const browserConfig = normalizeBrowserLaunchConfig(config.browserCommand, config.browserArgs)
  return browserConfig
}
