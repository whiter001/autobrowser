import { describe, expect, test } from 'bun:test'
import { launcherTargets } from '../scripts/build-launcher-go'

describe('Go launcher build targets', () => {
  test('builds the six release targets by default', () => {
    const targets = launcherTargets([])
    expect(targets).toHaveLength(6)
    expect(targets.map((target) => target.name)).toEqual([
      'autobrowser-darwin-arm64',
      'autobrowser-darwin-x64',
      'autobrowser-linux-x64',
      'autobrowser-linux-arm64',
      'autobrowser-windows-x64.exe',
      'autobrowser-windows-arm64.exe',
    ])
  })

  test('accepts npm-style separator and translates current platform to Go names', () => {
    expect(launcherTargets(['--', '--current'], 'win32', 'x64')).toEqual([
      { goos: 'windows', goarch: 'amd64', name: 'autobrowser-windows-x64.exe' },
    ])
    expect(launcherTargets(['--current'], 'darwin', 'arm64')).toHaveLength(1)
  })

  test('rejects unknown flags and unsupported current platforms', () => {
    expect(() => launcherTargets(['--oops'])).toThrow('Usage:')
    expect(() => launcherTargets(['--current'], 'freebsd', 'x64')).toThrow('Unsupported')
    expect(() => launcherTargets(['--current'], 'linux', 'ia32')).toThrow('Unsupported')
  })
})
