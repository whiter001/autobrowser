import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cliErrorPayload, runCli, type FetchResponseLike } from './command-line-test-utils.js'

const harPayload = {
  ok: true,
  result: {
    captureId: 'capture-1',
    requestCount: 1,
    har: { log: { entries: [] } },
  },
}

/**
 * stop --capture-id 会先发 status 确认 captureId 再发 stop，
 * 这里让两个请求都返回一致的 captureId，其余请求沿用 harPayload。
 */
function harFetchMock(
  stopPayload: unknown = harPayload,
): (url: string, init?: { body?: string }) => Promise<FetchResponseLike> {
  return async (_url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    if (body?.args?.action === 'har' && body.args.subaction === 'status') {
      return {
        ok: true,
        async json() {
          return { ok: true, result: { captureId: 'capture-1' } }
        },
      }
    }
    return {
      ok: true,
      async json() {
        return stopPayload
      },
    }
  }
}

async function makeOutputPath(name: string): Promise<string> {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-har-order-'))
  return path.join(outputDir, name)
}

describe('network har stop/recover output path', () => {
  test('accepts the output path before the options', async () => {
    const outputPath = await makeOutputPath('before.har')
    const result = await runCli(
      ['network', 'har', 'stop', outputPath, '--timeout-ms', '60000'],
      harPayload,
    )

    expect(result.exitCode).toBe(0)
    // 路径只用于本地写文件，不能混进发给扩展的参数
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: { action: 'har', subaction: 'stop', timeoutMs: 60000 },
    })
    expect(JSON.parse(result.stdout).result).toBe(outputPath)
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({ log: { entries: [] } })
  })

  test('accepts the output path after the options and keeps option values out of the path', async () => {
    const outputPath = await makeOutputPath('after.har')
    const result = await runCli(
      ['network', 'har', 'stop', '--capture-id', 'capture-1', '--timeout-ms', '60000', outputPath],
      harPayload,
      { fetchImpl: harFetchMock() },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body?.args).toEqual({
      action: 'har',
      subaction: 'status',
      timeoutMs: 60000,
    })
    expect(result.fetchCalls[1].body?.args).toEqual({
      action: 'har',
      subaction: 'stop',
      captureId: 'capture-1',
      timeoutMs: 60000,
    })
    expect(JSON.parse(result.stdout).result).toBe(outputPath)
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({ log: { entries: [] } })
  })

  test('accepts a Windows-style path as the output path', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-har-win-'))
    // win32 下还原成盘符+反斜杠形式，确保带反斜杠的路径不会被当成选项或选项值
    const outputPath =
      process.platform === 'win32'
        ? `${outputDir.replace(/\//g, '\\')}\\network.har`
        : path.join(outputDir, 'network.har')

    const result = await runCli(
      ['network', 'har', 'stop', '--timeout-ms', '5000', outputPath],
      harPayload,
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).result).toBe(outputPath)
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({ log: { entries: [] } })
  })

  test('recovers with the output path after the options', async () => {
    const outputPath = await makeOutputPath('recover.har')
    const result = await runCli(
      ['network', 'har', 'recover', '--timeout-ms', '5000', outputPath],
      harPayload,
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body?.args).toEqual({
      action: 'har',
      subaction: 'recover',
      timeoutMs: 5000,
    })
    expect(JSON.parse(result.stdout).result).toBe(outputPath)
    expect(JSON.parse(result.stdout).meta.har.recovered).toBe(true)
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({ log: { entries: [] } })
  })

  test('rejects duplicate output paths before dispatch', async () => {
    for (const args of [
      ['network', 'har', 'stop', 'C:\\tmp\\a.har', '--timeout-ms', '5000', 'C:\\tmp\\a.har'],
      ['network', 'har', 'recover', 'a.har', 'b.har'],
    ]) {
      const result = await runCli(args)
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(cliErrorPayload(result.stdout).error.message).toContain('duplicate HAR output path')
    }
  })

  test('rejects missing option values instead of treating the next option as a value', async () => {
    const outputPath = await makeOutputPath('missing.har')
    for (const args of [
      ['--capture-id'],
      ['--capture-id', ''],
      ['--capture-id', '--include-urls'],
      ['--capture-id', '--timeout-ms', '5000'],
    ]) {
      const result = await runCli(['network', 'har', 'stop', outputPath, ...args])
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
      expect(cliErrorPayload(result.stdout).error.message).toContain(
        'missing value for --capture-id',
      )
    }

    const emptyPath = await runCli(['network', 'har', 'stop', '--timeout-ms', '5000', ''])
    expect(emptyPath.exitCode).toBe(1)
    expect(emptyPath.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(emptyPath.stdout).error.message).toContain('HAR output path')
  })

  test('rejects unknown options even when a valid path is present', async () => {
    const outputPath = await makeOutputPath('unknown.har')
    const result = await runCli(['network', 'har', 'stop', outputPath, '--bogus'])

    expect(result.exitCode).toBe(1)
    expect(result.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(result.stdout).error.message).toContain(
      'unsupported network option: --bogus',
    )

    // recover 不接受 --capture-id/--include-urls，行为与改动前一致
    const recover = await runCli(['network', 'har', 'recover', '--capture-id', 'capture-1'])
    expect(recover.exitCode).toBe(1)
    expect(recover.fetchCalls).toHaveLength(0)
  })

  test('still writes the default temp file and returns URLs when no path is given', async () => {
    const urlsPayload = {
      ok: true,
      result: {
        captureId: 'capture-1',
        urls: ['https://example.com/b', 'https://example.com/a'],
        requestCount: 2,
        har: { log: { entries: [] } },
      },
    }
    const result = await runCli(
      ['network', 'har', 'stop', '--include-urls', '--timeout-ms', '60000'],
      urlsPayload,
      { fetchImpl: harFetchMock(urlsPayload) },
    )

    // 没有 --capture-id 就不会先发 status，stop 是当次唯一请求
    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body?.args).toEqual({
      action: 'har',
      subaction: 'stop',
      includeUrls: true,
      timeoutMs: 60000,
    })
    const output = JSON.parse(result.stdout)
    expect(output.result.captureId).toBe('capture-1')
    expect(output.result.urls).toEqual(['https://example.com/b', 'https://example.com/a'])
    expect(path.basename(output.result.path)).toBe('network.har')
    expect(JSON.parse(await readFile(output.result.path, 'utf8'))).toEqual({ log: { entries: [] } })
  })
})
