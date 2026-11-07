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

/**
 * 命令名的最近邻候选。
 *
 * 命令名没有 -- 前缀，而且最常见的误用是"只写对了一半"（snap → snapshot），
 * 所以命令名用前缀命中优先 + 宽松的编辑距离兜底；编辑距离还要求首字母相同，
 * 避免 "bogus" 命中 "focus" 这种纯噪声候选。
 */
export function didYouMeanCommand(
  value: string,
  candidates: readonly string[],
  limit = 3,
): string[] {
  const target = value.trim().toLowerCase()
  if (!target) {
    return []
  }

  return candidates
    .map((candidate) => ({
      candidate,
      score: commandCandidateScore(target, candidate.toLowerCase()),
    }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => (left.score ?? 0) - (right.score ?? 0))
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

function commandCandidateScore(target: string, candidate: string): number | null {
  if (candidate === target) {
    return 0
  }
  if (candidate.startsWith(target)) {
    return 1
  }
  if (candidate.includes(target)) {
    return 2
  }
  if (candidate[0] !== target[0]) {
    return null
  }

  const distance = editDistance(target, candidate)
  const threshold = Math.max(2, Math.floor(target.length / 3))
  return distance <= threshold ? 3 + distance : null
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
