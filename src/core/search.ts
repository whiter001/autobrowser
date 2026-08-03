export interface SearchQuerySpec {
  /** 是否为 /pattern/flags 正则形式；false 表示纯文本子串匹配 */
  literal: boolean
  /** 编译后的 RegExp（用于校验与单测） */
  regex: RegExp
  /** 用户输入的原始模式（正则形式去掉首尾斜杠；纯文本就是查询串本身） */
  pattern: string
  /** 归一化后的正则标志（g 被剥离，因为结果按窗口返回，无需全局匹配） */
  flags: string
}

function escapeRegExpSource(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把 search 查询解析成 RegExp 规格。
 * 形如 `/pattern/flags` 的输入按正则处理（`g` 标志被剥离）；
 * 其余文本一律当作大小写不敏感的子串匹配。
 */
export function parseSearchQueryRegex(query: string): SearchQuerySpec {
  const literalMatch = /^\/(.+)\/([a-zA-Z]*)$/.exec(query)
  if (literalMatch) {
    const [, pattern, rawFlags] = literalMatch
    const flags = rawFlags.replace(/g/g, '')
    try {
      return {
        literal: false,
        regex: new RegExp(pattern, flags),
        pattern,
        flags,
      }
    } catch {
      throw new Error(`invalid search regex: ${query}`)
    }
  }

  return {
    literal: true,
    regex: new RegExp(escapeRegExpSource(query), 'i'),
    pattern: query,
    flags: 'i',
  }
}
