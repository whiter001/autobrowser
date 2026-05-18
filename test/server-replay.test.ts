import { describe, expect, test } from 'bun:test'
import { getRecordedCommandFromStatus } from '../src/cli/commands/server.js'

describe('server replay helpers', () => {
  test('reads the last recorded command from server status', () => {
    expect(
      getRecordedCommandFromStatus({
        snapshot: {
          lastCommand: {
            command: 'network',
            args: {
              action: 'requests',
              filter: 'api',
            },
          },
        },
      }),
    ).toEqual({
      command: 'network',
      args: {
        action: 'requests',
        filter: 'api',
      },
    })
  })

  test('returns null when no last command is present', () => {
    expect(getRecordedCommandFromStatus({ snapshot: {} })).toBeNull()
  })
})
