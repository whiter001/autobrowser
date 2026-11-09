import { describe, expect, test } from 'bun:test'
import { TabRunLock } from '../src/core/tab-run-lock.js'

describe('TabRunLock', () => {
  test('waits for existing commands and blocks new same-tab commands before acquisition', async () => {
    const lock = new TabRunLock()
    const releaseCommand = lock.beginCommand(7)
    let acquired = false
    const acquiring = lock.acquireRun(7, 'run-1', 1000).then((release) => {
      acquired = true
      return release
    })
    await Promise.resolve()
    expect(() => lock.beginCommand(7)).toThrow(/waiting for exclusive access/)
    expect(lock.beginCommand(8)).toEqual(expect.any(Function))

    releaseCommand()
    const releaseRun = await acquiring
    expect(acquired).toBe(true)
    expect(() => lock.beginCommand(7)).toThrow(/running exclusively/)
    expect(() => lock.beginCommand(8)).not.toThrow()

    releaseRun()
    releaseRun()
    const releaseAfterRun = lock.beginCommand(7)
    releaseAfterRun()
  })

  test('rejects a second run and clears a timed-out pending run', async () => {
    const lock = new TabRunLock()
    const releaseCommand = lock.beginCommand(7)
    await expect(lock.acquireRun(7, 'run-1', 5)).rejects.toMatchObject({
      code: 'COMMAND_TIMEOUT',
    })
    releaseCommand()

    const releaseRun = await lock.acquireRun(7, 'run-2', 100)
    await expect(lock.acquireRun(7, 'run-3', 100)).rejects.toMatchObject({
      code: 'PAGE_SCRIPT_ACTIVE',
    })
    releaseRun()
  })
})
