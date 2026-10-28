import { describe, expect, test } from 'bun:test'
import { createTracingDomain } from '../extension/background/tracing.js'

function createHarness(
  chunks: Array<{ data: string; eof?: boolean; base64Encoded?: boolean }>,
  maxBytes?: number,
) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const pendingChunks = [...chunks]
  let domain: ReturnType<typeof createTracingDomain>
  domain = createTracingDomain(
    {
      getTargetTab: async () => ({ id: 1 }) as never,
      sendDebuggerCommand: async (
        _tab: number,
        method: string,
        params?: Record<string, unknown>,
      ) => {
        calls.push({ method, params })
        if (method === 'Tracing.end')
          domain.handleEvent({ tabId: 1 }, 'Tracing.tracingComplete', {
            stream: 'trace-stream',
          })
        if (method === 'IO.read') return (pendingChunks.shift() || { data: '', eof: true }) as never
        return undefined as never
      },
    },
    maxBytes,
  )
  return { domain, calls }
}

describe('CDP tracing', () => {
  test('starts, reports status and reads a text stream to EOF', async () => {
    const { domain, calls } = createHarness([{ data: '{"events":[' }, { data: ']}', eof: true }])
    expect(await domain.start(1)).toMatchObject({ recording: true })
    expect(await domain.status(1)).toMatchObject({ recording: true })
    const result = await domain.stop(1)
    expect(result).toMatchObject({
      recording: false,
      data: '{"events":[]}',
      base64Encoded: false,
      mimeType: 'application/json',
    })
    expect(calls.map((call) => call.method)).toEqual([
      'Tracing.start',
      'Tracing.end',
      'IO.read',
      'IO.read',
      'IO.close',
    ])
    expect(await domain.status(1)).toMatchObject({ recording: false })
  })

  test('decodes and re-encodes base64 stream chunks', async () => {
    const { domain } = createHarness([
      { data: 'eyJldmVu', base64Encoded: true },
      { data: 'dHMiOltdfQ==', base64Encoded: true, eof: true },
    ])
    await domain.start(1)
    const result = await domain.stop(1)
    expect(result.base64Encoded).toBe(true)
    expect(Buffer.from(result.data, 'base64').toString()).toBe('{"events":[]}')
  })

  test('rejects duplicate starts and stopping an inactive trace', async () => {
    const { domain } = createHarness([])
    await expect(domain.stop(1)).rejects.toMatchObject({ code: 'TRACING_NOT_STARTED' })
    await domain.start(1)
    await expect(domain.start(1)).rejects.toMatchObject({ code: 'TRACING_ACTIVE' })
    domain.handleDetach(1)
    await expect(domain.status(1)).resolves.toMatchObject({ recording: false })
  })

  test('fails stop when the debugger detaches during completion', async () => {
    const chunks: Array<{ data: string; eof?: boolean }> = []
    const calls: Array<string> = []
    let domain: ReturnType<typeof createTracingDomain>
    domain = createTracingDomain({
      getTargetTab: async () => ({ id: 1 }) as never,
      sendDebuggerCommand: async (_tab: number, method: string) => {
        calls.push(method)
        if (method === 'Tracing.end') domain.handleDetach(1)
        return chunks.shift() as never
      },
    })
    await domain.start(1)
    await expect(domain.stop(1)).rejects.toMatchObject({ code: 'TRACING_DETACHED' })
  })

  test('rejects oversized traces instead of truncating them', async () => {
    const { domain } = createHarness([{ data: '12345', eof: true }], 4)
    await domain.start(1)
    await expect(domain.stop(1)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
    expect(await domain.status(1)).toMatchObject({ recording: false })
  })
})
