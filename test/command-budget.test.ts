import { describe, expect, test } from 'bun:test'
import {
  COMMAND_TRANSPORT_ALLOWANCE_MS,
  FEED_EXECUTION_ALLOWANCE_MS,
  FEED_MAX_SCROLLS,
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

    // 超限时错误信息应带每步预算明细，便于定位是拆 batch 还是减小某步 timeoutMs。
    const manySteps = [
      ...Array.from({ length: 60 }, () => ({ command: 'eval', args: { script: '1+1' } })),
      { command: 'eval', args: { script: 'x', timeoutMs: 260_000 } },
    ]
    let detail = ''
    try {
      getCommandRequestBudgetMs('batch', { steps: manySteps })
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    expect(detail).toContain('batch request budget must not exceed')
    expect(detail).toContain('61 steps')
    expect(detail).toContain('eval=265000ms')
    expect(detail).toContain('eval=30000ms')
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

  test('budgets feed scrolling like the extension collectFeed defaults', () => {
    // 与 extension collectFeed 对齐：maxScrolls 默认 20、pauseMs 默认 900，滚动预算之外再留执行与传输余量
    expect(getCommandRequestBudgetMs('feed')).toBe(
      20 * 900 + FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS,
    )
    expect(getCommandRequestBudgetMs('feed', {})).toBe(
      20 * 900 + FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS,
    )
    expect(
      getCommandRequestBudgetMs('feed', { maxScrolls: 40, pauseMs: 1_000, stallRounds: 2 }),
    ).toBe(40 * 1_000 + FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS)
    // 扩展把滚动轮数收敛到 FEED_MAX_SCROLLS，超出部分不会真的滚，预算按有效值算
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: 500, pauseMs: 1_000 })).toBe(
      FEED_MAX_SCROLLS * 1_000 + FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS,
    )

    expect(() => validateCommandArgs('feed', { maxScrolls: 40, pauseMs: 100_000 })).toThrow()
    expect(() => validateCommandArgs('feed', { maxScrolls: -1 })).toThrow()
  })

  test('matches collectFeed normalization for zero and fractional feed counts', () => {
    const idleBudget = FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS
    // 0 轮/0 停顿都是合法输入，预算退化为页内解析余量
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: 0 })).toBe(idleBudget)
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: 0, pauseMs: 0 })).toBe(idleBudget)
    expect(getCommandRequestBudgetMs('feed', { pauseMs: 0 })).toBe(idleBudget)
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: 0, pauseMs: 0, stallRounds: 0 })).toBe(
      idleBudget,
    )
    // 归一化与 collectFeed 一致：向下取整
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: 3.9, pauseMs: 1_000 })).toBe(
      3 * 1_000 + FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS,
    )
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: 2, pauseMs: 900.7 })).toBe(
      2 * 900 + FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS,
    )
  })

  test('caps feed counts before bounding time and does not treat stall rounds as milliseconds', () => {
    const idleBudget = FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS
    const large = MAX_REQUEST_TIMEOUT_MS + 1
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: large, pauseMs: 0 })).toBe(idleBudget)
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: Number.MAX_VALUE, pauseMs: 1 })).toBe(
      idleBudget + FEED_MAX_SCROLLS,
    )
    expect(getCommandRequestBudgetMs('feed', { stallRounds: Number.MAX_VALUE })).toBe(
      getCommandRequestBudgetMs('feed'),
    )
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: 0, pauseMs: large })).toBe(idleBudget)
    expect(() =>
      validateCommandArgs('feed', { maxScrolls: large, pauseMs: 0, stallRounds: large }),
    ).not.toThrow()
    const pauseMs = (MAX_REQUEST_TIMEOUT_MS - idleBudget) / FEED_MAX_SCROLLS
    expect(getCommandRequestBudgetMs('feed', { maxScrolls: large, pauseMs })).toBe(
      MAX_REQUEST_TIMEOUT_MS,
    )
    expect(() =>
      getCommandRequestBudgetMs('feed', { maxScrolls: large, pauseMs: pauseMs + 1 }),
    ).toThrow('request budget')
    for (const key of ['maxScrolls', 'pauseMs', 'stallRounds']) {
      for (const value of [-1, Infinity, NaN, '2']) {
        expect(() => getCommandRequestBudgetMs('feed', { [key]: value })).toThrow(key)
      }
    }
  })

  test('gives nested feed steps the same budget inside a batch', () => {
    const feedBudget = 20 * 900 + FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS
    expect(
      getCommandRequestBudgetMs('batch', {
        steps: [{ command: 'feed', args: { maxScrolls: 5, pauseMs: 1_000 } }],
      }),
    ).toBe(5 * 1_000 + FEED_EXECUTION_ALLOWANCE_MS + COMMAND_TRANSPORT_ALLOWANCE_MS)
    expect(
      getCommandRequestBudgetMs('batch', {
        steps: [{ command: 'batch', args: { steps: ['feed', { command: 'feed', args: {} }] } }],
      }),
    ).toBe(2 * feedBudget)
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
