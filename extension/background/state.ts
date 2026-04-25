import type { ExtensionState } from './types.js'

export function createExtensionState(defaultRelayPort: number): ExtensionState {
  return {
    socket: null,
    reconnectTimer: null,
    connecting: false,
    suppressCloseError: false,
    attachedTabs: new Set<number>(),
    selectedFrames: new Map<number, string>(),
    targetTabId: null,
    tabHandles: new Map<number, string>(),
    tabIdsByHandle: new Map<string, number>(),
    pageEpochs: new Map<number, number>(),
    nextTabHandleIndex: 1,
    dialog: null,
    network: {
      routes: [],
      requests: [],
      requestMap: new Map(),
      harRecording: false,
      harStartedAt: null,
    },
    shouldReconnect: true,
    token: '',
    relayPort: defaultRelayPort,
    consoleMessages: [],
    pageErrors: [],
    connectionStatus: 'idle',
    connectionError: null,
    lastSocketClose: null,
    lastCommandError: null,
  }
}
