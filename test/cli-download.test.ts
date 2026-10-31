import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mediaCommandRegistry } from '../src/cli/commands/media.js'
import type { CommandContext } from '../src/cli/commands/types.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createContext(options: { media?: unknown[] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-cli-download-'))
  directories.push(directory)
  const requestCalls: Array<{ command: string; args: Record<string, unknown> }> = []
  const written: unknown[] = []
  const context = {
    flags: {
      json: true,
      server: 'http://127.0.0.1:3000',
      relayPort: 3000,
      ipcPort: 3001,
      extensionId: null,
      autoConnect: false,
      browserCommand: null,
      browserArgs: [],
      stdin: false,
      file: null,
      base64: false,
      tab: null,
      frame: null,
    },
    homeDir: directory,
    dependencies: {},
    writeHelp: () => 0,
    writeResult: (payload: unknown) => written.push(payload),
    requestCommand: async (
      _baseUrl: string,
      command: string,
      args: Record<string, unknown> = {},
    ) => {
      requestCalls.push({ command, args })
      if (command === 'media') {
        return { ok: true, result: { media: options.media ?? [] } }
      }
      const outputPath = String(args.outputPath)
      const sourceUrl = String(args.url)
      await writeFile(outputPath, new Uint8Array([0, 255, 128, 1]))
      return {
        ok: true,
        result: {
          sourceUrl,
          finalUrl: sourceUrl,
          contentType: 'application/octet-stream',
          bytes: 4,
          sha256: 'a'.repeat(64),
          path: outputPath,
        },
      }
    },
    openConnectFlow: async () => false,
    getStatus: async () => ({}),
    resolveEvalScript: async () => '',
    getCdpUrl: async () => '',
    extractScreenshotData: () => {
      throw new Error('not used')
    },
    resolveScreenshotOutputPath: async () => '',
    collectHarFromNetwork: async () => ({}),
    writeHarFile: async () => '',
  } as unknown as CommandContext
  return { context, directory, requestCalls, written }
}

async function captureStderr(run: () => Promise<number | void>) {
  const original = process.stderr.write.bind(process.stderr)
  let stderr = ''
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const code = await run()
    return { code, stderr }
  } finally {
    process.stderr.write = original
  }
}

describe('cli download command', () => {
  test('downloads through the browser callback and commits the requested output path', async () => {
    const { context, directory, requestCalls, written } = await createContext()
    const outputPath = path.join(directory, 'out', 'image.bin')
    const result = await mediaCommandRegistry.download!(
      ['https://example.com/image.bin', outputPath, '--timeout-ms', '45000'],
      context,
    )

    expect(result).toBe(0)
    expect(requestCalls).toHaveLength(1)
    expect(requestCalls[0]!.command).toBe('download')
    expect(requestCalls[0]!.args.url).toBe('https://example.com/image.bin')
    expect(requestCalls[0]!.args.timeoutMs).toBeGreaterThan(0)
    expect(requestCalls[0]!.args.timeoutMs).toBeLessThanOrEqual(45000)
    expect(new Uint8Array(await readFile(outputPath))).toEqual(new Uint8Array([0, 255, 128, 1]))
    expect(written[0]).toMatchObject({ ok: true, result: { path: outputPath, hls: false } })
  })

  test('derives a safe output filename from --output-dir', async () => {
    const { context, directory } = await createContext()
    const result = await mediaCommandRegistry.download!(
      ['https://example.com/media/master.mp4?token=a/b', '--output-dir', directory],
      context,
    )
    expect(result).toBe(0)
    // mock 返回普通二进制，因此只验证命名和提交，不触发真实 HLS 合并。
    expect((await readFile(path.join(directory, 'master.mp4'))).byteLength).toBe(4)
  })

  test('resolves --media through media list with playback probing', async () => {
    const sourceUrl = 'https://video.example.com/master.mp4'
    const { context, directory, requestCalls } = await createContext({
      media: [{ index: 2, type: 'video', url: sourceUrl, sources: [] }],
    })
    const outputPath = path.join(directory, 'video.mp4')
    const result = await mediaCommandRegistry.download!(
      ['--media', '2', outputPath, '--quality', '720p', '--concurrency', '3'],
      context,
    )
    expect(result).toBe(0)
    expect(requestCalls[0]).toEqual({
      command: 'media',
      args: { action: 'list', resolve: true },
    })
    expect(requestCalls[1]!.args.url).toBe(sourceUrl)
  })

  test('rejects non http(s) urls without contacting the relay', async () => {
    const { context, requestCalls } = await createContext()
    const { code, stderr } = await captureStderr(
      async () =>
        await mediaCommandRegistry.download!(['file:///etc/passwd', '/tmp/out.bin'], context),
    )
    expect(code).toBe(1)
    expect(stderr).toContain('http or https')
    expect(requestCalls).toHaveLength(0)
  })

  test('requires an output path or output directory', async () => {
    const { context, requestCalls } = await createContext()
    const { code, stderr } = await captureStderr(
      async () => await mediaCommandRegistry.download!(['https://example.com/image.png'], context),
    )
    expect(code).toBe(1)
    expect(stderr).toContain('output path or --output-dir')
    expect(requestCalls).toHaveLength(0)
  })

  test('rejects unknown options and conflicting output arguments', async () => {
    const { context, requestCalls } = await createContext()
    const unknown = await captureStderr(
      async () =>
        await mediaCommandRegistry.download!(
          ['https://example.com/image.png', '/tmp/out.bin', '--resume'],
          context,
        ),
    )
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('--resume')

    const conflict = await captureStderr(
      async () =>
        await mediaCommandRegistry.download!(
          ['https://example.com/image.png', '/tmp/out.bin', '--output-dir', '/tmp'],
          context,
        ),
    )
    expect(conflict.code).toBe(1)
    expect(conflict.stderr).toContain('cannot be combined')
    expect(requestCalls).toHaveLength(0)
  })

  test('no-clobber preserves an existing file without downloading', async () => {
    const { context, directory, requestCalls } = await createContext()
    const outputPath = path.join(directory, 'existing.bin')
    await writeFile(outputPath, 'previous')
    const { code, stderr } = await captureStderr(
      async () =>
        await mediaCommandRegistry.download!(
          ['https://example.com/image.bin', outputPath, '--no-clobber'],
          context,
        ),
    )
    expect(code).toBe(1)
    expect(stderr).toContain('拒绝覆盖')
    expect(await readFile(outputPath, 'utf8')).toBe('previous')
    expect(requestCalls).toHaveLength(0)
  })

  test('media list only enables playback probing with --resolve', async () => {
    const { context, requestCalls } = await createContext()
    expect(await mediaCommandRegistry.media!(['list'], context)).toBe(0)
    expect(await mediaCommandRegistry.media!(['list', '--resolve'], context)).toBe(0)
    expect(requestCalls.map((call) => call.args)).toEqual([
      { action: 'list', resolve: false },
      { action: 'list', resolve: true },
    ])
  })
})
