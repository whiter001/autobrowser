import { describe, expect, test } from 'bun:test'
import { didYouMeanOption, optionHintSuffix } from '../src/cli/option-hints.js'
import { parseConsoleArgs, parseNetworkRequestsArgs } from '../src/cli/parse.js'

describe('option hints', () => {
  test('suggests the closest known option', () => {
    // 拼写错误能被纠正；--limit 这类语义近似但字面差距大的写法由别名兜，不指望编辑距离
    expect(didYouMeanOption('--page-siz', ['--page', '--page-size', '--sort'])).toBe('--page-size')
    expect(didYouMeanOption('--page-size', ['--page', '--page-size'])).toBe('--page-size')
    expect(didYouMeanOption('  --page-siz  ', ['--page-size'])).toBe('--page-size')
  })

  test('stays silent when nothing is close enough', () => {
    expect(didYouMeanOption('--completely-different', ['--page-size'])).toBeNull()
    expect(didYouMeanOption('positional', ['--page-size'])).toBeNull()
    expect(didYouMeanOption('--x', [])).toBeNull()
    expect(optionHintSuffix('--screen', ['--page-size'])).toBe('')
  })

  test('formats the suffix only when a candidate exists', () => {
    expect(optionHintSuffix('--page-siz', ['--page-size'])).toBe(' (did you mean --page-size?)')
  })
})

describe('pagination aliases', () => {
  test('network requests accepts --limit as a page-size alias', () => {
    // 实测里最容易写错的一处：--limit 在分页命令上应等同于 --page-size
    expect(parseNetworkRequestsArgs(['--limit', '5'])).toMatchObject({ pageSize: 5 })
    expect(parseNetworkRequestsArgs(['--page-size', '5'])).toMatchObject({ pageSize: 5 })
    expect(() => parseNetworkRequestsArgs(['--limit', '0'])).toThrow('expected >= 1')
  })

  test('network requests points at the right option when one is misspelled', () => {
    expect(() => parseNetworkRequestsArgs(['--page-siz', '5'])).toThrow(
      'unsupported network option: --page-siz (did you mean --page-size?)',
    )
  })

  test('console accepts --limit and suggests options on typos', () => {
    expect(parseConsoleArgs(['--limit', '10'])).toMatchObject({ pageSize: 10 })
    expect(() => parseConsoleArgs(['--levl', 'error'])).toThrow(
      'unsupported console option: --levl (did you mean --level?)',
    )
  })
})
