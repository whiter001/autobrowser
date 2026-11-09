import { describe, expect, test } from 'bun:test'
import {
  sanitizeDownloadFilename,
  suggestedDownloadFilename,
} from '../src/core/download-filename.js'

describe('download filename resolution', () => {
  test('prefers Content-Disposition filename* over URL fields', () => {
    expect(
      suggestedDownloadFilename(
        'https://example.com/redirection?filename=query.epub',
        'application/epub+zip',
        "attachment; filename*=UTF-8''%E4%B9%A6.epub",
      ),
    ).toBe('书.epub')
  })

  test('uses the URL filename query for Z-Library redirection URLs', () => {
    expect(
      suggestedDownloadFilename(
        'https://example.com/redirection?filename=%E4%B9%A6.epub',
        'application/epub+zip',
        null,
      ),
    ).toBe('书.epub')
  })

  test('adds a known MIME extension when the candidate has none', () => {
    expect(
      suggestedDownloadFilename('https://example.com/redirection', 'application/epub+zip', null),
    ).toBe('redirection.epub')
    expect(suggestedDownloadFilename('https://example.com/file', 'video/mp4', null)).toBe(
      'file.mp4',
    )
  })

  test('removes path traversal and Windows-invalid characters while preserving Unicode', () => {
    expect(sanitizeDownloadFilename('../..\\ 书:test.epub')).toBe('书_test.epub')
    expect(sanitizeDownloadFilename('NUL.epub')).toBe('_NUL.epub')
    expect(sanitizeDownloadFilename('../../')).toBe('')
  })

  test('falls back to a safe generic name', () => {
    expect(suggestedDownloadFilename('not a url', null, null)).toBe('download.bin')
  })
})
