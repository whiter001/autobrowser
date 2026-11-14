import { parseSearchQueryRegex } from '../../src/core/search.js'
import { boundPageText } from './page-context-helpers.js'
import type { PageObserveDependencies } from './page-observe-context.js'
import { getPageEpoch, withFrameSelectorOptions } from './targeting.js'
import type { FrameSelector, TabInput } from './types.js'

const SEARCH_LINE_MAX_LENGTH = 240
const SEARCH_MAX_LIMIT = 200

export interface SearchMatchLine {
  line: number
  text: string
  matched: boolean
  /** 该行文本超过行宽上限被截断 */
  truncated: boolean
}

export interface SearchWindow {
  startLine: number
  endLine: number
  lines: SearchMatchLine[]
}

export interface SearchPageTextResult {
  pageEpoch: number
  query: string
  /** 查询是否为 /pattern/flags 正则形式（false 表示纯文本子串匹配） */
  regex: boolean
  /** 用户输入的原始模式（正则形式去掉首尾斜杠） */
  pattern: string
  context: number
  limit: number
  readyState: string
  totalMatches: number
  empty?: boolean
  emptyReason?: 'NO_DATA' | 'NO_MATCH'
  /** 字面量查询零命中且含正则元字符时的改写提示（有命中、显式正则、NO_DATA 时不存在） */
  hint?: string
  returned: number
  /** 窗口、行数、字节或单行宽度发生截断 */
  truncated: boolean
  startLine: number
  nextStartLine?: number
  windows: SearchWindow[]
  modal?: {
    open: boolean
    type: string
    message: string
    defaultPrompt: string
  }
}

export interface SearchPageTextOptions {
  query?: string
  context?: number
  limit?: number
  startLine?: number
  responseFormat?: 'concise' | 'detailed'
}

/** 纯函数通过 toString 注入，不能引用模块闭包。续取按原始行号裁窗口，避免上下文重复。 */
export function computeSearchPageTextMatches(
  rawText: string,
  query: string,
  pattern: string,
  regexFlags: string,
  context: number,
  limit: number,
  lineMax: number,
  readyState: string,
  startLine = 1,
  byteMax = 100_000,
  lineLimit = 200,
): Omit<SearchPageTextResult, 'pageEpoch'> {
  const escapeRegExpSource = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const literal = !/^\/(.+)\/([a-zA-Z]*)$/.test(query)
  const regex = new RegExp(literal ? escapeRegExpSource(pattern) : pattern, regexFlags)
  context = Number.isFinite(context) ? Math.min(50, Math.max(0, Math.floor(context))) : 3
  limit = Number.isFinite(limit) ? Math.min(200, Math.max(0, Math.floor(limit))) : 20
  startLine = Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : 1
  lineMax = Number.isFinite(lineMax) ? Math.min(240, Math.max(0, Math.floor(lineMax))) : 240
  const lines = rawText.split('\n')
  const matchedLines = new Set<number>()
  const merged: Array<{ startLine: number; endLine: number }> = []
  for (let index = 0; index < lines.length; index += 1) {
    regex.lastIndex = 0
    if (!regex.test(lines[index]!)) continue
    matchedLines.add(index + 1)
    const from = Math.max(startLine, index + 1 - context)
    const to = Math.min(lines.length, index + 1 + context)
    if (to < from) continue
    const last = merged[merged.length - 1]
    if (last && from <= last.endLine + 1) last.endLine = to
    else merged.push({ startLine: from, endLine: to })
  }
  const encoder = new TextEncoder()
  // 回显也计入预算，超大查询不能挤占全部行预算。
  const echo = (text: string) => text.slice(0, 1024)
  const hasText = rawText.trim() !== ''
  const windows: SearchWindow[] = []
  const result: Omit<SearchPageTextResult, 'pageEpoch'> = {
    query: echo(query),
    regex: !literal,
    pattern: echo(pattern),
    context,
    limit,
    startLine,
    readyState: echo(readyState),
    totalMatches: matchedLines.size,
    empty: matchedLines.size === 0,
    ...(matchedLines.size === 0 ? { emptyReason: hasText ? 'NO_MATCH' : 'NO_DATA' } : {}),
    returned: 0,
    truncated: query.length > 1024 || pattern.length > 1024,
    windows,
  }
  // 字面量模式下元字符只是普通字符，零命中时最容易误判成“页面没有内容”；
  // 只在有文本可查时提示改写方式，避免对 NO_DATA 或无元字符的普通查询刷噪音。
  if (literal && hasText && matchedLines.size === 0 && /[\\^$.*+?()[\]{}|]/.test(query)) {
    const example = echo(query).replace(/\//g, '\\/')
    result.hint =
      'Matched the query as literal text, so regex metacharacters such as | * ( ) [ ] ? + \\ ' +
      `are not operators; no line contains it. To match as a regex, use /pattern/flags, e.g. /${example}/.`
  }
  let remaining = byteMax - encoder.encode(JSON.stringify(result)).length - 1024
  let count = 0
  outer: for (const range of merged) {
    if (windows.length >= limit) {
      result.truncated = true
      // limit=0 是显式不取内容，不给出无法前进的续读游标。
      if (limit > 0) result.nextStartLine = range.startLine
      break
    }
    const window: SearchWindow = { startLine: range.startLine, endLine: range.startLine, lines: [] }
    remaining -= 100
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      const text = lines[line - 1]!
      const item = {
        line,
        text: text.slice(0, lineMax),
        matched: matchedLines.has(line),
        truncated: text.length > lineMax,
      }
      const cost = encoder.encode(JSON.stringify(item)).length + 1
      if (count >= lineLimit || cost > remaining) {
        result.truncated = true
        result.nextStartLine = line
        break outer
      }
      if (window.lines.length === 0) windows.push(window)
      window.lines.push(item)
      window.endLine = line
      count += 1
      remaining -= cost
      if (item.truncated) result.truncated = true
    }
  }
  result.returned = windows.length
  return result
}

const SEARCH_TEXT_MATCH_HELPERS_SOURCE = computeSearchPageTextMatches.toString()

/**
 * 创建页面文本搜索域，支持分页游标与正则匹配。
 */
export function createSearchFeature({
  state,
  getTargetTab,
  evaluateInTabContext,
}: PageObserveDependencies) {
  async function searchPageText(
    tabId: TabInput,
    options: SearchPageTextOptions = {},
    frameSelector: FrameSelector,
  ): Promise<SearchPageTextResult> {
    const query = String(options.query ?? '').trim()
    const context =
      typeof options.context === 'number' && Number.isFinite(options.context)
        ? Math.min(50, Math.max(0, Math.floor(options.context)))
        : 3
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.min(SEARCH_MAX_LIMIT, Math.max(0, Math.floor(options.limit)))
        : options.responseFormat === 'detailed'
          ? 20
          : 10
    const startLine =
      typeof options.startLine === 'number' && Number.isFinite(options.startLine)
        ? Math.max(1, Math.floor(options.startLine))
        : 1
    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const openDialog = state.session.dialogs.get(tab.id)
    if (openDialog || !query) {
      return {
        pageEpoch,
        query: boundPageText(query, 1024),
        regex: false,
        pattern: '',
        context,
        limit,
        startLine,
        readyState: openDialog ? 'blocked' : 'complete',
        totalMatches: 0,
        returned: 0,
        truncated: query.length > 1024,
        windows: [],
        ...(openDialog
          ? {
              modal: {
                open: true,
                type: openDialog.type,
                message: boundPageText(openDialog.message, 1024),
                defaultPrompt: boundPageText(openDialog.defaultPrompt, 1024),
              },
            }
          : {}),
      }
    }
    const spec = parseSearchQueryRegex(query)
    const { value } = await evaluateInTabContext<Partial<SearchPageTextResult>>(
      tab.id,
      `(() => {
        const query = ${JSON.stringify(query)};
        const pattern = ${JSON.stringify(spec.pattern)};
        const regexFlags = ${JSON.stringify(spec.flags)};
        const context = ${context};
        const limit = ${limit};
        const lineMax = ${SEARCH_LINE_MAX_LENGTH};
        const readyState = document.readyState;
        const rawText = document.body?.innerText ?? '';
${SEARCH_TEXT_MATCH_HELPERS_SOURCE}
        return computeSearchPageTextMatches(rawText, query, pattern, regexFlags,
          context, limit, lineMax, readyState, ${startLine},
          ${options.responseFormat === 'detailed' ? 100_000 : 32_768},
          ${options.responseFormat === 'detailed' ? 200 : 100});
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    const matches = value ?? {}
    return {
      pageEpoch,
      query: matches.query ?? boundPageText(query, 1024),
      regex: !spec.literal,
      pattern: matches.pattern ?? boundPageText(spec.pattern, 1024),
      context,
      limit,
      startLine,
      ...(matches.nextStartLine !== undefined ? { nextStartLine: matches.nextStartLine } : {}),
      readyState: matches.readyState ?? 'complete',
      totalMatches: matches.totalMatches ?? 0,
      ...(matches.empty !== undefined ? { empty: matches.empty } : {}),
      ...(matches.emptyReason !== undefined ? { emptyReason: matches.emptyReason } : {}),
      ...(matches.hint !== undefined ? { hint: matches.hint } : {}),
      returned: matches.returned ?? 0,
      truncated: matches.truncated ?? false,
      windows: matches.windows ?? [],
    }
  }

  return { searchPageText }
}
