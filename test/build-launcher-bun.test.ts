import { describe, expect, test } from 'bun:test'
import { bunLauncherBuildArgs, bunLauncherTargets } from '../scripts/build-launcher-bun'

describe('Bun AOT launcher build', () => {
  test('builds the six release targets by default', () => {
    const targets = bunLauncherTargets([])
    expect(targets).toEqual([
      { name: 'autobrowser-darwin-arm64', target: 'bun-darwin-arm64' },
      { name: 'autobrowser-darwin-x64', target: 'bun-darwin-x64' },
      { name: 'autobrowser-linux-x64', target: 'bun-linux-x64' },
      { name: 'autobrowser-linux-arm64', target: 'bun-linux-arm64' },
      { name: 'autobrowser-windows-x64.exe', target: 'bun-windows-x64' },
      { name: 'autobrowser-windows-arm64.exe', target: 'bun-windows-arm64' },
    ])
  })

  test('accepts npm-style separator and selects the current host', () => {
    expect(bunLauncherTargets(['--', '--current'], 'win32', 'x64')).toEqual([
      { name: 'autobrowser-windows-x64.exe', target: 'bun-windows-x64' },
    ])
    expect(bunLauncherTargets(['--current'], 'darwin', 'arm64')).toEqual([
      { name: 'autobrowser-darwin-arm64', target: 'bun-darwin-arm64' },
    ])
  })

  test('rejects unknown flags and unsupported hosts', () => {
    expect(() => bunLauncherTargets(['--oops'])).toThrow('Usage:')
    expect(() => bunLauncherTargets(['--current'], 'freebsd', 'x64')).toThrow('Unsupported')
    expect(() => bunLauncherTargets(['--current'], 'linux', 'ia32')).toThrow('Unsupported')
  })

  test('uses AOT standalone compilation without loading caller config', () => {
    const args = bunLauncherBuildArgs({
      entrypoint: '/repo/scripts/launcher-bun.ts',
      outfile: '/repo/launchers/autobrowser',
      target: 'bun-linux-x64',
    })
    expect(args).toEqual([
      'build',
      '/repo/scripts/launcher-bun.ts',
      '--compile',
      '--aot',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      '--outfile',
      '/repo/launchers/autobrowser',
      '--target',
      'bun-linux-x64',
    ])
  })

  test('embeds development paths as JSON-defined string constants', () => {
    const bunPath = 'C:\\Program Files\\Bun\\bun.exe'
    const distEntry = '/Volumes/My Repo/dist/autobrowser.js'
    const args = bunLauncherBuildArgs({
      entrypoint: '/repo/scripts/launcher-bun.ts',
      outfile: '/tmp/autobrowser',
      bunPath,
      distEntry,
    })
    expect(args).toContain(`AUTOBROWSER_DEFAULT_BUN_PATH=${JSON.stringify(bunPath)}`)
    expect(args).toContain(`AUTOBROWSER_DEFAULT_DIST_ENTRY=${JSON.stringify(distEntry)}`)
    expect(args).not.toContain('--target')
  })
})
