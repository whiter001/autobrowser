export interface CommandQueueEntry {
  id: string
  key: string
  state:
    | 'queued'
    | 'running'
    | 'cancelled'
    | 'completed'
    | 'failed'
    | 'completed_late'
    | 'failed_late'
  enqueuedAt: string
  startedAt: string | null
  deadlineAt: string | null
  finishedAt: string | null
  error: string | null
}

export interface CommandQueue {
  enqueue: <TResult>(
    key: string,
    task: () => Promise<TResult>,
    options?: { id?: string; deadlineAt?: string | null },
  ) => Promise<TResult>
  cancel: (id: string) => boolean
  reset: (key: string) => number
  list: () => CommandQueueEntry[]
}

interface QueueItem<TResult = unknown> extends CommandQueueEntry {
  task: () => Promise<TResult>
  resolve: (value: TResult) => void
  reject: (reason: Error) => void
  settled: boolean
}

function createCancellationError(id: string, reason: string): Error & { code?: string } {
  const error = new Error(`command ${id} cancelled: ${reason}`) as Error & { code?: string }
  error.code = 'COMMAND_CANCELLED'
  return error
}

/**
 * 同一 tab 的页面命令保持 FIFO。任务有显式 id，relay 超时后可取消排队项；
 * 运行项无法中断底层 CDP，但会与队列脱钩，避免后续控制命令无限堆积。
 */
export function createCommandQueue(): CommandQueue {
  const queues = new Map<string, QueueItem[]>()
  const itemsById = new Map<string, QueueItem>()
  const history: CommandQueueEntry[] = []

  function recordHistory(
    item: QueueItem,
    state: CommandQueueEntry['state'],
    error: string | null = null,
  ): void {
    const entry: CommandQueueEntry = {
      id: item.id,
      key: item.key,
      state,
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt,
      deadlineAt: item.deadlineAt,
      finishedAt: new Date().toISOString(),
      error,
    }
    const existing = history.findIndex((candidate) => candidate.id === item.id)
    if (existing >= 0) history[existing] = entry
    else history.push(entry)
    if (history.length > 100) history.splice(0, history.length - 100)
  }

  function settleCancelled(item: QueueItem, reason: string): void {
    if (item.settled) return
    item.settled = true
    item.state = 'cancelled'
    itemsById.delete(item.id)
    recordHistory(item, 'cancelled', reason)
    item.reject(createCancellationError(item.id, reason))
  }

  function pump(key: string): void {
    const queue = queues.get(key)
    if (!queue?.length || queue[0]?.state === 'running') return

    const item = queue[0]
    const deadlineMs = item.deadlineAt ? Date.parse(item.deadlineAt) : Number.NaN
    if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
      queue.shift()
      settleCancelled(item, 'deadline elapsed before execution')
      if (!queue.length) queues.delete(key)
      else pump(key)
      return
    }
    item.state = 'running'
    item.startedAt = new Date().toISOString()
    void item
      .task()
      .then(
        (result) => {
          if (!item.settled) {
            item.settled = true
            itemsById.delete(item.id)
            item.resolve(result)
            recordHistory(item, 'completed')
          } else if (item.state === 'cancelled') {
            recordHistory(item, 'completed_late')
          }
        },
        (error) => {
          if (!item.settled) {
            item.settled = true
            itemsById.delete(item.id)
            item.reject(error instanceof Error ? error : new Error(String(error)))
            recordHistory(item, 'failed', error instanceof Error ? error.message : String(error))
          } else if (item.state === 'cancelled') {
            recordHistory(
              item,
              'failed_late',
              error instanceof Error ? error.message : String(error),
            )
          }
        },
      )
      .finally(() => {
        const current = queues.get(key)
        if (current?.[0] === item) current.shift()
        if (!current?.length) queues.delete(key)
        else pump(key)
      })
  }

  function enqueue<TResult>(
    key: string,
    task: () => Promise<TResult>,
    options: { id?: string; deadlineAt?: string | null } = {},
  ): Promise<TResult> {
    const id = options.id || crypto.randomUUID()
    return new Promise<TResult>((resolve, reject) => {
      const item: QueueItem<TResult> = {
        id,
        key,
        state: 'queued',
        enqueuedAt: new Date().toISOString(),
        startedAt: null,
        deadlineAt: options.deadlineAt || null,
        finishedAt: null,
        error: null,
        task,
        resolve,
        reject,
        settled: false,
      }
      const queue = queues.get(key) || []
      queue.push(item as QueueItem)
      queues.set(key, queue)
      itemsById.set(id, item as QueueItem)
      pump(key)
    })
  }

  function cancel(id: string): boolean {
    const item = itemsById.get(id)
    if (!item) return false
    if (item.state === 'running') {
      const queue = queues.get(item.key)
      if (queue?.[0] === item) queue.shift()
      if (!queue?.length) queues.delete(item.key)
      settleCancelled(item, 'caller deadline elapsed while running')
      if (queue?.length) pump(item.key)
      return true
    }
    const queue = queues.get(item.key)
    const index = queue?.indexOf(item) ?? -1
    if (index >= 0) queue?.splice(index, 1)
    if (!queue?.length) queues.delete(item.key)
    settleCancelled(item, 'caller deadline elapsed while queued')
    return true
  }

  function reset(key: string): number {
    const queue = queues.get(key) || []
    queues.delete(key)
    for (const item of queue) settleCancelled(item, 'queue reset')
    return queue.length
  }

  function list(): CommandQueueEntry[] {
    const active = Array.from(itemsById.values()).map(
      ({ task: _task, resolve: _resolve, reject: _reject, settled: _settled, ...entry }) => entry,
    )
    return [...active, ...history]
  }

  return { enqueue, cancel, reset, list }
}
