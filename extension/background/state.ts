import type { DialogState, EmulationOverrides, ExtensionState } from './types.js'

export function createExtensionState(defaultRelayPort: number): ExtensionState {
  return {
    connection: {
      socket: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      heartbeatTimer: null,
      heartbeatTimeoutTimer: null,
      connecting: false,
      suppressCloseError: false,
      shouldReconnect: true,
      token: '',
      relayPort: defaultRelayPort,
      status: 'idle',
      error: null,
      lastSocketClose: null,
      lastCommandError: null,
      lastHeartbeatAt: null,
      lastHeartbeatSentAt: null,
    },
    targeting: {
      attachedTabs: new Set<number>(),
      selectedFrames: new Map<number, string>(),
      targetTabId: null,
      tabHandles: new Map<number, string>(),
      tabIdsByHandle: new Map<string, number>(),
      pageEpochs: new Map<number, number>(),
      nextTabHandleIndex: 1,
    },
    session: {
      dialogs: new Map<number, DialogState>(),
      lastDialog: null,
      consoleMessages: [],
      pageErrors: [],
      emulation: new Map<number, EmulationOverrides>(),
      // 默认自动 accept alert/beforeunload，保持历史行为兼容；仅运行期内存状态
      dialogAutoAccept: true,
      downloads: [],
    },
    network: {
      routes: [],
      requests: [],
      requestMap: new Map(),
      requestIndex: new Map(),
      pendingBodyFetches: new Set(),
      harRecording: false,
      harStartedAt: null,
      harMaxRequests: 1000,
      harMaxBodyBytes: 256 * 1024,
    },
    initScripts: [],
  }
}
