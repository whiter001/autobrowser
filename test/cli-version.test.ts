import { describe, expect, test } from 'bun:test'
import { compareVersions, readCliBuildInfo } from '../src/cli/build-info.js'
import { parseCli } from '../src/cli/flags.js'

describe('cli build info', () => {
  test('reports nulls instead of failing when build-info.json is absent (dev run)', async () => {
    // `bun src/cli.ts` 没有 dist/build-info.json：诊断信息缺失不能让命令失败
    expect(await readCliBuildInfo()).toEqual({
      version: null,
      commit: null,
      buildTime: null,
    })
  })

  test('flags matching versions as consistent and mismatches with a hint', () => {
    expect(compareVersions('0.1.5', '0.1.5')).toEqual({
      consistent: true,
      cli: '0.1.5',
      extension: '0.1.5',
      hint: null,
    })

    const skew = compareVersions('0.1.5', '0.1.1')
    expect(skew.consistent).toBe(false)
    expect(skew.hint).toContain('extension is 0.1.1')
    expect(skew.hint).toContain('extension reload')
  })

  test('stays inconclusive when either side is unknown', () => {
    // 老扩展/未连接的扩展没有版本字段，宁可不判断也不能误报错配
    expect(compareVersions('0.1.5', null).consistent).toBeNull()
    expect(compareVersions(null, '0.1.5').consistent).toBeNull()
    expect(compareVersions(null, null).hint).toBeNull()
  })
})

describe('autobrowser --version', () => {
  test('is shorthand for the version command', () => {
    expect(parseCli(['--version']).args).toEqual(['version'])
    // 命令名之后的 --json 仍按全局参数消费，不会留在位置参数里
    const explicit = parseCli(['version', '--json'])
    expect(explicit.args).toEqual(['version'])
    expect(explicit.flags.jsonExplicitlySet).toBe(true)
    expect(() => parseCli(['--totally-unknown'])).toThrow('unsupported global option')
  })
})
