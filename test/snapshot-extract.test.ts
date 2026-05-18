import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pageCommandRegistry } from '../src/cli/commands/page.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true })
    }),
  )
})

describe('snapshot extract command', () => {
  test('writes only selected fields to jsonl', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-snapshot-extract-'))
    tempDirs.push(homeDir)

    const outputDir = path.join(homeDir, 'exports')
    await mkdir(outputDir, { recursive: true })
    const outputPath = path.join(outputDir, 'snapshot-fields.jsonl')

    const result = await pageCommandRegistry.snapshot(
      ['extract', outputPath, '--field', 'page.title,page.url', '--field', 'elements[0].name'],
      {
        flags: {
          json: false,
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
        homeDir,
        dependencies: {},
        writeHelp: () => 0,
        writeResult: () => undefined,
        requestCommand: async () => ({
          ok: true,
          result: {
            pageEpoch: 7,
            title: 'Products',
            url: 'https://example.com/products',
            readyState: 'complete',
            text: 'ignored',
            elements: [
              {
                ref: '@e1#p7',
                tag: 'button',
                role: 'button',
                text: 'Buy now',
                name: 'Buy now',
              },
            ],
            frames: [],
            headings: [],
            buttons: [],
          },
        }),
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
      } as never,
    )

    expect(result).toBe(0)

    const lines = (await readFile(outputPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'field',
        fieldPath: 'page.title',
        value: 'Products',
      }),
      expect.objectContaining({
        kind: 'field',
        fieldPath: 'page.url',
        value: 'https://example.com/products',
      }),
      expect.objectContaining({
        kind: 'field',
        fieldPath: 'elements[0].name',
        value: 'Buy now',
      }),
    ])
  })
})