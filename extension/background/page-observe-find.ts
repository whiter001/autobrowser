import { AGENT_ELEMENT_REF_ATTRIBUTE } from '../../src/core/agent-selectors.js'
import { createToolError } from '../../src/core/tool-error.js'
import type { PageObserveDependencies } from './page-observe-context.js'
import { PAGE_CONTEXT_FIND_HELPERS_SOURCE } from './page-observe-helpers.js'
import { getPageEpoch, withFrameSelectorOptions } from './targeting.js'
import type { FrameSelector, TabInput } from './types.js'

/** 与 snapshot 共用同一套语义：Ant Design Vue TreeSelect 节点没有显式 role，按 treeitem 处理。 */
const ANT_TREE_NODE_SELECTOR = '.ant-select-tree-node-content-wrapper[title]'

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
  empty?: boolean
  emptyReason?: 'NO_MATCH'
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
  /** locate 查询允许无匹配；动作命令仍应失败。 */
  allowNoMatch?: boolean
  /**
   * 嵌套容器定位：从外到内逐层收窄，每层必须是 CSS 选择器或 @eN 引用且在上一层内唯一。
   * 协议允许 string 或 string[]，最多 6 层；缺省表示全文档定位。
   */
  within?: string | string[]
}

/** within 的最大嵌套层数；再深通常意味着应该用 snapshot 或更精确的容器选择器。 */
const MAX_WITHIN_LAYERS = 6

/** 归一并校验 within：字符串视作单层，数组保持顺序；空值报 INVALID_COMMAND_ARGS 而不是静默忽略。 */
function normalizeWithinLayers(value: FindSemanticTargetOptions['within']): string[] {
  if (value === undefined || value === null) {
    return []
  }

  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
  if (!raw) {
    throw createToolError(
      'INVALID_COMMAND_ARGS',
      'within must be a string or an array of strings',
      {
        details: { field: 'within', received: value },
      },
    )
  }
  if (raw.length === 0) {
    return []
  }
  if (raw.length > MAX_WITHIN_LAYERS) {
    throw createToolError(
      'INVALID_COMMAND_ARGS',
      `within accepts at most ${MAX_WITHIN_LAYERS} nested layers`,
      {
        details: {
          field: 'within',
          received: raw.length,
          expected: `1..${MAX_WITHIN_LAYERS}`,
        },
      },
    )
  }

  const layers = raw.map((item) => (typeof item === 'string' ? item.trim() : ''))
  if (layers.some((layer) => !layer)) {
    throw createToolError(
      'INVALID_COMMAND_ARGS',
      'within layers must be non-empty selectors or @eN refs',
      { details: { field: 'within', received: raw } },
    )
  }
  return layers
}

const WITHIN_SUGGESTED_ACTIONS: Record<string, string> = {
  WITHIN_SCOPE_NOT_FOUND:
    'The --within layer matched nothing. Check details.layer/details.selector, and confirm the container is rendered inside the previous layer before retrying.',
  WITHIN_SCOPE_AMBIGUOUS:
    'The --within container matched multiple elements. Narrow details.selector (or pass an @eN ref from snapshot) until each layer resolves to exactly one container.',
  WITHIN_SCOPE_ESCAPE:
    'The layer target only exists outside the previous container. Order layers outer-to-inner and point each layer inside its parent; autobrowser will not widen the scope.',
}

/**
 * 创建语义定位能力：多策略匹配（文本、placeholder、test-id 等）与 Top-N 排序。
 */
export function createSemanticFindFeature({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  evaluateInTabContext,
}: PageObserveDependencies) {
  async function findSemanticTarget(
    tabId: TabInput,
    options: FindSemanticTargetOptions,
    frameSelector: FrameSelector,
  ): Promise<SemanticTargetResult> {
    const tab = await getTargetTab(tabId)
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

    // 容器层先逐层解析 @eN 与 pageEpoch：引用过期要在进入页面脚本前就按原协议报 STALE_ELEMENT_REF。
    const withinLayers = normalizeWithinLayers(options.within)
    const resolvedWithin: string[] = []
    for (const layer of withinLayers) {
      const resolved = await resolveElementSelectorForTab(tab.id, layer)
      resolvedWithin.push(resolved.resolvedSelector)
    }
    const pageEpoch = getPageEpoch(state, tab.id)

    const { value } = await evaluateInTabContext<SemanticTargetResult>(
      tab.id,
      `(async () => {
        const refAttribute = ${JSON.stringify(AGENT_ELEMENT_REF_ATTRIBUTE)};
        const pageEpoch = ${pageEpoch};
        const strategy = ${JSON.stringify(strategy)};
        const role = ${JSON.stringify(role.toLowerCase())};
        const query = ${JSON.stringify(query)};
        const name = ${JSON.stringify(name)};
        const exact = ${exact ? 'true' : 'false'};
        const position = ${JSON.stringify(position)};
        const candidatesCount = ${candidatesCount};
        const withinSelectors = ${JSON.stringify(resolvedWithin)};
        const antTreeNodeSelector = ${JSON.stringify(ANT_TREE_NODE_SELECTOR)};
        // 可点击判定与候选列表必须同时包含 TreeSelect 节点，否则 role/name 命中了却退回到普通文本节点
        const actionableSelector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role],[tabindex]:not([tabindex="-1"]),' + antTreeNodeSelector;

${PAGE_CONTEXT_FIND_HELPERS_SOURCE}

        const deepElements = deepCollectElements(document);
        const nameIndex = createPageNameIndex(deepElements, document);
        await new Promise(resolve => setTimeout(resolve, 0));
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

          if (node.matches(antTreeNodeSelector)) {
            return 'treeitem';
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

        // ---- within：逐层把搜索根收窄到唯一容器 ----
        // 容器必须是上一层的后代（与 Element.querySelectorAll 一致），最后一层容器自身仍可作为语义目标。
        let scopeRoot = null;

        const ensureRef = (node) => {
          const index = computeStableRefIndexes([], [node], refAttribute, 'e',
            parsePageContextElementRefIndex, observation.highWater).get(node);
          return '@e' + index + '#p' + pageEpoch;
        };

        const parentAcrossShadow = (node) => {
          if (node.parentElement) return node.parentElement;
          if (node.parentNode && node.parentNode.nodeType === 1) return node.parentNode;
          const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
          return root && root.host ? root.host : null;
        };

        const describeContainer = (node) => {
          const rect = node.getBoundingClientRect();
          return {
            ref: ensureRef(node),
            tag: boundPageText(String(node.tagName || '').toLowerCase()),
            text: boundPageText(readText(node), 120),
            name: boundPageText(getAccessibleName(node), 120),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        };

        const resolveWithinScope = () => {
          if (withinSelectors.length === 0) {
            return { root: null };
          }

          let root = null;
          for (let index = 0; index < withinSelectors.length; index += 1) {
            const layer = index + 1;
            const selector = withinSelectors[index];
            const matches = root
              ? deepQuerySelectorAll(root, selector)
              : deepQuerySelectorAll(document, selector);
            if (matches.length === 1) {
              root = matches[0];
              continue;
            }
            if (matches.length > 1) {
              return {
                error: {
                  code: 'WITHIN_SCOPE_AMBIGUOUS',
                  details: { layer, selector, candidates: matches.slice(0, 5).map(describeContainer) },
                  reason: 'within layer ' + layer + ' selector ' + selector + ' matched ' +
                    matches.length + ' elements; every container layer must be unique',
                },
              };
            }

            // 容器外存在同选择器目标说明层级顺序写错了；这和"选择器不存在"要分开报
            const outsideMatches = root ? deepQuerySelectorAll(document, selector) : [];
            if (outsideMatches.length > 0) {
              return {
                error: {
                  code: 'WITHIN_SCOPE_ESCAPE',
                  details: {
                    layer,
                    selector,
                    candidates: outsideMatches.slice(0, 5).map(describeContainer),
                  },
                  reason: 'within layer ' + layer + ' selector ' + selector +
                    ' only matched elements outside the previous container',
                },
              };
            }
            return {
              error: {
                code: 'WITHIN_SCOPE_NOT_FOUND',
                details: { layer, selector, candidates: [] },
                reason: 'within layer ' + layer + ' selector ' + selector + ' matched no element' +
                  (root ? ' inside the previous container' : ''),
              },
            };
          }
          return { root };
        };

        const withinResolution = resolveWithinScope();
        if (withinResolution.error) {
          return { found: false, ...withinResolution.error };
        }
        scopeRoot = withinResolution.root;

        // 无 within 时保持全文档候选；有 within 时只收容器子树（含容器自身）的节点
        const scopedElements = () => {
          if (!scopeRoot) return deepElements;
          const collected = deepCollectElements(scopeRoot);
          return scopeRoot instanceof HTMLElement ? [scopeRoot, ...collected] : collected;
        };

        const uniqueCandidates = (selectors) => {
          const selector = selectors.join(',');
          if (!scopeRoot) {
            return deepQuerySelectorAll(document, selector).filter(isVisible);
          }
          const matches = deepQuerySelectorAll(scopeRoot, selector);
          const scopedMatches =
            scopeRoot instanceof HTMLElement && scopeRoot.matches(selector)
              ? [scopeRoot, ...matches]
              : matches;
          return scopedMatches.filter(isVisible);
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
          antTreeNodeSelector,
        ]);

        // 惰性计算：broadTextCandidates 需要逐节点 isVisible（强制同步布局），
        // 只有 text 策略的兜底分支才真正用到
        let broadTextCandidates = null;
        const getBroadTextCandidates = () => {
          if (!broadTextCandidates) {
            broadTextCandidates = scopedElements().filter(
              (node) => node instanceof HTMLElement && isVisible(node),
            );
          }
          return broadTextCandidates;
        };

        const pickActionableNode = (node) => {
          if (!(node instanceof HTMLElement)) {
            return null;
          }

          // 无 within 时沿用 closest 原路径：不跨 shadow 边界，行为与之前完全一致
          if (!scopeRoot) {
            return node.matches(actionableSelector) ? node : node.closest(actionableSelector) || node;
          }

          // within 下上溯必须停在容器边界；找不到容器内可交互祖先时保留原节点，
          // 绝不把动作带到容器外（包括跨 shadow host 上溯）。
          for (let current = node; current; current = parentAcrossShadow(current)) {
            if (current.matches(actionableSelector)) {
              return current;
            }
            if (current === scopeRoot) {
              break;
            }
          }
          return node;
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

        // ---- candidates 展示去重 ----
        // 同一交互目标常被祖先包装节点重复命中（如 role=menuitem 的 <li> 与其内部 <a href>），
        // 二者共享 accessible name/文本与中心点。这里只在“嵌套 + 同点位 + 同名/同文本”时收敛，
        // 并列目标、位置不同的目标一律保留；locate/click 的匹配序列不经过这段逻辑。

        const candidateCenters = new Map();
        const readCandidateCenter = (node) => {
          if (!candidateCenters.has(node)) {
            const rect = node.getBoundingClientRect();
            // 与 toTargetDescriptor 的取整一致，避免亚像素差异把同一目标判成两个点位
            candidateCenters.set(
              node,
              Math.round(rect.left + rect.width / 2) + ':' + Math.round(rect.top + rect.height / 2),
            );
          }
          return candidateCenters.get(node);
        };

        const isNativeInteractive = (node) => {
          const tagName = String(node.tagName || '').toLowerCase();
          if (tagName === 'a') {
            return Boolean(node.getAttribute('href'));
          }
          return ['button', 'input', 'textarea', 'select', 'summary'].includes(tagName);
        };

        // deepCollectElements 同时收光 DOM 与影子树节点，祖先判定要能跨 shadow 边界上溯
        const isAncestorNode = (ancestor, node) => {
          for (let current = node; current; ) {
            if (current === ancestor) {
              return true;
            }
            const parent = current.parentElement || current.parentNode;
            if (parent) {
              current = parent;
              continue;
            }
            const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
            current = root && root.host ? root.host : null;
          }
          return false;
        };

        // 名称或文本任一相同即视为同一目标文案；两者都空时不合并，避免误删无文案的真实目标
        const sharesCandidateText = (left, right) => {
          const leftName = getAccessibleName(left);
          if (leftName && leftName === getAccessibleName(right)) {
            return true;
          }
          const leftText = readText(left);
          return Boolean(leftText) && leftText === readText(right);
        };

        // 原生可交互元素比纯 role/tabindex 包装更具体；同类时保留更深的那个
        const prefersNestedTarget = (outer, inner) => {
          const outerNative = isNativeInteractive(outer);
          const innerNative = isNativeInteractive(inner);
          if (outerNative !== innerNative) {
            return innerNative;
          }
          return true;
        };

        const dedupeNestedCandidates = (sorted) => {
          const kept = [];
          const buckets = new Map();
          for (const candidate of sorted) {
            const node = candidate.node;
            const center = readCandidateCenter(node);
            // 只有同中心点的节点才可能互为重复，按点位分桶避免 O(n²) 全量祖先比较
            let bucket = buckets.get(center);
            if (!bucket) {
              bucket = [];
              buckets.set(center, bucket);
            }
            let merged = false;
            for (const keptIndex of bucket) {
              const existing = kept[keptIndex];
              const related =
                existing.node === node ||
                isAncestorNode(existing.node, node) ||
                isAncestorNode(node, existing.node);
              if (!related || !sharesCandidateText(existing.node, node)) {
                continue;
              }
              // 原位替换：沿用外层节点已占的排序位，Top-N 顺序保持稳定
              if (prefersNestedTarget(existing.node, node)) {
                kept[keptIndex] = candidate;
              }
              merged = true;
              break;
            }
            if (!merged) {
              bucket.push(kept.length);
              kept.push(candidate);
            }
          }
          return kept;
        };

        // text 策略的 broad 兜底会收进所有含文本的可见节点，html/nav 等祖先会和真正的叶子
        // 同时命中；祖先在 DOM 顺序里靠前，first 会直接选中它。这里自底向上标记"含有另一个
        // 匹配后代"的节点并剔除，只保留最深层匹配：平行分支与独立同文节点没有祖先关系，
        // 因此全部保留，剩余节点的 DOM 顺序也不变。
        const dropMatchedAncestors = (broadMatches) => {
          if (broadMatches.length < 2) {
            return broadMatches;
          }

          const matchedNodes = new Set(broadMatches.map((candidate) => candidate.node));
          const ancestorNodes = new Set();
          for (const candidate of broadMatches) {
            let current = candidate.node.parentElement || candidate.node.parentNode;
            while (current) {
              if (matchedNodes.has(current)) {
                ancestorNodes.add(current);
              }
              const parent = current.parentElement || current.parentNode;
              if (parent) {
                current = parent;
                continue;
              }
              // 跨越 shadow 边界：DocumentFragment/ShadowRoot 没有父元素，但 host 仍算祖先
              const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
              current = root && root.host ? root.host : null;
            }
          }
          return broadMatches.filter((candidate) => !ancestorNodes.has(candidate.node));
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
            const broadMatches = [];
            for (const node of getBroadTextCandidates()) {
              if (matchesText(readText(node), query)) {
                broadMatches.push({ node, exact: isExactText(readText(node), query) });
              }
            }
            // 只收敛 text 兜底序列；后面的 requireUnique/first/last/nth 都作用于过滤结果
            for (const candidate of dropMatchedAncestors(broadMatches)) {
              matches.push(candidate);
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
          const deduped = dedupeNestedCandidates(sorted);
          return {
            found: true,
            pageEpoch,
            ...(withinSelectors.length > 0 ? { within: withinSelectors } : {}),
            empty: deduped.length === 0,
            ...(deduped.length === 0 ? { emptyReason: 'NO_MATCH' } : {}),
            candidates: deduped
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
                code: 'INVALID_COMMAND_ARGS',
                details: {
                  field: 'position',
                  received: position,
                  expected: matches.length > 0 ? 'nth=1..nth=' + matches.length : 'first|last',
                },
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

        // 大 DOM 的名称索引与匹配完成后，让渲染和 CDP 回执先于下一次命令得到调度。
        await new Promise(resolve => setTimeout(resolve, 0));
        return {
          found: true,
          pageEpoch,
          ...(withinSelectors.length > 0 ? { within: withinSelectors } : {}),
          match: toTargetDescriptor(selected),
        };
      })()`,
      withFrameSelectorOptions(frameSelector),
    )

    if (
      value?.code === 'WITHIN_SCOPE_NOT_FOUND' ||
      value?.code === 'WITHIN_SCOPE_AMBIGUOUS' ||
      value?.code === 'WITHIN_SCOPE_ESCAPE'
    ) {
      // 容器层失败不能落成普通 ELEMENT_NOT_FOUND：details.layer/selector 才能指向真正要收窄的那一层
      throw createToolError(value.code, value.reason || 'within container resolution failed', {
        details: value.details ?? { within: withinLayers },
        suggestedAction: WITHIN_SUGGESTED_ACTIONS[value.code],
      })
    }
    if (value?.code === 'AMBIGUOUS_TARGET') {
      const error = createToolError(
        'AMBIGUOUS_TARGET',
        value.reason || 'multiple targets matched',
        {
          details: { candidates: value.candidates },
          suggestedAction:
            'Refine name with exact:true, inspect candidates, or explicitly set position (first/last/nth=N).',
        },
      )
      Object.assign(error, { candidates: value.candidates })
      throw error
    }
    if (!value?.found || (!value?.match?.ref && !Array.isArray(value.candidates))) {
      if (options.allowNoMatch && value?.found === false && !value.code) {
        return { ...value, found: false, empty: true, emptyReason: 'NO_MATCH' }
      }
      const code = value?.code === 'INVALID_COMMAND_ARGS' ? value.code : 'ELEMENT_NOT_FOUND'
      throw createToolError(code, value?.reason || `failed to find ${strategy} target`, {
        details: value?.details ?? { strategy, query: query || role },
        suggestedAction:
          code === 'INVALID_COMMAND_ARGS'
            ? 'Use the position range in details.expected, then retry the query.'
            : 'Change the query, check the selected frame, or wait for the element before retrying.',
      })
    }

    return value
  }

  return { findSemanticTarget }
}
