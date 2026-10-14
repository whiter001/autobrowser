import { describe, expect, test } from 'bun:test'
import {
  createResponseSender,
  MAX_RESPONSE_BYTES,
  RESPONSE_BUFFER_BYTES,
  RESPONSE_CHUNK_CHARS,
  ResponseAssembler,
  responseByteLength,
  responseChunks,
} from '../src/core/response-transfer.js'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function frames(id: string, text: string): Record<string, unknown>[] {
  const chunks = [...responseChunks(text)]
  const totalBytes = responseByteLength(text)
  return [
    { type: 'response.start', id, sequence: 0, totalBytes },
    ...chunks.map((data, sequence) => ({
      type: 'response.chunk',
      id,
      sequence,
      byteLength: responseByteLength(data),
      data,
    })),
    { type: 'response.end', id, sequence: chunks.length, totalBytes },
  ]
}

function mockSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    payloads: [] as string[],
    send(payload: string) {
      this.payloads.push(payload)
    },
    close() {
      this.readyState = 3
    },
  }
}

describe('response transfer', () => {
  test('keeps small responses unchanged and round trips Unicode across chunk boundaries', async () => {
    const socket = mockSocket()
    const sender = createResponseSender(socket)
    try {
      const small = { type: 'response' as const, id: 'small', ok: true, result: '中文😀' }
      await sender.send(small)
      expect(socket.payloads).toEqual([JSON.stringify(small)])
      socket.payloads = []
      const response = {
        ...small,
        id: 'large',
        result: 'a'.repeat(RESPONSE_CHUNK_CHARS - 57) + '😀中文\\\"'.repeat(90_000),
      }
      await sender.send(response)
      const assembler = new ResponseAssembler()
      let restored: unknown
      for (const payload of socket.payloads) {
        expect(responseByteLength(payload)).toBeLessThan(512 * 1024)
        restored = assembler.accept(JSON.parse(payload))
      }
      expect(restored).toEqual(response)
      expect(
        [...responseChunks('a'.repeat(RESPONSE_CHUNK_CHARS - 1) + '😀')].map(
          (chunk) => chunk.length,
        ),
      ).toEqual([RESPONSE_CHUNK_CHARS - 1, 2])
    } finally {
      sender.dispose()
    }
  })

  test('rejects malformed, duplicate, out-of-order and mismatched envelopes', () => {
    const text = JSON.stringify({ type: 'response', id: 'a', ok: true, result: 'ok' })
    const valid = frames('a', text)
    const invalidSequences = [
      [valid[1]],
      [valid[0], valid[0]],
      [valid[0], { ...valid[1], sequence: 1 }],
      [valid[0], valid[1], valid[1]],
      [valid[0], { ...valid[1], byteLength: 1 }],
      [valid[0], { ...valid[1], data: 'x'.repeat(RESPONSE_CHUNK_CHARS + 1) }],
      [valid[0], { ...valid[1], data: '', byteLength: 0 }],
      [valid[0], { ...valid[2], sequence: 0 }],
      [valid[0], valid[1], { ...valid[2], totalBytes: 1 }],
      [{ ...valid[0], totalBytes: 1 }, valid[1]],
      [
        { ...valid[0], totalBytes: 100 },
        { ...valid[1], data: 'a', byteLength: 1 },
      ],
      frames('a', '{invalid'),
      frames('a', JSON.stringify({ type: 'state', id: 'a' })),
      frames('a', JSON.stringify({ type: 'response', id: 'other' })),
    ]
    for (const sequence of invalidSequences) {
      const assembler = new ResponseAssembler()
      expect(() => {
        for (const frame of sequence) assembler.accept(frame!)
      }).toThrow(
        expect.objectContaining({
          code: 'RESPONSE_TRANSFER_ERROR',
          suggestedAction: expect.any(String),
        }),
      )
      for (const frame of valid) assembler.accept(frame!)
    }
    for (const totalBytes of [-1, 0, Infinity, NaN, 0.5, '10']) {
      expect(() => new ResponseAssembler().accept({ ...valid[0], totalBytes })).toThrow(
        'Invalid response totalBytes',
      )
    }
  })

  test('reserves the full declared bytes globally and releases on errors, completion and clear', () => {
    const assembler = new ResponseAssembler()
    const start = (id: string, totalBytes = MAX_RESPONSE_BYTES) => ({
      type: 'response.start',
      id,
      sequence: 0,
      totalBytes,
    })
    expect(() => assembler.accept(start('huge', MAX_RESPONSE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }),
    )
    assembler.accept(start('a'))
    expect(() => assembler.accept(start('b', 1))).toThrow(
      expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }),
    )
    assembler.release('a')
    assembler.accept(start('b'))
    assembler.clear()
    assembler.accept(start('c'))
    expect(() =>
      assembler.accept({
        type: 'response.end',
        id: 'c',
        sequence: 0,
        totalBytes: MAX_RESPONSE_BYTES,
      }),
    ).toThrow()
    assembler.accept(start('d'))
    assembler.release('d')
    for (const frame of frames('done', JSON.stringify({ type: 'response', id: 'done', ok: true })))
      assembler.accept(frame)
    assembler.accept(start('after'))
  })

  test('shares a bounded socket window between concurrent responses and stops on cancellation', async () => {
    const socket = mockSocket()
    socket.send = function (payload: string) {
      this.payloads.push(payload)
      this.bufferedAmount += responseByteLength(payload)
    }
    const sender = createResponseSender(socket)
    try {
      const result = '😀'.repeat(600_000)
      const first = sender
        .send({ type: 'response', id: 'a', ok: true, result })
        .catch((error) => error)
      const second = sender
        .send({ type: 'response', id: 'b', ok: true, result })
        .catch((error) => error)
      await delay(20)
      expect(socket.bufferedAmount).toBeLessThanOrEqual(RESPONSE_BUFFER_BYTES)
      const sent = socket.payloads.length
      await delay(20)
      expect(socket.payloads).toHaveLength(sent)
      sender.cancel('a')
      sender.cancel('b')
      expect(await first).toMatchObject({ code: 'RESPONSE_TRANSFER_ERROR' })
      expect(await second).toMatchObject({ code: 'RESPONSE_TRANSFER_ERROR' })
      socket.bufferedAmount = 0
      await delay(20)
      expect(socket.payloads).toHaveLength(sent)
      socket.send = function (payload: string) {
        this.payloads.push(payload)
      }
      await sender.send({ type: 'response', id: 'next', ok: true })
    } finally {
      sender.dispose()
    }
  }, 1000)

  test('deadline or send failure closes and releases the sender without retry loops', async () => {
    for (const throws of [false, true]) {
      const socket = mockSocket()
      socket.send = function (payload: string) {
        if (throws) throw new Error('socket failed')
        this.payloads.push(payload)
        this.bufferedAmount += responseByteLength(payload)
      }
      const sender = createResponseSender(socket)
      try {
        await expect(
          sender.send(
            { type: 'response', id: 'a', ok: true, result: 'x'.repeat(2 * 1024 * 1024) },
            new Date(Date.now() + 40).toISOString(),
          ),
        ).rejects.toMatchObject({ code: 'RESPONSE_TRANSFER_ERROR' })
        expect(socket.readyState).toBe(3)
        expect(socket.bufferedAmount).toBeLessThanOrEqual(RESPONSE_BUFFER_BYTES)
        const sent = socket.payloads.length
        await delay(20)
        expect(socket.payloads).toHaveLength(sent)
        await expect(sender.send({ type: 'response', id: 'b', ok: true })).rejects.toThrow(
          'not open',
        )
      } finally {
        sender.dispose()
      }
    }
  })

  test('bounds queued jobs and rejects expired or unserializable responses before sending', async () => {
    const socket = mockSocket()
    socket.bufferedAmount = RESPONSE_BUFFER_BYTES
    const sender = createResponseSender(socket)
    const outcomes: Promise<unknown>[] = []
    try {
      await expect(
        sender.send({ type: 'response', id: 'expired', ok: true }, '1970-01-01T00:00:00.000Z'),
      ).rejects.toThrow('deadline')
      const cyclic: { self?: unknown } = {}
      cyclic.self = cyclic
      await expect(
        sender.send({ type: 'response', id: 'cyclic', ok: true, result: cyclic }),
      ).rejects.toMatchObject({ code: 'RESPONSE_TRANSFER_ERROR' })
      for (let index = 0; index < 128; index += 1) {
        outcomes.push(
          sender
            .send({ type: 'response', id: String(index), ok: true })
            .catch((error: unknown) => error),
        )
      }
      await expect(
        sender.send({ type: 'response', id: 'overflow', ok: true }),
      ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
      expect(socket.payloads).toHaveLength(0)
    } finally {
      sender.dispose()
      for (const outcome of outcomes)
        expect(await outcome).toMatchObject({ code: 'RESPONSE_TRANSFER_ERROR' })
    }
  })
})
