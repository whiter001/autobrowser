import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cliErrorPayload, runCli } from './command-line-test-utils.js'

describe('cli command routing', () => {
  test('routes requests to the configured ipc port', async () => {
    const result = await runCli(['--ipc-port', '5001', 'status'], {
      ok: true,
      ready: true,
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].url).toBe('http://127.0.0.1:5001/status')
  })

  test('routes network abort commands to the extension', async () => {
    const result = await runCli(['network', 'route', 'https://api.example.com', '--abort'])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'route',
        url: 'https://api.example.com',
        abort: true,
      },
    })
  })

  test('routes network request filters to the extension', async () => {
    const result = await runCli([
      'network',
      'requests',
      '--filter',
      'api',
      '--type',
      'xhr,fetch',
      '--method',
      'POST',
      '--status',
      '2xx',
      '--sort',
      'newest',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(1)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'requests',
        filter: 'api',
        type: 'xhr,fetch',
        method: 'POST',
        status: '2xx',
        sort: 'newest',
      },
    })

    const invalid = await runCli(['network', 'requests', '--sort', 'random'])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.fetchCalls).toHaveLength(0)
    expect(cliErrorPayload(invalid.stdout).error.message).toContain('expected oldest|newest')
  })

  test('writes HAR output when stopping a recording', async () => {
    const payload = {
      ok: true,
      result: {
        har: {
          log: {
            version: '1.2',
            creator: { name: 'autobrowser', version: '0.1.0' },
            entries: [
              {
                startedDateTime: '2026-04-20T15:00:00.000Z',
                time: 12,
                request: {
                  method: 'GET',
                  url: 'https://example.com/',
                  httpVersion: 'HTTP/1.1',
                  cookies: [],
                  headers: [],
                  queryString: [],
                  headersSize: -1,
                  bodySize: 0,
                },
                response: {
                  status: 200,
                  statusText: 'OK',
                  httpVersion: 'HTTP/1.1',
                  cookies: [],
                  headers: [],
                  content: {
                    size: 19,
                    mimeType: 'text/html',
                    text: 'hello from response',
                  },
                  redirectURL: '',
                  headersSize: -1,
                  bodySize: 19,
                },
                cache: {},
                timings: {
                  send: 0,
                  wait: 12,
                  receive: 0,
                },
                pageref: 'tab-1275677941',
              },
            ],
          },
        },
      },
    }
    const result = await runCli(['network', 'har', 'stop'], payload)

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(1)

    const output = JSON.parse(result.stdout)
    const outputPath = output.result
    expect(outputPath.length).toBeGreaterThan(0)
    expect(output.meta.har).toEqual({
      recovered: false,
      captureId: null,
      captureTabId: null,
      requestCount: 1,
      checkpoint: null,
    })

    const harContent = await readFile(outputPath, 'utf8')
    expect(harContent).toContain('"version": "1.2"')
    expect(harContent).toContain('"creator"')
    expect(harContent).toContain('"https://example.com/"')
    expect(harContent).toContain('"entries": [')
  })

  test('warns on an empty HAR and forwards the stop timeout without failing the export', async () => {
    const result = await runCli(['network', 'har', 'stop', '--timeout-ms', '60000'], {
      ok: true,
      result: {
        captureTabId: 13,
        requestCount: 0,
        checkpoint: { saved: true },
        har: { log: { entries: [] } },
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: { action: 'har', subaction: 'stop', timeoutMs: 60000 },
    })
    expect(result.stderr).toContain('HAR contains 0 entries')
    expect(result.stderr).toContain('--tab <handle>')
    expect(JSON.parse(result.stdout).meta.har).toEqual({
      recovered: false,
      captureId: null,
      captureTabId: 13,
      requestCount: 0,
      checkpoint: { saved: true },
    })
  })

  test('forwards guarded HAR stop and returns URLs while writing the file', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-har-urls-test-'))
    const outputPath = path.join(outputDir, 'network.har')
    const result = await runCli(
      [
        'network',
        'har',
        'stop',
        outputPath,
        '--capture-id',
        'capture-1',
        '--include-urls',
        '--timeout-ms',
        '60000',
      ],
      {
        ok: true,
        result: {
          captureId: 'capture-1',
          urls: ['https://example.com/b', 'https://example.com/a'],
          requestCount: 2,
          har: { log: { entries: [] } },
        },
      },
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
      includeUrls: true,
      timeoutMs: 60000,
    })
    expect(JSON.parse(result.stdout).result).toEqual({
      path: outputPath,
      captureId: 'capture-1',
      urls: ['https://example.com/b', 'https://example.com/a'],
    })
    expect(JSON.parse(result.stdout).meta.har.captureId).toBe('capture-1')
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({ log: { entries: [] } })
  })

  test('rejects missing, duplicate and invalid HAR stop options before dispatch', async () => {
    for (const args of [
      ['--capture-id'],
      ['--capture-id', ''],
      ['--capture-id', '--include-urls'],
      ['--capture-id', 'a', '--capture-id', 'b'],
      ['--include-urls', '--include-urls'],
      ['--timeout-ms'],
      ['--timeout-ms', '1', '--timeout-ms', '2'],
      ['--timeout-ms', '0'],
      ['--bogus'],
      ['--include-urls', 'extra'],
    ]) {
      const result = await runCli(['network', 'har', 'stop', ...args])
      expect(result.exitCode).toBe(1)
      expect(result.fetchCalls).toHaveLength(0)
    }
    const failed = await runCli(['network', 'har', 'stop', '--capture-id', 'stale'], {
      ok: false,
      error: { message: 'HAR captureId does not match the active capture' },
    })
    expect(failed.exitCode).toBe(1)
    expect(failed.fetchCalls).toHaveLength(1)
  })

  test('reconstructs HAR output when stop only returns metadata', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-har-rebuild-test-'))
    const outputPath = path.join(outputDir, 'network.har')
    const startedAt = '2026-04-20T15:00:00.000Z'
    const stoppedAt = '2026-04-20T15:00:05.000Z'
    const requestSummary = {
      id: '1275677941:abc',
      requestId: 'abc',
      tabId: 1275677941,
      url: 'https://example.com/',
      method: 'GET',
      resourceType: 'Document',
      status: 200,
      statusText: 'OK',
      startedAt,
      durationMs: 12,
    }
    const requestDetail = {
      request: requestSummary,
      summary: {
        id: requestSummary.id,
        requestId: requestSummary.requestId,
        tabId: requestSummary.tabId,
        url: requestSummary.url,
        method: requestSummary.method,
        resourceType: requestSummary.resourceType,
        status: requestSummary.status,
        statusText: requestSummary.statusText,
        startedAt: requestSummary.startedAt,
        durationMs: requestSummary.durationMs,
      },
      harEntry: {
        startedDateTime: startedAt,
        time: 12,
        request: {
          method: 'GET',
          url: 'https://example.com/',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: {
            size: 19,
            mimeType: 'text/html',
            text: 'hello from response',
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: 19,
        },
        cache: {},
        timings: {
          send: 0,
          wait: 12,
          receive: 0,
        },
        pageref: 'tab-1275677941',
      },
    }

    const result = await runCli(
      ['network', 'har', 'stop', outputPath],
      { ok: true, result: { recording: false, startedAt, stoppedAt, requestCount: 1 } },
      {
        fetchImpl: async (url, init = {}) => {
          const body = init.body ? JSON.parse(init.body) : null

          if (body?.command !== 'network') {
            throw new Error(`unexpected command: ${JSON.stringify(body)}`)
          }

          if (body.args.action === 'har' && body.args.subaction === 'stop') {
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  result: { recording: false, startedAt, stoppedAt, requestCount: 1 },
                }
              },
            }
          }

          if (body.args.action === 'requests') {
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  result: {
                    total: 1,
                    requests: [requestSummary],
                  },
                }
              },
            }
          }

          if (body.args.action === 'request') {
            expect(body.args.requestId).toBe('abc')
            return {
              ok: true,
              async json() {
                return {
                  ok: true,
                  result: requestDetail,
                }
              },
            }
          }

          throw new Error(`unexpected URL or body: ${String(url)} ${JSON.stringify(body)}`)
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls.length).toBeGreaterThanOrEqual(3)
    expect(result.fetchCalls[0].body).toEqual({
      command: 'network',
      args: {
        action: 'har',
        subaction: 'stop',
      },
    })
    expect(result.fetchCalls[1].body).toEqual({
      command: 'network',
      args: {
        action: 'requests',
      },
    })
    expect(result.fetchCalls[2].body).toEqual({
      command: 'network',
      args: {
        action: 'request',
        requestId: 'abc',
      },
    })

    const harContent = JSON.parse(await readFile(outputPath, 'utf8'))
    expect(harContent.log.entries).toHaveLength(1)
    expect(harContent.log.entries[0].response.content.text).toBe('hello from response')
  })
})
