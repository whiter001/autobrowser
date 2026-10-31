import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileUploadError, FileUploadStore } from '../src/core/file-upload.js'
import { MAX_FILE_UPLOAD_BYTES } from '../src/core/file-transfer.js'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes.buffer as ArrayBuffer).body!
}

/** 复制出一段字节：body() 依赖独立的 ArrayBuffer，不能直接传 subarray 视图 */
function segment(bytes: Uint8Array, start: number, end: number): Uint8Array {
  return bytes.slice(start, end)
}

describe('file upload store', () => {
  const directories: string[] = []
  const stores: FileUploadStore[] = []

  async function createStore(idleTimeoutMs?: number) {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autobrowser-file-upload-'))
    directories.push(homeDir)
    const store = new FileUploadStore(idleTimeoutMs)
    stores.push(store)
    const outputPath = path.join(homeDir, 'nested', 'target.bin')
    return { homeDir, store, outputPath }
  }

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.clear()))
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('stores binary bytes exactly, including zero and non-utf8 bytes', async () => {
    const { store, outputPath } = await createStore()
    // 0x00 与 0xff 都不是合法 UTF-8，文本模式写盘一定会被破坏
    const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x00, 0x41, 0xc3, 0x28, 0x00])
    store.register({
      requestId: 'request',
      transferId: 'transfer-binary-0001',
      totalBytes: bytes.byteLength,
      sha256: sha256(bytes),
      outputPath,
    })

    const result = await store.write(
      'transfer-binary-0001',
      `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      String(bytes.byteLength),
      body(bytes),
    )
    expect(result).toMatchObject({ done: true, receivedBytes: bytes.byteLength })
    expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes)
    // 成功后临时文件必须消失，只留下最终文件
    expect(await readdir(path.dirname(outputPath))).toEqual(['target.bin'])
  })

  test('supports empty files', async () => {
    const { store, outputPath } = await createStore()
    store.register({
      requestId: 'request',
      transferId: 'transfer-empty-00001',
      totalBytes: 0,
      sha256: sha256(new Uint8Array(0)),
      outputPath,
    })

    const result = await store.write(
      'transfer-empty-00001',
      'bytes 0-0/0',
      '0',
      body(new Uint8Array(0)),
    )
    expect(result).toMatchObject({ done: true, receivedBytes: 0, totalBytes: 0 })
    expect((await readFile(outputPath)).byteLength).toBe(0)
  })

  test('resumes from the confirmed offset with ordered segments', async () => {
    const { store, outputPath } = await createStore()
    const bytes = new Uint8Array(Array.from({ length: 30 }, (_, index) => index))
    store.register({
      requestId: 'request',
      transferId: 'transfer-resume-0001',
      totalBytes: bytes.byteLength,
      sha256: sha256(bytes),
      outputPath,
    })

    const first = await store.write(
      'transfer-resume-0001',
      'bytes 0-9/30',
      '10',
      body(bytes.slice(0, 10)),
    )
    expect(first).toMatchObject({ done: false, receivedBytes: 10 })
    expect(store.offset('transfer-resume-0001')).toMatchObject({
      receivedBytes: 10,
      totalBytes: 30,
    })

    const second = await store.write(
      'transfer-resume-0001',
      'bytes 10-19/30',
      '10',
      body(bytes.slice(10, 20)),
    )
    expect(second).toMatchObject({ done: false, receivedBytes: 20 })

    const third = await store.write(
      'transfer-resume-0001',
      'bytes 20-29/30',
      '10',
      body(bytes.slice(20, 30)),
    )
    expect(third).toMatchObject({ done: true, receivedBytes: 30 })
    expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes)
  })

  test('rejects overlapping and out-of-order ranges without advancing', async () => {
    const { store, outputPath } = await createStore()
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
    store.register({
      requestId: 'request',
      transferId: 'transfer-overlap-001',
      totalBytes: bytes.byteLength,
      sha256: sha256(bytes),
      outputPath,
    })
    await store.write('transfer-overlap-001', 'bytes 0-2/6', '3', body(bytes.slice(0, 3)))
    await expect(
      store.write('transfer-overlap-001', 'bytes 1-3/6', '3', body(bytes.slice(1, 4))),
    ).rejects.toMatchObject({ httpStatus: 409, receivedBytes: 3 })
    expect(store.offset('transfer-overlap-001').receivedBytes).toBe(3)
  })

  test('rejects a digest mismatch and keeps the previous target intact', async () => {
    const { store, outputPath } = await createStore()
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, 'previous')
    const bytes = new Uint8Array([9, 9, 9, 9])
    store.register({
      requestId: 'request',
      transferId: 'transfer-digest-00001',
      totalBytes: bytes.byteLength,
      sha256: '0'.repeat(64),
      outputPath,
    })
    await expect(
      store.write('transfer-digest-00001', 'bytes 0-3/4', '4', body(bytes)),
    ).rejects.toMatchObject({ httpStatus: 422 })
    // 校验失败不能覆盖已有目标
    expect(await readFile(outputPath, 'utf8')).toBe('previous')
  })

  test('times out a stalled body and preserves only confirmed bytes', async () => {
    const { store, outputPath } = await createStore(20)
    const bytes = new Uint8Array([1, 2])
    store.register({
      requestId: 'request',
      transferId: 'transfer-stalled-0001',
      totalBytes: 2,
      sha256: sha256(bytes),
      outputPath,
    })
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
      },
    })
    await expect(
      store.write('transfer-stalled-0001', 'bytes 0-1/2', '2', stalled),
    ).rejects.toMatchObject({ httpStatus: 408 })
    expect(store.offset('transfer-stalled-0001').receivedBytes).toBe(1)
  })

  test('enforces one upload per request, the byte budget and the upload count limit', async () => {
    const { store, outputPath } = await createStore()
    store.register({
      requestId: 'request',
      transferId: 'transfer-budget-00001',
      totalBytes: 1024,
      sha256: sha256(new Uint8Array(1024)),
      outputPath,
    })
    expect(() =>
      store.register({
        requestId: 'request',
        transferId: 'transfer-budget-00002',
        totalBytes: 1024,
        sha256: sha256(new Uint8Array(1024)),
        outputPath,
      }),
    ).toThrow(FileUploadError)

    expect(() =>
      store.register({
        requestId: 'other',
        transferId: 'transfer-budget-00003',
        totalBytes: MAX_FILE_UPLOAD_BYTES,
        sha256: sha256(new Uint8Array(0)),
        outputPath,
      }),
    ).toThrow(/budget/)

    // 单个文件超出预算同样拒绝
    expect(() =>
      store.register({
        requestId: 'other',
        transferId: 'transfer-budget-00004',
        totalBytes: MAX_FILE_UPLOAD_BYTES + 1,
        sha256: sha256(new Uint8Array(0)),
        outputPath,
      }),
    ).toThrow(/budget/)
  })

  test('release removes the temporary file and frees the reserved budget', async () => {
    const { store, outputPath } = await createStore()
    const bytes = new Uint8Array([1, 2, 3, 4])
    store.register({
      requestId: 'request',
      transferId: 'transfer-release-0001',
      totalBytes: bytes.byteLength,
      sha256: sha256(bytes),
      outputPath,
    })
    await store.write('transfer-release-0001', 'bytes 0-1/4', '2', body(bytes.slice(0, 2)))
    expect(await readdir(path.dirname(outputPath))).toEqual([
      '.autobrowser-upload-transfer-release-0001.tmp',
    ])

    await store.release('transfer-release-0001')
    expect(await readdir(path.dirname(outputPath))).toEqual([])
    expect(() => store.offset('transfer-release-0001')).toThrow(
      expect.objectContaining({ httpStatus: 404 }),
    )
    // 释放后预算归还，可以继续登记新文件
    expect(() =>
      store.register({
        requestId: 'other',
        transferId: 'transfer-release-0002',
        totalBytes: 1024,
        sha256: sha256(new Uint8Array(1024)),
        outputPath,
      }),
    ).not.toThrow()
  })

  test('releaseRequest drops every upload of a cancelled command', async () => {
    const { store, outputPath } = await createStore()
    store.register({
      requestId: 'request',
      transferId: 'transfer-cancel-00001',
      totalBytes: 4,
      sha256: sha256(new Uint8Array(4)),
      outputPath,
    })
    await store.write('transfer-cancel-00001', 'bytes 0-1/4', '2', body(new Uint8Array([1, 2])))
    await store.releaseRequest('request')
    expect(await readdir(path.dirname(outputPath))).toEqual([])
    expect(() => store.offset('transfer-cancel-00001')).toThrow(
      expect.objectContaining({ httpStatus: 404 }),
    )
  })

  test('requires absolute output paths and valid metadata', async () => {
    const { store } = await createStore()
    expect(() =>
      store.register({
        requestId: 'request',
        transferId: 'transfer-invalid-0001',
        totalBytes: 1,
        sha256: sha256(new Uint8Array(1)),
        outputPath: 'relative/path.bin',
      }),
    ).toThrow(/absolute/)
    expect(() =>
      store.register({
        requestId: 'request',
        transferId: 'short',
        totalBytes: 1,
        sha256: sha256(new Uint8Array(1)),
        outputPath: path.join(os.tmpdir(), 'x.bin'),
      }),
    ).toThrow(/transferId/)
    expect(() =>
      store.register({
        requestId: 'request',
        transferId: 'transfer-invalid-0002',
        totalBytes: -1,
        sha256: sha256(new Uint8Array(1)),
        outputPath: path.join(os.tmpdir(), 'x.bin'),
      }),
    ).toThrow(/totalBytes/)
    expect(() =>
      store.register({
        requestId: 'request',
        transferId: 'transfer-invalid-0003',
        totalBytes: 1,
        sha256: 'zz',
        outputPath: path.join(os.tmpdir(), 'x.bin'),
      }),
    ).toThrow(/SHA-256/)
  })

  test('accepts a streaming registration without an extension digest', async () => {
    const { store, outputPath } = await createStore()
    const bytes = new Uint8Array(Array.from({ length: 64 }, (_, index) => index))
    store.register({
      requestId: 'request',
      transferId: 'transfer-stream-0001',
      totalBytes: bytes.byteLength,
      // 流式上传没有整文件摘要：relay 边写边算
      sha256: null,
      outputPath,
    })
    const result = await store.write(
      'transfer-stream-0001',
      `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      String(bytes.byteLength),
      body(bytes),
      sha256(bytes),
    )
    expect(result).toMatchObject({ done: true, sha256: sha256(bytes) })
    expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes)
  })

  test('rejects a wrong chunk digest and keeps the confirmed offset', async () => {
    const { store, outputPath } = await createStore()
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    store.register({
      requestId: 'request',
      transferId: 'transfer-stream-0002',
      totalBytes: bytes.byteLength,
      sha256: null,
      outputPath,
    })
    await expect(
      store.write(
        'transfer-stream-0002',
        'bytes 0-3/8',
        '4',
        body(segment(bytes, 0, 4)),
        '0'.repeat(64),
      ),
    ).rejects.toMatchObject({ httpStatus: 422 })
    // 摘要不符时不能推进偏移，也不能把字节写进临时文件
    expect(store.offset('transfer-stream-0002').receivedBytes).toBe(0)

    // 修正后的分段可以正常继续
    const result = await store.write(
      'transfer-stream-0002',
      'bytes 0-3/8',
      '4',
      body(segment(bytes, 0, 4)),
      sha256(segment(bytes, 0, 4)),
    )
    expect(result).toMatchObject({ done: false, receivedBytes: 4 })
  })

  test('requires a chunk digest for streaming uploads', async () => {
    const { store, outputPath } = await createStore()
    const bytes = new Uint8Array([1, 2, 3, 4])
    store.register({
      requestId: 'request',
      transferId: 'transfer-stream-0003',
      totalBytes: bytes.byteLength,
      sha256: null,
      outputPath,
    })
    await expect(
      store.write('transfer-stream-0003', 'bytes 0-3/4', '4', body(bytes)),
    ).rejects.toMatchObject({ httpStatus: 400 })
    expect(store.offset('transfer-stream-0003').receivedBytes).toBe(0)
  })

  test('resumes a streaming upload from the confirmed offset', async () => {
    const { store, outputPath } = await createStore()
    const bytes = new Uint8Array(Array.from({ length: 40 }, (_, index) => index))
    store.register({
      requestId: 'request',
      transferId: 'transfer-stream-0004',
      totalBytes: bytes.byteLength,
      sha256: null,
      outputPath,
    })
    await store.write(
      'transfer-stream-0004',
      'bytes 0-9/40',
      '10',
      body(segment(bytes, 0, 10)),
      sha256(segment(bytes, 0, 10)),
    )
    // 续传只覆盖剩余部分
    const result = await store.write(
      'transfer-stream-0004',
      'bytes 10-39/40',
      '30',
      body(segment(bytes, 10, 40)),
      sha256(segment(bytes, 10, 40)),
    )
    expect(result).toMatchObject({ done: true, receivedBytes: 40, sha256: sha256(bytes) })
    expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes)
  })

  test('rejects a streaming segment that does not continue the confirmed offset', async () => {
    const { store, outputPath } = await createStore()
    const bytes = new Uint8Array(Array.from({ length: 12 }, (_, index) => index))
    store.register({
      requestId: 'request',
      transferId: 'transfer-stream-0005',
      totalBytes: bytes.byteLength,
      sha256: null,
      outputPath,
    })
    await expect(
      store.write(
        'transfer-stream-0005',
        'bytes 4-11/12',
        '8',
        body(segment(bytes, 4, 12)),
        sha256(segment(bytes, 4, 12)),
      ),
    ).rejects.toMatchObject({ httpStatus: 409 })
    expect(store.offset('transfer-stream-0005').receivedBytes).toBe(0)
  })
})
