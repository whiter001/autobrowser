import { resolveAgentSelector } from '../../src/core/agent-selectors.js'
import {
  clearSelectedFrame,
  getPageEpoch,
  invalidatePageRefs,
  withFrameSelectorOptions,
} from './targeting.js'
import type {
  EvaluateInTabContextOptions,
  ExtensionState,
  FrameExecutionContext,
  FrameSelector,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  TabInput,
  TabWithId,
} from './types.js'

interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

interface ElementActionResult extends Record<string, unknown> {
  found: boolean
  reason?: string
}

interface PageInputDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  resolveElementSelectorForTab: (
    tabId: TabInput,
    selector: string,
  ) => Promise<ResolvedSelectorTarget>
  resolveFrameTarget: (tabId: TabInput, selector: string) => Promise<ResolvedFrameTarget>
  getFrameExecutionContext: (
    tabId: TabInput,
    frameSelector: FrameSelector,
  ) => Promise<FrameExecutionContext>
  evaluateInTabContext: <TValue = unknown>(
    tabId: TabInput,
    expression: string,
    options?: EvaluateInTabContextOptions,
  ) => Promise<{
    tab: TabWithId
    response: { result: unknown }
    value: TValue | null
  }>
  sendDebuggerCommand: <TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<TResult>
}

export function createPageInputDomain({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  getFrameExecutionContext,
  evaluateInTabContext,
  sendDebuggerCommand,
}: PageInputDependencies) {
  function parseKeyboardKey(key: string): { key: string; modifiers: number } {
    const modifiers = { shift: false, ctrl: false, alt: false, meta: false }
    let remaining = key

    if (remaining.includes('Control+')) {
      modifiers.ctrl = true
      remaining = remaining.replace('Control+', '')
    }
    if (remaining.includes('Shift+')) {
      modifiers.shift = true
      remaining = remaining.replace('Shift+', '')
    }
    if (remaining.includes('Alt+')) {
      modifiers.alt = true
      remaining = remaining.replace('Alt+', '')
    }
    if (remaining.includes('Meta+')) {
      modifiers.meta = true
      remaining = remaining.replace('Meta+', '')
    }

    let mask = 0
    if (modifiers.ctrl) mask |= 2
    if (modifiers.shift) mask |= 4
    if (modifiers.alt) mask |= 1
    if (modifiers.meta) mask |= 8

    return { key: remaining, modifiers: mask }
  }

  async function dispatchMouseClick(
    tabId: number,
    box: ElementBox,
    clickCount: number,
  ): Promise<void> {
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount,
    })
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount,
    })
  }

  async function dispatchKeyEvent(
    tabId: number,
    keyName: string,
    modifiers: number,
    type: 'keyDown' | 'keyUp',
  ): Promise<void> {
    await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
      type,
      key: keyName,
      code: keyName,
      modifiers,
    })
  }

  async function getElementBox(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<ElementBox>(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height
        };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return value
  }

  async function dispatchInsertText(tabId: TabInput, text: string) {
    const tab = await getTargetTab(tabId)
    await sendDebuggerCommand(tab.id, 'Input.insertText', {
      text: String(text || ''),
    })
    return { inserted: true, text }
  }

  async function insertTextSequentially(tabId: TabInput, text: string) {
    const normalizedText = String(text || '')

    for (const character of normalizedText) {
      await dispatchInsertText(tabId, character)
    }

    return { typed: true, text: normalizedText }
  }

  async function insertTextOnce(tabId: TabInput, text: string) {
    return await dispatchInsertText(tabId, text)
  }

  async function evaluateScript(tabId: TabInput, script: string, frameSelector: FrameSelector) {
    const { value } = await evaluateInTabContext(
      tabId,
      script,
      withFrameSelectorOptions(frameSelector, {
        userGesture: true,
      }),
    )
    return value
  }

  async function navigateTo(tabId: TabInput, url: string) {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    await sendDebuggerCommand(tab.id, 'Page.enable', {})
    await sendDebuggerCommand(tab.id, 'Page.navigate', { url })
    return { tabId: tab.id, url }
  }

  async function clickSelector(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        node.click();
        return { found: true, selector: ${JSON.stringify(selector)} };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (result?.found) {
      return result
    }

    const box = await getElementBox(tab.id, selector, frameSelector)
    if (!box) {
      throw new Error(`element not found: ${selector}`)
    }

    await dispatchMouseClick(tab.id, box, 1)
    return { found: true, selector }
  }

  async function hoverElement(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const box = await getElementBox(tab.id, selector, frameSelector)
    if (!box) {
      throw new Error(`element not found: ${selector}`)
    }

    const { value } = await evaluateInTabContext<boolean>(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
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
      withFrameSelectorOptions(frameSelector),
    )

    if (value) {
      return { found: true, selector }
    }

    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.x,
      y: box.y,
      button: 'none',
      clickCount: 0,
    })

    return { found: true, selector }
  }

  async function pressKey(tabId: TabInput, key: string) {
    const { key: keyName, modifiers } = parseKeyboardKey(key)
    const tab = await getTargetTab(tabId)

    await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyDown')
    await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyUp')

    return { key, pressed: true }
  }

  async function focusElement(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.focus();
        return { found: true, focused: document.activeElement === node };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value?.found) {
      return value
    }

    throw new Error(`element not found: ${selector}`)
  }

  async function selectOption(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.focus();
        node.value = ${JSON.stringify(value)};
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, value: node.value };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (result?.found) {
      return result
    }
    throw new Error(`element not found: ${selector}`)
  }

  async function checkElement(
    tabId: TabInput,
    selector: string,
    checked: boolean,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.focus();
        node.checked = ${checked};
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, checked: node.checked };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (result?.found) {
      return result
    }
    throw new Error(`element not found: ${selector}`)
  }

  async function scrollElement(
    tabId: TabInput,
    selector: string | null,
    deltaX = 0,
    deltaY = 100,
    frameSelector: FrameSelector,
  ) {
    let resolvedSelector = ''
    if (selector) {
      ;({ resolvedSelector } = await resolveElementSelectorForTab(tabId, selector))
    }
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tabId,
      `(() => {
        ${
          selector
            ? `
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        `
            : ''
        }
        window.scrollBy(${deltaX}, ${deltaY});
        return { found: true, scrolled: true };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    return value || { found: true, scrolled: true }
  }

  async function dragElement(
    tabId: TabInput,
    startSelector: string,
    endSelector: string,
    frameSelector: FrameSelector,
  ) {
    const startBox = await getElementBox(tabId, startSelector, frameSelector)
    if (!startBox) {
      throw new Error(`start element not found: ${startSelector}`)
    }

    let endBox: ElementBox
    if (endSelector) {
      const resolvedEndBox = await getElementBox(tabId, endSelector, frameSelector)
      if (!resolvedEndBox) {
        throw new Error(`end element not found: ${endSelector}`)
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

    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startBox.x,
      y: startBox.y,
      button: 'left',
      clickCount: 1,
    })

    const steps = 10
    for (let i = 1; i <= steps; i++) {
      const x = startBox.x + (endBox.x - startBox.x) * (i / steps)
      const y = startBox.y + (endBox.y - startBox.y) * (i / steps)
      await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'left',
        clickCount: 1,
      })
    }

    await sendDebuggerCommand(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: endBox.x,
      y: endBox.y,
      button: 'left',
      clickCount: 1,
    })

    return { found: true, dragged: true }
  }

  async function uploadFiles(
    tabId: TabInput,
    selector: string,
    filePaths: string[],
    frameSelector: FrameSelector,
  ) {
    const { resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { tab, executionContextId } = await getFrameExecutionContext(tabId, frameSelector)
    const result = await sendDebuggerCommand<{ result?: { objectId?: string } }>(
      tab.id,
      'Runtime.evaluate',
      {
        expression: `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node && node.tagName === 'INPUT' && node.type === 'file' ? node : null;
      })()`,
        awaitPromise: true,
        returnByValue: false,
        ...(executionContextId ? { contextId: executionContextId } : {}),
      },
    )

    const objectId = result?.result?.objectId
    if (!objectId) {
      throw new Error(`file input not found: ${selector}`)
    }

    try {
      await sendDebuggerCommand(tab.id, 'DOM.setFileInputFiles', {
        files: filePaths,
        objectId,
      })
    } finally {
      await sendDebuggerCommand(tab.id, 'Runtime.releaseObject', {
        objectId,
      }).catch(() => {})
    }

    return { found: true, files: filePaths }
  }

  async function navigateBack(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    const history = await sendDebuggerCommand<{
      entries?: Array<{ id: number }>
      currentIndex?: number
    }>(tab.id, 'Page.getNavigationHistory')
    const entries = history.entries || []
    const currentIndex = history.currentIndex

    if (typeof currentIndex === 'number' && currentIndex > 0) {
      const targetIndex = currentIndex - 1
      const targetEntry = entries[targetIndex]
      if (targetEntry) {
        await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
          entryId: targetEntry.id,
        })
        return { navigated: true, back: true }
      }
    }
    return { navigated: false, reason: 'no back history' }
  }

  async function navigateForward(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    const history = await sendDebuggerCommand<{
      entries?: Array<{ id: number }>
      currentIndex?: number
    }>(tab.id, 'Page.getNavigationHistory')
    const entries = history.entries || []
    const currentIndex = history.currentIndex

    if (typeof currentIndex === 'number' && currentIndex < entries.length - 1) {
      const targetIndex = currentIndex + 1
      const targetEntry = entries[targetIndex]
      if (targetEntry) {
        await sendDebuggerCommand(tab.id, 'Page.navigateToHistoryEntry', {
          entryId: targetEntry.id,
        })
        return { navigated: true, forward: true }
      }
    }
    return { navigated: false, reason: 'no forward history' }
  }

  async function reloadPage(tabId: TabInput) {
    const tab = await getTargetTab(tabId)
    invalidatePageRefs(state, tab.id)
    await sendDebuggerCommand(tab.id, 'Page.reload', {})
    return { reloaded: true }
  }

  async function switchToFrame(tabId: TabInput, selector: string) {
    const tab = await getTargetTab(tabId)
    if (['top', 'main', 'default'].includes(selector)) {
      clearSelectedFrame(state, tab.id)
      return {
        found: true,
        cleared: true,
        pageEpoch: getPageEpoch(state, tab.id),
        frame: null as null,
      }
    }

    const frame = await resolveFrameTarget(tab.id, selector)
    state.selectedFrames.set(tab.id, selector)
    return {
      found: true,
      pageEpoch: frame.pageEpoch,
      frame: {
        ref: frame.ref,
        selector: frame.selector,
        src: frame.src,
      },
    }
  }

  async function checkIsState(
    tabId: TabInput,
    selector: string,
    stateType: string,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const checkJs = {
      visible: `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      })()`,
      enabled: `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node && !node.disabled;
      })()`,
      checked: `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node && node.checked === true;
      })()`,
      disabled: `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node && node.disabled === true;
      })()`,
      focused: `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node && node === node.ownerDocument.activeElement;
      })()`,
    }

    const normalizedStateType = stateType as keyof typeof checkJs
    const js = checkJs[normalizedStateType]
    if (!js) {
      throw new Error(`unknown state type: ${stateType}`)
    }

    const { value } = await evaluateInTabContext(
      tab.id,
      js,
      withFrameSelectorOptions(frameSelector),
    )
    return {
      found: true,
      state: stateType,
      value,
    }
  }

  async function getAttribute(
    tabId: TabInput,
    selector: string,
    attrName: string,
    frameSelector: FrameSelector,
  ) {
    if (attrName === 'cdp-url') {
      if (!state.token) {
        throw new Error('missing token')
      }

      return {
        found: true,
        value: `ws://127.0.0.1:${state.relayPort}/ws?token=${encodeURIComponent(state.token)}`,
      }
    }

    const selectorContext = ['title', 'url'].includes(attrName)
      ? null
      : await resolveElementSelectorForTab(tabId, selector)
    const resolvedSelector = selectorContext?.resolvedSelector || resolveAgentSelector(selector)
    const resolvedTabId = selectorContext?.tab.id ?? tabId

    if (attrName === 'text') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        `(() => {
          const node = document.querySelector(${JSON.stringify(resolvedSelector)});
          return node ? node.textContent : null;
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'html') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        `(() => {
          const node = document.querySelector(${JSON.stringify(resolvedSelector)});
          return node ? node.innerHTML : null;
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'value') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        `(() => {
          const node = document.querySelector(${JSON.stringify(resolvedSelector)});
          return node ? node.value : null;
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'title') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        'document.title',
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'url') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        'window.location.href',
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'count') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        `(() => {
          return document.querySelectorAll(${JSON.stringify(resolvedSelector)}).length;
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'box') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        `(() => {
          const node = document.querySelector(${JSON.stringify(resolvedSelector)});
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'styles') {
      const { value } = await evaluateInTabContext(
        resolvedTabId,
        `(() => {
          const node = document.querySelector(${JSON.stringify(resolvedSelector)});
          if (!node) return null;
          const styles = window.getComputedStyle(node);
          return Object.fromEntries(Array.from(styles).map((name) => [name, styles.getPropertyValue(name)]));
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    const { value } = await evaluateInTabContext(
      resolvedTabId,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        return node ? node.getAttribute(${JSON.stringify(attrName)}) : null;
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    return { found: true, value }
  }

  async function fillSelector(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!node) {
          return { found: false };
        }

        if (!("value" in node)) {
          return { found: false, reason: "element does not accept value" };
        }

        node.focus();
        node.value = ${JSON.stringify(value)};
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        return { found: true, selector: ${JSON.stringify(selector)} };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    return result
  }

  async function keyDownOnly(tabId: TabInput, key: string) {
    const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
    const tab = await getTargetTab(tabId)

    await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyDown')
    return { key, pressed: true, type: 'keydown' }
  }

  async function keyUpOnly(tabId: TabInput, key: string) {
    const { key: keyName, modifiers } = parseKeyboardKey(String(key || ''))
    const tab = await getTargetTab(tabId)

    await dispatchKeyEvent(tab.id, keyName, modifiers, 'keyUp')
    return { key, released: true, type: 'keyup' }
  }

  async function typeIntoSelector(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
  ) {
    await focusElement(tabId, selector, frameSelector)
    const typed = await insertTextSequentially(tabId, value)
    return {
      found: true,
      selector,
      ...typed,
    }
  }

  async function doubleClickSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) {
    const box = await getElementBox(tabId, selector, frameSelector)
    if (!box) {
      throw new Error(`element not found: ${selector}`)
    }

    const tab = await getTargetTab(tabId)
    await dispatchMouseClick(tab.id, box, 2)

    return { found: true, selector, doubleClicked: true }
  }

  async function scrollIntoViewSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        try {
          const node = document.querySelector(${JSON.stringify(resolvedSelector)});
          if (!node) return { found: false, reason: 'element not found' };
          node.scrollIntoView({ block: 'center', inline: 'center' });
          return { found: true, selector: ${JSON.stringify(selector)} };
        } catch (error) {
          return {
            found: false,
            reason: error instanceof Error ? error.message : 'failed to scroll into view',
          };
        }
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    return value
  }

  return {
    checkElement,
    checkIsState,
    clickSelector,
    doubleClickSelector,
    evaluateScript,
    fillSelector,
    focusElement,
    getAttribute,
    hoverElement,
    insertTextOnce,
    insertTextSequentially,
    keyDownOnly,
    keyUpOnly,
    navigateBack,
    navigateForward,
    navigateTo,
    pressKey,
    reloadPage,
    scrollElement,
    scrollIntoViewSelector,
    selectOption,
    switchToFrame,
    typeIntoSelector,
    uploadFiles,
    dragElement,
  }
}
