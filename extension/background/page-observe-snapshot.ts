import { AGENT_FRAME_REF_ATTRIBUTE, AGENT_FRAME_REF_PREFIX } from '../../src/core/agent-handles.js'
import { AGENT_ELEMENT_REF_ATTRIBUTE } from '../../src/core/agent-selectors.js'
import { boundPageText } from './page-context-helpers.js'
import { createElementNotFoundError } from './page-input-helpers.js'
import type { PageObserveDependencies } from './page-observe-context.js'
import {
  PAGE_CONTEXT_SNAPSHOT_HELPERS_SOURCE,
  truncateSnapshotToByteLimit,
} from './page-observe-helpers.js'
import {
  getPageEpoch,
  resolveEffectiveFrameSelector,
  withFrameSelectorOptions,
} from './targeting.js'
import type { FrameSelector, TabInput } from './types.js'

const AGENT_SNAPSHOT_MAX_ELEMENTS = 200
const CONCISE_SNAPSHOT_MAX_ELEMENTS = 50
const SNAPSHOT_MAX_JSON_BYTES = 200_000

/** concise 元素只保留可操作字段；text 与坐标在大页面上占比最高，默认不返回。 */
const CONCISE_ELEMENT_FIELDS = [
  'ref',
  'tag',
  'role',
  'name',
  'value',
  'placeholder',
  'type',
  'href',
  'disabled',
  'checked',
] as const
const CONCISE_HEADING_FIELDS = ['ref', 'tag', 'text'] as const
// changed 模式是纯 diff：页面元信息、text、buttons、headings、frames 与 diff 无关，
// 即使 includeText 也不附带，保证空 diff 稳定在 1KB 以内。
const CHANGED_SNAPSHOT_FIELDS = [
  'pageEpoch',
  'elements',
  'unchangedCount',
  'full',
  'removedRefs',
  'truncated',
  'totalElements',
  'returnedElements',
  'suggestedAction',
] as const
const CONCISE_SNAPSHOT_FIELDS = [
  'pageEpoch',
  'title',
  'url',
  'readyState',
  'elements',
  'frames',
  'headings',
  // 截断诊断属于操作信息，保留在普通 concise 快照里；changed 模式的同名字段在其白名单中。
  'truncated',
  'totalElements',
  'returnedElements',
  'suggestedAction',
] as const

export interface SnapshotTabOptions {
  /** CSS selector 或 @eN ref：只截取该元素子树 */
  selector?: string
  /** 只返回匹配这些 role 的元素；空数组表示不过滤（保持默认行为） */
  roles?: string[]
  /** 增量模式：只返回相对上次快照新增/变化的元素，并带 unchangedCount 汇总 */
  changed?: boolean
  /**
   * 返回元素数量上限。只为 concise 抬升默认 50，硬上限仍是 AGENT_SNAPSHOT_MAX_ELEMENTS；
   * 字节预算不随 limit 放宽。
   */
  limit?: number
  /**
   * concise 普通快照显式附带整页 text；changed 模式始终是纯 diff，忽略该选项。
   * detailed 本来就带 text，不需要这个开关。
   */
  includeText?: boolean
  responseFormat?: 'concise' | 'detailed'
}

// limit 是用户可控输入：非法值回落到该格式的默认值，合法值夹在 [1, 200]，
// 保证 concise 能被抬到 200、detailed 也绝不会越过硬上限。
function resolveSnapshotMaxElements(
  responseFormat: SnapshotTabOptions['responseFormat'],
  limit: number | undefined,
): number {
  const fallback =
    responseFormat === 'detailed' ? AGENT_SNAPSHOT_MAX_ELEMENTS : CONCISE_SNAPSHOT_MAX_ELEMENTS
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return fallback
  }

  return Math.min(Math.floor(limit), AGENT_SNAPSHOT_MAX_ELEMENTS)
}

function projectFields(value: unknown, fields: readonly string[]): unknown {
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const field of fields) {
    if (source[field] !== undefined) projected[field] = source[field]
  }
  return projected
}

function projectFrames(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((frame) => {
    if (!frame || typeof frame !== 'object') return frame
    const {
      x: _x,
      y: _y,
      width: _width,
      height: _height,
      ...rest
    } = frame as Record<string, unknown>
    return rest
  })
}

/**
 * concise 输出投影：只裁剪最终返回体，不参与签名、baseline、截断和遍历，
 * 因此缓存仍基于未投影结果，diff 语义不受影响。modal 阻塞分支单独返回，不走这里。
 */
function projectConciseSnapshot(
  result: Record<string, unknown>,
  options: { changed: boolean; includeText: boolean },
): Record<string, unknown> {
  const fields = options.changed ? CHANGED_SNAPSHOT_FIELDS : CONCISE_SNAPSHOT_FIELDS
  const projected: Record<string, unknown> = {}
  for (const field of fields) {
    if (!(field in result)) continue
    if (field === 'elements') {
      projected.elements = Array.isArray(result.elements)
        ? result.elements.map((item) => projectFields(item, CONCISE_ELEMENT_FIELDS))
        : result.elements
      continue
    }
    if (field === 'frames') {
      projected.frames = projectFrames(result.frames)
      continue
    }
    if (field === 'headings') {
      projected.headings = Array.isArray(result.headings)
        ? result.headings.map((item) => projectFields(item, CONCISE_HEADING_FIELDS))
        : result.headings
      continue
    }
    projected[field] = result[field]
  }
  if (!options.changed && options.includeText && 'text' in result) {
    projected.text = result.text
  }
  return projected
}

/**
 * 创建快照能力：把页面结构转成带 @eN 引用的紧凑文本，并维护引用与代次。
 */
export function createSnapshotFeature({
  state,
  getTargetTab,
  resolveElementSelectorForTab,
  evaluateInTabContext,
}: PageObserveDependencies) {
  // 增量快照缓存：按 tab + roles + 子树 selector + 元素上限缓存最近一次快照的元素签名，随 pageEpoch 变化作废。
  // 签名集合由 roles 过滤与子树范围共同决定，只按 tab 键控会让 role 子集快照覆盖全量签名，
  // 之后不带 roles 的全量 --changed 用子集签名 diff 全量元素，导致非目标角色被误判为 changed。
  // limit 同理：不同上限交付的元素不同，共用键会让被截掉的元素在下次更宽的 limit 下丢失 baseline。
  const snapshotSignatureCache = new Map<
    string,
    { pageEpoch: number; documentId?: string; signatures: string[] }
  >()

  const snapshotCacheKey = (
    tabId: number,
    roles: string[],
    selector: string | undefined,
    frame: FrameSelector | undefined,
    maxElements: number,
  ) =>
    JSON.stringify([tabId, [...roles].sort(), selector?.trim() || '', frame || 'top', maxElements])

  async function snapshotTab(
    tabId: TabInput,
    frameSelector: FrameSelector,
    options: SnapshotTabOptions = {},
  ) {
    // 子树截取：目标可以是 CSS selector 或 @eN ref，先解析成当前页面可用的 selector
    const targetSelector = options.selector
    const resolvedTarget = targetSelector?.trim()
      ? await resolveElementSelectorForTab(tabId, targetSelector.trim())
      : null
    const tab = resolvedTarget ? resolvedTarget.tab : await getTargetTab(tabId)
    const openDialog = state.session.dialogs.get(tab.id)
    if (openDialog) {
      // 页面被未处理的 JS 对话框阻塞：不执行 DOM 遍历（会挂起），直接返回 modal 描述
      return {
        pageEpoch: getPageEpoch(state, tab.id),
        title: null,
        url: null,
        readyState: 'blocked',
        text: '',
        elements: [],
        frames: [],
        headings: [],
        buttons: [],
        modal: {
          open: true,
          type: openDialog.type,
          message: boundPageText(openDialog.message, 1024),
          defaultPrompt: boundPageText(openDialog.defaultPrompt, 1024),
        },
      }
    }
    const pageEpoch = getPageEpoch(state, tab.id)
    const roles = options.roles ?? []
    const changedMode = Boolean(options.changed)
    // 字节预算只跟输出格式走，limit 再大也不放宽，避免 concise 变成无上限大包
    const maxElements = resolveSnapshotMaxElements(options.responseFormat, options.limit)
    const maxJsonBytes = options.responseFormat === 'detailed' ? SNAPSHOT_MAX_JSON_BYTES : 32_768
    // 增量模式：pageEpoch 未变时用上次缓存的签名做页内 diff，否则退化为全量
    const effectiveFrameSelector = resolveEffectiveFrameSelector(state, tab, frameSelector)
    const cacheKey = snapshotCacheKey(
      tab.id,
      roles,
      options.selector,
      effectiveFrameSelector,
      maxElements,
    )
    const cached = changedMode ? snapshotSignatureCache.get(cacheKey) : undefined
    const previousSignatures = cached && cached.pageEpoch === pageEpoch ? cached.signatures : []
    const refAttribute = AGENT_ELEMENT_REF_ATTRIBUTE
    const frameAttribute = AGENT_FRAME_REF_ATTRIBUTE
    const frameRefPrefix = AGENT_FRAME_REF_PREFIX
    const { value } = await evaluateInTabContext(
      tab.id,
      `(async () => {
        const refAttribute = ${JSON.stringify(refAttribute)};
        const frameAttribute = ${JSON.stringify(frameAttribute)};
        const frameRefPrefix = ${JSON.stringify(frameRefPrefix)};
        const pageEpoch = ${pageEpoch};
        const targetRootSelector = ${JSON.stringify(resolvedTarget?.resolvedSelector || null)};
        const roles = ${JSON.stringify(roles)};
        const changedMode = ${changedMode};
        const previousSignatures = ${JSON.stringify(previousSignatures)};

${PAGE_CONTEXT_SNAPSHOT_HELPERS_SOURCE}

        // 隐藏或冻结标签页可能不再执行宏任务，等待 timer 会让 CDP awaitPromise 永久挂起。
        const yieldToBrowser = () => document.hidden
          ? Promise.resolve()
          : new Promise(resolve => setTimeout(resolve, 0));
        const scope = targetRootSelector ? deepQuerySelector(document, targetRootSelector) : document;
        if (!scope) {
          return { found: false, pageEpoch };
        }

        const observation = getPageObservationState(document, pageEpoch);
        const documentId = observation.id;
        const sameDocument = documentId === ${JSON.stringify(cached?.documentId || null)};
        const previousSet = new Set(sameDocument ? previousSignatures : []);
        const deepElements = deepCollectElements(scope);
        await yieldToBrowser();
        // 传入遍历根：scope 为 document 时名称索引覆盖整棵树，未命中即确定负结果。
        const nameIndex = createPageNameIndex(deepElements, scope);
        await yieldToBrowser();
        let fieldsTruncated = false;
        const bounded = (value, limit = 1024) => {
          const text = String(value ?? '');
          const result = boundPageText(text, limit);
          if (result.length < text.length) fieldsTruncated = true;
          return result;
        };
        const isPassword = (node) => node instanceof HTMLInputElement && node.type.toLowerCase() === 'password';
        // 密码值不参与名称兜底、文本或签名；保留显式可访问名称以便定位。
        const readValue = (node) => !isPassword(node) && typeof node.value === 'string' ? node.value : null;
        const readText = (node) => isPassword(node) ? '' : collapseWhitespace(bounded(node.innerText || node.textContent || '', 2048));
        const getAssociatedLabel = (node) => {
          const label = nameIndex.lookupLabel(node, node.id);
          return label ? readText(label) : '';
        };
        const getAriaLabelledByText = (node) => splitWhitespaceTokens(node.getAttribute('aria-labelledby'))
          .map((id) => nameIndex.lookupId(node, id)).filter(Boolean).map(readText).filter(Boolean).join(' ');

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

        const names = new Map();
        const getName = (node) => {
          if (!names.has(node)) names.set(node,
            node.getAttribute('aria-label')?.trim() || getAriaLabelledByText(node) ||
            getAssociatedLabel(node) || node.getAttribute('alt')?.trim() ||
            node.getAttribute('title')?.trim() || node.getAttribute('placeholder')?.trim() ||
            readValue(node)?.trim() || readText(node));
          return names.get(node);
        };

        const toNodeSummary = (node) => ({
          tag: bounded(node.tagName),
          text: bounded(readText(node), 120),
          id: bounded(node.id) || null,
          className: typeof node.className === "string" ? bounded(node.className) : null,
          ref: node.getAttribute(refAttribute)
            ? '@' + bounded(node.getAttribute(refAttribute), 100) + '#p' + pageEpoch
            : null,
        });

        // 元素/frame 的 document/epoch 高水位与 find 共用；删除节点不回收编号，
        // 子树和角色过滤不清理其它节点的 ref，也不会降低高水位。

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

        // 合并成单个选择器，一次遍历取齐全部候选（deepQuerySelectorAll 内部已去重）
        const actionableSelector = selectors.join(',');
        const candidates = deepQuerySelectorAll(scope, actionableSelector);
        // Element.querySelectorAll 不含根自身，子树根命中选择器时补进候选
        if (scope instanceof HTMLElement && scope.matches(actionableSelector)) {
          candidates.unshift(scope);
        }

        const encoder = new TextEncoder();
        const size = (value) => encoder.encode(JSON.stringify(value)).length;
        // 输出预留 80KB 给内部签名、删除项与截断诊断；每个条目仅序列化一次计费。
        const result = {
          pageEpoch, documentId,
          title: bounded(document.title), url: bounded(location.href),
          readyState: bounded(document.readyState),
          text: bounded(scope === document ? document.body?.innerText || '' : isPassword(scope) ? '' : scope.innerText || '', 5000),
          elements: [], frames: [], headings: [], buttons: [],
        };
        let remaining = 120000 - size(result);
        let truncated = false;
        const append = (list, item, limit) => {
          const cost = size(item) + 1;
          if (list.length >= limit || cost > remaining) { truncated = true; return false; }
          list.push(item); remaining -= cost; return true;
        };
        const signatureOf = (item) => {
          const text = JSON.stringify(item);
          let a = 2166136261, b = 5381;
          for (let i = 0; i < text.length; i++) {
            a = Math.imul(a ^ text.charCodeAt(i), 16777619);
            b = Math.imul(b, 33) ^ text.charCodeAt(i);
          }
          return item.ref + '~' + (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
        };
        const signatures = [];
        const retained = [];
        const currentRefs = new Set();
        let totalElements = 0, unchangedCount = 0;
        // 第一趟集中读布局（含 frame）；ref 属性可能被页面 CSS 使用，不能逐节点读写交错。
        const selectedElements = [];
        for (const element of candidates) {
          if (!(element instanceof HTMLElement)) continue;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' ||
              style.visibility === 'hidden' || Number(style.opacity || '1') === 0) continue;
          const role = inferRole(element);
          if (roles.length > 0 && (!role || !roles.includes(role))) continue;
          selectedElements.push({ element, rect, role });
        }
        const selectedFrames = [];
        for (const frame of deepQuerySelectorAll(scope, 'iframe')) {
          if (!(frame instanceof HTMLIFrameElement)) continue;
          const rect = frame.getBoundingClientRect(), style = getComputedStyle(frame);
          if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' ||
              style.visibility === 'hidden' || Number(style.opacity || '1') === 0) continue;
          selectedFrames.push({ frame, rect });
        }
        await yieldToBrowser();
        // 第二趟批量分配 ref，再用已读 rect 构造条目。
        const elementIndexes = computeStableRefIndexes(deepQuerySelectorAll(document, '[' + refAttribute + ']'),
          selectedElements.map(({ element }) => element), refAttribute, 'e', parsePageContextElementRefIndex, observation.highWater);
        for (const { element, rect, role } of selectedElements) {
          const index = elementIndexes.get(element);
          const item = {
            ref: '@e' + index + '#p' + pageEpoch,
            tag: bounded(element.tagName.toLowerCase()), role: role ? bounded(role) : null,
            text: bounded(readText(element), 240), name: bounded(getName(element), 240),
            value: readValue(element) === null ? null : bounded(readValue(element)),
            placeholder: bounded(element.getAttribute('placeholder')) || null,
            type: element instanceof HTMLInputElement ? bounded(element.type || 'text') : null,
            href: element instanceof HTMLAnchorElement ? bounded(element.href) || null : null,
            disabled: 'disabled' in element ? Boolean(element.disabled) : false,
            checked: 'checked' in element ? Boolean(element.checked) : null,
            x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width), height: Math.round(rect.height),
          };
          totalElements++;
          currentRefs.add(item.ref);
          const signature = signatureOf(item);
          if (changedMode && previousSet.has(signature)) {
            unchangedCount++;
            if (retained.length < 1000) retained.push(signature);
          } else if (append(result.elements, item, ${maxElements})) signatures.push(signature);
          if (totalElements % 25 === 0) await yieldToBrowser();
        }
        const parseFrameRefIndex = (value) => {
          const match = /^f(\\d+)$/.exec(String(value || '').trim());
          return match ? Number(match[1]) : null;
        };
        computeStableRefIndexes(deepQuerySelectorAll(document, '[' + frameAttribute + ']'), [],
          frameAttribute, 'f', parseFrameRefIndex, observation.highWater);
        for (const { frame, rect } of selectedFrames) {
          const index = computeStableRefIndexes([], [frame], frameAttribute, 'f',
            parseFrameRefIndex, observation.highWater).get(frame);
          if (!append(result.frames, {
            ref: frameRefPrefix + index + '#p' + pageEpoch,
            name: bounded(frame.name) || null, title: bounded(frame.title) || null,
            src: bounded(frame.src || frame.getAttribute('src')) || null,
            x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width), height: Math.round(rect.height),
          }, ${maxElements})) break;
        }
        for (const node of deepQuerySelectorAll(scope, 'h1,h2,h3')) {
          if (!append(result.headings, toNodeSummary(node), 20)) break;
        }
        for (const node of deepQuerySelectorAll(scope, "button,[role='button'],input[type='button'],input[type='submit']")) {
          if (!append(result.buttons, toNodeSummary(node), 20)) break;
        }
        const removedRefs = sameDocument ? previousSignatures.map((s) => s.split('~')[0]).filter((ref) => !currentRefs.has(ref)) : [];
        Object.assign(result, { signatures: [...signatures, ...retained].slice(0, 1000) });
        if (changedMode) Object.assign(result, { unchangedCount, full: !sameDocument, removedRefs });
        if (truncated || fieldsTruncated) Object.assign(result, {
          truncated: true, totalElements, returnedElements: result.elements.length,
          suggestedAction: 'Narrow snapshot with selector/roles; use changed:true for undisclosed elements.',
        });
        // 大 DOM 的多趟遍历之间主动让出事件循环，避免渲染与 CDP 回执被连续计算饿死。
        await yieldToBrowser();
        return truncateSnapshotToByteLimit(result, ${maxJsonBytes});
      })()`,
      withFrameSelectorOptions(effectiveFrameSelector || 'top'),
    )

    // 子树目标不存在时与其它命令保持一致：按裸选择器或 @eN 引用给出对应错误
    if (value && (value as { found?: boolean }).found === false) {
      throw createElementNotFoundError(targetSelector?.trim() || '')
    }

    // 增量缓存更新：只认本次收集集的签名；found 检查之后再写，失败不污染缓存
    if (value && typeof value === 'object') {
      const { signatures, documentId, ...result } = value as Record<string, unknown>
      const delivered = truncateSnapshotToByteLimit(result, maxJsonBytes)
      if (Array.isArray(signatures)) {
        const refs = new Set(
          (Array.isArray(delivered.elements) ? delivered.elements : []).map(
            (item: { ref?: string }) => item.ref,
          ),
        )
        const previous = new Set(cached?.documentId === documentId ? previousSignatures : [])
        snapshotSignatureCache.set(cacheKey, {
          pageEpoch,
          documentId: typeof documentId === 'string' ? documentId : undefined,
          signatures: signatures
            .filter(
              (signature): signature is string =>
                typeof signature === 'string' &&
                (refs.has(signature.split('~')[0]) || previous.has(signature)),
            )
            .slice(0, 1000),
        })
      }
      // 投影只影响返回体：缓存写入在投影前完成，签名/ref/baseline 仍是未裁剪结果。
      return options.responseFormat === 'detailed'
        ? delivered
        : projectConciseSnapshot(delivered, {
            changed: changedMode,
            includeText: Boolean(options.includeText),
          })
    }

    return value
  }
  return { snapshotTab }
}
