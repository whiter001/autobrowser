import { withFrameSelectorOptions } from './targeting.js'
import type { FrameSelector, TabInput } from './types.js'
import type { PageInputContext } from './page-input-context.js'
import { assertEvalResultWithinLimit, createElementNotFoundError } from './page-input-helpers.js'

// eval / locator / highlight 三个页面求值工具：
// 都基于页面内表达式执行，共享 selector 解析与求值入口

/**
 * 创建脚本执行命令：eval 与相关的注入执行入口。
 */
export function createEvalCommands(pageContext: PageInputContext) {
  const { resolveElementSelectorForTab, evaluateInTabContext } = pageContext

  async function evaluateScript(
    tabId: TabInput,
    script: string,
    frameSelector: FrameSelector,
    timeoutMs?: number,
    elementSelector?: string,
    maxResultBytes?: number,
  ) {
    const options = withFrameSelectorOptions(frameSelector, {
      userGesture: true,
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    })
    let effectiveScript = script
    if (elementSelector) {
      const { resolvedSelector } = await resolveElementSelectorForTab(tabId, elementSelector)
      effectiveScript = `(() => {
        const el = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!el) return { __autobrowserElementNotFound: true };
        return (${script})(el);
      })()`
    }
    try {
      const { value } = await evaluateInTabContext(tabId, effectiveScript, options)
      if (
        elementSelector &&
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).__autobrowserElementNotFound === true
      )
        throw createElementNotFoundError(elementSelector)
      assertEvalResultWithinLimit(value, maxResultBytes)
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        !/SyntaxError:\s*(?:Illegal return statement|await is only valid in async functions)/i.test(
          message,
        )
      ) {
        throw error
      }
      // 表达式必须保留直接求值语义；仅编译期确认存在顶层 return/await 时才按 async 函数体重试，
      // 避免普通脚本被包装后不再返回表达式值，也避免其他错误导致脚本重复执行。
      const { value } = await evaluateInTabContext(
        tabId,
        `(async () => {\n${effectiveScript}\n})()`,
        options,
      )
      assertEvalResultWithinLimit(value, maxResultBytes)
      return value
    }
  }

  async function generateLocator(tabId: TabInput, selector: string, frameSelector: FrameSelector) {
    const { resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const { value } = await evaluateInTabContext<
      { found: false } | { found: true; selector: string; strategy: string; unique: true }
    >(
      tabId,
      `(() => {
        const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!node) return { found: false };
        const isUnique = (selector) => {
          try {
            const matches = deepQuerySelectorAll(document, selector);
            return matches.length === 1 && matches[0] === node;
          } catch {
            return false;
          }
        };
        const testId = node.getAttribute('data-testid');
        if (testId) {
          const candidate = '[data-testid="' + CSS.escape(testId) + '"]';
          if (isUnique(candidate)) return { found: true, selector: candidate, strategy: 'test-id', unique: true };
        }
        if (node.id) {
          const candidate = '#' + CSS.escape(node.id);
          if (isUnique(candidate)) return { found: true, selector: candidate, strategy: 'id', unique: true };
        }
        const segments = [];
        let current = node;
        for (let depth = 0; depth < 8 && current && current.nodeType === 1; depth++) {
          const parent = current.parentElement;
          if (!parent) break;
          const tag = current.tagName.toLowerCase();
          const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
          const index = siblings.indexOf(current);
          segments.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (index + 1) + ')' : ''));
          const candidate = segments.join(' > ');
          if (isUnique(candidate)) return { found: true, selector: candidate, strategy: 'css-path', unique: true };
          current = parent;
        }
        const ref = node.getAttribute('data-autobrowser-ref');
        if (ref) {
          const candidate = '[data-autobrowser-ref="' + CSS.escape(ref) + '"]';
          if (isUnique(candidate)) return { found: true, selector: candidate, strategy: 'agent-ref', unique: true };
        }
        return { found: false };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    if (!value?.found) throw new Error(`unable to generate a unique locator for ${selector}`)
    return value
  }

  async function highlightElement(
    tabId: TabInput,
    selector: string | undefined,
    style: string | undefined,
    hide: boolean,
    frameSelector: FrameSelector,
  ) {
    const resolvedSelector = selector
      ? (await resolveElementSelectorForTab(tabId, selector)).resolvedSelector
      : null
    const { value } = await evaluateInTabContext<{
      found?: boolean
      highlighted?: boolean
      cleared?: number
      count?: number
    }>(
      tabId,
      `(() => {
        const owner = document;
        const highlights = owner.__autobrowserHighlights || new Map();
        owner.__autobrowserHighlights = highlights;
        const restore = (node) => {
          const previous = highlights.get(node);
          if (!previous) return;
          node.style.outline = previous.outline;
          node.style.outlineOffset = previous.outlineOffset;
          highlights.delete(node);
        };
        const selector = ${JSON.stringify(resolvedSelector)};
        if (${hide}) {
          if (selector) {
            const node = deepQuerySelector(document, selector);
            if (!node) return { found: false };
            restore(node);
            return { found: true, cleared: 1, count: highlights.size };
          }
          const cleared = highlights.size;
          for (const node of [...highlights.keys()]) restore(node);
          return { found: true, cleared, count: 0 };
        }
        const node = deepQuerySelector(document, selector);
        if (!node) return { found: false };
        if (!highlights.has(node)) {
          highlights.set(node, {
            outline: node.style.outline,
            outlineOffset: node.style.outlineOffset
          });
        }
        node.style.outline = ${JSON.stringify(style || '2px solid #ff9800')};
        node.style.outlineOffset = '2px';
        return { found: true, highlighted: true, count: highlights.size };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )
    if (!value?.found && selector) throw createElementNotFoundError(selector)
    return value
  }

  return { evaluateScript, generateLocator, highlightElement }
}
