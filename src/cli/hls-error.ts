export class HlsDownloadError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'HlsDownloadError'
  }
}
