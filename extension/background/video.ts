import { resolveAgentSelector } from '../../src/core/agent-selectors.js'
import type { EvaluateInTabContextOptions, FrameSelector, TabInput, TabWithId } from './types.js'

export const VIDEO_MAX_BYTES = 64 * 1024 * 1024
export const VIDEO_DEFAULT_MAX_DURATION_MS = 10 * 60_000

interface VideoChapter {
  title: string
  description?: string
  durationMs?: number
  at: string
}

interface ActionCalloutOptions {
  durationMs: number
  position: string
  highlightStyle?: string
}

interface ActiveVideo {
  startedAt: string
  maxDurationMs: number
  chapters: VideoChapter[]
  callouts?: ActionCalloutOptions
  timer: ReturnType<typeof setTimeout>
  stopping?: Promise<Record<string, unknown>>
  completed?: Record<string, unknown>
}

interface VideoBrowserApi {
  getMediaStreamId: (tabId: number) => Promise<string>
  ensureOffscreen: () => Promise<void>
  sendMessage: (message: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  addResultListener: (
    listener: (result: { tabId: number; data: string; bytes: number; mimeType: string }) => void,
  ) => void
}

interface VideoDependencies {
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<{ value: TValue | null }>
  browser: VideoBrowserApi
}

function videoError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

export function createVideoDomain({
  getTargetTab,
  evaluateInTabContext,
  browser,
}: VideoDependencies) {
  const activeVideos = new Map<number, ActiveVideo>()
  const resultWaiters = new Map<
    number,
    {
      resolve: (result: { data: string; bytes: number; mimeType: string }) => void
      reject: (error: Error) => void
    }
  >()

  browser.addResultListener((result) => {
    const waiter = resultWaiters.get(result.tabId)
    if (!waiter) return
    resultWaiters.delete(result.tabId)
    waiter.resolve(result)
  })

  async function stopRecording(
    tabId: number,
    active: ActiveVideo,
  ): Promise<Record<string, unknown>> {
    if (active.stopping) return await active.stopping
    active.stopping = (async () => {
      try {
        const resultPromise = new Promise<{ data: string; bytes: number; mimeType: string }>(
          (resolve, reject) => {
            resultWaiters.set(tabId, { resolve, reject })
          },
        )
        const response = await browser.sendMessage({ type: 'autobrowser.video.stop', tabId })
        if (!response.ok)
          throw videoError(response.error || 'Failed to stop recording', 'VIDEO_ERROR')
        const result = await resultPromise
        if (result.bytes > VIDEO_MAX_BYTES)
          throw videoError('Video exceeds the 64MiB limit', 'RESPONSE_TOO_LARGE')
        const completed = {
          recording: false,
          startedAt: active.startedAt,
          stoppedAt: new Date().toISOString(),
          chapters: active.chapters,
          ...result,
        }
        active.completed = completed
        return completed
      } finally {
        clearTimeout(active.timer)
        resultWaiters.delete(tabId)
      }
    })()
    return await active.stopping
  }

  async function start(tabId: TabInput, maxDurationMs = VIDEO_DEFAULT_MAX_DURATION_MS) {
    const tab = await getTargetTab(tabId)
    if (activeVideos.has(tab.id))
      throw videoError('Video recording is already active', 'VIDEO_ACTIVE')
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 3_600_000)
      throw videoError('Video maxDurationMs must be between 1 and 3600000', 'INVALID_COMMAND_ARGS')
    await browser.ensureOffscreen()
    const streamId = await browser.getMediaStreamId(tab.id)
    const response = await browser.sendMessage({
      type: 'autobrowser.video.start',
      tabId: tab.id,
      streamId,
    })
    if (!response.ok) throw videoError(response.error || 'Failed to start recording', 'VIDEO_ERROR')
    const active: ActiveVideo = {
      startedAt: new Date().toISOString(),
      maxDurationMs,
      chapters: [],
      timer: setTimeout(() => {
        const current = activeVideos.get(tab.id)
        if (current) void stopRecording(tab.id, current).catch(() => {})
      }, maxDurationMs),
    }
    activeVideos.set(tab.id, active)
    return { recording: true, startedAt: active.startedAt, maxDurationMs }
  }

  async function status(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    const active = activeVideos.get(tab.id)
    return {
      recording: Boolean(active && !active.completed),
      startedAt: active?.startedAt || null,
      maxDurationMs: active?.maxDurationMs || null,
      chapterCount: active?.chapters.length || 0,
      showActions: Boolean(active?.callouts),
    }
  }

  async function stop(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    const active = activeVideos.get(tab.id)
    if (!active) throw videoError('Video recording has not been started', 'VIDEO_NOT_STARTED')
    const result = await stopRecording(tab.id, active)
    activeVideos.delete(tab.id)
    return result
  }

  async function chapter(
    tabId: TabInput,
    title: string,
    description?: string,
    durationMs?: number,
  ) {
    const tab = await getTargetTab(tabId)
    const active = activeVideos.get(tab.id)
    if (!active) throw videoError('Video recording has not been started', 'VIDEO_NOT_STARTED')
    const chapter: VideoChapter = {
      title,
      ...(description ? { description } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      at: new Date().toISOString(),
    }
    active.chapters.push(chapter)
    return { added: true, chapter }
  }

  async function showActions(tabId: TabInput, options: ActionCalloutOptions) {
    const tab = await getTargetTab(tabId)
    const active = activeVideos.get(tab.id)
    if (!active) throw videoError('Video recording has not been started', 'VIDEO_NOT_STARTED')
    active.callouts = options
    return { showActions: true, ...options }
  }

  async function hideActions(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    const active = activeVideos.get(tab.id)
    if (active) active.callouts = undefined
    await evaluateInTabContext(
      tab.id,
      `document.getElementById('autobrowser-video-callout')?.remove()`,
      { frameSelector: 'top' },
    )
    return { showActions: false }
  }

  return {
    start,
    status,
    stop,
    chapter,
    showActions,
    hideActions,
    async handleAction(
      command: string,
      tabId: number,
      frameSelector: FrameSelector,
      selector: string,
      ok: boolean,
    ): Promise<void> {
      const active = activeVideos.get(tabId)
      const callouts = active?.callouts
      if (!active || !callouts) return
      const resolvedSelector = selector ? resolveAgentSelector(selector) : ''
      await evaluateInTabContext(
        tabId,
        `(() => {
          document.getElementById('autobrowser-video-callout')?.remove();
          const callout = document.createElement('div');
          callout.id = 'autobrowser-video-callout';
          callout.textContent = ${JSON.stringify(`${command}${ok ? '' : ' (failed)'}`)};
          callout.style.cssText = 'position:fixed;z-index:2147483647;padding:6px 10px;background:rgba(0,0,0,.8);color:white;font:12px sans-serif;pointer-events:none;' + ${JSON.stringify(callouts.position)};
          document.documentElement.appendChild(callout);
          setTimeout(() => callout.remove(), ${callouts.durationMs});
          const selector = ${JSON.stringify(resolvedSelector)};
          const style = ${JSON.stringify(callouts.highlightStyle || '')};
          if (selector && style) {
            const node = deepQuerySelector(document, selector);
            if (node) {
              const previous = node.style.outline;
              node.style.outline = style;
              setTimeout(() => { node.style.outline = previous; }, ${callouts.durationMs});
            }
          }
        })()`,
        { frameSelector: frameSelector || undefined },
      )
    },
    handleDetach(tabId: number): void {
      const active = activeVideos.get(tabId)
      if (!active) return
      clearTimeout(active.timer)
      activeVideos.delete(tabId)
      resultWaiters
        .get(tabId)
        ?.reject(videoError('Tab detached during video recording', 'VIDEO_DETACHED'))
      resultWaiters.delete(tabId)
      void browser.sendMessage({ type: 'autobrowser.video.stop', tabId }).catch(() => {})
    },
  }
}
