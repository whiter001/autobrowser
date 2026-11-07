import { describe, expect, test } from 'bun:test'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

/**
 * 解析期错误必须和运行期错误走同一套 JSON 契约：
 * stdout 上是 {ok:false,error:{message,code,suggestedAction}}，agent 才能按错误码分支处理。
 */
describe('CLI parse-time error contract', () => {
  test('missing argument is reported as JSON with a code and a next step', async () => {
    const result = await runCli(['click'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(result.stderr).toBe('')

    const payload = cliErrorPayload(result.stdout)
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('CLI_INVALID_ARGUMENT')
    expect(payload.error.message).toContain('missing value for click')
    expect(payload.error.suggestedAction).toContain('autobrowser help click')
    expect(payload.error.details).toMatchObject({ command: 'click', path: 'click' })
  })

  test('unexpected extra argument keeps the JSON contract', async () => {
    const result = await runCli(['click', '#a', '--nope'])

    expect(result.exitCode).toBe(1)
    const payload = cliErrorPayload(result.stdout)
    expect(payload.error.code).toBe('CLI_INVALID_ARGUMENT')
    expect(payload.error.message).toContain('unexpected extra argument for click: --nope')
    expect(payload.error.suggestedAction).toContain('autobrowser help click')
  })

  test('an unknown global flag is reported as JSON too', async () => {
    const result = await runCli(['--selecor', 'click'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    const payload = cliErrorPayload(result.stdout)
    expect(payload.error.code).toBe('CLI_INVALID_ARGUMENT')
    expect(payload.error.message).toContain('unsupported global option: --selecor')
    expect(payload.error.suggestedAction).toContain('autobrowser help')
  })

  test('an unknown command names itself instead of printing the whole help', async () => {
    const result = await runCli(['bogus'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    // 旧行为是打印整页根 help（130 行），调用方无从判断命令名写错了
    expect(result.stdout).not.toContain('Usage:')

    const payload = cliErrorPayload(result.stdout)
    expect(payload.error.code).toBe('CLI_UNKNOWN_COMMAND')
    expect(payload.error.message).toContain('Unknown command "bogus"')
    expect(payload.error.suggestedAction).toContain('autobrowser help')
  })

  test('a mistyped command suggests the closest command name', async () => {
    const result = await runCli(['snap'])

    expect(result.exitCode).toBe(1)
    const payload = cliErrorPayload(result.stdout)
    expect(payload.error.code).toBe('CLI_UNKNOWN_COMMAND')
    expect(payload.error.message).toContain('Did you mean: snapshot?')
    expect(payload.error.details).toMatchObject({ command: 'snap', candidates: ['snapshot'] })
  })

  test('text mode keeps errors on stderr with the suggested action', async () => {
    const result = await runCli(['--raw', 'click'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('missing value for click')
    expect(result.stderr).toContain('[AI SUGGESTION]:')
  })

  test('every CLI error carries a suggested action', async () => {
    for (const argv of [
      ['click'],
      ['click', '#a', 'extra'],
      ['bogus'],
      ['--selecor', 'click'],
      ['wait', '#field', '--bogus'],
    ]) {
      const result = await runCli(argv)
      const payload = cliErrorPayload(result.stdout)

      expect(payload.ok).toBe(false)
      expect(payload.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/)
      expect(payload.error.suggestedAction.length).toBeGreaterThan(0)
      expect(payload.error.message.length).toBeGreaterThan(0)
    }
  })
})
