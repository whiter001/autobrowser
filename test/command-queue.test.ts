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

  test('shares live cancellation and deadline state with running tasks', async () => {
    const queue = createCommandQueue()
    let context!: Parameters<Parameters<typeof queue.enqueue>[1]>[0]
    const pending = queue.enqueue(
      'tab:1',
      async (value) => {
        context = value
        await new Promise(() => {})
      },
      { id: 'context', deadlineAt: new Date(Date.now() + 20).toISOString() },
    )
    expect(context.cancelled).toBe(false)
    let aborts = 0
    context.signal.addEventListener('abort', () => {
      aborts += 1
    })
    await flush(30)
    expect(context.cancelled).toBe(true)
    expect(context.signal.aborted).toBe(true)
    expect(aborts).toBe(1)
    expect(() => context.throwIfCancelled()).toThrow('deadline elapsed')
    expect(queue.reset('tab:1')).toBe(1)
    await expect(pending).rejects.toMatchObject({ code: 'COMMAND_CANCELLED' })
    expect(context.cancelled).toBe(true)
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

  test('keeps a late result available after the caller deadline', async () => {
    const queue = createCommandQueue()
    let finish!: (result: unknown) => void
    const pending = queue.enqueue('tab:1', () => new Promise((resolve) => (finish = resolve)), {
      id: 'late-result',
    })

    expect(queue.cancel('late-result')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'COMMAND_CANCELLED' })
    finish({ province: '江西', timepoints: 24 })
    await flush(0)

    expect(queue.list()).toEqual([
      expect.objectContaining({
        id: 'late-result',
        state: 'completed_late',
        result: { province: '江西', timepoints: 24 },
      }),
    ])
  })

  test('keeps command and workspace metadata on active and terminal entries', async () => {
    const queue = createCommandQueue()
    let release!: () => void
    const pending = queue.enqueue(
      'tab:1',
      () => new Promise<void>((resolve) => (release = resolve)),
      {
        id: 'meta-running',
        command: 'click',
        workspace: 'ai-a',
      },
    )
    const queued = queue.enqueue('tab:1', async () => 'next', {
      id: 'meta-queued',
      command: 'snapshot',
    })

    expect(queue.list()).toEqual([
      expect.objectContaining({
        id: 'meta-running',
        state: 'running',
        command: 'click',
        workspace: 'ai-a',
      }),
      // 未启用 workspace 的命令只记录 command，workspace 归一为 null
      expect.objectContaining({
        id: 'meta-queued',
        state: 'queued',
        command: 'snapshot',
        workspace: null,
      }),
    ])

    release()
    await pending
    await queued
    expect(queue.list()).toEqual([
      expect.objectContaining({
        id: 'meta-running',
        state: 'completed',
        command: 'click',
        workspace: 'ai-a',
      }),
      expect.objectContaining({
        id: 'meta-queued',
        state: 'completed',
        command: 'snapshot',
        workspace: null,
      }),
    ])
  })

  test('keeps more than 100 commands for multi-agent status queries', async () => {
    const queue = createCommandQueue()
    for (let index = 0; index < 101; index += 1) {
      await queue.enqueue('tab:1', async () => index, { id: `cmd-${index}` })
    }

    const ids = queue.list().map((entry) => entry.id)
    // 多 AI 共用一个扩展时，101 条以内的记录都还必须能按 id 查询
    expect(ids).toHaveLength(101)
    expect(ids[0]).toBe('cmd-0')
    expect(queue.wasEvicted('cmd-0')).toBe(false)
    expect(queue.diagnostics()).toMatchObject({
      historyLimit: 500,
      lateResultLimit: 25,
      restoredCount: 0,
      evictedCount: 0,
      lastPersistError: null,
    })
  })

  test('evicts the oldest metadata beyond 500 entries and reports it', async () => {
    const stored: Record<string, unknown> = {}
    const storage = {
      get: async () => stored,
      set: async (items: Record<string, unknown>) => {
        Object.assign(stored, items)
      },
    }
    const queue = createCommandQueue({ storage })
    await queue.ready()
    for (let index = 0; index < 505; index += 1) {
      await queue.enqueue('tab:1', async () => index, { id: `cmd-${index}`, command: 'snapshot' })
    }
    await flush(0)

    const entries = queue.list()
    expect(entries).toHaveLength(500)
    expect(entries[0]).toMatchObject({ id: 'cmd-5', state: 'completed' })
    expect(queue.wasEvicted('cmd-0')).toBe(true)
    expect(queue.wasEvicted('cmd-4')).toBe(true)
    expect(queue.wasEvicted('cmd-5')).toBe(false)
    expect(queue.diagnostics()).toMatchObject({ evictedCount: 5, restoredCount: 0 })

    // 淘汰清单和累计计数随历史一起持久化，重启后仍能区分“已淘汰”和“未知 id”
    const restored = createCommandQueue({ storage })
    await restored.ready()
    expect(restored.list()).toHaveLength(500)
    expect(restored.wasEvicted('cmd-4')).toBe(true)
    expect(restored.wasEvicted('cmd-5')).toBe(false)
    expect(restored.diagnostics()).toMatchObject({ evictedCount: 5, restoredCount: 500 })
  })

  test('keeps only the newest 25 late results and marks older ones as evicted', async () => {
    const queue = createCommandQueue()
    for (let index = 0; index < 30; index += 1) {
      const id = `late-${index}`
      const pending = queue.enqueue(
        'tab:1',
        () =>
          new Promise<unknown>((resolve) => {
            setTimeout(() => resolve({ index }), 0)
          }),
        { id },
      )
      expect(queue.cancel(id)).toBe(true)
      await pending.catch(() => {})
      await flush(5)
    }
    await flush(10)

    const entries = queue.list()
    const evicted = entries.filter((entry) => entry.resultEvicted)
    const kept = entries.filter((entry) => entry.result !== undefined)
    expect(evicted).toHaveLength(5)
    expect(kept).toHaveLength(25)
    // 最早的 5 份结果被裁掉，但记录本身（id/state/时间戳）保留
    expect(evicted.map((entry) => entry.id)).toEqual([
      'late-0',
      'late-1',
      'late-2',
      'late-3',
      'late-4',
    ])
    expect(evicted[0]).toMatchObject({ state: 'completed_late' })
    expect(evicted[0]).not.toHaveProperty('result')
    expect(evicted[0]?.finishedAt).toBeString()
    expect(kept.map((entry) => entry.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `late-${index + 5}`),
    )
    // 最新一份结果原样保留，且没有被误标为已裁
    expect(kept.at(-1)).toMatchObject({ id: 'late-29', result: { index: 29 } })
    expect(kept.at(-1)?.resultEvicted).toBeUndefined()
    expect(queue.diagnostics().lateResultLimit).toBe(25)
  })

  test('preserves requestedAt and receivedAt across active, terminal, persist and restore', async () => {
    const stored: Record<string, unknown> = {}
    const storage = {
      get: async () => stored,
      set: async (items: Record<string, unknown>) => {
        Object.assign(stored, items)
      },
    }
    const queue = createCommandQueue({ storage })
    await queue.ready()
    let release!: () => void
    const pending = queue.enqueue(
      'tab:1',
      () => new Promise<void>((resolve) => (release = resolve)),
      {
        id: 'timed',
        requestedAt: '2026-11-17T07:24:24.893Z',
        receivedAt: '2026-11-17T07:24:24.900Z',
      },
    )
    // storage 模式下入队要等恢复完成，先 ready 再看 running 条目
    await queue.ready()
    await flush(0)
    expect(queue.list()[0]).toMatchObject({
      id: 'timed',
      requestedAt: '2026-11-17T07:24:24.893Z',
      receivedAt: '2026-11-17T07:24:24.900Z',
    })

    release()
    await pending
    await flush(0)
    expect(queue.list()[0]).toMatchObject({
      id: 'timed',
      state: 'completed',
      requestedAt: '2026-11-17T07:24:24.893Z',
      receivedAt: '2026-11-17T07:24:24.900Z',
    })

    const restored = createCommandQueue({ storage })
    await restored.ready()
    expect(restored.list()[0]).toMatchObject({
      id: 'timed',
      requestedAt: '2026-11-17T07:24:24.893Z',
      receivedAt: '2026-11-17T07:24:24.900Z',
    })
  })

  test('records persist failures without breaking command outcomes', async () => {
    const storage = {
      get: async () => ({}),
      set: async () => {
        throw new Error('quota exceeded')
      },
    }
    const queue = createCommandQueue({ storage })
    await queue.ready()

    await expect(queue.enqueue('tab:1', async () => 'done', { id: 'write-fails' })).resolves.toBe(
      'done',
    )
    await flush(0)
    expect(queue.diagnostics()).toMatchObject({ lastPersistError: 'quota exceeded' })
    expect(queue.list()).toEqual([
      expect.objectContaining({ id: 'write-fails', state: 'completed' }),
    ])
  })

  test('records restore failures without breaking the queue', async () => {
    const storage = {
      get: async () => {
        throw new Error('storage unavailable')
      },
      set: async () => {},
    }
    const queue = createCommandQueue({ storage })
    await queue.ready()

    // 读取历史失败要留下诊断，但队列本身仍要可用
    expect(queue.diagnostics().lastRestoreError).toBe('storage unavailable')
    await expect(queue.enqueue('tab:1', async () => 'done', { id: 'restore-fails' })).resolves.toBe(
      'done',
    )
    expect(queue.list()).toEqual([
      expect.objectContaining({ id: 'restore-fails', state: 'completed' }),
    ])
    expect(queue.diagnostics().lastRestoreError).toBe('storage unavailable')
  })

  test('restores history written before evictedIds and resultEvicted existed', async () => {
    const legacy: Record<string, unknown> = {
      'autobrowser.command-history.v1': {
        commands: Array.from({ length: 3 }, (_, index) => ({
          id: `old-${index}`,
          key: 'tab:1',
          state: 'completed',
          enqueuedAt: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:00.000Z',
          deadlineAt: null,
          finishedAt: '2026-01-01T00:00:01.000Z',
          error: null,
        })),
      },
    }
    const storage = {
      get: async () => legacy,
      set: async () => {},
    }
    const queue = createCommandQueue({ storage })
    await queue.ready()

    expect(queue.list().map((entry) => entry.id)).toEqual(['old-0', 'old-1', 'old-2'])
    expect(queue.wasEvicted('old-0')).toBe(false)
    expect(queue.diagnostics()).toMatchObject({
      evictedCount: 0,
      restoredCount: 3,
      lastRestoreError: null,
    })
  })

  test('persists and restores command and workspace metadata', async () => {
    const stored: Record<string, unknown> = {}
    const storage = {
      get: async () => stored,
      set: async (items: Record<string, unknown>) => {
        Object.assign(stored, items)
      },
    }
    const queue = createCommandQueue({ storage })
    await queue.ready()
    await queue.enqueue('tab:1', async () => 'done', {
      id: 'persisted',
      command: 'fill',
      workspace: 'ai-b',
    })
    await flush(0)

    const restored = createCommandQueue({ storage })
    await restored.ready()
    expect(restored.list()).toEqual([
      expect.objectContaining({
        id: 'persisted',
        state: 'completed',
        command: 'fill',
        workspace: 'ai-b',
      }),
    ])
  })

  test('restores legacy entries that have no command or workspace metadata', async () => {
    const legacy: Record<string, unknown> = {
      'autobrowser.command-history.v1': {
        commands: [
          {
            id: 'legacy',
            key: 'tab:1',
            state: 'completed',
            enqueuedAt: '2026-01-01T00:00:00.000Z',
            startedAt: '2026-01-01T00:00:00.000Z',
            deadlineAt: null,
            finishedAt: '2026-01-01T00:00:01.000Z',
            error: null,
          },
        ],
      },
    }
    const storage = {
      get: async () => legacy,
      set: async () => {},
    }
    const queue = createCommandQueue({ storage })
    await queue.ready()

    const entry = queue.list()[0]!
    expect(entry).toMatchObject({ id: 'legacy', key: 'tab:1', state: 'completed' })
    expect(entry.command).toBeUndefined()
    expect(entry.workspace).toBeUndefined()
  })

  test('restores terminal history and marks pre-restart work as interrupted', async () => {
    const stored: Record<string, unknown> = {
      'autobrowser.command-history.v1': {
        commands: [
          {
            id: 'before-restart',
            key: 'tab:1',
            state: 'running',
            enqueuedAt: '2026-01-01T00:00:00.000Z',
            startedAt: '2026-01-01T00:00:00.000Z',
            deadlineAt: null,
            finishedAt: null,
            error: null,
          },
          {
            id: 'late-before-restart',
            key: 'tab:1',
            state: 'completed_late',
            enqueuedAt: '2026-01-01T00:00:00.000Z',
            startedAt: '2026-01-01T00:00:00.000Z',
            deadlineAt: null,
            finishedAt: '2026-01-01T00:00:01.000Z',
            error: null,
            result: { preserved: true },
          },
        ],
      },
    }
    const storage = {
      get: async () => stored,
      set: async (items: Record<string, unknown>) => {
        Object.assign(stored, items)
      },
    }
    const queue = createCommandQueue({ storage })
    await queue.ready()

    expect(queue.list()).toEqual([
      expect.objectContaining({ id: 'before-restart', state: 'interrupted' }),
      expect.objectContaining({
        id: 'late-before-restart',
        state: 'completed_late',
        result: { preserved: true },
      }),
    ])

    await expect(queue.enqueue('tab:1', async () => 'done', { id: 'after-restart' })).resolves.toBe(
      'done',
    )
    await queue.ready()
    await flush(0)
    const restored = createCommandQueue({ storage })
    await restored.ready()
    expect(restored.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'before-restart', state: 'interrupted' }),
        expect.objectContaining({ id: 'after-restart', state: 'completed' }),
      ]),
    )
  })
})
