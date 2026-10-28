import { describe, expect, test } from 'bun:test'
import { createVideoDomain } from '../extension/background/video.js'

function createVideoHarness(bytes = 4) {
  const messages: Array<Record<string, unknown>> = []
  const expressions: Array<{ source: string; options: unknown }> = []
  let resultListener:
    | ((result: { tabId: number; data: string; bytes: number; mimeType: string }) => void)
    | undefined
  const domain = createVideoDomain({
    getTargetTab: async () => ({ id: 1 }) as never,
    evaluateInTabContext: async (_tab: unknown, source: string, options: unknown) => {
      expressions.push({ source, options })
      return { value: undefined } as never
    },
    browser: {
      getMediaStreamId: async () => 'stream-id',
      ensureOffscreen: async () => {},
      sendMessage: async (message) => {
        messages.push(message)
        if (message.type === 'autobrowser.video.stop') {
          queueMicrotask(() => {
            resultListener?.({ tabId: 1, data: 'VklERU8=', bytes, mimeType: 'video/webm' })
          })
        }
        return { ok: true }
      },
      addResultListener: (listener) => {
        resultListener = listener
      },
    },
  })
  return { domain, messages, expressions }
}

describe('video recording domain', () => {
  test('records chapters and action callouts through the full lifecycle', async () => {
    const { domain, messages, expressions } = createVideoHarness()
    expect(await domain.start(1)).toMatchObject({ recording: true })
    await expect(domain.start(1)).rejects.toMatchObject({ code: 'VIDEO_ACTIVE' })
    await domain.chapter(1, 'Chapter 1', 'Details', 1000)
    await domain.showActions(1, {
      durationMs: 600,
      position: 'top:1px;right:1px;',
      highlightStyle: '2px solid red',
    })
    await domain.handleAction('click', 1, null, '#submit', true)
    expect(expressions[0]!.source).toContain('autobrowser-video-callout')
    expect(expressions[0]!.source).toContain('2px solid red')
    expect(expressions[0]!.source).toContain('click')
    const result = await domain.stop(1)
    expect(result).toMatchObject({
      recording: false,
      data: 'VklERU8=',
      bytes: 4,
      chapters: [{ title: 'Chapter 1', description: 'Details', durationMs: 1000 }],
    })
    expect(messages.map((message) => message.type)).toEqual([
      'autobrowser.video.start',
      'autobrowser.video.stop',
    ])
    await domain.hideActions(1)
    expect(expressions.at(-1)!.source).toContain('remove()')
  })

  test('rejects stopping an inactive recording and oversized videos', async () => {
    const { domain } = createVideoHarness(64 * 1024 * 1024 + 1)
    await expect(domain.stop(1)).rejects.toMatchObject({ code: 'VIDEO_NOT_STARTED' })
    await domain.start(1)
    await expect(domain.stop(1)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })

  test('cleans up when the tab detaches', async () => {
    const { domain, messages } = createVideoHarness()
    await domain.start(1)
    domain.handleDetach(1)
    expect(await domain.status(1)).toMatchObject({ recording: false })
    expect(messages.at(-1)).toMatchObject({ type: 'autobrowser.video.stop' })
  })

  test('stops automatically at maxDurationMs and preserves the result', async () => {
    const { domain } = createVideoHarness()
    await domain.start(1, 1)
    await Bun.sleep(15)
    expect(await domain.status(1)).toMatchObject({ recording: false })
    expect(await domain.stop(1)).toMatchObject({ recording: false, data: 'VklERU8=' })
  })
})
