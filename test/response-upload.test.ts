import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ResponseUploadError, ResponseUploadStore } from '../src/core/response-upload.js'
import { MAX_RESPONSE_BYTES } from '../src/core/response-transfer.js'

const encoder = new TextEncoder()

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes.buffer as ArrayBuffer).body!
}

describe('response upload store', () => {
  const directories: string[] = []
  const stores: ResponseUploadStore[] = []

  async function createStore(idleTimeoutMs?: number) {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-upload-test-'))
    directories.push(homeDir)
    const store = await ResponseUploadStore.create(homeDir, idleTimeoutMs)
    stores.push(store)
    return { homeDir, store }
  }

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.clear()))
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('writes to disk, resumes at the confirmed offset and verifies SHA-256', async () => {
    const { store } = await createStore()
    const text = JSON.stringify({
      type: 'response',
      id: 'request',
      ok: true,
      result: '中文😀'.repeat(1000),
    })
    const bytes = encoder.encode(text)
    const split = Math.floor(bytes.byteLength / 2)
    store.register({
      requestId: 'request',
      transferId: 'transfer-complete-0001',
      totalBytes: bytes.byteLength,
      sha256: await sha256(bytes),
    })

    const first = await store.write(
      'transfer-complete-0001',
      `bytes 0-${split - 1}/${bytes.byteLength}`,
      String(split),
      body(bytes.slice(0, split)),
    )
    expect(first).toMatchObject({ done: false, receivedBytes: split })
    expect(store.offset('transfer-complete-0001').receivedBytes).toBe(split)
    const second = await store.write(
      'transfer-complete-0001',
      `bytes ${split}-${bytes.byteLength - 1}/${bytes.byteLength}`,
      String(bytes.byteLength - split),
      body(bytes.slice(split)),
    )
    expect(second).toMatchObject({ done: true, receivedBytes: bytes.byteLength, text })
    await store.release('transfer-complete-0001')
    expect(() => store.offset('transfer-complete-0001')).toThrow(
      expect.objectContaining({ httpStatus: 404 }),
    )
  })

  test('rejects overlapping ranges and digest mismatches without advancing', async () => {
    const { store } = await createStore()
    const bytes = encoder.encode('abcdef')
    store.register({
      requestId: 'request',
      transferId: 'transfer-overlap-00001',
      totalBytes: bytes.byteLength,
      sha256: await sha256(bytes),
    })
    await store.write('transfer-overlap-00001', 'bytes 0-2/6', '3', body(bytes.slice(0, 3)))
    await expect(
      store.write('transfer-overlap-00001', 'bytes 1-3/6', '3', body(bytes.slice(1, 4))),
    ).rejects.toMatchObject({ httpStatus: 409, receivedBytes: 3 })
    expect(store.offset('transfer-overlap-00001').receivedBytes).toBe(3)

    store.register({
      requestId: 'other',
      transferId: 'transfer-digest-000001',
      totalBytes: bytes.byteLength,
      sha256: '0'.repeat(64),
    })
    await expect(
      store.write('transfer-digest-000001', 'bytes 0-5/6', '6', body(bytes)),
    ).rejects.toMatchObject({ httpStatus: 422 })
  })

  test('times out a stalled body and preserves only confirmed bytes', async () => {
    const { store } = await createStore(20)
    const bytes = encoder.encode('ab')
    store.register({
      requestId: 'request',
      transferId: 'transfer-stalled-00001',
      totalBytes: 2,
      sha256: await sha256(bytes),
    })
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('a'))
      },
    })
    await expect(
      store.write('transfer-stalled-00001', 'bytes 0-1/2', '2', stalled),
    ).rejects.toMatchObject({ httpStatus: 408 })
    expect(store.offset('transfer-stalled-00001').receivedBytes).toBe(1)
  })

  test('release removes temporary data and enforces the global reservation budget', async () => {
    const { homeDir, store } = await createStore()
    store.register({
      requestId: 'huge',
      transferId: 'transfer-budget-000001',
      totalBytes: MAX_RESPONSE_BYTES,
      sha256: '0'.repeat(64),
    })
    expect(() =>
      store.register({
        requestId: 'overflow',
        transferId: 'transfer-budget-000002',
        totalBytes: 1,
        sha256: '0'.repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }))
    await store.releaseRequest('huge')
    expect(await readdir(path.join(homeDir, '.autobrowser', 'responses'))).toEqual([])
    expect(() =>
      store.register({
        requestId: 'after',
        transferId: 'transfer-budget-000003',
        totalBytes: 1,
        sha256: '0'.repeat(64),
      }),
    ).not.toThrow()
  })

  test('reports invalid content lengths as terminal protocol errors', async () => {
    const { store } = await createStore()
    const bytes = encoder.encode('abc')
    store.register({
      requestId: 'request',
      transferId: 'transfer-length-000001',
      totalBytes: 3,
      sha256: await sha256(bytes),
    })
    const outcome = store.write('transfer-length-000001', 'bytes 0-2/3', '2', body(bytes))
    await expect(outcome).rejects.toBeInstanceOf(ResponseUploadError)
    await expect(outcome).rejects.toMatchObject({ httpStatus: 400 })
  })
})
