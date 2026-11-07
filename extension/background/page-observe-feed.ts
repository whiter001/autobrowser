import type { PageObserveDependencies } from './page-observe-context.js'
import {
  normalizeFeedCount,
  PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE,
  PAGE_CONTEXT_TEXT_HELPERS_SOURCE,
} from './page-observe-helpers.js'
import { getPageEpoch, withFrameSelectorOptions } from './targeting.js'
import type { FrameSelector, TabInput } from './types.js'

const FEED_MAX_ITEMS = 200
const FEED_MAX_SCROLLS = 40

export type FeedDedupeStrategy = 'url' | 'text' | 'none'

export interface FeedCollectionItem extends Record<string, unknown> {
  index: number
  pageEpoch: number
  selector: string
  author: string | null
  handle: string | null
  time: string | null
  text: string
  url: string | null
  mediaUrls: string[]
}

export interface FeedCollectionResult extends Record<string, unknown> {
  pageEpoch: number
  selector: string
  limit: number
  dedupe: FeedDedupeStrategy
  maxScrolls: number
  pauseMs: number
  stallRounds: number
  scrolls: number
  stopReason: 'limit' | 'maxScrolls' | 'stalled'
  count: number
  items: FeedCollectionItem[]
}

export interface CollectFeedOptions {
  selector: string
  limit: number
  dedupe: FeedDedupeStrategy
  maxScrolls: number
  pauseMs: number
  stallRounds: number
}

/**
 * 按策略生成 feed 条目去重键：none 不去重，url 缺失时回落到作者+正文。
 */
export function feedItemDedupeKey(
  strategy: FeedDedupeStrategy,
  item: { url: string | null; author: string | null; handle: string | null; text: string },
): string | null {
  if (strategy === 'none') return null
  if (strategy === 'url' && item.url?.trim()) return item.url.trim()
  return [item.author || '', item.handle || '', item.text].join('|').trim()
}

/**
 * 创建 feed 采集域：滚动收集条目、按策略去重并维护翻页状态。
 */
export function createFeedFeature({
  state,
  getTargetTab,
  evaluateInTabContext,
}: PageObserveDependencies) {
  async function collectFeed(
    tabId: TabInput,
    options: CollectFeedOptions,
    frameSelector: FrameSelector,
  ): Promise<FeedCollectionResult> {
    const tab = await getTargetTab(tabId)
    const pageEpoch = getPageEpoch(state, tab.id)
    const selector = String(options.selector || '').trim() || 'article'
    const limit = Math.min(FEED_MAX_ITEMS, normalizeFeedCount(options.limit, 30))
    const maxScrolls = Math.min(FEED_MAX_SCROLLS, normalizeFeedCount(options.maxScrolls, 20))
    const pauseMs = normalizeFeedCount(options.pauseMs, 900)
    const stallRounds = normalizeFeedCount(options.stallRounds, 3)
    const dedupe = options.dedupe

    const { value } = await evaluateInTabContext<FeedCollectionResult>(
      tab.id,
      `(async () => {
        const selector = ${JSON.stringify(selector)};
        const limit = ${limit};
        const maxScrolls = ${maxScrolls};
        const pauseMs = ${pauseMs};
        const stallRounds = ${stallRounds};
        const dedupe = ${JSON.stringify(dedupe)};
        const pageEpoch = ${pageEpoch};

${PAGE_CONTEXT_TEXT_HELPERS_SOURCE}
${PAGE_CONTEXT_DEEP_DOM_HELPERS_SOURCE}

        const normalize = (value) => collapseWhitespace(value || '').trim();
        const feedItemDedupeKey = ${feedItemDedupeKey.toString()};

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

        const readText = (node) => normalize(node.querySelector("[data-testid='tweetText']")?.innerText || node.innerText || node.textContent || '');

        const parseAuthorHandle = (value) => {
          const raw = normalize(value);
          if (!raw) {
            return { author: null, handle: null };
          }

          const handleMatch = raw.match(/@[A-Za-z0-9_]+/);
          if (!handleMatch) {
            return { author: raw, handle: null };
          }

          const author = normalize(raw.slice(0, handleMatch.index).replace(/[\\s·•|-–—]+$/, ''));
          return {
            author: author || null,
            handle: handleMatch[0],
          };
        };

        const readTime = (node) => {
          const timeNode = node.querySelector('time');
          return normalize(timeNode?.dateTime || timeNode?.getAttribute('datetime') || '') || null;
        };

        const readUrl = (node) => {
          const link = node.querySelector("a[href*='/status/']");
          return link && typeof link.href === 'string' ? link.href : null;
        };

        const readMediaUrls = (node) => {
          const sources = [
            ...Array.from(node.querySelectorAll('img[src]')).map((img) => img.currentSrc || img.src || img.getAttribute('src')),
            ...Array.from(node.querySelectorAll('video[src]')).map((video) => video.currentSrc || video.src || video.getAttribute('src')),
            ...Array.from(node.querySelectorAll('video source[src]')).map((source) => source.currentSrc || source.src || source.getAttribute('src')),
          ];

          return Array.from(new Set(sources.map((source) => normalize(source)).filter(Boolean)));
        };

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const items = [];
        const seen = new Set();
        let stopReason = 'limit';

        const collectVisibleItems = () => {
          let added = 0;

          for (const node of deepQuerySelectorAll(document, selector)) {
            if (items.length >= limit) {
              break;
            }

            if (!(node instanceof HTMLElement) || !isVisible(node)) {
              continue;
            }

            const text = readText(node);
            const url = readUrl(node);
            const authorInfo = parseAuthorHandle(node.querySelector("[data-testid='User-Name']")?.innerText || '');
            const mediaUrls = readMediaUrls(node);
            const dedupeKey = normalize(feedItemDedupeKey(dedupe, {
              url,
              author: authorInfo.author,
              handle: authorInfo.handle,
              text
            }) || '');

            if (dedupeKey) {
              if (seen.has(dedupeKey)) {
                continue;
              }

              seen.add(dedupeKey);
            }

            items.push({
              index: items.length + 1,
              pageEpoch,
              selector,
              author: authorInfo.author,
              handle: authorInfo.handle,
              time: readTime(node),
              text: text.slice(0, 2400),
              url,
              mediaUrls,
            });
            added += 1;
          }

          return added;
        };

        const scrollAndWait = async () => {
          const beforeScrollY = window.scrollY || 0;
          window.scrollBy(0, Math.max(200, Math.floor((window.innerHeight || 0) * 0.9)));
          await sleep(pauseMs);
          return (window.scrollY || 0) !== beforeScrollY;
        };

        let scrolls = 0;
        let stalledRounds = 0;

        while (items.length < limit && scrolls < maxScrolls) {
          const added = collectVisibleItems();
          if (items.length >= limit) {
            stopReason = 'limit';
            break;
          }

          if (added === 0) {
            stalledRounds += 1;
          } else {
            stalledRounds = 0;
          }

          if (stalledRounds > stallRounds) {
            stopReason = 'stalled';
            break;
          }

          const moved = await scrollAndWait();
          scrolls += 1;

          // 仅在本轮 added > 0 时才追加：避免与上面 added===0 分支双重计数
          if (!moved && added > 0) {
            stalledRounds += 1;
            if (stalledRounds > stallRounds) {
              stopReason = 'stalled';
              break;
            }
          }
        }

        if (items.length < limit && scrolls >= maxScrolls && stopReason === 'limit') {
          stopReason = 'maxScrolls';
        }

        collectVisibleItems();

        return {
          pageEpoch,
          selector,
          limit,
          dedupe,
          maxScrolls,
          pauseMs,
          stallRounds,
          scrolls,
          stopReason,
          count: items.length,
          items,
        };
      })()`,
      // 滚动采集可能远超默认 25s（maxScrolls * pauseMs），显式放宽 evaluate 上限避免被掐断
      withFrameSelectorOptions(frameSelector, { timeoutMs: maxScrolls * pauseMs + 60_000 }),
    )

    // 长滚动可能跨越导航；旧 document 的卡片不能作为新 epoch 的采集结果交付。
    if (getPageEpoch(state, tab.id) !== pageEpoch) {
      const error = new Error(
        `feed collection became stale: expected page epoch ${pageEpoch}, current page epoch ${getPageEpoch(state, tab.id)}`,
      ) as Error & { code?: string; suggestedAction?: string }
      error.code = 'STALE_FEED_STATE'
      error.suggestedAction =
        'Run feed collect again on the current page without navigating during collection.'
      throw error
    }

    // evaluate 抛异常时上层已 throw；这里只对空结果做结构兜底
    if (value && Array.isArray(value.items)) {
      return value
    }

    return {
      pageEpoch,
      selector,
      limit,
      dedupe,
      maxScrolls,
      pauseMs,
      stallRounds,
      scrolls: 0,
      stopReason: 'stalled',
      count: 0,
      items: [],
    }
  }

  return { collectFeed }
}
