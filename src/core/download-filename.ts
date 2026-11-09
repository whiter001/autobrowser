const MIME_EXTENSIONS: Record<string, string> = {
  'application/epub+zip': '.epub',
  'application/x-mobipocket-ebook': '.mobi',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
}

export function sanitizeDownloadFilename(value: string): string {
  const basename = value.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
  const safe = basename
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join('')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180)
  if (!safe) return ''
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe
}

function contentDispositionFilename(value: string | null): string {
  if (!value) return ''
  const extended = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)
  if (extended) {
    const encoded = extended[1]!.trim().replace(/^"|"$/g, '')
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*("[^"]*"|[^;]+)/i.exec(value)
  return plain?.[1]?.trim().replace(/^"|"$/g, '') || ''
}

export function suggestedDownloadFilename(
  sourceUrl: string,
  contentType: string | null,
  contentDisposition: string | null,
): string {
  let pathName = ''
  let queryName = ''
  try {
    const url = new URL(sourceUrl)
    queryName = url.searchParams.get('filename') || ''
    pathName = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '')
  } catch {
    // URL 已在命令入口校验；这里保留安全兜底。
  }

  const candidate =
    sanitizeDownloadFilename(contentDispositionFilename(contentDisposition)) ||
    sanitizeDownloadFilename(queryName) ||
    sanitizeDownloadFilename(pathName) ||
    'download.bin'
  const extension = MIME_EXTENSIONS[(contentType || '').split(';', 1)[0]!.trim().toLowerCase()]
  return extension && !/\.[A-Za-z0-9]{1,8}$/.test(candidate)
    ? `${candidate}${extension}`
    : candidate
}
