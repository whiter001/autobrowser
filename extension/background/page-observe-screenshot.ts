import { createElementNotFoundError } from './page-input-helpers.js'
import type { PageObserveDependencies } from './page-observe-context.js'
import { PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE } from './page-observe-helpers.js'
import { resolveEffectiveFrameSelector, withFrameSelectorOptions } from './targeting.js'
import type { FrameSelector, ScreenshotCaptureOptions, TabInput } from './types.js'

const SCREENSHOT_ANNOTATION_OVERLAY_ID = 'autobrowser-screenshot-annotations'
const SCREENSHOT_ANNOTATION_MAX_ELEMENTS = 200

interface ScreenshotAnnotationResult {
  count?: number
}

export function createScreenshotFeature({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  evaluateInTabContext,
  sendDebuggerCommand,
}: PageObserveDependencies) {
  async function clearScreenshotAnnotations(tabId: TabInput, frameSelector: FrameSelector) {
    await evaluateInTabContext(
      tabId,
      `(() => {
        const overlay = document.getElementById(${JSON.stringify(SCREENSHOT_ANNOTATION_OVERLAY_ID)})
        if (overlay) {
          overlay.remove()
        }

        const body = document.body
        if (!body) {
          return true
        }

        if (body.dataset.autobrowserScreenshotPreviousPosition !== undefined) {
          const previousPosition = body.dataset.autobrowserScreenshotPreviousPosition
          if (previousPosition) {
            body.style.position = previousPosition
          } else {
            body.style.removeProperty('position')
          }
          delete body.dataset.autobrowserScreenshotPreviousPosition
        }

        return true
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
  }

  async function addScreenshotAnnotations(tabId: TabInput, frameSelector: FrameSelector) {
    const { value } = await evaluateInTabContext<ScreenshotAnnotationResult>(
      tabId,
      `(() => {
        const body = document.body
        if (!body) {
          return { count: 0 }
        }

        const doc = document.documentElement
        const existing = document.getElementById(${JSON.stringify(SCREENSHOT_ANNOTATION_OVERLAY_ID)})
        if (existing) {
          existing.remove()
        }

        if (getComputedStyle(body).position === 'static') {
          body.dataset.autobrowserScreenshotPreviousPosition = body.style.position || ''
          body.style.position = 'relative'
        }

${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

        const overlay = document.createElement('div')
        overlay.id = ${JSON.stringify(SCREENSHOT_ANNOTATION_OVERLAY_ID)}
        overlay.style.position = 'absolute'
        overlay.style.left = '0'
        overlay.style.top = '0'
        overlay.style.pointerEvents = 'none'
        overlay.style.zIndex = '2147483647'
        overlay.style.width = Math.max(doc.scrollWidth, doc.clientWidth, body.scrollWidth, body.clientWidth) + 'px'
        overlay.style.height = Math.max(doc.scrollHeight, doc.clientHeight, body.scrollHeight, body.clientHeight) + 'px'

        const selectors = [
          'a[href]',
          'button',
          'input:not([type="hidden"])',
          'textarea',
          'select',
          'summary',
          '[role="button"]',
          '[role="link"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="tab"]',
          '[tabindex]:not([tabindex="-1"])',
          'img',
        ]

        const seen = new Set()
        const candidates = []
        for (const selector of selectors) {
          for (const element of deepQuerySelectorAll(document, selector)) {
            if (seen.has(element)) {
              continue
            }
            seen.add(element)
            candidates.push(element)
          }
        }

        let count = 0
        for (const element of candidates) {
          if (!(element instanceof HTMLElement)) {
            continue
          }

          if (count >= ${SCREENSHOT_ANNOTATION_MAX_ELEMENTS}) {
            break
          }

          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          if (rect.width < 4 || rect.height < 4 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
            continue
          }

          const badge = document.createElement('div')
          badge.textContent = String(count + 1)
          badge.style.position = 'absolute'
          badge.style.left = Math.max(0, rect.left + window.scrollX) + 'px'
          badge.style.top = Math.max(0, rect.top + window.scrollY) + 'px'
          badge.style.transform = 'translate(-6px, -6px)'
          badge.style.background = 'rgba(220, 38, 38, 0.94)'
          badge.style.color = '#ffffff'
          badge.style.border = '2px solid #ffffff'
          badge.style.borderRadius = '999px'
          badge.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.35)'
          badge.style.font = '700 12px/1.1 system-ui, sans-serif'
          badge.style.padding = '3px 6px'
          badge.style.minWidth = '16px'
          badge.style.textAlign = 'center'
          badge.style.whiteSpace = 'nowrap'
          overlay.appendChild(badge)
          count += 1
        }

        body.appendChild(overlay)
        return { count }
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    return Number(value?.count || 0)
  }

  async function captureScreenshot(
    tabId: TabInput,
    options: ScreenshotCaptureOptions = {},
    frameSelector: FrameSelector,
  ) {
    const tab = await getTargetTab(tabId)
    const effectiveFrameSelector = resolveEffectiveFrameSelector(state, tab, frameSelector)

    // 元素截图只裁元素区域，与整页截图语义冲突，提前报明确错误而不是静默二选一
    if (options.element && options.full) {
      throw new Error('screenshot element capture cannot be combined with --full')
    }

    await sendDebuggerCommand(tab.id, 'Page.enable', {})

    let annotationCount = 0
    try {
      if (options.annotate) {
        await clearScreenshotAnnotations(tab.id, effectiveFrameSelector).catch(() => {})
        annotationCount = await addScreenshotAnnotations(tab.id, effectiveFrameSelector)
      }

      const format = options.format === 'jpeg' ? 'jpeg' : 'png'
      const captureOptions = {
        format,
        fromSurface: true,
        ...(format === 'jpeg' && typeof options.quality === 'number'
          ? { quality: options.quality }
          : {}),
      }

      if (options.element) {
        const { resolvedSelector } = await resolveElementSelectorForTab(tab.id, options.element)
        const { value: elementRect } = await evaluateInTabContext<{
          x: number
          y: number
          width: number
          height: number
        }>(
          tab.id,
          `(() => {
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

            const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          })()`,
          withFrameSelectorOptions(effectiveFrameSelector),
        )

        if (!elementRect) {
          throw createElementNotFoundError(options.element)
        }

        // frame 内元素的 rect 是 frame 视口坐标，clip 走主页面坐标系，要叠回 frame 偏移
        let frameOffsetX = 0
        let frameOffsetY = 0
        if (effectiveFrameSelector) {
          const frame = await resolveFrameTarget(tab.id, effectiveFrameSelector)
          frameOffsetX = frame.left
          frameOffsetY = frame.top
        }

        Object.assign(captureOptions, {
          clip: {
            x: Math.max(0, elementRect.x + frameOffsetX),
            y: Math.max(0, elementRect.y + frameOffsetY),
            width: Math.max(1, elementRect.width),
            height: Math.max(1, elementRect.height),
            // scale 取 1：输出像素 = CSS 尺寸 × devicePixelRatio，与 frame clip 的既有行为一致
            scale: 1,
          },
        })
      } else if (effectiveFrameSelector) {
        const frame = await resolveFrameTarget(tab.id, effectiveFrameSelector)
        Object.assign(captureOptions, {
          clip: {
            x: Math.max(0, frame.left),
            y: Math.max(0, frame.top),
            width: Math.max(1, frame.width),
            height: Math.max(1, frame.height),
            scale: 1,
          },
        })
      } else if (options.full) {
        Object.assign(captureOptions, {
          captureBeyondViewport: true,
        })
      }

      const result = await sendDebuggerCommand<{ data: string }>(
        tab.id,
        'Page.captureScreenshot',
        captureOptions,
      )

      return {
        tabId: tab.id,
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        format,
        fullPage: Boolean(options.full),
        annotated: Boolean(options.annotate),
        annotationCount,
        ...(options.element ? { element: options.element } : {}),
        dataUrl: `data:${format === 'jpeg' ? 'image/jpeg' : 'image/png'};base64,${result.data}`,
        data: result.data,
      }
    } finally {
      if (options.annotate) {
        await clearScreenshotAnnotations(tab.id, effectiveFrameSelector).catch((error) => {
          console.error('failed to clear screenshot annotations', error)
        })
      }
    }
  }

  return { captureScreenshot }
}
