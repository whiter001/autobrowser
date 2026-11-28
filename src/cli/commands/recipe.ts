import { chmod, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { isRecord } from '../client.js'
import {
  normalizeRecipeSpec,
  recipeMetadata,
  RECIPE_MAX_SPEC_BYTES,
  RECIPE_MAX_TIMEOUT_MS,
  RECIPE_MIN_TIMEOUT_MS,
  isValidRecipeName,
  type RecipeSpec,
} from '../../core/recipe.js'
import { writeJsonFile } from '../../core/protocol.js'
import { stripBom } from '../../core/text.js'
import { CliUsageError } from '../cli-error.js'
import { isHelpToken } from '../help.js'
import { COMMAND_ACTIONS } from './actions.js'
import type { CommandContext, CommandRegistry } from './types.js'

const RECIPE_ACTIONS = COMMAND_ACTIONS.recipe.actions

const RECIPE_NOT_FOUND = 'RECIPE_NOT_FOUND'
const RECIPE_ALREADY_EXISTS = 'RECIPE_ALREADY_EXISTS'
const INVALID_RECIPE_SPEC = 'INVALID_RECIPE_SPEC'
const RECIPE_ARGUMENTS_INVALID = 'RECIPE_ARGUMENTS_INVALID'

function usageError(message: string, pathLabel: string, details?: unknown): CliUsageError {
  return new CliUsageError(message, {
    details: { path: pathLabel, ...(isRecord(details) ? details : {}) },
  })
}

function specError(message: string, details: Record<string, unknown>): CliUsageError {
  return new CliUsageError(message, { code: INVALID_RECIPE_SPEC, details })
}

function notFoundError(name: string, filePath: string): CliUsageError {
  return new CliUsageError(`recipe not found: ${name}`, {
    code: RECIPE_NOT_FOUND,
    details: { name, path: filePath },
    suggestedAction: `Run 'autobrowser recipe list' to see saved recipes, then save this one with 'autobrowser recipe save ${name} <spec.json>'.`,
  })
}

function alreadyExistsError(name: string, filePath: string): CliUsageError {
  return new CliUsageError(`recipe already exists: ${name}`, {
    code: RECIPE_ALREADY_EXISTS,
    details: { name, path: filePath },
    suggestedAction:
      'Run the command with --force to overwrite it, or choose a different recipe name.',
  })
}

function argumentsInvalidError(message: string, details: Record<string, unknown>): CliUsageError {
  return new CliUsageError(message, {
    code: RECIPE_ARGUMENTS_INVALID,
    details,
    suggestedAction:
      'Pass every required parameter (non-empty) as --arg key=value or --args-json, then run the recipe again.',
  })
}

function recipesRoot(context: CommandContext): string {
  return path.join(context.homeDir, 'recipes')
}

function recipeFilePath(context: CommandContext, name: string): string {
  return path.join(recipesRoot(context), `${name}.json`)
}

/** 目录权限是"尽量 700"：Windows 上 chmod 语义不同，失败不能阻断保存。 */
async function ensureRecipesRoot(context: CommandContext): Promise<string> {
  const root = recipesRoot(context)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    await chmod(root, 0o700).catch(() => {})
  }
  return root
}

function requireRecipeName(value: string | undefined, pathLabel: string): string {
  if (!value) {
    throw usageError(`missing recipe name for ${pathLabel}`, pathLabel)
  }
  if (!isValidRecipeName(value)) {
    throw usageError(
      `invalid recipe name ${JSON.stringify(value)}: use a lowercase slug of letters, digits, "_" or "-" (max 64 chars)`,
      pathLabel,
    )
  }
  return value
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function parseSpecText(text: string, filePath: string): RecipeSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw specError(`recipe spec is not valid JSON: ${message}`, { path: filePath })
  }
  try {
    return normalizeRecipeSpec(parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw specError(message, { path: filePath })
  }
}

async function readSpecFile(specPath: string): Promise<RecipeSpec> {
  const resolved = path.resolve(specPath)
  let size: number
  try {
    const stats = await stat(resolved)
    if (!stats.isFile())
      throw specError(`recipe spec path is not a file: ${resolved}`, { path: resolved })
    size = stats.size
  } catch (error) {
    if (error instanceof CliUsageError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw specError(`recipe spec file not found: ${resolved}`, { path: resolved })
    }
    throw error
  }
  if (size > RECIPE_MAX_SPEC_BYTES) {
    throw specError(`recipe spec file exceeds ${RECIPE_MAX_SPEC_BYTES} bytes`, { path: resolved })
  }
  return parseSpecText(await readFile(resolved, 'utf8'), resolved)
}

async function readStoredRecipe(context: CommandContext, name: string): Promise<RecipeSpec> {
  const filePath = recipeFilePath(context, name)
  let size: number
  try {
    const stats = await stat(filePath)
    if (!stats.isFile())
      throw specError(`recipe path is not a file: ${filePath}`, { path: filePath })
    size = stats.size
  } catch (error) {
    if (error instanceof CliUsageError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFoundError(name, filePath)
    throw error
  }
  if (size > RECIPE_MAX_SPEC_BYTES) {
    throw specError(`recipe file exceeds ${RECIPE_MAX_SPEC_BYTES} bytes: ${filePath}`, {
      path: filePath,
    })
  }
  const spec = parseSpecText(await readFile(filePath, 'utf8'), filePath)
  // 文件名是查找主键；内容里的 name 与之不符说明文件被手改过或放错了位置。
  if (spec.name !== name) {
    throw specError(
      `recipe file ${filePath} declares name ${JSON.stringify(spec.name)} instead of ${JSON.stringify(name)}`,
      { path: filePath },
    )
  }
  return spec
}

interface SaveOptions {
  name: string
  specPath: string
  force: boolean
}

function parseSaveOptions(rest: string[]): SaveOptions {
  const positionals: string[] = []
  let force = false
  for (const value of rest) {
    if (value === '--force') {
      if (force) throw usageError('duplicate --force option', 'recipe save')
      force = true
      continue
    }
    if (value.startsWith('--')) {
      throw usageError(`unsupported recipe save option: ${value}`, 'recipe save')
    }
    positionals.push(value)
  }
  if (positionals.length < 2) {
    throw usageError('usage: autobrowser recipe save <name> <spec.json> [--force]', 'recipe save')
  }
  if (positionals.length > 2) {
    throw usageError(`unexpected extra argument for recipe save: ${positionals[2]}`, 'recipe save')
  }
  return {
    name: requireRecipeName(positionals[0], 'recipe save'),
    specPath: positionals[1]!,
    force,
  }
}

async function saveRecipe(rest: string[], context: CommandContext): Promise<number | void> {
  const options = parseSaveOptions(rest)
  const spec = await readSpecFile(options.specPath)
  if (spec.name !== options.name) {
    throw specError(
      `recipe spec name ${JSON.stringify(spec.name)} does not match the save name ${JSON.stringify(options.name)}`,
      { path: path.resolve(options.specPath), name: options.name },
    )
  }

  const filePath = recipeFilePath(context, options.name)
  const existed = await fileExists(filePath)
  if (existed && !options.force) {
    throw alreadyExistsError(options.name, filePath)
  }

  await ensureRecipesRoot(context)
  await writeJsonFile(filePath, spec)
  context.writeResult({
    ok: true,
    result: {
      name: spec.name,
      path: filePath,
      overwritten: existed,
      lastVerified: spec.lastVerified,
    },
  })
  return 0
}

async function listRecipes(rest: string[], context: CommandContext): Promise<number | void> {
  if (rest.length > 0) {
    throw usageError(`unexpected argument for recipe list: ${rest[0]}`, 'recipe list')
  }
  const root = recipesRoot(context)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      context.writeResult({ ok: true, result: { count: 0, recipes: [] } })
      return 0
    }
    throw error
  }

  const recipes = []
  for (const entry of entries) {
    // writeJsonFile 的 .tmp 残渣和用户随手放的其它文件不参与列表。
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const name = entry.name.slice(0, -'.json'.length)
    if (!isValidRecipeName(name)) {
      throw specError(`recipe file has an invalid name: ${path.join(root, entry.name)}`, {
        path: path.join(root, entry.name),
      })
    }
    recipes.push(recipeMetadata(await readStoredRecipe(context, name)))
  }
  recipes.sort((left, right) => left.name.localeCompare(right.name))
  context.writeResult({ ok: true, result: { count: recipes.length, recipes } })
  return 0
}

async function showRecipe(rest: string[], context: CommandContext): Promise<number | void> {
  if (rest.length < 1) {
    throw usageError('usage: autobrowser recipe show <name>', 'recipe show')
  }
  if (rest.length > 1) {
    throw usageError(`unexpected extra argument for recipe show: ${rest[1]}`, 'recipe show')
  }
  const name = requireRecipeName(rest[0], 'recipe show')
  const spec = await readStoredRecipe(context, name)
  context.writeResult({
    ok: true,
    result: { path: recipeFilePath(context, name), recipe: spec },
  })
  return 0
}

interface RunOptions {
  args: Record<string, string>
  timeoutMs?: number
}

function parseTimeout(value: string | undefined, pathLabel: string): number {
  if (value === undefined) {
    throw usageError('missing value for --timeout-ms', pathLabel)
  }
  const parsed = Number(value)
  if (
    !Number.isInteger(parsed) ||
    parsed < RECIPE_MIN_TIMEOUT_MS ||
    parsed > RECIPE_MAX_TIMEOUT_MS
  ) {
    throw usageError(
      `--timeout-ms must be an integer between ${RECIPE_MIN_TIMEOUT_MS} and ${RECIPE_MAX_TIMEOUT_MS}`,
      pathLabel,
    )
  }
  return parsed
}

/**
 * 解析 run/verify 的注入参数。
 *
 * 与 eval 不同：--arg 的值永远按字符串进入 args；--args-json 的字符串原样保留，
 * 其余类型 JSON.stringify 后作为字符串，保证页面脚本只需处理一种值类型。
 */
function parseRunOptions(rest: string[], pathLabel: string): RunOptions {
  // null 原型避免 __proto__ 之类的键改写对象原型。
  const args: Record<string, string> = Object.create(null)
  let argsUsed = false
  let argsJsonUsed = false
  let timeoutMs: number | undefined

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--timeout-ms') {
      if (timeoutMs !== undefined) {
        throw usageError('duplicate --timeout-ms option', pathLabel)
      }
      timeoutMs = parseTimeout(rest[index + 1], pathLabel)
      index += 1
      continue
    }
    if (value === '--arg') {
      if (argsJsonUsed) {
        throw usageError('--arg and --args-json cannot be combined', pathLabel)
      }
      const pair = rest[index + 1]
      if (pair === undefined) {
        throw usageError('missing value for --arg', pathLabel)
      }
      const separator = pair.indexOf('=')
      if (separator < 0) {
        throw usageError(`invalid --arg ${JSON.stringify(pair)}: expected key=value`, pathLabel)
      }
      const key = pair.slice(0, separator)
      if (!key) {
        throw usageError('invalid --arg: key must be non-empty (expected key=value)', pathLabel)
      }
      if (key in args) {
        throw usageError(`duplicate --arg key: ${key}`, pathLabel)
      }
      args[key] = pair.slice(separator + 1)
      argsUsed = true
      index += 1
      continue
    }
    if (value === '--args-json') {
      if (argsUsed) {
        throw usageError('--arg and --args-json cannot be combined', pathLabel)
      }
      if (argsJsonUsed) {
        throw usageError('duplicate --args-json option', pathLabel)
      }
      const raw = rest[index + 1]
      if (raw === undefined) {
        throw usageError('missing value for --args-json', pathLabel)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw usageError('invalid --args-json: expected a JSON object', pathLabel)
      }
      if (!isRecord(parsed) || Array.isArray(parsed)) {
        throw usageError('invalid --args-json: expected a JSON object', pathLabel)
      }
      for (const [key, entry] of Object.entries(parsed)) {
        if (!key) {
          throw usageError('invalid --args-json: keys must be non-empty', pathLabel)
        }
        args[key] = typeof entry === 'string' ? entry : (JSON.stringify(entry) ?? 'null')
      }
      argsJsonUsed = true
      index += 1
      continue
    }
    if (value.startsWith('--')) {
      throw usageError(`unsupported ${pathLabel} option: ${value}`, pathLabel)
    }
    throw usageError(`unexpected extra argument for ${pathLabel}: ${value}`, pathLabel)
  }

  return { args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
}

function validateRecipeArgs(
  spec: RecipeSpec,
  args: Record<string, string>,
): { warnings: string[] } {
  const missing = spec.params
    .filter(
      (param) => param.required && (args[param.name] === undefined || args[param.name] === ''),
    )
    .map((param) => param.name)
  if (missing.length > 0) {
    throw argumentsInvalidError(
      `recipe ${spec.name} is missing required argument(s): ${missing.join(', ')}`,
      { recipe: spec.name, missing },
    )
  }

  const declared = new Set(spec.params.map((param) => param.name))
  const undeclared = Object.keys(args)
    .filter((key) => !declared.has(key))
    .sort()
  const warnings =
    undeclared.length > 0
      ? [
          `recipe ${spec.name} does not declare argument(s): ${undeclared.join(', ')}; they were passed through anyway`,
        ]
      : []
  return { warnings }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

/**
 * 读取当前标签页 URL。
 *
 * 读不到时返回空串：调用方会按"跨源"处理并显式 goto，而不是拿未知来源去猜复用。
 */
async function readCurrentUrl(context: CommandContext): Promise<string> {
  const payload = await context.requestCommand(context.flags.server, 'get', { attr: 'url' })
  if (payload.ok === false) return ''
  return typeof payload.result === 'string' ? payload.result : ''
}

/**
 * 保留原始错误码，同时补上 recipe 上下文。
 *
 * 不能把失败改写成 verified:false 之类的"成功响应"：调用方会误以为脚本跑过一遍。
 */
function writeExecutionFailure(
  context: CommandContext,
  payload: Awaited<ReturnType<CommandContext['requestCommand']>>,
  spec: RecipeSpec,
  mode: 'run' | 'verify',
): 1 {
  const error = payload.error ?? { message: 'recipe execution failed' }
  const baseDetails = error.details
  const recipeContext = { name: spec.name, entryUrl: spec.entryUrl }
  const details =
    baseDetails === undefined
      ? { recipe: recipeContext }
      : isRecord(baseDetails) && !Array.isArray(baseDetails)
        ? { ...baseDetails, recipe: recipeContext }
        : { recipe: recipeContext, cause: baseDetails }

  const hint =
    mode === 'verify'
      ? `Fix the recipe script/spec or the page state, then run 'autobrowser recipe verify ${spec.name}' again; lastVerified was not changed.`
      : `Inspect the failure, fix the script or page state, then run 'autobrowser recipe run ${spec.name}' again.`
  const original =
    typeof error.suggestedAction === 'string'
      ? error.suggestedAction
      : typeof error.suggestion === 'string'
        ? error.suggestion
        : ''

  context.writeResult({
    ok: false,
    error: {
      ...error,
      details,
      suggestedAction: original ? `${original} ${hint}` : hint,
    },
  })
  return 1
}

/**
 * 解包 eval 结果。
 *
 * eval 对对象结果可能返回 {value, meta}，对字符串/数字/boolean/null/数组等原始值则直接返回原值；
 * 只有对象自身带 value 字段时才取 value，其余情况保留整个 result，不能把原始值丢掉。
 */
function readEvalValue(result: unknown): unknown {
  if (isRecord(result) && Object.prototype.hasOwnProperty.call(result, 'value')) {
    return (result as Record<string, unknown>).value
  }
  return result
}

async function executeRecipe(
  rest: string[],
  context: CommandContext,
  mode: 'run' | 'verify',
): Promise<number | void> {
  const pathLabel = `recipe ${mode}`
  if (rest.length < 1) {
    throw usageError(
      `usage: autobrowser recipe ${mode} <name> [--arg key=value ...|--args-json <object>] [--timeout-ms <ms>]`,
      pathLabel,
    )
  }
  const name = requireRecipeName(rest[0], pathLabel)
  const options = parseRunOptions(rest.slice(1), pathLabel)
  const spec = await readStoredRecipe(context, name)
  const { warnings } = validateRecipeArgs(spec, options.args)

  const currentUrl = await readCurrentUrl(context)
  // 同源就复用当前页面状态（登录、滚动位置、已展开的面板）；跨源才导航到 entryUrl。
  if (!sameOrigin(currentUrl, spec.entryUrl)) {
    const gotoPayload = await context.requestCommand(context.flags.server, 'goto', {
      url: spec.entryUrl,
    })
    if (gotoPayload.ok === false) {
      return writeExecutionFailure(context, gotoPayload, spec, mode)
    }
  }

  const evalPayload = await context.requestCommand(context.flags.server, 'eval', {
    script: spec.script,
    args: options.args,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
  if (evalPayload.ok === false) {
    return writeExecutionFailure(context, evalPayload, spec, mode)
  }

  const value = readEvalValue(evalPayload.result)

  if (mode === 'run') {
    context.writeResult({
      ok: true,
      result: {
        recipe: { name: spec.name, entryUrl: spec.entryUrl, lastVerified: spec.lastVerified },
        value,
        warnings,
      },
    })
    return 0
  }

  // 只有真正执行成功才固化验证时间；失败路径在上面的 return 里已经结束。
  const verifiedAt = new Date().toISOString()
  await writeJsonFile(recipeFilePath(context, name), { ...spec, lastVerified: verifiedAt })
  context.writeResult({
    ok: true,
    result: {
      verified: true,
      recipe: { name: spec.name, entryUrl: spec.entryUrl, lastVerified: verifiedAt },
      value,
      warnings,
    },
  })
  return 0
}

async function handleRecipe(rest: string[], context: CommandContext): Promise<number | void> {
  if (isHelpToken(rest[0])) {
    context.writeHelp(['recipe'])
    return 0
  }
  const action = rest[0]
  if (!action || !(RECIPE_ACTIONS as readonly string[]).includes(action)) {
    throw usageError(
      `unsupported recipe action: ${action || '(empty)'} (expected ${RECIPE_ACTIONS.join('|')})`,
      'recipe',
    )
  }
  // 二级帮助必须在解析位置参数前截住，否则 `recipe run --help` 会被当成缺 name。
  if (rest.slice(1).some((value) => isHelpToken(value))) {
    context.writeHelp(['recipe', action])
    return 0
  }

  const actionRest = rest.slice(1)
  switch (action) {
    case 'save':
      return await saveRecipe(actionRest, context)
    case 'list':
      return await listRecipes(actionRest, context)
    case 'show':
      return await showRecipe(actionRest, context)
    case 'run':
    case 'verify':
      return await executeRecipe(actionRest, context, action)
    default:
      throw usageError(`unsupported recipe action: ${action}`, 'recipe')
  }
}

export const recipeCommandRegistry: CommandRegistry = {
  recipe: handleRecipe,
}
