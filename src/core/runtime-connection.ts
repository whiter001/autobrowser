import type { ErrorWithCode, ExtensionMetadata, RuntimeState, Snapshot } from './runtime-types.js'

/**
 * 扩展连接的生命周期管理：连接接管、心跳超时检测与连接等待队列。
 *
 * 连接模块只维护"当前连接是谁"，不关心命令分发与传输状态；
 * 连接丢失时通过 onConnectionLost 通知运行时清理 pending 请求与传输登记，
 * 连接状态变化时通过 onConnectionChanged 触发持久化。
 */

/** 连接丢失的原因：被新连接顶替，或扩展主动断开 */
export type ExtensionConnectionLostReason = 'replaced' | 'disconnected'

export interface ExtensionConnectionOptions {
  /** 运行时状态对象，连接模块直接维护 extensionSocket / extensionId */
  runtime: RuntimeState
  /** 共享快照对象，连接模块直接维护 snapshot.extension */
  snapshot: Snapshot
  /** 心跳超时时长；<=0 表示不启用超时检测 */
  heartbeatTimeoutMs: number
  /** 连接断开或被替换时清理传输状态并拒绝 pending 命令 */
  onConnectionLost: (reason: ExtensionConnectionLostReason) => void
  /** 连接状态变化后需要持久化快照 */
  onConnectionChanged: () => void
}

export interface ExtensionConnection {
  /** 关联一个新的扩展连接，并接管旧连接 */
  attach: (socket: Bun.ServerWebSocket<ExtensionMetadata>, meta?: ExtensionMetadata) => void
  /** 断开扩展连接；传入 socket 时仅当它是当前连接才断开（防重连竞态） */
  detach: (socket?: Bun.ServerWebSocket<ExtensionMetadata>) => void
  /** 等待扩展连接；已连接时立即返回当前连接 */
  waitForConnection: (timeoutMs: number) => Promise<Bun.ServerWebSocket<ExtensionMetadata>>
  /** 处理心跳消息：刷新心跳时间、重置超时计时并回执 */
  handleHeartbeat: (sentAt: unknown) => void
  /** 当前扩展连接，没有连接时为 null */
  getSocket: () => Bun.ServerWebSocket<ExtensionMetadata> | null
}

interface ConnectionWaiter {
  resolve: (socket: Bun.ServerWebSocket<ExtensionMetadata>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 扩展未连接（或连接已断开）时使用的错误 */
export function createExtensionDisconnectedError(
  message: string = 'no extension is connected',
): Error {
  const error = new Error(message) as ErrorWithCode
  error.code = 'EXTENSION_DISCONNECTED'
  return error
}

export function createExtensionConnection(
  options: ExtensionConnectionOptions,
): ExtensionConnection {
  const { runtime, snapshot, heartbeatTimeoutMs } = options
  const connectionWaiters = new Set<ConnectionWaiter>()
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

  function getSocket(): Bun.ServerWebSocket<ExtensionMetadata> | null {
    return runtime.extensionSocket
  }

  function resolveConnectionWaiters(socket: Bun.ServerWebSocket<ExtensionMetadata>): void {
    for (const waiter of connectionWaiters) {
      connectionWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(socket)
    }
  }

  function clearHeartbeatTimeout(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function scheduleHeartbeatTimeout(socket: Bun.ServerWebSocket<ExtensionMetadata>): void {
    clearHeartbeatTimeout()
    if (!(heartbeatTimeoutMs > 0)) {
      return
    }

    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null
      // 重连竞态：定时器触发时可能已经换了连接，只对当前 socket 生效
      if (runtime.extensionSocket !== socket) {
        return
      }

      // 主动关掉半开连接；close 事件会走 detach 身份校验（对当前 socket 生效）。
      // 直接 detach 兜底，避免部分环境 close 事件不可达时扩展仍被误认为在线。
      try {
        if (typeof socket.close === 'function') {
          socket.close()
        }
      } catch {
        // 连接可能已断开，忽略关闭失败
      }
      detach(socket)
    }, heartbeatTimeoutMs)
  }

  function attach(
    socket: Bun.ServerWebSocket<ExtensionMetadata>,
    meta: ExtensionMetadata = {},
  ): void {
    const previousSocket = runtime.extensionSocket
    if (previousSocket && previousSocket !== socket) {
      options.onConnectionLost('replaced')
      // 扩展重连时旧 socket 还挂在运行时上：先通知旧连接被新实例顶替，再主动关闭，
      // 否则旧侧会把断开误判成网络故障；detach 会做身份校验，不会误伤新连接
      try {
        const displacedPayload = JSON.stringify({
          type: 'displaced',
          reason: 'A new extension instance connected and took over this connection.',
        })
        if (typeof previousSocket.send === 'function') {
          previousSocket.send(displacedPayload)
        }
      } catch {
        // 旧连接可能已断开，忽略发送失败
      }
      try {
        previousSocket.close()
      } catch {
        // 旧连接可能已断开，忽略关闭失败
      }
    }

    runtime.extensionSocket = socket
    runtime.extensionId = typeof meta.extensionId === 'string' ? meta.extensionId : null
    snapshot.extension = {
      extensionId: runtime.extensionId,
      connectedAt: new Date().toISOString(),
      userAgent: (meta.userAgent as string) || null,
      lastHeartbeatAt: null,
    }
    resolveConnectionWaiters(socket)
    scheduleHeartbeatTimeout(socket)
    options.onConnectionChanged()
  }

  function detach(socket?: Bun.ServerWebSocket<ExtensionMetadata>): void {
    if (socket && runtime.extensionSocket !== socket) {
      // 重连竞态：旧 socket 的 close 事件晚于新连接 attach 到达，不能把新连接踢掉
      return
    }

    runtime.extensionSocket = null
    runtime.extensionId = null
    snapshot.extension = null
    clearHeartbeatTimeout()
    options.onConnectionLost('disconnected')
    // 断开时立即唤醒等待连接的 waiter，否则它们只能干等超时
    // reject 内的 settle 会把 waiter 从 Set 删除，Set 迭代期间删除当前元素是安全的
    for (const waiter of connectionWaiters) {
      waiter.reject(
        createExtensionDisconnectedError('extension disconnected while waiting for connection'),
      )
    }
    options.onConnectionChanged()
  }

  function waitForConnection(timeoutMs: number): Promise<Bun.ServerWebSocket<ExtensionMetadata>> {
    if (runtime.extensionSocket && runtime.extensionSocket.readyState === WebSocket.OPEN) {
      return Promise.resolve(runtime.extensionSocket)
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(createExtensionDisconnectedError())
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let waiter: ConnectionWaiter

      const settle = (callback: () => void): void => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(waiter.timer)
        connectionWaiters.delete(waiter)
        callback()
      }

      const timer = setTimeout(() => {
        settle(() => reject(createExtensionDisconnectedError()))
      }, timeoutMs)

      waiter = {
        timer,
        resolve(socket) {
          settle(() => resolve(socket))
        },
        reject(error) {
          settle(() => reject(error))
        },
      }

      connectionWaiters.add(waiter)
    })
  }

  function handleHeartbeat(sentAt: unknown): void {
    // 心跳每 30s 一次，lastHeartbeatAt 是运行时状态无需持久化；只更新内存，避免每次都全量落盘
    if (snapshot.extension) {
      snapshot.extension.lastHeartbeatAt = new Date().toISOString()
    }

    // 收到心跳说明连接仍健康，重置超时计时
    if (runtime.extensionSocket) {
      scheduleHeartbeatTimeout(runtime.extensionSocket)
    }

    if (runtime.extensionSocket && runtime.extensionSocket.readyState === WebSocket.OPEN) {
      runtime.extensionSocket.send(
        JSON.stringify({
          type: 'heartbeat',
          sentAt: typeof sentAt === 'string' ? sentAt : null,
          receivedAt: new Date().toISOString(),
        }),
      )
    }
  }

  return {
    attach,
    detach,
    waitForConnection,
    handleHeartbeat,
    getSocket,
  }
}
