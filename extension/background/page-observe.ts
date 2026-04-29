import { AGENT_FRAME_REF_ATTRIBUTE, formatAgentFrameRef } from '../../src/core/agent-handles.js'
import { AGENT_ELEMENT_REF_ATTRIBUTE } from '../../src/core/agent-selectors.js'
import {
  collapseWhitespace,
  parsePageContextElementRefIndex,
  splitWhitespaceTokens,
} from './page-context-helpers.js'
import {
  getPageEpoch,
  resolveEffectiveFrameSelector,
  withFrameSelectorOptions,
} from './targeting.js'
import type {
  EvaluateInTabContextOptions,
  ExtensionState,
  FrameSelector,
  ResolvedFrameTarget,
  ResolvedSelectorTarget,
  ScreenshotCaptureOptions,
  TabInput,
  TabWithId,
} from './types.js'

const SCREENSHOT_ANNOTATION_OVERLAY_ID = 'autobrowser-screenshot-annotations'
const SCREENSHOT_ANNOTATION_MAX_ELEMENTS = 200
const AGENT_SNAPSHOT_MAX_ELEMENTS = 200

const PAGE_CONTEXT_TEXT_HELPERS_SOURCE = [
  collapseWhitespace.toString(),
  splitWhitespaceTokens.toString(),
].join('\n')

const PAGE_CONTEXT_FIND_HELPERS_SOURCE = [
  PAGE_CONTEXT_TEXT_HELPERS_SOURCE,
  parsePageContextElementRefIndex.toString(),
].join('\n')

interface ScreenshotAnnotationResult {
  count?: number
}

export interface SemanticTargetMatch extends Record<string, unknown> {
  ref?: string
  tag?: string
  role?: string
  text?: string
  name?: string
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface SemanticTargetResult extends Record<string, unknown> {
  found: boolean
  reason?: string
  pageEpoch?: number
  match?: SemanticTargetMatch
}

export interface FindSemanticTargetOptions {
  strategy: string
  role: string
  query: string
  name: string
  exact: boolean
}

interface PageObserveDependencies {
  state: ExtensionState
  getTargetTab: (tabId: TabInput) => Promise<TabWithId>
  resolveElementSelectorForTab: (
    tabId: TabInput,
    selector: string,
  ) => Promise<ResolvedSelectorTarget>
  resolveFrameTarget: (tabId: TabInput, selector: string) => Promise<ResolvedFrameTarget>
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

export function createPageObserveDomain({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  resolveFrameTarget,
  evaluateInTabContext,
  sendDebuggerCommand,
}: PageObserveDependencies) {
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

    try {
      return new RegExp(normalizedPattern).test(currentUrl)
    } catch {
      return false
    }
  }

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
          for (const element of document.querySelectorAll(selector)) {
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

      if (effectiveFrameSelector) {
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

  async function snapshotTab(tabId: TabInput, frameSelector: FrameSelector) {
    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const refAttribute = AGENT_ELEMENT_REF_ATTRIBUTE
    const frameAttribute = AGENT_FRAME_REF_ATTRIBUTE
    const frameRefPrefix = formatAgentFrameRef(1).replace('1', '')
    const { value } = await evaluateInTabContext(
      tab.id,
      `(() => {
        const refAttribute = ${JSON.stringify(refAttribute)};
        const frameAttribute = ${JSON.stringify(frameAttribute)};
        const frameRefPrefix = ${JSON.stringify(frameRefPrefix)};
        const pageEpoch = ${pageEpoch};

${PAGE_CONTEXT_TEXT_HELPERS_SOURCE}

        const readText = (node) => collapseWhitespace(node.innerText || node.textContent || '');

        const getAssociatedLabel = (node) => {
          if (!(node instanceof HTMLElement) || !node.id) {
            return '';
          }

          try {
            const label = document.querySelector('label[for="' + CSS.escape(node.id) + '"]');
            return label ? readText(label) : '';
          } catch {
            return '';
          }
        };

        const getAriaLabelledByText = (node) => {
          const labelledBy = node.getAttribute('aria-labelledby');
          if (!labelledBy) {
            return '';
          }

          return splitWhitespaceTokens(labelledBy)
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map((element) => readText(element))
            .filter(Boolean)
            .join(' ')
            .trim();
        };

        const inferRole = (node) => {
          const explicitRole = node.getAttribute('role');
          if (explicitRole) {
            return explicitRole;
          }

          const tagName = node.tagName.toLowerCase();
          if (tagName === 'a' && node.getAttribute('href')) return 'link';
          if (tagName === 'button') return 'button';
          if (tagName === 'select') return 'combobox';
          if (tagName === 'textarea') return 'textbox';
          if (tagName === 'summary') return 'button';
          if (tagName === 'input') {
            const inputType = (node.getAttribute('type') || 'text').toLowerCase();
            if (['button', 'submit', 'reset'].includes(inputType)) return 'button';
            if (inputType === 'checkbox') return 'checkbox';
            if (inputType === 'radio') return 'radio';
            return 'textbox';
          }

          return null;
        };

        const getName = (node) => {
          const candidates = [
            node.getAttribute('aria-label') || '',
            getAriaLabelledByText(node),
            getAssociatedLabel(node),
            node.getAttribute('alt') || '',
            node.getAttribute('title') || '',
            node.getAttribute('placeholder') || '',
            typeof node.value === 'string' ? node.value : '',
            readText(node),
          ]

          return candidates.find((value) => value && value.trim()) || '';
        };

        const toNodeSummary = (node) => ({
          tag: node.tagName,
          text: readText(node).slice(0, 120),
          id: node.id || null,
          className: typeof node.className === "string" ? node.className : null,
          ref: node.getAttribute(refAttribute)
            ? '@' + node.getAttribute(refAttribute) + '#p' + pageEpoch
            : null,
        });

        for (const element of document.querySelectorAll('[' + refAttribute + ']')) {
          element.removeAttribute(refAttribute);
        }

        for (const frameElement of document.querySelectorAll('[' + frameAttribute + ']')) {
          frameElement.removeAttribute(frameAttribute);
        }

        const selectors = [
          'a[href]',
          'button',
          'input:not([type="hidden"])',
          'textarea',
          'select',
          'summary',
          '[role]',
          '[tabindex]:not([tabindex="-1"])',
        ];

        const seen = new Set();
        const candidates = [];
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            if (seen.has(element)) {
              continue;
            }

            seen.add(element);
            candidates.push(element);
          }
        }

        const elements = [];
        for (const element of candidates) {
          if (!(element instanceof HTMLElement)) {
            continue;
          }

          if (elements.length >= ${AGENT_SNAPSHOT_MAX_ELEMENTS}) {
            break;
          }

          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') !== 0;

          if (!visible) {
            continue;
          }

          const refValue = 'e' + (elements.length + 1);
          element.setAttribute(refAttribute, refValue);

          elements.push({
            ref: '@' + refValue + '#p' + pageEpoch,
            tag: element.tagName.toLowerCase(),
            role: inferRole(element),
            text: readText(element).slice(0, 240),
            name: getName(element).slice(0, 240),
            placeholder: element.getAttribute('placeholder') || null,
            type: element instanceof HTMLInputElement ? element.type || 'text' : null,
            href: element instanceof HTMLAnchorElement ? element.href || null : null,
            disabled: 'disabled' in element ? Boolean(element.disabled) : false,
            checked: 'checked' in element ? Boolean(element.checked) : null,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }

        const frames = [];
        for (const frameElement of document.querySelectorAll('iframe')) {
          if (!(frameElement instanceof HTMLIFrameElement)) {
            continue;
          }

          if (frames.length >= ${AGENT_SNAPSHOT_MAX_ELEMENTS}) {
            break;
          }

          const rect = frameElement.getBoundingClientRect();
          const style = getComputedStyle(frameElement);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') !== 0;

          if (!visible) {
            continue;
          }

          const refValue = 'f' + (frames.length + 1);
          frameElement.setAttribute(frameAttribute, refValue);
          frames.push({
            ref: frameRefPrefix + (frames.length + 1) + '#p' + pageEpoch,
            name: frameElement.name || null,
            title: frameElement.title || null,
            src: frameElement.src || frameElement.getAttribute('src') || null,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }

        return {
          pageEpoch,
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          text: (document.body?.innerText || "").slice(0, 5000),
          elements,
          frames,
          headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 20).map(toNodeSummary),
          buttons: Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")).slice(0, 20).map(toNodeSummary),
        };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    return value
  }

  async function findSemanticTarget(
    tabId: TabInput,
    options: FindSemanticTargetOptions,
    frameSelector: FrameSelector,
  ): Promise<SemanticTargetResult> {
    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const strategy = String(options.strategy || '').trim()
    const role = String(options.role || '').trim()
    const query = String(options.query || '').trim()
    const name = String(options.name || '').trim()
    const exact = options.exact === true

    if (!['role', 'text', 'label'].includes(strategy)) {
      throw new Error(`unsupported find strategy: ${strategy || '(empty)'}`)
    }

    if (strategy === 'role' && !role) {
      throw new Error('missing role value')
    }

    if (strategy !== 'role' && !query) {
      throw new Error(`missing ${strategy} value`)
    }

    const { value } = await evaluateInTabContext<SemanticTargetResult>(
      tab.id,
      `(() => {
        const refAttribute = ${JSON.stringify(AGENT_ELEMENT_REF_ATTRIBUTE)};
        const pageEpoch = ${pageEpoch};
        const strategy = ${JSON.stringify(strategy)};
        const role = ${JSON.stringify(role.toLowerCase())};
        const query = ${JSON.stringify(query)};
        const name = ${JSON.stringify(name)};
        const exact = ${exact ? 'true' : 'false'};
        const actionableSelector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role],[tabindex]:not([tabindex="-1"])';

${PAGE_CONTEXT_FIND_HELPERS_SOURCE}

        const normalizeText = (value) => collapseWhitespace(value);

        const matchesText = (candidate, needle) => {
          const normalizedCandidate = normalizeText(candidate).toLowerCase();
          const normalizedNeedle = normalizeText(needle).toLowerCase();
          if (!normalizedNeedle) {
            return false;
          }

          return exact
            ? normalizedCandidate === normalizedNeedle
            : normalizedCandidate.includes(normalizedNeedle);
        };

        const isVisible = (node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }

          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return false;
          }

          const style = node.ownerDocument.defaultView.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
        };

        const readText = (node) => normalizeText(node?.innerText || node?.textContent || '');

        const getAssociatedLabelText = (node) => {
          const labels = [];

          if ('labels' in node && node.labels) {
            labels.push(
              ...Array.from(node.labels)
                .map((label) => readText(label))
                .filter(Boolean),
            );
          }

          if (node.id) {
            try {
              const externalLabel = document.querySelector('label[for="' + CSS.escape(node.id) + '"]');
              if (externalLabel) {
                labels.push(readText(externalLabel));
              }
            } catch {
              // Ignore invalid selectors.
            }
          }

          return normalizeText(labels.join(' '));
        };

        const getAriaLabelledByText = (node) => {
          const labelledBy = normalizeText(node.getAttribute('aria-labelledby'));
          if (!labelledBy) {
            return '';
          }

          return normalizeText(
            splitWhitespaceTokens(labelledBy)
              .map((id) => document.getElementById(id))
              .filter(Boolean)
              .map((element) => readText(element))
              .filter(Boolean)
              .join(' '),
          );
        };

        const inferRole = (node) => {
          const explicitRole = normalizeText(node.getAttribute('role'));
          if (explicitRole) {
            return explicitRole.toLowerCase();
          }

          const tagName = String(node.tagName || '').toLowerCase();
          if (tagName === 'a' && node.getAttribute('href')) return 'link';
          if (tagName === 'button') return 'button';
          if (tagName === 'select') return 'combobox';
          if (tagName === 'textarea') return 'textbox';
          if (tagName === 'summary') return 'button';
          if (tagName === 'input') {
            const inputType = normalizeText(node.getAttribute('type') || 'text').toLowerCase();
            if (['button', 'submit', 'reset'].includes(inputType)) return 'button';
            if (inputType === 'checkbox') return 'checkbox';
            if (inputType === 'radio') return 'radio';
            return 'textbox';
          }

          return null;
        };

        const getAccessibleName = (node) => {
          const candidates = [
            normalizeText(node.getAttribute('aria-label')),
            getAriaLabelledByText(node),
            getAssociatedLabelText(node),
            normalizeText(node.getAttribute('alt')),
            normalizeText(node.getAttribute('title')),
            normalizeText(node.getAttribute('placeholder')),
            typeof node.value === 'string' ? normalizeText(node.value) : '',
            readText(node),
          ];

          return candidates.find(Boolean) || '';
        };

        const uniqueCandidates = (selectors) => {
          const seen = new Set();
          const candidates = [];

          for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
              if (!(node instanceof HTMLElement) || seen.has(node)) {
                continue;
              }

              seen.add(node);
              if (isVisible(node)) {
                candidates.push(node);
              }
            }
          }

          return candidates;
        };

        const interactiveCandidates = uniqueCandidates([
          'a[href]',
          'button',
          'input:not([type="hidden"])',
          'textarea',
          'select',
          'summary',
          '[role]',
          '[tabindex]:not([tabindex="-1"])',
        ]);

        const broadTextCandidates = Array.from(document.querySelectorAll('body *')).filter(
          (node) => node instanceof HTMLElement && isVisible(node),
        );

        const pickActionableNode = (node) => {
          if (!(node instanceof HTMLElement)) {
            return null;
          }

          return node.matches(actionableSelector) ? node : node.closest(actionableSelector) || node;
        };

        const ensureRef = (node) => {
          const currentRef = normalizeText(node.getAttribute(refAttribute));
          if (currentRef) {
            return '@' + currentRef + '#p' + pageEpoch;
          }

          let maxIndex = 0;
          for (const element of document.querySelectorAll('[' + refAttribute + ']')) {
            const refValue = normalizeText(element.getAttribute(refAttribute));
            const refIndex = parsePageContextElementRefIndex(refValue);
            if (refIndex !== null) {
              maxIndex = Math.max(maxIndex, refIndex);
            }
          }

          const refValue = 'e' + (maxIndex + 1);
          node.setAttribute(refAttribute, refValue);
          return '@' + refValue + '#p' + pageEpoch;
        };

        let match = null;

        if (strategy === 'role') {
          match = interactiveCandidates.find((node) => {
            if (inferRole(node) !== role) {
              return false;
            }

            if (!name) {
              return true;
            }

            return matchesText(getAccessibleName(node), name);
          }) || null;
        }

        if (strategy === 'text') {
          match = interactiveCandidates.find((node) => {
            return matchesText(getAccessibleName(node), query) || matchesText(readText(node), query);
          }) || null;

          if (!match) {
            match = broadTextCandidates.find((node) => matchesText(readText(node), query)) || null;
          }

          match = pickActionableNode(match);
        }

        if (strategy === 'label') {
          match = uniqueCandidates(['input:not([type="hidden"])', 'textarea', 'select']).find((node) => {
            return (
              matchesText(getAssociatedLabelText(node), query) ||
              matchesText(getAccessibleName(node), query)
            );
          }) || null;
        }

        if (!match) {
          return {
            found: false,
            reason:
              strategy === 'role'
                ? 'no role match found: ' + role + (name ? ' (' + name + ')' : '')
                : 'no ' + strategy + ' match found: ' + query,
          };
        }

        const rect = match.getBoundingClientRect();
        return {
          found: true,
          pageEpoch,
          match: {
            ref: ensureRef(match),
            tag: String(match.tagName || '').toLowerCase(),
            role: inferRole(match),
            text: readText(match).slice(0, 240),
            name: getAccessibleName(match).slice(0, 240),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (!value?.found || !value?.match?.ref) {
      throw new Error(value?.reason || `failed to find ${strategy} target`)
    }

    return value
  }

  async function waitForLoadEvent(tabId: TabInput, timeout = 30000) {
    const tab = await getTargetTab(tabId)
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

    return await pollUntil(
      timeout,
      async () => {
        const { value } = await evaluateInTabContext(
          tab.id,
          `(() => {
            const node = document.querySelector(${JSON.stringify(resolvedSelector)});
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
  ) {
    return await pollUntil(
      timeout,
      async () => {
        const { value } = await evaluateInTabContext<string>(
          tabId,
          "document.body ? document.body.innerText : ''",
          withFrameSelectorOptions(frameSelector),
        )
        const pageText = (value || '').toLowerCase()
        return pageText.includes(text.toLowerCase())
          ? { waited: true, condition: 'text', text }
          : null
      },
      `wait text timeout: ${text}`,
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
          `(() => {
            try {
              return Boolean(Function('return (' + ${JSON.stringify(expression)} + ')')());
            } catch (error) {
              return false;
            }
          })()`,
          withFrameSelectorOptions(frameSelector),
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
    captureScreenshot,
    findSemanticTarget,
    snapshotTab,
    waitForExpression,
    waitForLoadEvent,
    waitForNetworkIdle,
    waitForSelectorState,
    waitForText,
    waitForUrl,
    waitWithTimeout,
  }
}
