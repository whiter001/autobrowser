import {
  createCancellationError,
  createOperationContext,
  type OperationContext,
} from './operation-context.js'

export type CommandExecutionContext = OperationContext

interface CommandQueueEntry {
  id: string
  key: string
  /** 命令名（不含参数），便于多 AI 场景判断历史条目来源；旧持久化记录可能缺失 */
  command?: string
  /** 发起命令的 workspace；无 workspace 或旧记录为 null/缺失 */
  workspace?: string | null
  state:
    | 'queued'
    | 'running'
    | 'cancelled'
    | 'completed'
    | 'failed'
    | 'completed_late'
    | 'failed_late'
    | 'interrupted'
  enqueuedAt: string
  startedAt: string | null
  deadlineAt: string | null
  finishedAt: string | null
  error: string | null
  /** 仅迟到完成时保留结果，避免正常历史额外持有大快照 */
  result?: unknown
}

export interface CommandQueue {
  enqueue: <TResult>(
    key: string,
    task: (context: CommandExecutionContext) => Promise<TResult>,
    options?: {
      id?: string
      deadlineAt?: string | null
      command?: string
      workspace?: string | null
    },
  ) => Promise<TResult>
  cancel: (id: string) => boolean
  reset: (key: string) => number
  list: () => CommandQueueEntry[]
  ready: () => Promise<void>
}

export interface CommandQueueStorage {
  get: (keys: string[]) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
}

interface CommandQueueOptions {
  storage?: CommandQueueStorage
  storageKey?: string
}

interface QueueItem<TResult = unknown> extends CommandQueueEntry {
  task: (context: CommandExecutionContext) => Promise<TResult>
  resolve: (value: TResult) => void
  reject: (reason: Error) => void
  settled: boolean
  operation?: ReturnType<typeof createOperationContext>
}

/**
 * 同一 tab 的页面命令保持 FIFO。任务有显式 id，relay 超时后可取消排队项；
 * 运行项通过 AbortSignal 通知具体恢复动作，并与队列脱钩，避免后续控制命令无限堆积。
 */
export function createCommandQueue(options: CommandQueueOptions = {}): CommandQueue {
  const queues = new Map<string, QueueItem[]>()
  const itemsById = new Map<string, QueueItem>()
  const history: CommandQueueEntry[] = []
  const storageKey = options.storageKey || 'autobrowser.command-history.v1'
  let persistChain: Promise<void> = Promise.resolve()

  function persist(): void {
    if (!options.storage) return
    const commands = list()
    persistChain = persistChain
      .then(async () => await options.storage!.set({ [storageKey]: { commands } }))
      .catch(() => {})
  }

  // storage.local 能跨 MV3 worker 重启保留状态；恢复时尚未结束的 Promise 已随旧 worker 消失，
  // 必须明确标为 interrupted，不能让 command status 返回空记录或永远 running。
  const restoration = options.storage
    ? options.storage
        .get([storageKey])
        .then((stored) => {
          const value = stored[storageKey] as { commands?: unknown } | undefined
          if (!Array.isArray(value?.commands)) return
          for (const candidate of value.commands) {
            if (!candidate || typeof candidate !== 'object') continue
            const entry = candidate as CommandQueueEntry
            if (typeof entry.id !== 'string' || typeof entry.key !== 'string') continue
            const interrupted = entry.state === 'queued' || entry.state === 'running'
            history.push({
              ...entry,
              state: interrupted ? 'interrupted' : entry.state,
              ...(interrupted
                ? {
                    finishedAt: entry.finishedAt || new Date().toISOString(),
                    error: 'extension restarted before the command result was delivered',
                  }
                : {}),
            })
          }
          if (history.length > 100) history.splice(0, history.length - 100)
        })
        .catch(() => {})
    : Promise.resolve()

  function recordHistory(
    item: QueueItem,
    state: CommandQueueEntry['state'],
    error: string | null = null,
    result?: unknown,
  ): void {
    const entry: CommandQueueEntry = {
      id: item.id,
      key: item.key,
      ...(item.command !== undefined ? { command: item.command } : {}),
      workspace: item.workspace ?? null,
      state,
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt,
      deadlineAt: item.deadlineAt,
      finishedAt: new Date().toISOString(),
      error,
      ...(state === 'completed_late' ? { result } : {}),
    }
    const existing = history.findIndex((candidate) => candidate.id === item.id)
    if (existing >= 0) history[existing] = entry
    else history.push(entry)
    if (history.length > 100) history.splice(0, history.length - 100)
    persist()
  }

  function settleCancelled(item: QueueItem, reason: string): void {
    if (item.settled) return
    item.settled = true
    item.state = 'cancelled'
    item.operation?.cancel(reason)
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
    const operation = createOperationContext(item.id, item.deadlineAt)
    item.operation = operation
    const context: OperationContext = operation.context
    // 同步异常也必须走队列清理路径；取消后即使底层任务迟到，后续步骤也能读到同一状态。
    const execute = async () => {
      context.throwIfCancelled()
      return await item.task(context)
    }
    void execute()
      .then(
        (result) => {
          if (!item.settled) {
            item.settled = true
            itemsById.delete(item.id)
            item.resolve(result)
            recordHistory(item, 'completed')
          } else if (item.state === 'cancelled') {
            recordHistory(item, 'completed_late', null, result)
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
        operation.dispose()
        const current = queues.get(key)
        if (current?.[0] === item) current.shift()
        if (!current?.length) queues.delete(key)
        else pump(key)
      })
  }

  function enqueue<TResult>(
    key: string,
    task: (context: CommandExecutionContext) => Promise<TResult>,
    requestOptions: {
      id?: string
      deadlineAt?: string | null
      command?: string
      workspace?: string | null
    } = {},
  ): Promise<TResult> {
    const id = requestOptions.id || crypto.randomUUID()
    return new Promise<TResult>((resolve, reject) => {
      const enqueueRestored = () => {
        const item: QueueItem<TResult> = {
          id,
          key,
          ...(requestOptions.command !== undefined ? { command: requestOptions.command } : {}),
          workspace: requestOptions.workspace ?? null,
          state: 'queued',
          enqueuedAt: new Date().toISOString(),
          startedAt: null,
          deadlineAt: requestOptions.deadlineAt || null,
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
        persist()
        pump(key)
      }
      if (options.storage) void restoration.then(enqueueRestored)
      else enqueueRestored()
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
      ({
        task: _task,
        resolve: _resolve,
        reject: _reject,
        settled: _settled,
        operation: _operation,
        ...entry
      }) => entry,
    )
    return [...active, ...history]
  }

  return {
    enqueue,
    cancel,
    reset,
    list,
    ready: async () => await restoration,
  }
}
