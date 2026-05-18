import { describe, expect, test } from 'bun:test'
import { buildSnapshotFieldJsonl } from '../src/cli/snapshot-structure.js'

describe('snapshot field jsonl export', () => {
  test('flattens snapshot values into field-oriented jsonl records', () => {
    const result = buildSnapshotFieldJsonl({
      pageEpoch: 8,
      title: 'Products',
      url: 'https://example.com/products',
      readyState: 'complete',
      text: 'one\ntwo',
      elements: [
        {
          ref: '@e1#p8',
          tag: 'button',
          role: 'button',
          text: 'Buy now',
          name: 'Buy now',
          placeholder: null,
          type: 'button',
          href: null,
          checked: false,
          disabled: false,
        },
      ],
      frames: [
        {
          ref: '@f1#p8',
          name: 'sidebar',
          title: 'Sidebar',
          src: 'https://example.com/frame',
        },
      ],
      headings: [
        {
          ref: '@e2#p8',
          tag: 'h1',
          text: 'Catalog',
          name: 'Catalog',
        },
      ],
      buttons: [
        {
          ref: '@e3#p8',
          tag: 'button',
          text: 'Next',
          name: 'Next',
        },
      ],
    })

    const lines = result.content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(result.recordCount).toBe(19)
    expect(lines[0]).toMatchObject({
      kind: 'field',
      pageEpoch: 8,
      fieldPath: 'page.title',
      value: 'Products',
      source: {
        kind: 'snapshot',
        ref: null,
      },
      matchStrategy: 'page-metadata',
    })
    expect(lines[4]).toMatchObject({
      kind: 'field',
      pageEpoch: 8,
      fieldPath: 'elements[0].name',
      value: 'Buy now',
      source: {
        kind: 'snapshot',
        ref: '@e1#p8',
      },
      matchStrategy: 'role+name',
    })
    expect(lines[5]).toMatchObject({
      kind: 'field',
      pageEpoch: 8,
      fieldPath: 'elements[0].text',
      value: 'Buy now',
      source: {
        kind: 'snapshot',
        ref: '@e1#p8',
      },
      matchStrategy: 'role+text',
    })
    expect(lines[11]).toMatchObject({
      kind: 'field',
      pageEpoch: 8,
      fieldPath: 'frames[0].title',
      value: 'Sidebar',
      source: {
        kind: 'snapshot',
        ref: '@f1#p8',
      },
      matchStrategy: 'frame-title',
    })
  })
})