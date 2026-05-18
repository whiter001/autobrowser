import { describe, expect, test } from 'bun:test'
import { buildSnapshotJsonl } from '../src/cli/snapshot-export.js'

describe('snapshot jsonl export', () => {
  test('flattens snapshot groups into jsonl records', () => {
    const result = buildSnapshotJsonl({
      pageEpoch: 12,
      title: 'Products',
      url: 'https://example.com/products',
      readyState: 'complete',
      text: 'one\ntwo',
      elements: [
        {
          ref: '@e1#p12',
          tag: 'button',
          role: 'button',
          text: 'Buy now',
          name: 'Buy now',
        },
      ],
      frames: [
        {
          ref: '@f1#p12',
          name: 'sidebar',
          title: 'Sidebar',
        },
      ],
      headings: [
        {
          ref: '@e2#p12',
          tag: 'h1',
          text: 'Catalog',
        },
      ],
      buttons: [
        {
          ref: '@e3#p12',
          tag: 'button',
          text: 'Next',
        },
      ],
    })

    const lines = result.content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(result.recordCount).toBe(5)
    expect(lines[0]).toMatchObject({
      kind: 'page',
      pageEpoch: 12,
      title: 'Products',
      url: 'https://example.com/products',
      readyState: 'complete',
      text: 'one\ntwo',
      source: {
        kind: 'snapshot',
        ref: null,
      },
      matchStrategy: 'page-metadata',
    })
    expect(lines[1]).toMatchObject({
      kind: 'element',
      pageEpoch: 12,
      ref: '@e1#p12',
      tag: 'button',
      role: 'button',
      text: 'Buy now',
      name: 'Buy now',
      source: {
        kind: 'snapshot',
        ref: '@e1#p12',
      },
      matchStrategy: 'role+name',
    })
    expect(lines[2]).toMatchObject({
      kind: 'frame',
      pageEpoch: 12,
      ref: '@f1#p12',
      name: 'sidebar',
      title: 'Sidebar',
    })
    expect(lines[3]).toMatchObject({
      kind: 'heading',
      pageEpoch: 12,
      ref: '@e2#p12',
      tag: 'h1',
      text: 'Catalog',
    })
    expect(lines[4]).toMatchObject({
      kind: 'button',
      pageEpoch: 12,
      ref: '@e3#p12',
      tag: 'button',
      text: 'Next',
    })
  })
})
