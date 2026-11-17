import {
  createCancellationError,
  createOperationContext,
  type OperationContext,
} from './operation-context.js'

export type CommandExecutionContext = OperationContext

/** 历史元数据上限：多 AI 共用一个扩展时，500 条以内都必须能按 id 查状态 */
const HISTORY_LIMIT = 500
/** 迟到结果通常是大快照，只保留最新若干份，旧条目仍保留状态与时间戳 */
const LATE_RESULT_LIMIT = 25
/** 淘汰 id 只用于区分“明确淘汰”和“未知 id”，有界保留避免存储无限增长 */
const EVICTED_ID_LIMIT = 1000

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
  /** relay 侧生成请求的时间，用于拆解 relay→扩展的时间差；旧记录缺失 */
  requestedAt?: string
  /** 扩展收到命令的时间；与 requestedAt/enqueuedAt/startedAt 组合才能拆出接收前、入队前和同 tab 等待；旧记录缺失 */
  receivedAt?: string
  enqueuedAt: string
  startedAt: string | null
  deadlineAt: string | null
  finishedAt: string | null
  error: string | null
  /** 仅迟到完成时保留结果，避免正常历史额外持有大快照 */
  result?: unknown
  /** 迟到结果因超出保留上限被裁掉；条目本身仍可查询 */
  resultEvicted?: boolean
}

export interface CommandQueueDiagnostics {
  historyLimit: number
  lateResultLimit: number
  /** 本次扩展启动时从存储恢复的条目数（已按当前上限裁剪） */
  restoredCount: number
  /** 累计被上限淘汰的条目数，包含恢复时裁剪的部分 */
  evictedCount: number
  lastPersistError: string | null
  lastPersistedAt: string | null
  /** 本次启动读取历史失败时的错误信息；非空说明历史为空可能源于恢复失败，而不是没有历史 */
  lastRestoreError: string | null
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
      requestedAt?: string | null
      receivedAt?: string | null
    },
  ) => Promise<TResult>
  cancel: (id: string) => boolean
  reset: (key: string) => number
  list: () => CommandQueueEntry[]
  diagnostics: () => CommandQueueDiagnostics
  wasEvicted: (id: string) => boolean
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

interface PersistedCommandHistory {
  commands?: unknown
  /** 旧版本存储没有这两个字段；缺失时按空清单处理 */
  evictedIds?: unknown
  evictedCount?: unknown
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
  const evictedIds: string[] = []
  const storageKey = options.storageKey || 'autobrowser.command-history.v1'
  const storage = options.storage
  let persistChain: Promise<void> = Promise.resolve()
  let restoredCount = 0
  let evictedCount = 0
  let lastPersistError: string | null = null
  let lastPersistedAt: string | null = null
  let lastRestoreError: string | null = null

  function recordEviction(id: string): void {
    evictedCount += 1
    const existing = evictedIds.indexOf(id)
    if (existing >= 0) evictedIds.splice(existing, 1)
    evictedIds.push(id)
    if (evictedIds.length > EVICTED_ID_LIMIT) {
      evictedIds.splice(0, evictedIds.length - EVICTED_ID_LIMIT)
    }
  }

  /** 恢复新记录与恢复旧存储共用同一套裁剪，保证上限只有一处定义 */
  function trimHistory(): void {
    while (history.length > HISTORY_LIMIT) {
      const oldest = history.shift()
      if (oldest) recordEviction(oldest.id)
    }
    const withResult = history.filter((entry) => entry.result !== undefined)
    for (let index = 0; index < withResult.length - LATE_RESULT_LIMIT; index += 1) {
      const entry = withResult[index]!
      delete entry.result
      entry.resultEvicted = true
    }
  }

  function diagnostics(): CommandQueueDiagnostics {
    return {
      historyLimit: HISTORY_LIMIT,
      lateResultLimit: LATE_RESULT_LIMIT,
      restoredCount,
      evictedCount,
      lastPersistError,
      lastPersistedAt,
      lastRestoreError,
    }
  }

  function wasEvicted(id: string): boolean {
    return evictedIds.includes(id)
  }

  function persist(): void {
    if (!storage) return
    persistChain = persistChain.then(async () => {
      try {
        await storage.set({
          [storageKey]: { commands: list(), evictedIds: [...evictedIds], evictedCount },
        })
        lastPersistError = null
        lastPersistedAt = new Date().toISOString()
      } catch (error) {
        // 存储失败只进入诊断，已完成的命令和后续命令都不能因此失败
        lastPersistError = error instanceof Error ? error.message : String(error)
      }
    })
  }

  // storage.local 能跨 MV3 worker 重启保留状态；恢复时尚未结束的 Promise 已随旧 worker 消失，
  // 必须明确标为 interrupted，不能让 command status 返回空记录或永远 running。
  const restoration = storage
    ? Promise.resolve()
        // storage.get 既可能返回 rejected promise，也可能同步抛错，都要落到诊断而不是中断队列
        .then(async () => await storage.get([storageKey]))
        .then((stored) => {
          lastRestoreError = null
          const value = stored[storageKey] as PersistedCommandHistory | undefined
          if (!Array.isArray(value?.commands)) return
          if (Array.isArray(value.evictedIds)) {
            for (const id of value.evictedIds) {
              if (typeof id === 'string') evictedIds.push(id)
            }
            if (evictedIds.length > EVICTED_ID_LIMIT) {
              evictedIds.splice(0, evictedIds.length - EVICTED_ID_LIMIT)
            }
          }
          // 旧版本没有累计计数：先以可查到的淘汰 id 数量兜底
          const storedCount = value.evictedCount
          evictedCount =
            typeof storedCount === 'number' && Number.isFinite(storedCount) && storedCount >= 0
              ? Math.max(storedCount, evictedIds.length)
              : evictedIds.length
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
          // 旧版本按 100 条裁剪过；这里统一按当前上限补齐，并将被裁的 id 计入淘汰清单
          trimHistory()
          restoredCount = history.length
        })
        // 恢复失败只进诊断，不能让整个队列不可用：后续 enqueue 仍要能执行
        .catch((error: unknown) => {
          lastRestoreError = error instanceof Error ? error.message : String(error)
        })
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
      ...(item.requestedAt !== undefined ? { requestedAt: item.requestedAt } : {}),
      ...(item.receivedAt !== undefined ? { receivedAt: item.receivedAt } : {}),
      state,
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt,
      deadlineAt: item.deadlineAt,
      finishedAt: new Date().toISOString(),
      error,
      ...(state === 'completed_late' && result !== undefined ? { result } : {}),
    }
    const existing = history.findIndex((candidate) => candidate.id === item.id)
    if (existing >= 0) history[existing] = entry
    else history.push(entry)
    trimHistory()
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
      requestedAt?: string | null
      receivedAt?: string | null
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
          ...(requestOptions.requestedAt != null
            ? { requestedAt: requestOptions.requestedAt }
            : {}),
          ...(requestOptions.receivedAt != null ? { receivedAt: requestOptions.receivedAt } : {}),
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
      if (storage) void restoration.then(enqueueRestored)
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
    diagnostics,
    wasEvicted,
    ready: async () => await restoration,
  }
}
