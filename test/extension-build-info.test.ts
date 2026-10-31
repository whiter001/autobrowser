import { describe, expect, test } from 'bun:test'
import { readExtensionBuildInfo } from '../extension/background/build-info.js'

const url = 'chrome-extension://test/build-info.json'
const valid = { buildTime: '2026-10-31T00:00:00.000Z', commit: 'abcdef1' }

function fetchJson(data: unknown): (url: string) => Promise<Response> {
  return (async () => Response.json(data)) as (url: string) => Promise<Response>
}

describe('extension build info', () => {
  test('reads valid metadata from the extension URL without returning its version', async () => {
    const urls: string[] = []
    const fetchBuildInfo = (async (input) => {
      urls.push(String(input))
      return Response.json({ version: 'wrong-version', ...valid })
    }) as (url: string) => Promise<Response>
    expect(await readExtensionBuildInfo(url, fetchBuildInfo)).toEqual(valid)
    expect(urls).toEqual([url])
  })

  test('falls back for old builds, failed fetches and invalid JSON', async () => {
    const failures = [
      async () => new Response(null, { status: 404 }),
      async () => {
        throw new Error('missing file')
      },
      async () => new Response('{'),
    ]
    for (const fetchBuildInfo of failures) {
      expect(
        await readExtensionBuildInfo(url, fetchBuildInfo as (url: string) => Promise<Response>),
      ).toEqual({
        buildTime: null,
        commit: null,
      })
    }
  })

  test('falls back for missing and illegal metadata fields', async () => {
    for (const data of [
      null,
      [],
      {},
      { buildTime: 123, commit: false },
      { buildTime: 'not-a-date', commit: '' },
      { buildTime: '2026-10-31', commit: 'not-a-commit' },
    ]) {
      expect(await readExtensionBuildInfo(url, fetchJson(data))).toEqual({
        buildTime: null,
        commit: null,
      })
    }
  })

  test('validates fields independently and accepts a null commit from builds without git', async () => {
    expect(await readExtensionBuildInfo(url, fetchJson({ ...valid, commit: null }))).toEqual({
      buildTime: valid.buildTime,
      commit: null,
    })
    expect(await readExtensionBuildInfo(url, fetchJson({ ...valid, buildTime: false }))).toEqual({
      buildTime: null,
      commit: valid.commit,
    })
  })
})
