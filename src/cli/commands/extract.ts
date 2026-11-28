import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CliUsageError } from '../cli-error.js'
import {
  buildExtractQuality,
  EXTRACT_MAX_LIMIT,
  EXTRACT_PAGE_SCRIPT,
  normalizeExtractSpec,
  parseExtractResult,
  resolveExtractLimit,
  type ExtractPageResult,
  type ExtractSpec,
} from '../../core/extract.js'
import { stripBom } from '../../core/text.js'
import { isHelpToken } from '../help.js'
import { parseOrThrow, throwCommandError } from './shared.js'
import type { CommandContext, CommandRegistry } from './types.js'

const EXTRACT_SPEC_ERROR_CODE = 'INVALID_EXTRACT_SPEC'

interface ExtractCliOptions {
  specPath: string
  outputPath?: string
  dryRun: boolean
  limit?: number
}

function extractSpecError(message: string, specPath: string): CliUsageError {
  return new CliUsageError(message, {
    code: EXTRACT_SPEC_ERROR_CODE,
    details: { path: specPath },
  })
}

/**
 * 解析 extract 的位置参数与本地选项。
 *
 * --output/--limit/--dry-run 都是命令级选项，全局 flags 解析只认识 --tab/--frame 等，
 * 因此这里拿到的 rest 里仍是原始 token。
 */
function parseExtractArgs(rest: string[]): ExtractCliOptions {
  let specPath: string | undefined
  let outputPath: string | undefined
  let dryRun = false
  let limit: number | undefined

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--output') {
      if (outputPath !== undefined) throw new Error('duplicate --output option')
      const next = rest[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error('missing value for --output')
      outputPath = next
      index += 1
      continue
    }
    if (value === '--limit') {
      if (limit !== undefined) throw new Error('duplicate --limit option')
      const next = rest[index + 1]
      if (next === undefined) throw new Error('missing value for --limit')
      const parsed = Number(next)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > EXTRACT_MAX_LIMIT) {
        throw new Error(`--limit must be an integer between 1 and ${EXTRACT_MAX_LIMIT}`)
      }
      limit = parsed
      index += 1
      continue
    }
    if (value === '--dry-run') {
      if (dryRun) throw new Error('duplicate --dry-run option')
      dryRun = true
      continue
    }
    if (value.startsWith('--')) throw new Error(`unsupported extract option: ${value}`)
    if (specPath !== undefined) throw new Error(`unexpected extra argument for extract: ${value}`)
    specPath = value
  }

  if (!specPath) throw new Error('missing extract spec file')
  if (dryRun && outputPath !== undefined) {
    throw new Error('--dry-run cannot be combined with --output')
  }

  return {
    specPath,
    dryRun,
    ...(outputPath !== undefined ? { outputPath } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}

async function readExtractSpec(specPath: string): Promise<ExtractSpec> {
  const resolvedPath = path.resolve(specPath)
  const text = await readFile(resolvedPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw extractSpecError(`extract spec is not valid JSON: ${message}`, specPath)
  }
  try {
    return normalizeExtractSpec(parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw extractSpecError(message, specPath)
  }
}

async function writeJsonlFile(filePath: string, items: Record<string, unknown>[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const content = items.map((item) => JSON.stringify(item)).join('\n')
  const body = content ? `${content}\n` : ''
  if (process.platform === 'win32') {
    // 与 writeJsonFile 一致：Windows 上 rename 覆盖可能间歇性 EPERM/EBUSY。
    await writeFile(filePath, body, 'utf8')
    return
  }
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(tempPath, body, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    // rename 失败时清掉临时文件，避免输出目录里堆积 .tmp 残渣。
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function handleExtract(rest: string[], context: CommandContext): Promise<number | void> {
  if (rest.some((value) => isHelpToken(value))) {
    context.writeHelp(['extract'])
    return 0
  }

  const options = parseOrThrow(() => parseExtractArgs(rest))
  const spec = await readExtractSpec(options.specPath)
  const limit = resolveExtractLimit({
    specLimit: spec.limit,
    cliLimit: options.limit,
    dryRun: options.dryRun,
  })

  // 复用 eval 的 args 注入：spec 只作为数据进入页面，脚本本身是固定源码。
  // 强制 detailed：concise 的 32KiB 上限会把大结果截断，质量报告就成了假数据；
  // 需要控制体积时走 --output/--limit，而不是牺牲报告准确性。
  const payload = await context.requestCommand(context.flags.server, 'eval', {
    script: EXTRACT_PAGE_SCRIPT,
    responseFormat: 'detailed',
    args: {
      spec: {
        itemSelector: spec.itemSelector,
        fields: spec.fields,
        limit,
      },
    },
  })
  if (payload.ok === false) {
    context.writeResult(payload)
    return 1
  }

  let extracted: ExtractPageResult
  try {
    extracted = parseExtractResult(payload.result)
  } catch (error) {
    throwCommandError(error)
  }
  const quality = buildExtractQuality(extracted)

  if (options.outputPath === undefined) {
    context.writeResult({ ok: true, result: { items: extracted.items, quality } })
    return 0
  }

  const outputPath = path.resolve(options.outputPath)
  await writeJsonlFile(outputPath, extracted.items)
  context.writeResult({
    ok: true,
    result: { path: outputPath, itemCount: extracted.items.length, quality },
  })
  return 0
}

export const extractCommandRegistry: CommandRegistry = {
  extract: handleExtract,
}
