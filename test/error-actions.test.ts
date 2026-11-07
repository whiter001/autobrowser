import { describe, expect, test } from 'bun:test'
import { ERROR_ACTIONS, describeErrorCode } from '../src/core/error-actions.js'

const SOURCE_DIRS = ['src', 'extension']
const CODE_PATTERN = /(?:code = |code: )'([A-Z][A-Z0-9_]+)'/g

async function collectSourceCodes(): Promise<string[]> {
  const codes = new Set<string>()
  const glob = new Bun.Glob('**/*.ts')
  for (const dir of SOURCE_DIRS) {
    for await (const file of glob.scan({ cwd: `${import.meta.dir}/../${dir}` })) {
      if (file.includes('node_modules')) continue
      const text = await Bun.file(`${import.meta.dir}/../${dir}/${file}`).text()
      for (const match of text.matchAll(CODE_PATTERN)) {
        codes.add(match[1])
      }
    }
  }
  return [...codes].sort()
}

describe('error action table', () => {
  test('every statically assigned error code has a next step', async () => {
    // 新增错误码却忘了给动作时，这条会失败——这正是"单一事实来源"要挡住的漂移
    const missing = (await collectSourceCodes()).filter((code) => !(code in ERROR_ACTIONS))
    expect(missing).toEqual([])
  })

  test('describes known codes and falls back generically for unknown ones', () => {
    expect(describeErrorCode('STALE_ELEMENT_REF')?.action).toContain('snapshot')
    expect(describeErrorCode('MODAL_OPEN')?.action).toContain('dialog')
    expect(describeErrorCode('SOME_FUTURE_CODE')).toMatchObject({ retryable: false })
    expect(describeErrorCode('SOME_FUTURE_CODE')?.action).toContain('status')
    expect(describeErrorCode(null)).toBeNull()
    expect(describeErrorCode('')).toBeNull()
  })

  test('marks genuinely retryable failures so callers do not treat them as fatal', () => {
    expect(describeErrorCode('COMMAND_TIMEOUT')?.retryable).toBe(true)
    expect(describeErrorCode('EXTENSION_DISCONNECTED')?.retryable).toBe(true)
    expect(describeErrorCode('STALE_TAB_HANDLE')?.retryable).toBe(false)
    expect(describeErrorCode('COMMAND_EXECUTION_UNKNOWN')?.retryable).toBe(false)
  })
})
