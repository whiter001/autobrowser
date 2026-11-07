import { resolveAgentSelector } from '../../src/core/agent-selectors.js'
import { withFrameSelectorOptions } from './targeting.js'
import type { CommandExecutionContext } from './command-queue.js'
import type { FrameSelector, TabInput } from './types.js'
import type { ElementActionResult, FillFormField, PageInputContext } from './page-input-context.js'
import { createElementNotFoundError, FILL_VALUE_HELPER_SOURCE } from './page-input-helpers.js'
import { PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE } from './page-input-context.js'

// 元素读取与填写：属性读取、状态判定、焦点/选中/勾选、填充与滚动

/**
 * 创建元素操作命令：click、fill、type、select、hover 等。
 */
export function createElementCommands(pageContext: PageInputContext) {
  const {
    state,
    resolveElementSelectorForTab,
    getFrameExecutionContext,
    evaluateInTabContext,
    sendDebuggerCommand,
  } = pageContext

  async function focusElement(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    context?.throwIfCancelled()
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.focus();
        return { found: true, focused: isDeepActiveElement(document, node) };
      })()`,
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )

    if (value?.found) {
      return value
    }

    throw createElementNotFoundError(selector)
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
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
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
    throw createElementNotFoundError(selector)
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
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
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
    throw createElementNotFoundError(selector)
  }

  async function scrollElement(
    tabId: TabInput,
    selector: string | null,
    deltaX = 0,
    deltaY = 100,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    let resolvedSelector = ''
    if (selector) {
      ;({ resolvedSelector } = await resolveElementSelectorForTab(tabId, selector))
    }
    context?.throwIfCancelled()
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tabId,
      `(() => {
        ${
          selector
            ? `
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        `
            : ''
        }
        window.scrollBy(${deltaX}, ${deltaY});
        return { found: true, scrolled: true };
      })()`,
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )

    if (selector && value && value.found === false) {
      throw createElementNotFoundError(selector)
    }

    return value || { found: true, scrolled: true }
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
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      })()`,
      enabled: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && !node.disabled;
      })()`,
      checked: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && node.checked === true;
      })()`,
      disabled: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && node.disabled === true;
      })()`,
      focused: `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && isDeepActiveElement(document, node);
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
      if (!state.connection.token) {
        throw new Error('missing token')
      }

      return {
        found: true,
        value: `ws://127.0.0.1:${state.connection.relayPort}/ws?token=${encodeURIComponent(state.connection.token)}`,
      }
    }

    const selectorContext = ['title', 'url'].includes(attrName)
      ? null
      : await resolveElementSelectorForTab(tabId, selector)
    const resolvedSelector = selectorContext?.resolvedSelector || resolveAgentSelector(selector)
    const resolvedTabId = selectorContext?.tab.id ?? tabId

    // 依赖目标元素的读取统一走这里：节点不存在时抛带分类的错误，
    // 避免把"元素不存在"静默伪装成 found:true + value:null
    async function readElementValue<TValue>(valueExpression: string): Promise<TValue> {
      const { value } = await evaluateInTabContext<{ found: boolean; value: TValue }>(
        resolvedTabId,
        `(() => {
          const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
          if (!node) return { found: false };
          return { found: true, value: (${valueExpression}) };
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      if (!value?.found) {
        throw createElementNotFoundError(selector)
      }
      return value.value
    }

    if (attrName === 'text') {
      return { found: true, value: await readElementValue('node.textContent') }
    }

    if (attrName === 'html') {
      return { found: true, value: await readElementValue('node.innerHTML') }
    }

    if (attrName === 'value') {
      return { found: true, value: await readElementValue('node.value') }
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
          return deepQuerySelectorAll(document, ${JSON.stringify(resolvedSelector)}).length;
        })()`,
        withFrameSelectorOptions(frameSelector),
      )
      return { found: true, value }
    }

    if (attrName === 'box') {
      return {
        found: true,
        value: await readElementValue(`(() => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`),
      }
    }

    if (attrName === 'styles') {
      return {
        found: true,
        value: await readElementValue(`(() => {
          const styles = window.getComputedStyle(node);
          return Object.fromEntries(Array.from(styles).map((name) => [name, styles.getPropertyValue(name)]));
        })()`),
      }
    }

    return {
      found: true,
      value: await readElementValue(`node.getAttribute(${JSON.stringify(attrName)})`),
    }
  }

  /** 单字段填充核心：解析 selector → 页面内执行三分支 fill 逻辑 → 按结果抛错 */
  async function fillElement(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ): Promise<ElementActionResult> {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    context?.throwIfCancelled()
    const { value: result } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        ${FILL_VALUE_HELPER_SOURCE}
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) {
          return { found: false };
        }

        const result = applyFillValue(node, ${JSON.stringify(value)});
        return { ...result, selector: ${JSON.stringify(selector)} };
      })()`,
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )

    if (result?.found) {
      return result
    }

    if (result?.reason) {
      throw new Error(`cannot fill ${selector}: ${result.reason}`)
    }

    throw createElementNotFoundError(selector)
  }

  async function fillSelector(
    tabId: TabInput,
    selector: string,
    value: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    return await fillElement(tabId, selector, value, frameSelector, context)
  }

  /** 批量填表：逐 field 串行执行 fillElement，单个失败不中断（语义同 batch 的
   *  continueOnError）。全部失败时也照常 200 返回，由 succeeded/failed 统计体现 */
  async function fillFields(
    tabId: TabInput,
    fields: FillFormField[],
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ): Promise<{
    results: Array<{ selector: string; ok: boolean; error?: string }>
    succeeded: number
    failed: number
  }> {
    const results: Array<{ selector: string; ok: boolean; error?: string }> = []
    let succeeded = 0
    let failed = 0
    for (const field of fields) {
      // 取消后不再填下一个字段，也不能把取消误报成普通字段失败
      context?.throwIfCancelled()
      try {
        await fillElement(tabId, field.selector, field.value, frameSelector, context)
        context?.throwIfCancelled()
        results.push({ selector: field.selector, ok: true })
        succeeded += 1
      } catch (error) {
        context?.throwIfCancelled()
        results.push({
          selector: field.selector,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        failed += 1
      }
    }
    return { results, succeeded, failed }
  }

  async function scrollIntoViewSelector(
    tabId: TabInput,
    selector: string,
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    context?.throwIfCancelled()
    const { value } = await evaluateInTabContext<ElementActionResult>(
      tab.id,
      `(() => {
        try {
          const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
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
      withFrameSelectorOptions(frameSelector, { commandContext: context }),
    )

    if (value?.found) {
      return value
    }

    // 页面内执行异常（如滚动画廊报错）与元素缺失区分开，避免误报 STALE_REFERENCE
    if (value?.reason && value.reason !== 'element not found') {
      throw new Error(`failed to scroll into view: ${selector}: ${value.reason}`)
    }

    throw createElementNotFoundError(selector)
  }

  async function uploadFiles(
    tabId: TabInput,
    selector: string,
    filePaths: string[],
    frameSelector: FrameSelector,
    context?: CommandExecutionContext,
  ) {
    const { resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { tab, executionContextId } = await getFrameExecutionContext(tabId, frameSelector)
    const result = await sendDebuggerCommand<{
      result?: { objectId?: string }
      exceptionDetails?: {
        text?: string
        exception?: { description?: string }
      }
    }>(
      tab.id,
      'Runtime.evaluate',
      {
        expression: `(() => {
        ${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        return node && node.tagName === 'INPUT' && node.type === 'file' ? node : null;
      })()`,
        awaitPromise: true,
        returnByValue: false,
        ...(executionContextId ? { contextId: executionContextId } : {}),
      },
      context,
    )

    // evaluate 抛异常时 result 是异常对象，其 objectId 若传给 setFileInputFiles 会产生误导性报错
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails
      throw new Error(
        `failed to resolve file input ${selector}: ${details.exception?.description || details.text || 'unknown error'}`,
      )
    }

    const objectId = result?.result?.objectId
    if (!objectId) {
      throw new Error(`file input not found: ${selector}`)
    }

    try {
      context?.throwIfCancelled()
      await sendDebuggerCommand(
        tab.id,
        'DOM.setFileInputFiles',
        {
          files: filePaths,
          objectId,
        },
        context,
      )
    } finally {
      await sendDebuggerCommand(tab.id, 'Runtime.releaseObject', {
        objectId,
      }).catch(() => {})
    }

    return { found: true, files: filePaths }
  }

  return {
    checkElement,
    checkIsState,
    fillElement,
    fillFields,
    fillSelector,
    focusElement,
    getAttribute,
    scrollElement,
    scrollIntoViewSelector,
    selectOption,
    uploadFiles,
  }
}
