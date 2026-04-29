import { describe, expect, test } from 'bun:test'
import {
  collapseWhitespace,
  parsePageContextElementRefIndex,
  splitWhitespaceTokens,
} from '../extension/background/page-context-helpers.js'

function evaluateSerializedHelpers<TResult>(expression: string): TResult {
  return (0, eval)(`(() => {
${collapseWhitespace.toString()}
${splitWhitespaceTokens.toString()}
${parsePageContextElementRefIndex.toString()}
return (${expression});
})()`) as TResult
}

describe('page context helpers', () => {
  test('collapses mixed whitespace for snapshot and find text normalization', () => {
    expect(collapseWhitespace('  hello\n\tworld   again  ')).toBe('hello world again')
  })

  test('splits aria-labelledby token lists by any whitespace', () => {
    expect(splitWhitespaceTokens('first\n second\t\tthird  fourth')).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ])
  })

  test('parses existing element ref ordinals from trimmed attribute values', () => {
    expect(parsePageContextElementRefIndex(' e42 ')).toBe(42)
    expect(parsePageContextElementRefIndex('x42')).toBeNull()
  })

  test('preserves regex behavior after helper source is serialized into injected scripts', () => {
    expect(
      evaluateSerializedHelpers<string>("collapseWhitespace('  hello\\n\\tworld   again  ')"),
    ).toBe('hello world again')
    expect(
      evaluateSerializedHelpers<string[]>(
        "splitWhitespaceTokens('first\\n second\\t\\tthird  fourth')",
      ),
    ).toEqual(['first', 'second', 'third', 'fourth'])
    expect(
      evaluateSerializedHelpers<number | null>("parsePageContextElementRefIndex(' e42 ')"),
    ).toBe(42)
  })
})
