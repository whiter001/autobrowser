import type { PageObserveDependencies } from './page-observe-context.js'
import {
  PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE,
  PAGE_CONTEXT_TEXT_HELPERS_SOURCE,
} from './page-observe-helpers.js'
import { withFrameSelectorOptions } from './targeting.js'
import type { FrameSelector, TabInput } from './types.js'

async function pollUntil<TResult>(
  timeout: number,
  step: () => Promise<TResult | null>,
  timeoutMessage: string,
): Promise<TResult> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const result = await step()
    if (result !== null) {
      return result
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(timeoutMessage)
}

function waitForDebuggerEvent<TResult>(
  tabId: number,
  timeout: number,
  enable: () => Promise<void>,
  matches: (source: { tabId?: number }, method: string, params?: unknown) => boolean,
  buildResult: () => TResult,
  timeoutMessage: string,
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    // 统一在一处收敛 listener/timeout 清理，避免新增等待类型时遗漏解除订阅。
    const cleanup = () => {
      chrome.debugger.onEvent.removeListener(listener)
      clearTimeout(timeoutId)
    }

    const listener = (source: { tabId?: number }, method: string, params?: unknown) => {
      if (source.tabId === tabId && matches(source, method, params)) {
        cleanup()
        resolve(buildResult())
      }
    }

    const timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error(timeoutMessage))
    }, timeout)

    chrome.debugger.onEvent.addListener(listener)
    enable().catch((error) => {
      cleanup()
      reject(error)
    })
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(pattern: string): RegExp {
  const escaped = escapeRegExp(pattern)
    .replaceAll('\\*\\*', '.*')
    .replaceAll('\\*', '[^/]*')
    .replaceAll('\\?', '.')
  return new RegExp(`^${escaped}$`)
}

function matchesUrlPattern(currentUrl: string, pattern: string): boolean {
  const normalizedPattern = String(pattern || '').trim()
  if (!normalizedPattern) {
    return false
  }

  if (currentUrl.includes(normalizedPattern)) {
    return true
  }

  if (normalizedPattern.includes('*') || normalizedPattern.includes('?')) {
    try {
      return globToRegExp(normalizedPattern).test(currentUrl)
    } catch {
      return false
    }
  }

  // 不将用户输入当作 RegExp 执行，避免 ReDoS 和意外语义；子串匹配已覆盖绝大多数 URL 等待场景。
  return false
}

export function createWaitFeature({
  getTargetTab,
  resolveElementSelectorForTab,
  evaluateInTabContext,
  sendDebuggerCommand,
}: PageObserveDependencies) {
  async function waitForLoadEvent(tabId: TabInput, timeout = 30000) {
    const tab = await getTargetTab(tabId)
    // 页面可能早已加载完成，之后不会再触发 load 事件，先查 readyState 避免空等到超时
    const { value: readyState } = await evaluateInTabContext<string>(tab.id, 'document.readyState')
    if (readyState === 'complete') {
      return { waited: true, condition: 'load' }
    }

    return await waitForDebuggerEvent(
      tab.id,
      timeout,
      async () => {
        await sendDebuggerCommand(tab.id, 'Page.enable', {})
      },
      (_, method) => method === 'Page.loadEventFired',
      () => ({ waited: true, condition: 'load' }),
      'wait load timeout',
    )
  }

  async function waitForNetworkIdle(tabId: TabInput, timeout = 30000) {
    const tab = await getTargetTab(tabId)
    return await waitForDebuggerEvent(
      tab.id,
      timeout,
      async () => {
        await Promise.all([
          sendDebuggerCommand(tab.id, 'Page.enable', {}),
          sendDebuggerCommand(tab.id, 'Page.setLifecycleEventsEnabled', { enabled: true }),
        ])
      },
      (_, method, params) => {
        const lifecycleParams = params as { name?: string } | undefined
        return method === 'Page.lifecycleEvent' && lifecycleParams?.name === 'networkidle'
      },
      () => ({ waited: true, condition: 'networkidle' }),
      'wait networkidle timeout',
    )
  }

  async function waitForSelectorState(
    tabId: TabInput,
    selector: string,
    state = 'visible',
    timeout = 30000,
    frameSelector: FrameSelector,
  ) {
    const { tab, resolvedSelector } = await resolveElementSelectorForTab(tabId, selector)
    const hidden = state === 'hidden'

    const getVisibleSignature = async () => {
      const { value } = await evaluateInTabContext<{ signature: string } | null>(
        tab.id,
        `(() => {
${PAGE_CONTEXT_TEXT_HELPERS_SOURCE}
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

          const visibleNodes = Array.from(deepQuerySelectorAll(document, ${JSON.stringify(resolvedSelector)})).filter((node) => {
            if (!(node instanceof HTMLElement)) {
              return false;
            }

            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              return false;
            }

            const style = node.ownerDocument.defaultView.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
          });

          if (visibleNodes.length === 0) {
            return null;
          }

          const fingerprint = visibleNodes
            .slice(0, 5)
            .map((node) => {
              const text = collapseWhitespace(node.innerText || node.textContent || '').slice(0, 80);
              const rect = node.getBoundingClientRect();
              const href = typeof node.href === 'string' ? node.href : node.getAttribute('href') || '';
              return [text, href, Math.round(rect.top), Math.round(rect.left), Math.round(rect.width), Math.round(rect.height)].join('~');
            })
            .join('|');

          return { signature: String(visibleNodes.length) + ':' + fingerprint };
        })()`,
        withFrameSelectorOptions(frameSelector),
      )

      return value?.signature || null
    }

    if (state === 'stable') {
      let previousSignature: string | null = null
      let stableRounds = 0

      return await pollUntil(
        timeout,
        async () => {
          const signature = await getVisibleSignature()

          if (!signature) {
            previousSignature = null
            stableRounds = 0
            return null
          }

          if (signature === previousSignature) {
            stableRounds += 1
          } else {
            previousSignature = signature
            stableRounds = 0
          }

          return stableRounds >= 1
            ? { waited: true, condition: 'selector-stable', selector, state }
            : null
        },
        `wait stable timeout: ${selector}`,
      )
    }

    if (state === 'new') {
      let baselineSignature: string | null = null

      return await pollUntil(
        timeout,
        async () => {
          const signature = await getVisibleSignature()

          if (!signature) {
            return null
          }

          if (baselineSignature === null) {
            baselineSignature = signature
            return null
          }

          return signature !== baselineSignature
            ? { waited: true, condition: 'selector-new', selector, state }
            : null
        },
        `wait new timeout: ${selector}`,
      )
    }

    return await pollUntil(
      timeout,
      async () => {
        const { value } = await evaluateInTabContext(
          tab.id,
          `(() => {
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

            const node = deepQuerySelector(document, ${JSON.stringify(resolvedSelector)});
            const visible = Boolean(node) && (() => {
              const rect = node.getBoundingClientRect();
              const style = node.ownerDocument.defaultView.getComputedStyle(node);
              return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            })();
            return ${hidden ? '!visible' : 'visible'};
          })()`,
          withFrameSelectorOptions(frameSelector),
        )

        return value === true ? { waited: true, condition: 'selector', selector, state } : null
      },
      `wait selector timeout: ${selector}`,
    )
  }

  async function waitForUrl(
    tabId: TabInput,
    urlPattern: string,
    timeout = 30000,
    frameSelector: FrameSelector,
  ) {
    return await pollUntil(
      timeout,
      async () => {
        const { value } = await evaluateInTabContext<string>(
          tabId,
          'window.location.href',
          withFrameSelectorOptions(frameSelector),
        )
        const currentUrl = value || ''
        if (!matchesUrlPattern(currentUrl, urlPattern)) {
          return null
        }

        return {
          waited: true,
          condition: 'url',
          url: currentUrl,
          pattern: urlPattern,
        }
      },
      `wait url timeout: ${urlPattern}`,
    )
  }

  async function waitForText(
    tabId: TabInput,
    text: string,
    timeout = 30000,
    frameSelector: FrameSelector,
    gone = false,
  ) {
    return await pollUntil(
      timeout,
      async () => {
        // 匹配在页面内完成，每轮 poll 只回传布尔值，避免整页 innerText 经 CDP 回传。
        // gone 时条件取反：body 不存在也视为"已消失"，与 textGone 语义对齐
        const { value } = await evaluateInTabContext<boolean>(
          tabId,
          gone
            ? `document.body ? !document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}) : true`
            : `document.body ? document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}) : false`,
          withFrameSelectorOptions(frameSelector),
        )
        return value === true
          ? { waited: true, condition: gone ? 'text-gone' : 'text', text }
          : null
      },
      `wait ${gone ? 'text-gone' : 'text'} timeout: ${text}`,
    )
  }

  async function waitForExpression(
    tabId: TabInput,
    expression: string,
    timeout = 30000,
    frameSelector: FrameSelector,
  ) {
    return await pollUntil(
      timeout,
      async () => {
        const { value } = await evaluateInTabContext(
          tabId,
          `((async () => {
            try {
              return Boolean(await Promise.resolve(Function('return (' + ${JSON.stringify(expression)} + ')')()));
            } catch (error) {
              return false;
            }
          })())`,
          // 单次 poll 的 evaluate 上限比 wait 自身超时更长：长 wait 不会被默认 25s 掐断，
          // 整体超时由 pollUntil 自己兜底并给出明确的 wait timeout 错误
          withFrameSelectorOptions(frameSelector, { timeoutMs: timeout + 5000 }),
        )

        return value === true ? { waited: true, condition: 'fn', expression } : null
      },
      `wait fn timeout: ${expression}`,
    )
  }

  async function waitWithTimeout(_tabId: TabInput, ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { waited: true, condition: 'time', ms }
  }

  return {
    waitForExpression,
    waitForLoadEvent,
    waitForNetworkIdle,
    waitForSelectorState,
    waitForText,
    waitForUrl,
    waitWithTimeout,
  }
}
