/**
 * 未知命令行参数的最近邻建议。
 * 目的是把"unsupported option"从死胡同变成纠错提示：--limit / --page-size 这种近义参数
 * 人和 agent 都会混用，直接报错只会诱发下一轮猜测。
 */
export function didYouMeanOption(value: string, candidates: readonly string[]): string | null {
  const target = value.trim()
  if (!target.startsWith('--')) {
    return null
  }

  let best: { candidate: string; distance: number } | null = null
  for (const candidate of candidates) {
    const distance = editDistance(target, candidate)
    if (!best || distance < best.distance) {
      best = { candidate, distance }
    }
  }

  if (!best) {
    return null
  }
  // 阈值随长度放宽，但始终不超过参数长度的一半，避免给出毫无意义的纠正
  const threshold = Math.max(2, Math.floor(target.length / 3))
  return best.distance <= threshold ? best.candidate : null
}

/** 拼进错误消息的尾巴；没有合适候选时返回空串，调用方无需分支。 */
export function optionHintSuffix(value: string, candidates: readonly string[]): string {
  const hint = didYouMeanOption(value, candidates)
  return hint ? ` (did you mean ${hint}?)` : ''
}

/** 经典 Levenshtein：参数名都很短，直接算比引入依赖更省事。 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_unused, index) => index)
  for (let row = 1; row < rows; row += 1) {
    const current = [row]
    for (let col = 1; col < cols; col += 1) {
      const substitution = previous[col - 1] + (a[row - 1] === b[col - 1] ? 0 : 1)
      current[col] = Math.min(previous[col] + 1, current[col - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[cols - 1]
}
