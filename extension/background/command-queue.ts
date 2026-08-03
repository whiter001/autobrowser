export interface CommandQueue {
  enqueue: <TResult>(key: string, task: () => Promise<TResult>) => Promise<TResult>
}

/**
 * 按 key 隔离的 promise 链队列：同一 key 的任务严格 FIFO 串行，不同 key 互不阻塞。
 * 用于把同一 tab 的 chrome.debugger.sendCommand 串行化，避免多 CLI 并发时
 * 触发 "another command is already in progress"。
 * 单个任务 reject 只会让该任务失败，队尾吞掉错误后下个任务仍能正常启动。
 */
export function createCommandQueue(): CommandQueue {
  const tails = new Map<string, Promise<unknown>>()

  function enqueue<TResult>(key: string, task: () => Promise<TResult>): Promise<TResult> {
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    // 队尾永远记录"已吞错"的完成信号，保证 reject 不污染链条
    tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  return { enqueue }
}
