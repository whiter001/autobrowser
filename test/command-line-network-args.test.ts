import { describe, expect, test } from 'bun:test'
import { parseConsoleArgs, parseNetworkRouteArgs } from '../src/cli/parse.js'

describe('cli network route and console argument parsing', () => {
  test('parses network route mock options', () => {
    expect(
      parseNetworkRouteArgs([
        '**/api/*',
        '--status',
        '404',
        '--content-type',
        'text/plain',
        '--header',
        'X-Mock: yes',
        '--header',
        'X-Other: a:b',
        '--remove-headers',
        'Authorization, X-Debug',
      ]),
    ).toEqual({
      url: '**/api/*',
      abort: false,
      status: 404,
      contentType: 'text/plain',
      headers: { 'X-Mock': 'yes', 'X-Other': 'a:b' },
      removeHeaders: ['Authorization', 'X-Debug'],
    })
  })

  test('rejects invalid network route options', () => {
    expect(() => parseNetworkRouteArgs(['**/api/*', '--status'])).toThrow('missing status value')
    expect(() => parseNetworkRouteArgs(['**/api/*', '--status', '99'])).toThrow('expected >= 100')
    expect(() => parseNetworkRouteArgs(['**/api/*', '--header', 'NoColon'])).toThrow(
      'expected "Name: Value"',
    )
    expect(() => parseNetworkRouteArgs(['**/api/*', '--remove-headers'])).toThrow(
      'missing remove-headers value',
    )
  })

  test('parses console level with strict validation', () => {
    expect(parseConsoleArgs([])).toEqual({ level: null })
    expect(parseConsoleArgs(['--level', 'warning'])).toEqual({ level: 'warning' })
    expect(() => parseConsoleArgs(['--level', 'verbose'])).toThrow('unsupported console level')
    expect(() => parseConsoleArgs(['--bogus'])).toThrow('unsupported console option')
    expect(() => parseConsoleArgs(['extra'])).toThrow('unexpected extra console argument')
  })
})
