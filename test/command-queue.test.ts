import { describe, expect, test } from 'bun:test'
import { createCommandQueue } from '../extension/background/command-queue.js'

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('command queue', () => {
  test('serializes tasks with the same key in FIFO order', async () => {
    const queue = createCommandQueue()
    const order: string[] = []

    const tasks = ['a', 'b', 'c'].map((name) =>
      queue.enqueue('same', async () => {
        order.push(`${name}-start`)
        await flush()
        order.push(`${name}-end`)
        return name
      }),
    )

    const results = await Promise.all(tasks)

    expect(results).toEqual(['a', 'b', 'c'])
    // 同 key 严格串行：上一个任务 end 之后下一个任务才 start
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end'])
  })

  test('runs tasks with different keys concurrently while same-key stays serial', async () => {
    const queue = createCommandQueue()
    const activeByKey = new Map<string, number>()
    const maxActiveByKey = new Map<string, number>()
    let overallMax = 0

    const run = (key: string) =>
      queue.enqueue(key, async () => {
        const active = (activeByKey.get(key) || 0) + 1
        activeByKey.set(key, active)
        maxActiveByKey.set(key, Math.max(maxActiveByKey.get(key) || 0, active))
        overallMax = Math.max(
          overallMax,
          Array.from(activeByKey.values()).reduce((sum, count) => sum + count, 0),
        )
        await flush()
        activeByKey.set(key, (activeByKey.get(key) || 0) - 1)
        return key
      })

    await Promise.all([run('A'), run('A'), run('A'), run('B'), run('B'), run('C')])

    // 同 key 永不重叠
    expect(maxActiveByKey.get('A')).toBe(1)
    expect(maxActiveByKey.get('B')).toBe(1)
    // 不同 key 可并行：全部串行时 overallMax 只能是 1
    expect(overallMax).toBeGreaterThan(1)
  })

  test('a rejected task does not block later tasks with the same key', async () => {
    const queue = createCommandQueue()
    const order: string[] = []

    const first = queue.enqueue('same', async () => {
      order.push('first')
      throw new Error('boom')
    })
    const second = queue.enqueue('same', async () => {
      order.push('second')
      return 'ok'
    })

    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('ok')
    expect(order).toEqual(['first', 'second'])
  })

  test('queue stays usable after a rejected task for repeated enqueues', async () => {
    const queue = createCommandQueue()

    await expect(queue.enqueue('k', async () => 'first')).resolves.toBe('first')
    await expect(queue.enqueue('k', async () => Promise.reject(new Error('x')))).rejects.toThrow(
      'x',
    )
    await expect(queue.enqueue('k', async () => 'after')).resolves.toBe('after')
  })

  test('cancels a stuck running task and starts the next task', async () => {
    const queue = createCommandQueue()
    const stuck = queue.enqueue('tab:1', () => new Promise(() => {}), { id: 'stuck' })
    const next = queue.enqueue('tab:1', async () => 'recovered', { id: 'next' })

    expect(queue.list()).toEqual([
      expect.objectContaining({ id: 'stuck', state: 'running' }),
      expect.objectContaining({ id: 'next', state: 'queued' }),
    ])
    expect(queue.cancel('stuck')).toBe(true)
    await expect(stuck).rejects.toMatchObject({ code: 'COMMAND_CANCELLED' })
    await expect(next).resolves.toBe('recovered')
    expect(queue.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'stuck', state: 'cancelled' }),
        expect.objectContaining({ id: 'next', state: 'completed' }),
      ]),
    )
  })

  test('does not start a queued command after its deadline', async () => {
    const queue = createCommandQueue()
    let ran = false
    await expect(
      queue.enqueue(
        'tab:1',
        async () => {
          ran = true
        },
        { id: 'expired', deadlineAt: new Date(Date.now() - 1).toISOString() },
      ),
    ).rejects.toMatchObject({ code: 'COMMAND_CANCELLED' })
    expect(ran).toBe(false)
  })
})
