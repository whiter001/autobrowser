import { describe, expect, test } from 'bun:test'
import { EXTENSION_PUBLIC_KEY, getExtensionId, getExtensionUrl } from '../src/core/extension.js'

describe('extension url helpers', () => {
  test('derives a stable extension id from the public key', () => {
    expect(getExtensionId()).toBe('bfccnpkjkbhceghimfjgnkigilidldep')
    expect(getExtensionId(EXTENSION_PUBLIC_KEY)).toBe('bfccnpkjkbhceghimfjgnkigilidldep')
  })

  test('builds chrome extension urls with query params', () => {
    expect(getExtensionUrl('/connect.html', { token: 'abc', relayPort: 47978 })).toBe(
      'chrome-extension://bfccnpkjkbhceghimfjgnkigilidldep/connect.html?token=abc&relayPort=47978',
    )
  })
})
