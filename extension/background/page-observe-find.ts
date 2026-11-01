import { AGENT_ELEMENT_REF_ATTRIBUTE } from '../../src/core/agent-selectors.js'
import type { PageObserveDependencies } from './page-observe-context.js'
import { PAGE_CONTEXT_FIND_HELPERS_SOURCE } from './page-observe-helpers.js'
import { getPageEpoch, withFrameSelectorOptions } from './targeting.js'
import type { FrameSelector, TabInput } from './types.js'

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
  candidates?: SemanticTargetMatch[]
}

export interface FindSemanticTargetOptions {
  strategy: string
  role: string
  query: string
  name: string
  exact: boolean
  /** first / last / nth=N，缺省为 first */
  position?: string
  /** >0 时返回按质量排序的 Top-N 候选列表，而不是单个目标 */
  candidates?: number
  /** 写操作要求唯一目标；显式 position 仍可选择多匹配中的一项。 */
  requireUnique?: boolean
}

/**
 * 创建语义定位能力：多策略匹配（文本、placeholder、test-id 等）与 Top-N 排序。
 */
export function createSemanticFindFeature({
  state,
  getTargetTab,
  evaluateInTabContext,
}: PageObserveDependencies) {
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
    const position = String(options.position || 'first').trim()
    const candidatesCount =
      typeof options.candidates === 'number' &&
      Number.isFinite(options.candidates) &&
      options.candidates > 0
        ? Math.min(200, Math.floor(options.candidates))
        : 0

    if (
      !['role', 'text', 'label', 'placeholder', 'alt', 'title', 'test-id', 'exact-name'].includes(
        strategy,
      )
    ) {
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
        const position = ${JSON.stringify(position)};
        const candidatesCount = ${candidatesCount};
        const actionableSelector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role],[tabindex]:not([tabindex="-1"])';

${PAGE_CONTEXT_FIND_HELPERS_SOURCE}

        const deepElements = deepCollectElements(document);
        const nameIndex = createPageNameIndex(deepElements, document);
        const observation = getPageObservationState(document, pageEpoch);
        computeStableRefIndexes(deepElements, [], refAttribute, 'e', parsePageContextElementRefIndex, observation.highWater);
        const requireUnique = ${options.requireUnique === true && !options.position};

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

        const isPassword = (node) => node instanceof HTMLInputElement && node.type.toLowerCase() === 'password';
        // 与 snapshot 一致：密码不参与名称或文本兜底，也不读取 value getter。
        const readValue = (node) => !isPassword(node) && typeof node.value === 'string' ? normalizeText(node.value) : '';
        const readText = (node) => isPassword(node) ? '' : normalizeText(node?.innerText || node?.textContent || '');

        const getAssociatedLabelText = (node) => {
          // 原生 labels 已包含 for 关联；按节点身份合并双来源，保留不同 label 的同文语义。
          const labels = new Set();
          if ('labels' in node && node.labels) {
            for (const label of node.labels) labels.add(label);
          }
          if (node.id) {
            const externalLabel = nameIndex.lookupLabel(node, node.id);
            if (externalLabel) labels.add(externalLabel);
          }
          return normalizeText(Array.from(labels, readText).filter(Boolean).join(' '));
        };

        const getAriaLabelledByText = (node) => {
          const labelledBy = normalizeText(node.getAttribute('aria-labelledby'));
          if (!labelledBy) {
            return '';
          }

          return normalizeText(
            splitWhitespaceTokens(labelledBy)
              .map((id) => nameIndex.lookupId(node, id))
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

        const names = new Map();
        const getAccessibleName = (node) => {
          if (!names.has(node)) names.set(node,
            normalizeText(node.getAttribute('aria-label')) || getAriaLabelledByText(node) ||
            getAssociatedLabelText(node) || normalizeText(node.getAttribute('alt')) ||
            normalizeText(node.getAttribute('title')) || normalizeText(node.getAttribute('placeholder')) ||
            readValue(node) || readText(node));
          return names.get(node);
        };

        const uniqueCandidates = (selectors) =>
          deepQuerySelectorAll(document, selectors.join(',')).filter(isVisible);

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

        // 惰性计算：broadTextCandidates 需要逐节点 isVisible（强制同步布局），
        // 只有 text 策略的兜底分支才真正用到
        let broadTextCandidates = null;
        const getBroadTextCandidates = () => {
          if (!broadTextCandidates) {
            broadTextCandidates = deepElements.filter(
              (node) => node instanceof HTMLElement && isVisible(node),
            );
          }
          return broadTextCandidates;
        };

        const pickActionableNode = (node) => {
          if (!(node instanceof HTMLElement)) {
            return null;
          }

          return node.matches(actionableSelector) ? node : node.closest(actionableSelector) || node;
        };

        const ensureRef = (node) => {
          const index = computeStableRefIndexes([], [node], refAttribute, 'e',
            parsePageContextElementRefIndex, observation.highWater).get(node);
          return '@e' + index + '#p' + pageEpoch;
        };

        // 排序键：精确匹配优先于模糊，可交互优先于纯文本兜底；值越小越靠前
        const interactiveSet = new Set(interactiveCandidates);
        const isExactText = (candidate, needle) => {
          const normalizedCandidate = normalizeText(candidate).toLowerCase();
          const normalizedNeedle = normalizeText(needle).toLowerCase();
          return Boolean(normalizedNeedle) && normalizedCandidate === normalizedNeedle;
        };
        const rankMatch = (candidate) =>
          (candidate.exact ? 0 : 2) + (interactiveSet.has(candidate.node) ? 0 : 1);

        const toTargetDescriptor = (node) => {
          const actionable = pickActionableNode(node);
          const rect = actionable.getBoundingClientRect();
          return {
            ref: ensureRef(actionable),
            tag: boundPageText(String(actionable.tagName || '').toLowerCase()),
            role: boundPageText(inferRole(actionable)) || null,
            text: boundPageText(readText(actionable), 240),
            name: boundPageText(getAccessibleName(actionable), 240),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };

        // 按 DOM 顺序收集全部匹配，first/last/nth 都基于这个序列取值
        const matches = [];

        if (strategy === 'role') {
          for (const node of interactiveCandidates) {
            if (inferRole(node) !== role) {
              continue;
            }
            if (name && !matchesText(getAccessibleName(node), name)) {
              continue;
            }
            matches.push({
              node,
              exact: !name || isExactText(getAccessibleName(node), name),
            });
          }
        }

        if (strategy === 'text') {
          for (const node of interactiveCandidates) {
            if (matchesText(getAccessibleName(node), query) || matchesText(readText(node), query)) {
              matches.push({
                node,
                exact:
                  isExactText(getAccessibleName(node), query) || isExactText(readText(node), query),
              });
            }
          }
          if (matches.length === 0) {
            for (const node of getBroadTextCandidates()) {
              if (matchesText(readText(node), query)) {
                matches.push({ node, exact: isExactText(readText(node), query) });
              }
            }
          }
        }

        if (strategy === 'exact-name') {
          for (const node of interactiveCandidates) {
            if (isExactText(getAccessibleName(node), query) || isExactText(readText(node), query)) {
              matches.push({ node, exact: true });
            }
          }
          if (matches.length === 0) {
            for (const node of getBroadTextCandidates()) {
              if (isExactText(readText(node), query)) {
                matches.push({ node, exact: true });
              }
            }
          }
        }

        if (strategy === 'label') {
          for (const node of uniqueCandidates(['input:not([type="hidden"])', 'textarea', 'select'])) {
            if (
              matchesText(getAssociatedLabelText(node), query) ||
              matchesText(getAccessibleName(node), query)
            ) {
              matches.push({
                node,
                exact:
                  isExactText(getAssociatedLabelText(node), query) ||
                  isExactText(getAccessibleName(node), query),
              });
            }
          }
        }

        if (strategy === 'placeholder') {
          for (const node of uniqueCandidates(['input:not([type="hidden"])', 'textarea'])) {
            const placeholderText = normalizeText(node.getAttribute('placeholder'));
            if (placeholderText && matchesText(placeholderText, query)) {
              matches.push({ node, exact: isExactText(placeholderText, query) });
            }
          }
        }

        if (strategy === 'alt') {
          for (const node of uniqueCandidates(['[alt]'])) {
            const altText = normalizeText(node.getAttribute('alt'));
            if (altText && matchesText(altText, query)) {
              matches.push({ node, exact: isExactText(altText, query) });
            }
          }
        }

        if (strategy === 'title') {
          for (const node of getBroadTextCandidates()) {
            const titleText = normalizeText(node.getAttribute('title'));
            if (titleText && matchesText(titleText, query)) {
              matches.push({ node, exact: isExactText(titleText, query) });
            }
          }
        }

        if (strategy === 'test-id') {
          for (const node of uniqueCandidates(['[data-testid]'])) {
            const testId = normalizeText(node.getAttribute('data-testid'));
            if (testId && matchesText(testId, query)) {
              matches.push({ node, exact: isExactText(testId, query) });
            }
          }
        }

        if (requireUnique && matches.length > 1) {
          return { found: false, code: 'AMBIGUOUS_TARGET',
            reason: 'Multiple targets matched (' + matches.length + ').',
            candidates: matches.slice(0, 10).map((candidate) => toTargetDescriptor(candidate.node)),
          };
        }
        if (candidatesCount > 0) {
          const sorted = matches.slice().sort((a, b) => rankMatch(a) - rankMatch(b));
          return {
            found: true,
            pageEpoch,
            candidates: sorted
              .slice(0, candidatesCount)
              .map((candidate) => toTargetDescriptor(candidate.node)),
          };
        }

        let selected = null;
        if (matches.length > 0) {
          if (position === 'last') {
            selected = matches[matches.length - 1].node;
          } else if (position === 'first') {
            selected = matches[0].node;
          } else {
            const nthIndex = position.startsWith('nth=') ? Number(position.slice(4)) : NaN;
            if (!Number.isInteger(nthIndex) || nthIndex < 1 || nthIndex > matches.length) {
              return {
                found: false,
                reason:
                  'nth position out of range: ' +
                  position +
                  ' (only ' +
                  matches.length +
                  (matches.length === 1 ? ' match' : ' matches') +
                  ' found)',
              };
            }
            selected = matches[nthIndex - 1].node;
          }
        }

        if (!selected) {
          return {
            found: false,
            reason:
              strategy === 'role'
                ? 'no role match found: ' + role + (name ? ' (' + name + ')' : '')
                : 'no ' + strategy + ' match found: ' + query,
          };
        }

        return {
          found: true,
          pageEpoch,
          match: toTargetDescriptor(selected),
        };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (value?.code === 'AMBIGUOUS_TARGET') {
      throw Object.assign(new Error(value.reason), {
        code: 'AMBIGUOUS_TARGET',
        candidates: value.candidates,
        details: { candidates: value.candidates },
        suggestedAction:
          'Refine name with exact:true, inspect candidates, or explicitly set position (first/last/nth=N).',
      })
    }
    if (!value?.found || (!value?.match?.ref && !Array.isArray(value.candidates))) {
      throw new Error(value?.reason || `failed to find ${strategy} target`)
    }

    return value
  }

  return { findSemanticTarget }
}
