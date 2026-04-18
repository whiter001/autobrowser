import { getExtensionId } from './extension.js'
import {
  getConfigPath,
  getHomeDir,
  readJsonFile,
  writeJsonFile,
} from './protocol.js'

export interface BrowserLaunchConfig {
  command: string
  args: string[]
}

export interface CliConfig {
  extensionId?: string
  browserCommand?: string
  browserArgs?: string[]
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => normalizeString(item))
    .filter((item) => item.length > 0)
}

function normalizeExtensionIdCandidate(value: unknown): string {
  return normalizeString(value)
}

function isValidExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value)
}

function normalizeBrowserLaunchConfig(
  command: unknown,
  args: unknown,
): BrowserLaunchConfig | null {
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

async function readRawCliConfig(homeDir: string): Promise<Record<string, unknown>> {
  try {
    const rawConfig = await readJsonFile<Record<string, unknown> | null>(getConfigPath(homeDir), null)
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

  if ('extensionId' in updates) {
    const extensionId = normalizeExtensionIdCandidate(updates.extensionId)
    if (extensionId) {
      nextConfig.extensionId = extensionId
    } else {
      delete nextConfig.extensionId
    }
  }

  if ('browserCommand' in updates) {
    const browserCommand = normalizeString(updates.browserCommand)
    if (browserCommand) {
      nextConfig.browserCommand = browserCommand
    } else {
      delete nextConfig.browserCommand
    }
  }

  if ('browserArgs' in updates) {
    const browserArgs = Array.isArray(updates.browserArgs) ? normalizeStringArray(updates.browserArgs) : []
    if (browserArgs.length > 0) {
      nextConfig.browserArgs = browserArgs
    } else {
      delete nextConfig.browserArgs
    }
  }

  await writeCliConfig(homeDir, nextConfig)
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
