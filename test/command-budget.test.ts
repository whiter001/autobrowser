import { describe, expect, test } from 'bun:test'
import {
  COMMAND_TRANSPORT_ALLOWANCE_MS,
  getCommandRequestBudgetMs,
  MAX_REQUEST_TIMEOUT_MS,
} from '../src/core/command-budget.js'
import { validateCommandArgs } from '../src/core/command-spec.js'

describe('bounded command budgets', () => {
  test('keeps default and short runtime defaults, but honors explicit durations', () => {
    expect(getCommandRequestBudgetMs('snapshot')).toBe(30_000)
    expect(getCommandRequestBudgetMs('snapshot', {}, 25)).toBe(25)
    for (const command of ['eval', 'goto', 'open', 'click', 'reload']) {
      expect(getCommandRequestBudgetMs(command, { timeoutMs: 35_000 })).toBe(40_000)
    }
    expect(getCommandRequestBudgetMs('wait', { timeout: 60_000 })).toBe(65_000)
    expect(getCommandRequestBudgetMs('wait', { ms: 80_000 })).toBe(85_000)
    expect(getCommandRequestBudgetMs('reload', { timeoutMs: 35_000, waitFor: 'url' })).toBe(75_000)
  })

  test('composes nested steps, retries and per-step retry delays', () => {
    const args = {
      retries: 1,
      retryDelayMs: 100,
      steps: [
        'snapshot',
        {
          command: 'batch',
          args: {
            retries: 2,
            retryDelayMs: 50,
            steps: [{ command: 'wait', args: { ms: 40_000 } }],
          },
        },
      ],
    }
    expect(getCommandRequestBudgetMs('batch', args)).toBe(330_400)
  })

  test('accepts exact ceiling including allowance and rejects rather than clamps', () => {
    expect(
      getCommandRequestBudgetMs('eval', {
        timeoutMs: MAX_REQUEST_TIMEOUT_MS - COMMAND_TRANSPORT_ALLOWANCE_MS,
      }),
    ).toBe(MAX_REQUEST_TIMEOUT_MS)
    for (const timeoutMs of [MAX_REQUEST_TIMEOUT_MS, 2 ** 32, Infinity, NaN, -1]) {
      expect(() => validateCommandArgs('eval', { script: '1', timeoutMs })).toThrow()
    }
    expect(() =>
      validateCommandArgs('batch', {
        retries: 100,
        steps: ['snapshot'],
      }),
    ).toThrow('batch request budget')
    expect(() => validateCommandArgs('batch', { steps: [], retries: 1e100 })).toThrow('retries')
    expect(() => validateCommandArgs('batch', { steps: [], retryDelayMs: 2 ** 32 })).toThrow()
    expect(() => validateCommandArgs('wait', { ms: Infinity })).toThrow()
  })

  test('rejects deep, cyclic and oversized batches before recursive shape validation', () => {
    const cyclic: Record<string, unknown> = { steps: [] }
    cyclic.steps = [{ command: 'batch', args: cyclic }]
    expect(() => validateCommandArgs('batch', cyclic)).toThrow('nesting levels')
    let deep: Record<string, unknown> = { steps: [] }
    for (let i = 0; i < 20; i++) deep = { steps: [{ command: 'batch', args: deep }] }
    expect(() => validateCommandArgs('batch', deep)).toThrow('nesting levels')
    expect(() => validateCommandArgs('batch', { steps: Array(10_001).fill('snapshot') })).toThrow(
      'too many',
    )
  })

  test('validates bounded search continuation arguments', () => {
    expect(() =>
      validateCommandArgs('search', { query: 'x', startLine: 2, context: 50 }),
    ).not.toThrow()
    for (const startLine of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateCommandArgs('search', { query: 'x', startLine })).toThrow()
    }
    expect(() => validateCommandArgs('search', { query: 'x', context: 51 })).toThrow('context')
  })
})
