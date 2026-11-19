import { withFrameSelectorOptions } from './targeting.js'
import type { ErrorWithCode, FrameSelector, TabInput } from './types.js'
import type { PageInputContext } from './page-input-context.js'
import {
  assertEvalResultWithinLimit,
  createElementNotFoundError,
  createNavigationFailedError,
  isBrowserErrorPageUrl,
} from './page-input-helpers.js'
import {
  isEvalPaginationRequested,
  paginateEvalResult,
  type EvalPaginationRequest,
} from './page-input-eval-result.js'

// eval / locator / highlight 三个页面求值工具：
// 都基于页面内表达式执行，共享 selector 解析与求值入口

export interface EvaluateScriptOptions extends EvalPaginationRequest {
  /** 页面脚本通过局部变量 args 读取的注入值；缺省为空对象。 */
  args?: Record<string, unknown>
}

const NAVIGATION_FAILED_RESULT = '__autobrowserNavigationFailed'

// args 会作为 JS 字面量拼进源码，JSON.stringify 后仍需转义行分隔符：
// 它们在 JSON 字符串里合法，但直接落进源码会被部分引擎当成换行。
function serializeEvalArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '{}'
  return JSON.stringify(args)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 创建脚本执行命令：eval 与相关的注入执行入口。
 */
export function createEvalCommands(pageContext: PageInputContext) {
  const {
    resolveElementSelectorForTab,
    evaluateInTabContext,
    getFrameExecutionContext,
    sendDebuggerCommand,
  } = pageContext

  /**
   * 脚本能否按 classic script 编译通过。用 Runtime.compileScript 做纯编译检查（不执行），
   * 用来区分 direct eval 的失败发生在编译期还是运行期：
   * - 编译通过 → direct eval 的异常是运行期抛出的，脚本已经执行过，不能再换求值方式重试；
   * - 编译失败 → 脚本一行都没跑（顶层 await / 顶层 return / 真实语法错误），换路径不会重复副作用。
   */
  async function compilesAsClassicScript(
    tabId: TabInput,
    script: string,
    frameSelector: FrameSelector,
  ): Promise<boolean> {
    const { tab, executionContextId } = await getFrameExecutionContext(tabId, frameSelector)
    const result = await sendDebuggerCommand<{ exceptionDetails?: unknown }>(
      tab.id,
      'Runtime.compileScript',
      {
        expression: script,
        sourceURL: '',
        persistScript: false,
        // 注意 compileScript 的上下文参数名是 executionContextId，与 Runtime.evaluate 的 contextId 不同
        ...(executionContextId ? { executionContextId } : {}),
      },
    )
    return !result.exceptionDetails
  }

  async function evaluateScript(
    tabId: TabInput,
    script: string,
    frameSelector: FrameSelector,
    timeoutMs?: number,
    elementSelector?: string,
    maxResultBytes?: number,
    evalOptions?: EvaluateScriptOptions,
  ) {
    // 错误页本身有可执行文档，但脚本只会读到 chromewebdata 的空内容，把导航失败
    // 伪装成页面真的没数据；先拒绝并提示重新导航。tabs.url 在失败页可能仍是旧地址，
    // 所以 direct-eval 包装还会检查真实 location。只影响公共 eval，导航内部探测不经过这里。
    const targetTab = await pageContext.getTargetTab(tabId)
    if (isBrowserErrorPageUrl(targetTab.url)) {
      throw createNavigationFailedError(targetTab.url)
    }

    const options = withFrameSelectorOptions(frameSelector, {
      userGesture: true,
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    })
    const argsLiteral = serializeEvalArgs(evalOptions?.args)
    let effectiveScript = script
    if (elementSelector) {
      const { resolvedSelector } = await resolveElementSelectorForTab(tabId, elementSelector)
      effectiveScript = `(() => {
        const el = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
        if (!el) return { __autobrowserElementNotFound: true };
        return (${script})(el, args);
      })()`
    }
    const finish = (value: unknown): unknown => {
      if (value && typeof value === 'object') {
        const result = value as Record<string, unknown>
        if (
          result[NAVIGATION_FAILED_RESULT] === true &&
          typeof result.url === 'string' &&
          isBrowserErrorPageUrl(result.url)
        ) {
          throw createNavigationFailedError(result.url)
        }
      }
      if (
        elementSelector &&
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).__autobrowserElementNotFound === true
      )
        throw createElementNotFoundError(elementSelector)
      const paginated = paginateEvalResult(value, evalOptions)
      // 分页后检查上限：先切片再量大小，避免大结果在分页前就被字节上限拒绝
      assertEvalResultWithinLimit(
        isEvalPaginationRequested(evalOptions) ? paginated : value,
        maxResultBytes,
      )
      return paginated
    }

    // 第一级：direct eval。直接以全局脚本执行会把顶层 const/let 留在页面词法环境，
    // 第二次运行同一脚本即报 "already declared"。包进函数作用域的 direct eval：仍返回
    // completion value（简单表达式的值不变），声明与函数只在 wrapper 内可见，可原样重复执行。
    // args 定义在 wrapper 作用域，eval 里的脚本按作用域链读取，脚本自己声明 args 也不会冲突。
    try {
      const { value } = await evaluateInTabContext(
        tabId,
        `(() => { const args = ${argsLiteral};
if (globalThis.location?.href.startsWith('chrome-error://')) return { ${NAVIGATION_FAILED_RESULT}: true, url: globalThis.location.href };
return eval(${JSON.stringify(effectiveScript)}) })()`,
        options,
      )
      return finish(value)
    } catch (error) {
      // 错误页守卫在求值用户脚本前返回；即使脚本带顶层 await/return，也不能进入后续求值路径
      if ((error as ErrorWithCode).code === 'NAVIGATION_FAILED') throw error
      // 编译检查失败时按"已执行过"处理，宁可不重试也不能重放副作用
      let compiled = true
      try {
        compiled = await compilesAsClassicScript(tabId, effectiveScript, frameSelector)
      } catch {
        compiled = true
      }
      if (compiled) throw error
    }

    // 第二级：replMode。direct eval 的求值上下文不是 async，顶层 await 会解析失败；
    // Runtime.evaluate 的 replMode 原生支持顶层 await，并保留脚本的完成值，
    // 同时顶层 const/let 不泄漏到页面全局。args 只能作为前置声明注入。
    try {
      const { value } = await evaluateInTabContext(
        tabId,
        `const args = ${argsLiteral};\n${effectiveScript}`,
        {
          ...options,
          replMode: true,
        },
      )
      return finish(value)
    } catch (error) {
      // 编译期失败没有运行期调用栈；有栈说明脚本已经开始执行，不能再换路径重放。
      // 缺字段时按有栈处理，宁可不重试。
      if ((error as ErrorWithCode).hasRuntimeStack !== false) throw error
    }

    // 第三级：async IIFE。replMode 同样不接受顶层 return（"Illegal return statement"），
    // 这类脚本必须自己带 return，因此完成值由脚本的 return 给出，不会像顶层 await 那样丢值。
    // args 走形参而不是 const 声明，脚本自己写 `const args` 时不会撞名。
    const { value } = await evaluateInTabContext(
      tabId,
      `(async (args) => {\n${effectiveScript}\n})(${argsLiteral})`,
      options,
    )
    return finish(value)
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
