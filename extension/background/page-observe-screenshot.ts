import { createElementNotFoundError } from './page-input-helpers.js'
import type { PageObserveDependencies } from './page-observe-context.js'
import { PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE } from './page-observe-helpers.js'
import { resolveEffectiveFrameSelector, withFrameSelectorOptions } from './targeting.js'
import type { FrameSelector, ScreenshotCaptureOptions, TabInput } from './types.js'

const SCREENSHOT_ANNOTATION_OVERLAY_ID = 'autobrowser-screenshot-annotations'
const SCREENSHOT_ANNOTATION_MAX_ELEMENTS = 200
/** 元素截图等待图片 decode 的上限：decode 卡住时截图命令必须还能返回。 */
const ELEMENT_SCREENSHOT_DECODE_TIMEOUT_MS = 1000

interface ScreenshotAnnotationResult {
  count?: number
}

/**
 * 创建截图能力：整页/元素截图，支持格式与质量参数。
 */
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

  /**
   * Page.captureScreenshot 的 clip 用主页面文档坐标，而 getBoundingClientRect 与 frame 位置都是
   * 视口坐标；必须补一次主页面滚动偏移，否则页面滚动后截图区域会整体错位。
   * frame 内部滚动已体现在元素 rect 里，不再重复叠加，所以固定显式读 top，
   * 不能沿用当前选中的 frame。
   */
  async function readMainFrameScroll(tabId: TabInput) {
    const { value } = await evaluateInTabContext<{ x: number; y: number }>(
      tabId,
      '(() => ({ x: window.scrollX, y: window.scrollY }))()',
      { frameSelector: 'top' },
    )
    return { x: Number(value?.x) || 0, y: Number(value?.y) || 0 }
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
          `(async () => {
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

            const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
            if (!node) return null;

            // 懒加载图片和虚拟列表要先进入视口才绘制；直接量首次 rect 会截到空白。
            node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

            // 后台标签页不派发 requestAnimationFrame，用定时器兜底，避免 awaitPromise 永久挂起。
            const nextFrame = () => new Promise((resolve) => {
              if (document.hidden) {
                resolve();
                return;
              }
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                resolve();
              };
              requestAnimationFrame(done);
              setTimeout(done, 50);
            });

            // decode 失败（坏图/跨域）只影响绘制质量，不阻断截图；超时兜底防止 decode 永不 settle。
            const decodeImage = (image) => Promise.race([
              Promise.resolve(image.decode?.()).catch(() => undefined),
              new Promise((resolve) => setTimeout(resolve, ${ELEMENT_SCREENSHOT_DECODE_TIMEOUT_MS})),
            ]);

            await nextFrame();
            await nextFrame();

            const images = node.tagName === 'IMG'
              ? [node, ...node.querySelectorAll('img')]
              : [...node.querySelectorAll('img')];
            await Promise.all(images.map(decodeImage));

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

        // 页面表达式里的 scrollIntoView 已经改变主页面滚动位置，必须在滚动之后读取
        const mainScroll = await readMainFrameScroll(tab.id)

        Object.assign(captureOptions, {
          // 只截当前视口内可见部分：不临时改设备度量，避免截图后把用户视口留在错误尺寸。
          captureBeyondViewport: false,
          clip: {
            x: Math.max(0, elementRect.x + frameOffsetX + mainScroll.x),
            y: Math.max(0, elementRect.y + frameOffsetY + mainScroll.y),
            width: Math.max(1, elementRect.width),
            height: Math.max(1, elementRect.height),
            // scale 取 1：输出像素 = CSS 尺寸 × devicePixelRatio，与 frame clip 的既有行为一致
            scale: 1,
          },
        })
      } else if (effectiveFrameSelector) {
        const frame = await resolveFrameTarget(tab.id, effectiveFrameSelector)
        const mainScroll = await readMainFrameScroll(tab.id)
        Object.assign(captureOptions, {
          clip: {
            x: Math.max(0, frame.left + mainScroll.x),
            y: Math.max(0, frame.top + mainScroll.y),
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
