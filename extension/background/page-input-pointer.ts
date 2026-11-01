import { resolveAgentFrameSelector } from '../../src/core/agent-handles.js'
import {
  assertFreshFrameRef,
  getPageEpoch,
  resolveEffectiveFrameSelector,
  withFrameSelectorOptions,
} from './targeting.js'
import type { CommandExecutionContext } from './command-queue.js'
import type { FrameSelector, TabInput } from './types.js'
import type { ElementActionResult, ElementBox, PageInputContext } from './page-input-context.js'
import { createElementNotFoundError } from './page-input-helpers.js'
import type { createNavigationCommands } from './page-input-navigation.js'

// 鼠标相关命令：坐标测量、点击/双击/悬停、拖拽、坐标移动与拖放数据投递。
// 坐标测量与导航等待都来自共享的 navigation 模块，避免重复实现

/**
 * 创建指针类命令：鼠标移动、按下抬起、滚轮与拖拽。
 */
export function createPointerCommands(
  pageContext: PageInputContext,
  navigation: ReturnType<typeof createNavigationCommands>,
) {
  const {
    state,
    getTargetTab,
    resolveElementSelectorForTab,
    resolveFrameTarget,
    evaluateInTabContext,
    sendDebuggerCommand,
  } = pageContext
  const mousePositions = new Map<number, { x: number; y: number }>()

  // 坐标测量会滚动父页/iframe/目标元素，属于副作用，取消后不能再发
  async function getElementBox(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    scrollIntoView: boolean | 'none' = false,
    context?: CommandExecutionContext,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const effectiveFrame = resolveEffectiveFrameSelector(state, tab, frameSelector)
    const frameExpression = effectiveFrame
      ? `const root = deepQuerySelector(document, ${JSON.stringify(resolveAgentFrameSelector(effectiveFrame))});
         const frame = root && (root.tagName === 'IFRAME' ? root : deepQuerySelector(root, 'iframe'));
         if (!frame) throw new Error('frame not found');`
      : ''
    if (effectiveFrame) assertFreshFrameRef(state, tab.id, effectiveFrame)
    if (effectiveFrame && scrollIntoView !== 'none') {
      // 必须先滚动父页，否则屏幕外 iframe 的 CDP frame 解析可能命中错误位置。
      context?.throwIfCancelled()
      await evaluateInTabContext(
        tab.id,
        `(() => {
          ${frameExpression}
          frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        })()`,
        { frameSelector: 'top', commandContext: context },
      )
    }
    context?.throwIfCancelled()
    const { value } = await evaluateInTabContext<ElementBox>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return null;
        ${scrollIntoView !== 'none' && (scrollIntoView || effectiveFrame) ? "node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });" : ''}
        const rect = node.getBoundingClientRect();
        ${scrollIntoView === true ? 'if (rect.width === 0 && rect.height === 0) return null;' : ''}
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height
        };
      })()`,
      withFrameSelectorOptions(effectiveFrame || 'top', { commandContext: context }),
    )
    if (!value || !effectiveFrame) return value

    // 子页滚动可能连带移动父页；重新取 frame 位置，并补上内容视口的边框偏移。
    const frame = await resolveFrameTarget(tab.id, effectiveFrame)
    context?.throwIfCancelled()
    const { value: border } = await evaluateInTabContext<{ left: number; top: number }>(
      tab.id,
      `(() => {
        ${frameExpression}
        return { left: frame.clientLeft, top: frame.clientTop };
      })()`,
      { frameSelector: 'top', commandContext: context },
    )
    if (!border) throw new Error(`frame not found: ${effectiveFrame}`)
    return { ...value, x: value.x + frame.left + border.left, y: value.y + frame.top + border.top }
  }

  async function dispatchMouseClick(
    tabId: number,
    box: ElementBox,
    clickCount: number,
    context?: CommandExecutionContext,
  ): Promise<void> {
    // 只在按下前检查：释放是收尾动作，按下已发出就必须补上，否则页面停留在按下状态
    context?.throwIfCancelled()
    await sendDebuggerCommand(
      tabId,
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount,
      },
      context,
    )
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount,
    })
  }

  async function clickSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    timeoutMs = 10000,
    context?: CommandExecutionContext,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const beforeEpoch = getPageEpoch(state, tab.id)
    const beforeUrl = tab.url

    // CDP 优先：先 scrollIntoView 并取元素中心坐标，走 trusted 的 Input.dispatchMouseEvent；
    // 依赖 isTrusted 的页面（表单校验/统计埋点等）必须由真实输入事件触发
    const boxResult = await getElementBox(tab.id, selector, frameSelector, true, context)

    if (boxResult) {
      await dispatchMouseClick(tab.id, boxResult, 1, context)
    } else {
      // 坐标拿不到（display:none 等不可见元素）时回退到页面内 node.click()
      context?.throwIfCancelled()
      const { value: jsResult } = await evaluateInTabContext<ElementActionResult>(
        tab.id,
        `(() => {
          const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
          if (!node) return { found: false };
          node.click();
          return { found: true, selector: ${JSON.stringify(selector)} };
        })()`,
        withFrameSelectorOptions(frameSelector, { commandContext: context }),
      )

      if (!jsResult?.found) {
        throw createElementNotFoundError(selector)
      }
    }

    // 点击可能触发导航（链接/表单提交），两条路径统一在这里检测并等待页面稳定
    context?.throwIfCancelled()
    const navigated = await navigation.detectNavigationAfterClick(tab.id, beforeEpoch, beforeUrl)
    if (navigated) {
      const settle = await navigation.waitForPageSettled(tab.id, {
        timeoutMs,
        commandContext: context,
      })
      let currentUrl: string | null = null
      try {
        const currentTab = await getTargetTab(tab.id)
        currentUrl = currentTab.url || null
      } catch {
        // 点击后 tab 被关闭（如 window.open + 原页关闭），保持 null
      }
      return {
        found: true,
        selector,
        navigatedToUrl: currentUrl,
        settled: settle.settled,
        ...(settle.settled ? {} : { settleReason: settle.settleReason || 'page did not settle' }),
      }
    }
    return { found: true, selector }
  }

  async function doubleClickSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const box = await getElementBox(tabId, selector, frameSelector, false, context)
    if (!box) {
      throw createElementNotFoundError(selector)
    }

    const tab = await getTargetTab(tabId)
    await dispatchMouseClick(tab.id, box, 2, context)

    return { found: true, selector, doubleClicked: true }
  }

  async function hoverElement(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const box = await getElementBox(tab.id, selector, frameSelector, false, context)
    if (!box) {
      throw createElementNotFoundError(selector)
    }

    context?.throwIfCancelled()
    const { value } = await evaluateInTabContext<boolean>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const win = node.ownerDocument.defaultView;
        const opts = { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y };
        node.dispatchEvent(new PointerEvent('pointerover', opts));
        node.dispatchEvent(new MouseEvent('mouseover', opts));
        node.dispatchEvent(new PointerEvent('pointerenter', opts));
        node.dispatchEvent(new MouseEvent('mouseenter', opts));
        node.dispatchEvent(new MouseEvent('mousemove', opts));
        return true;
      })()`,
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )

    if (value) {
      return { found: true, selector }
    }

    context?.throwIfCancelled()
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: box.x,
        y: box.y,
        button: 'none',
        clickCount: 0,
      },
      context,
    )

    return { found: true, selector }
  }

  async function dragElement(
    tabId: TabInput,
    startSelector: string,
    endSelector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    let startBox = await getElementBox(tabId, startSelector, frameSelector, false, context)
    if (!startBox) {
      throw new Error(`start element not found: ${startSelector}`)
    }

    let endBox: ElementBox
    if (endSelector) {
      const resolvedEndBox = await getElementBox(tabId, endSelector, frameSelector, false, context)
      if (!resolvedEndBox) {
        throw new Error(`end element not found: ${endSelector}`)
      }
      const tab = await getTargetTab(tabId)
      if (resolveEffectiveFrameSelector(state, tab, frameSelector)) {
        // 终点滚动后起点坐标也可能变化；只重新测量，避免再次滚动使终点失效。
        startBox = await getElementBox(tab.id, startSelector, frameSelector, 'none', context)
        if (!startBox) throw new Error(`start element not found: ${startSelector}`)
      }
      endBox = resolvedEndBox
    } else {
      endBox = {
        x: startBox.x,
        y: startBox.y + 100,
        width: startBox.width,
        height: startBox.height,
      }
    }

    const tab = await getTargetTab(tabId)

    context?.throwIfCancelled()
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: startBox.x,
        y: startBox.y,
        button: 'left',
        clickCount: 1,
      },
      context,
    )

    const steps = 10
    const mouseRelease = {
      type: 'mouseReleased',
      x: endBox.x,
      y: endBox.y,
      button: 'left',
      clickCount: 1,
    }
    try {
      for (let i = 1; i <= steps; i++) {
        context?.throwIfCancelled()
        const x = startBox.x + (endBox.x - startBox.x) * (i / steps)
        const y = startBox.y + (endBox.y - startBox.y) * (i / steps)
        await sendDebuggerCommand(
          tab.id,
          'Input.dispatchMouseEvent',
          {
            type: 'mouseMoved',
            x,
            y,
            button: 'left',
            clickCount: 1,
          },
          context,
        )
      }
    } catch (error) {
      // 拖拽途中失败或被取消：按下的左键必须释放，页面不能停留在拖拽状态
      await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', mouseRelease).catch(() => {})
      throw error
    }

    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', mouseRelease)

    return { found: true, dragged: true }
  }

  async function dropData(
    tabId: TabInput,
    selector: string,
    data: Record<string, string>,
    files: Array<{ name: string; mimeType: string; dataBase64: string }>,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const { resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<{ found?: boolean; dropped?: boolean }>(
      tabId,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        const transfer = new DataTransfer();
        const textData = ${JSON.stringify(data)};
        for (const [mimeType, text] of Object.entries(textData)) transfer.setData(mimeType, text);
        const files = ${JSON.stringify(files)};
        for (const fileData of files) {
          const binary = atob(fileData.dataBase64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
          transfer.items.add(new File([bytes], fileData.name, { type: fileData.mimeType }));
        }
        const rect = node.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        for (const type of ['dragenter', 'dragover', 'drop']) {
          node.dispatchEvent(new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX,
            clientY
          }));
        }
        return { found: true, dropped: true };
      })()`,
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )
    if (!value?.found) throw createElementNotFoundError(selector)
    return { ...value, selector, textItems: Object.keys(data).length, fileCount: files.length }
  }

  async function mouseMove(
    tabId: TabInput,
    x: number,
    y: number,
    context?: CommandExecutionContext,
  ) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y },
      context,
    )
    mousePositions.set(tab.id, { x, y })
    return { moved: true, x, y }
  }

  async function mouseButton(
    tabId: TabInput,
    pressed: boolean,
    button: string,
    context?: CommandExecutionContext,
  ) {
    const tab = await getTargetTab(tabId)
    const point = mousePositions.get(tab.id) || { x: 0, y: 0 }
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      {
        type: pressed ? 'mousePressed' : 'mouseReleased',
        ...point,
        button,
        clickCount: 1,
      },
      context,
    )
    return { pressed, button, ...point }
  }

  async function mouseWheel(
    tabId: TabInput,
    deltaX: number,
    deltaY: number,
    context?: CommandExecutionContext,
  ) {
    const tab = await getTargetTab(tabId)
    const point = mousePositions.get(tab.id) || { x: 0, y: 0 }
    await sendDebuggerCommand(
      tab.id,
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', ...point, deltaX, deltaY },
      context,
    )
    return { scrolled: true, deltaX, deltaY, ...point }
  }

  return {
    clickSelector,
    doubleClickSelector,
    dragElement,
    dropData,
    getElementBox,
    hoverElement,
    mouseButton,
    mouseMove,
    mouseWheel,
  }
}
