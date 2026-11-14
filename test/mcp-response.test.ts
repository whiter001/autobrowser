import { describe, expect, test } from 'bun:test'
import { parseMcpResponseMode, toErrorResult, toSuccessResult } from '../src/cli/mcp-response.js'

describe('parseMcpResponseMode', () => {
  test('defaults to text and accepts the three modes', () => {
    expect(parseMcpResponseMode(undefined)).toBe('text')
    expect(parseMcpResponseMode('')).toBe('text')
    expect(parseMcpResponseMode('text')).toBe('text')
    expect(parseMcpResponseMode('structured')).toBe('structured')
    expect(parseMcpResponseMode('both')).toBe('both')
    expect(parseMcpResponseMode(' BOTH ')).toBe('both')
  })

  test('rejects unknown modes with a clear error', () => {
    expect(() => parseMcpResponseMode('json')).toThrow(
      'Invalid AUTOBROWSER_MCP_RESPONSE_MODE "json": expected "text", "structured" or "both".',
    )
  })
})

describe('toSuccessResult response modes', () => {
  test('defaults to text and omits structuredContent', () => {
    const result = toSuccessResult({ clicked: true })

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: '{"clicked":true}' }])
  })

  test('structured writes only structuredContent and leaves content empty', () => {
    const result = toSuccessResult(
      { clicked: true },
      {
        responseMode: 'structured',
      },
    )

    expect(result.content).toEqual([])
    expect(result.structuredContent).toEqual({ clicked: true })
  })

  test('both keeps the legacy content and structuredContent pair', () => {
    const result = toSuccessResult({ clicked: true }, { responseMode: 'both' })

    expect(result.content).toEqual([{ type: 'text', text: '{"clicked":true}' }])
    expect(result.structuredContent).toEqual({ clicked: true })
  })

  test('structured falls back to text for arrays and primitives', () => {
    const array = toSuccessResult([1, 2], { responseMode: 'structured' })
    expect(array.structuredContent).toBeUndefined()
    expect(array.content).toEqual([{ type: 'text', text: '[1,2]' }])

    const primitive = toSuccessResult(42, { responseMode: 'structured' })
    expect(primitive.structuredContent).toBeUndefined()
    expect(primitive.content).toEqual([{ type: 'text', text: '42' }])
  })

  test('honours detailed formatting in text mode', () => {
    const result = toSuccessResult({ a: 1 }, { responseFormat: 'detailed' })

    expect(result.content).toEqual([{ type: 'text', text: '{\n  "a": 1\n}' }])
    expect(result.structuredContent).toBeUndefined()
  })
})

describe('toErrorResult response modes', () => {
  const error = {
    suggestion: 'Run snapshot to refresh element refs before retrying.',
  }

  test('defaults to text and omits structuredContent', () => {
    const result = toErrorResult('STALE_ELEMENT_REF', 'element ref @e7 is stale', error)

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect((result.content[0] as { text: string }).text).toContain('[AI SUGGESTION]: Run snapshot')
  })

  test('structured writes an empty content array plus the structured error', () => {
    const result = toErrorResult('STALE_ELEMENT_REF', 'element ref @e7 is stale', error, {
      responseMode: 'structured',
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([])
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'STALE_ELEMENT_REF',
        message: 'element ref @e7 is stale',
        suggestion: error.suggestion,
      },
    })
  })

  test('both keeps the legacy content and structuredContent pair', () => {
    const result = toErrorResult('STALE_ELEMENT_REF', 'element ref @e7 is stale', error, {
      responseMode: 'both',
    })

    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'STALE_ELEMENT_REF' },
    })
  })
})
