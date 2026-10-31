import { describe, expect, test } from 'bun:test'
import {
  currentBuildEnv,
  launcherLdflags,
  launcherTargets,
  quoteGoLdflagField,
} from '../scripts/build-launcher-go'

// 复刻 cmd/go 的 quoted.Split：引号内原样保留，只按同种引号配对。
function splitGoFields(input: string): string[] {
  const fields: string[] = []
  let rest = input
  while (rest.length > 0) {
    rest = rest.replace(/^\s+/, '')
    if (rest.length === 0) break
    const quote = rest[0]
    if (quote === '"' || quote === "'") {
      const end = rest.indexOf(quote, 1)
      if (end < 0) throw new Error('unterminated quoted string')
      fields.push(rest.slice(1, end))
      rest = rest.slice(end + 1)
      continue
    }
    const end = rest.search(/\s/)
    if (end < 0) {
      fields.push(rest)
      break
    }
    fields.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  return fields
}

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

describe('Go launcher linker flags', () => {
  test('release build keeps -s -w and injects nothing', () => {
    expect(launcherLdflags()).toBe('-s -w')
    expect(splitGoFields(launcherLdflags())).toEqual(['-s', '-w'])
  })

  test('development link injects the Bun and dist paths', () => {
    const flags = launcherLdflags({
      bunPath: '/opt/bun/bin/bun',
      distEntry: '/repo/dist/autobrowser.js',
    })
    expect(flags).toBe(
      '-s -w -X main.defaultBunPath=/opt/bun/bin/bun -X main.defaultDistEntry=/repo/dist/autobrowser.js',
    )
    expect(splitGoFields(flags)).toEqual([
      '-s',
      '-w',
      '-X',
      'main.defaultBunPath=/opt/bun/bin/bun',
      '-X',
      'main.defaultDistEntry=/repo/dist/autobrowser.js',
    ])
  })

  test('paths with spaces, backslashes and quotes survive Go quoting', () => {
    const bunPath = 'C:\\Program Files\\Bun\\bun.exe'
    const distEntry = '/Volumes/My Repo/dist/autobrowser.js'
    const flags = launcherLdflags({ bunPath, distEntry })
    expect(splitGoFields(flags)).toEqual([
      '-s',
      '-w',
      '-X',
      `main.defaultBunPath=${bunPath}`,
      '-X',
      `main.defaultDistEntry=${distEntry}`,
    ])
    expect(flags).toContain("-X 'main.defaultBunPath=C:\\Program Files\\Bun\\bun.exe'")
  })

  test('a path containing a double quote stays inside one field', () => {
    const bunPath = '/opt/"bun"/bun'
    const flags = launcherLdflags({ bunPath })
    expect(splitGoFields(flags)).toEqual(['-s', '-w', '-X', `main.defaultBunPath=${bunPath}`])
  })

  test('a path containing both quote characters is rejected', () => {
    expect(() => quoteGoLdflagField(`main.defaultBunPath=/opt/it's"bun`)).toThrow('Cannot embed')
    expect(() => launcherLdflags({ bunPath: `/opt/it's"bun` })).toThrow('Cannot embed')
  })
})

describe('Go launcher build environment', () => {
  const hostGoos: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
  const hostGoarch: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }

  test('targets the host platform and disables cgo', () => {
    expect(currentBuildEnv()).toEqual({
      GOOS: hostGoos[process.platform],
      GOARCH: hostGoarch[process.arch],
      CGO_ENABLED: '0',
    })
  })

  test('maps a given platform to Go names', () => {
    expect(currentBuildEnv('win32', 'x64')).toEqual({
      GOOS: 'windows',
      GOARCH: 'amd64',
      CGO_ENABLED: '0',
    })
  })

  test('ignores cross compilation values coming from the environment', () => {
    const before = { GOOS: process.env.GOOS, GOARCH: process.env.GOARCH }
    process.env.GOOS = 'windows'
    process.env.GOARCH = '386'
    try {
      expect(currentBuildEnv()).toEqual({
        GOOS: hostGoos[process.platform],
        GOARCH: hostGoarch[process.arch],
        CGO_ENABLED: '0',
      })
    } finally {
      if (before.GOOS === undefined) delete process.env.GOOS
      else process.env.GOOS = before.GOOS
      if (before.GOARCH === undefined) delete process.env.GOARCH
      else process.env.GOARCH = before.GOARCH
    }
  })

  test('rejects unsupported hosts', () => {
    expect(() => currentBuildEnv('freebsd', 'x64')).toThrow('Unsupported')
  })
})
