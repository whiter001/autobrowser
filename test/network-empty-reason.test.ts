import { describe, expect, test } from 'bun:test'
import { createNetworkDomain } from '../extension/background/network.js'
import { upsertNetworkRequest } from '../extension/background/network-records.js'
import { createExtensionState } from '../extension/background/state.js'

function createHarness() {
  const state = createExtensionState(57978)
  const send = async <TResult = unknown>(): Promise<TResult> => ({}) as TResult
  const network = createNetworkDomain({
    state,
    getTargetTab: async () => ({ id: 1 }) as never,
    sendRawDebuggerCommand: send,
    sendDebuggerCommand: send,
  })
  return { state, network }
}

describe('network request empty diagnostics', () => {
  test('distinguishes an unattached tab from an attached tab with no data', () => {
    const { state, network } = createHarness()

    expect(network.listRequests({ tabId: 1, pageEpoch: 1 })).toMatchObject({
      emptyReason: 'NOT_ATTACHED',
      meta: { suggestedAction: expect.stringContaining('cannot be recovered') },
    })

    state.targeting.attachedTabs.add(1)
    expect(network.listRequests({ tabId: 1, pageEpoch: 1 })).toMatchObject({
      emptyReason: 'NO_DATA',
    })
  })

  test('identifies records hidden only by the current page epoch', () => {
    const { state, network } = createHarness()
    state.targeting.attachedTabs.add(1)
    upsertNetworkRequest(state, {
      id: '1:request-one',
      requestId: 'request-one',
      tabId: 1,
      pageEpoch: 1,
      url: 'https://example.com/api',
    })

    expect(network.listRequests({ tabId: 1, pageEpoch: 2 })).toMatchObject({
      emptyReason: 'EPOCH_FILTERED',
      meta: { suggestedAction: expect.stringContaining('--all-epochs') },
    })
    expect(network.listRequests({ tabId: 1, pageEpoch: 1 })).toMatchObject({
      empty: false,
      total: 1,
    })
  })
})
