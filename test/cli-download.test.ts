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

async function createContext(
  options: {
    media?: unknown[]
    mediaResult?: Record<string, unknown>
    files?: Record<string, string>
    failUrl?: string
  } = {},
) {
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
        return {
          ok: true,
          result: {
            media: options.media ?? [],
            scope: { selector: args.selector ?? null },
            includeBackground: args.includeBackground === true,
            pageEpoch: 1,
            ...options.mediaResult,
          },
        }
      }
      const outputPath = String(args.outputPath)
      const sourceUrl = String(args.url)
      if (sourceUrl === options.failUrl) {
        return { ok: false, error: { message: 'simulated segment failure' } }
      }
      await writeFile(outputPath, options.files?.[sourceUrl] ?? new Uint8Array([0, 255, 128, 1]))
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
  test.each([
    [0, 0],
    [5, 60_000],
  ])('forwards explicit retry options %i/%i', async (retries, retryDelayMs) => {
    const { context, directory, requestCalls } = await createContext()
    expect(
      await mediaCommandRegistry.download!(
        [
          'https://example.com/file',
          path.join(directory, 'file'),
          '--retries',
          String(retries),
          '--retry-delay-ms',
          String(retryDelayMs),
        ],
        context,
      ),
    ).toBe(0)
    expect(requestCalls[0]!.args).toMatchObject({ retries, retryDelayMs })
  })

  test('forwards retry options to HLS master, playlist, init and segment requests', async () => {
    const base = 'https://example.com/'
    const files = {
      [`${base}master.m3u8`]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvideo.m3u8\n',
      [`${base}video.m3u8`]:
        '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n',
      [`${base}init.mp4`]: 'init',
    }
    const { context, directory, requestCalls } = await createContext({
      files,
      failUrl: `${base}seg.ts`,
    })
    // 只探测工具可用性；分片故意失败，不执行合并，也不依赖本机安装 ffmpeg。
    for (const tool of ['ffmpeg', 'ffprobe']) {
      await writeFile(path.join(directory, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    const oldPath = process.env.PATH
    process.env.PATH = `${directory}${path.delimiter}${oldPath ?? ''}`
    try {
      const { code, stderr } = await captureStderr(
        async () =>
          await mediaCommandRegistry.download!(
            [
              `${base}master.m3u8`,
              path.join(directory, 'video.mp4'),
              '--concurrency',
              '1',
              '--retries',
              '3',
              '--retry-delay-ms',
              '17',
              '--timeout-ms',
              '10000',
            ],
            context,
          ),
      )
      expect(code).toBe(1)
      expect(stderr).toContain('simulated segment failure')
      expect(requestCalls.map((call) => call.args.url)).toEqual([
        `${base}master.m3u8`,
        `${base}video.m3u8`,
        `${base}init.mp4`,
        `${base}seg.ts`,
      ])
      for (const call of requestCalls) {
        expect(call.args).toMatchObject({ retries: 3, retryDelayMs: 17 })
        expect(call.args.timeoutMs).toBeGreaterThan(0)
        expect(call.args.timeoutMs).toBeLessThanOrEqual(10000)
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
    }
  })

  test('rejects duplicate, missing, non-integer and out-of-range retry options', async () => {
    const { context, requestCalls } = await createContext()
    for (const option of ['--retries', '--retry-delay-ms']) {
      for (const extra of [
        [option],
        [option, '--no-clobber'],
        [option, '1', option, '2'],
        [option, '-1'],
        [option, '1.5'],
        [option, 'NaN'],
        [option, option === '--retries' ? '6' : '60001'],
      ]) {
        const { code, stderr } = await captureStderr(
          async () =>
            await mediaCommandRegistry.download!(
              ['https://example.com/file', '/tmp/out.bin', ...extra],
              context,
            ),
        )
        expect(code).toBe(1)
        expect(stderr).toContain(option)
      }
    }
    expect(requestCalls).toHaveLength(0)
  })
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
    expect(requestCalls[0]!.args).toMatchObject({ retries: 2, retryDelayMs: 250 })
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

  test('download re-lists with the same scope and checks the exact epoch', async () => {
    for (const epoch of [1, 2]) {
      const sourceUrl = 'https://example.com/trusted.mp4'
      const { context, directory, requestCalls } = await createContext({
        media: [{ index: 0, url: sourceUrl, sources: [] }],
      })
      const { code, stderr } = await captureStderr(
        async () =>
          await mediaCommandRegistry.download!(
            [
              '--media',
              '0',
              '--selector',
              'article',
              '--include-background',
              '--media-epoch',
              String(epoch),
              path.join(directory, 'out.mp4'),
            ],
            context,
          ),
      )
      expect(requestCalls[0]).toEqual({
        command: 'media',
        args: {
          action: 'list',
          resolve: true,
          selector: 'article',
          includeBackground: true,
          mediaEpoch: epoch,
        },
      })
      expect(code).toBe(epoch === 1 ? 0 : 1)
      expect(requestCalls).toHaveLength(epoch === 1 ? 2 : 1)
      if (epoch !== 1) expect(stderr).toContain('STALE_MEDIA_STATE')
    }
  })

  test('download rejects old responses without scope/background/epoch proof', async () => {
    for (const mediaResult of [
      { scope: undefined },
      { scope: { selector: 'body' } },
      { includeBackground: undefined },
      { pageEpoch: undefined },
    ]) {
      const { context, directory, requestCalls } = await createContext({
        media: [{ index: 0, url: 'https://example.com/v.mp4', sources: [] }],
        mediaResult,
      })
      const { code } = await captureStderr(
        async () =>
          await mediaCommandRegistry.download!(
            [
              '--media',
              '0',
              '--selector',
              'article',
              '--include-background',
              '--media-epoch',
              '1',
              path.join(directory, 'out.mp4'),
            ],
            context,
          ),
      )
      expect(code).toBe(1)
      expect(requestCalls).toHaveLength(1)
    }
  })

  test('download never falls back to observedSources', async () => {
    const { context, directory, requestCalls } = await createContext({
      media: [
        {
          index: 0,
          url: null,
          sources: [],
          observedSources: [{ url: 'https://example.com/unverified.mp4', unverified: true }],
        },
      ],
    })
    const { code, stderr } = await captureStderr(
      async () =>
        await mediaCommandRegistry.download!(
          ['--media', '0', path.join(directory, 'out.mp4')],
          context,
        ),
    )
    expect(code).toBe(1)
    expect(stderr).toContain('no downloadable')
    expect(requestCalls).toHaveLength(1)
  })

  test('media rejects all duplicate options including timeout-ms', async () => {
    const { context, requestCalls } = await createContext()
    for (const extra of [
      ['--timeout-ms', '1', '--timeout-ms', '2', '--wait-for', 'article'],
      ['--wait-for', 'a', '--wait-for', 'b'],
      ['--resolve', '--resolve'],
      ['--include-background', '--include-background'],
    ]) {
      const { code, stderr } = await captureStderr(
        async () => await mediaCommandRegistry.media!(['list', ...extra], context),
      )
      expect(code).toBe(1)
      expect(stderr).toContain('duplicate option')
    }
    for (const extra of [
      ['--selector', 'a', '--selector', 'b'],
      ['--include-background', '--include-background'],
      ['--media-epoch', '1', '--media-epoch', '2'],
      ['--timeout-ms', '1', '--timeout-ms', '2'],
    ]) {
      const { code, stderr } = await captureStderr(
        async () =>
          await mediaCommandRegistry.download!(['--media', '0', '/tmp/out', ...extra], context),
      )
      expect(code).toBe(1)
      expect(stderr).toContain('duplicate option')
    }
    expect(requestCalls).toHaveLength(0)
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

  test('media list forwards the selector and background options', async () => {
    const { context, requestCalls } = await createContext()
    expect(
      await mediaCommandRegistry.media!(
        ['list', '--selector', 'article[data-role="tweet"]', '--include-background'],
        context,
      ),
    ).toBe(0)
    expect(requestCalls[0]!.args).toEqual({
      action: 'list',
      resolve: false,
      selector: 'article[data-role="tweet"]',
      includeBackground: true,
    })
  })

  test('media list rejects duplicated options and a missing selector value', async () => {
    const { context, requestCalls } = await createContext()
    const duplicated = await captureStderr(
      async () =>
        await mediaCommandRegistry.media!(['list', '--selector', 'a', '--selector', 'b'], context),
    )
    expect(duplicated.code).toBe(1)
    expect(duplicated.stderr).toContain('duplicate option: --selector')

    const missing = await captureStderr(
      async () => await mediaCommandRegistry.media!(['list', '--selector'], context),
    )
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('missing value for --selector')

    const unknown = await captureStderr(
      async () => await mediaCommandRegistry.media!(['list', '--all'], context),
    )
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('usage: autobrowser media list')
    expect(requestCalls).toHaveLength(0)
  })
})
