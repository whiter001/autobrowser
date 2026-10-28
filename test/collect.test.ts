import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectCommandRegistry } from '../src/cli/commands/collect.js'
import { readJsonPath } from '../src/core/collect.js'
import type { CommandResponse } from '../src/cli/client.js'
import type { CommandContext } from '../src/cli/commands/types.js'

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-collect-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function createContext(
  handler: (command: string, args: Record<string, unknown>) => unknown,
  written: CommandResponse[],
): CommandContext {
  return {
    flags: { server: 'http://mock', engine: 'chromium' },
    requestCommand: async (_baseUrl: string, command: string, args: object = {}) => {
      const result = handler(command, args as Record<string, unknown>)
      if (result instanceof Error) return { ok: false, error: { message: result.message } }
      return { ok: true, result }
    },
    writeResult: (payload: CommandResponse) => {
      written.push(payload as CommandResponse)
    },
  } as unknown as CommandContext
}

describe('collect orchestration', () => {
  test('readJsonPath traverses objects and arrays', () => {
    expect(readJsonPath({ data: { items: [{ id: 1 }] } }, 'data.items.0.id')).toBe(1)
    expect(readJsonPath({ data: null }, 'data.items')).toBeUndefined()
  })

  test('feed run writes structured JSONL and completed resume is a no-op', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'feed.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({ name: 'cards', mode: 'feed', output: 'cards.jsonl', feed: { limit: 2 } }),
      )
      const written: CommandResponse[] = []
      let feedCalls = 0
      const context = createContext((command) => {
        if (command === 'goto') return { url: 'https://example.com' }
        if (command === 'feed') {
          feedCalls += 1
          return {
            pageEpoch: 3,
            items: [{ author: 'Ada', text: 'hello', url: null }],
          }
        }
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(0)
      const output = await readFile(path.join(directory, 'cards.jsonl'), 'utf8')
      const item = JSON.parse(output.trim())
      expect(item).toMatchObject({
        author: 'Ada',
        _meta: { task: 'cards', mode: 'feed', page: 1, pageEpoch: 3 },
      })
      expect(JSON.parse(await readFile(checkpointPath, 'utf8')).status).toBe('completed')

      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      expect(feedCalls).toBe(1)
      expect(written.at(-1)).toMatchObject({ ok: true, result: { itemCount: 1 } })
    })
  })

  test('network mode follows response cursors and decodes base64 bodies', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'network.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          name: 'api',
          mode: 'network',
          startUrl: 'https://example.com/page/1',
          output: 'api.jsonl',
          maxPages: 3,
          network: { urlPattern: '/api/cards', itemsPath: 'data.items', nextPath: 'data.next' },
        }),
      )
      const written: CommandResponse[] = []
      let currentUrl = ''
      const context = createContext((command, args) => {
        if (command === 'goto') {
          currentUrl = String(args.url)
          return { url: currentUrl }
        }
        if (command === 'network' && args.action === 'requests') {
          return { requests: [{ id: 'request-1' }] }
        }
        if (command === 'network' && args.action === 'request') {
          const body = currentUrl.endsWith('/page/1')
            ? { data: { items: [{ id: 1 }], next: '/page/2' } }
            : { data: { items: [{ id: 2 }], next: null } }
          return {
            request: {
              responseBody: currentUrl.endsWith('/page/1')
                ? JSON.stringify(body)
                : Buffer.from(JSON.stringify(body)).toString('base64'),
              responseBodyBase64: !currentUrl.endsWith('/page/1'),
              pageEpoch: 4,
            },
          }
        }
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(0)
      const lines = (await readFile(path.join(directory, 'api.jsonl'), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)._meta).toMatchObject({ page: 1, requestId: 'request-1' })
      expect(JSON.parse(lines[1]!)._meta).toMatchObject({ page: 2, pageEpoch: 4 })
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        status: 'completed',
        nextPage: 3,
      })
      expect(written.at(-1)).toMatchObject({ ok: true, result: { itemCount: 2, pageCount: 2 } })
    })
  })

  test('failed network run saves context and resume continues without duplicate items', async () => {
    await withTempDir(async (directory) => {
      const checkpointPath = path.join(directory, 'resume.json')
      await writeFile(
        checkpointPath,
        JSON.stringify({
          name: 'resume',
          mode: 'network',
          startUrl: 'https://example.com/page/1',
          output: 'resume.jsonl',
          network: { urlPattern: '/api/cards', itemsPath: 'data.items' },
        }),
      )
      const written: CommandResponse[] = []
      let available = false
      const context = createContext((command, args) => {
        if (command === 'goto') return { url: args.url }
        if (command === 'network' && args.action === 'requests') {
          return { requests: available ? [{ id: 'request-1' }] : [] }
        }
        if (command === 'network' && args.action === 'request') {
          return { request: { responseBody: JSON.stringify({ data: { items: [{ id: 1 }] } }) } }
        }
        throw new Error(`unexpected ${command}`)
      }, written)

      expect(await collectCommandRegistry.collect!(['run', checkpointPath], context)).toBe(1)
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        status: 'failed',
        nextPage: 1,
      })
      available = true
      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      expect(await collectCommandRegistry.collect!(['resume', checkpointPath], context)).toBe(0)
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
      expect(checkpoint).toMatchObject({ status: 'completed', items: [{ id: 1 }] })
      expect(checkpoint.failures).toHaveLength(1)
      const output = (await readFile(path.join(directory, 'resume.jsonl'), 'utf8')).trim()
      expect(output.split('\n')).toHaveLength(1)
    })
  })
})
