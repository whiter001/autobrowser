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
  /** 头像图片地址；与正文媒体分开，避免把头像当成正文配图。 */
  avatarUrls: string[]
  /** 时间线上下文（如 "Hongbo Zhang 已转帖"）；没有则为 null。 */
  timelineContext: string | null
  /** 转帖人；不是转帖或识别不出时为 null，作者字段不受影响。 */
  repostBy: string | null
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

export function parseFeedAuthorHandle(value: string): {
  author: string | null
  handle: string | null
} {
  const raw = (value || '').replace(/\s+/g, ' ').trim()
  if (!raw) return { author: null, handle: null }

  const handleMatch = raw.match(/@[A-Za-z0-9_]+/)
  if (!handleMatch) return { author: raw, handle: null }

  const author = raw
    .slice(0, handleMatch.index)
    .replace(/[\s·•|-–—]+$/, '')
    .trim()
  return { author: author || null, handle: handleMatch[0] }
}

export function readFeedItemUrl(node: any): string | null {
  const preferred =
    node.querySelector("a[href*='/status/']") ||
    node.querySelector('h1 a[href], h2 a[href], h3 a[href]')
  const links = preferred ? [preferred] : Array.from(node.querySelectorAll('a[href]'))

  for (const link of links) {
    const href = typeof link.href === 'string' ? link.href : ''
    if (!/^https?:\/\//.test(href)) continue
    const text = (link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim()
    // 通用回退跳过头像等空链接，避免把作者主页误当成正文链接。
    if (!preferred && !text) continue
    return href
  }
  return null
}

export function readFeedItemAuthor(node: any): string {
  const explicit = node.querySelector(
    "[data-testid='User-Name'], [itemprop='author'], [rel='author'], [class*='author' i]",
  )
  const explicitText = (explicit?.innerText || explicit?.textContent || '').trim()
  if (explicitText) return explicitText

  // 部分搜索卡片没有作者链接，只用“粗体作者名 + 冒号”分隔正文。
  const boldAuthor = (Array.from(node.querySelectorAll('b')) as any[]).find((candidate) => {
    const name = (candidate.innerText || candidate.textContent || '').trim()
    return name && name.length <= 80 && /^[：:]/.test(candidate.nextSibling?.textContent || '')
  })
  return (boldAuthor?.innerText || boldAuthor?.textContent || '').trim()
}

export function readFeedItemTime(node: any): string | null {
  const normalize = (value: string) => (value || '').replace(/\s+/g, ' ').trim()
  const timeNode = node.querySelector(
    "time, [itemprop='datePublished'], [datetime], [class*='date' i], [class*='time' i]",
  )
  const explicit = normalize(
    timeNode?.dateTime || timeNode?.getAttribute('datetime') || timeNode?.innerText || '',
  )
  if (explicit) return explicit

  const text = normalize(node.innerText || node.textContent || '')
  const matches = text.match(
    /\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|(?<!\d)\d{1,2}-\d{1,2}(?!\d)/g,
  )
  return matches?.[matches.length - 1] || null
}

/**
 * 归一化时间线上下文文本；空白内容视为没有上下文。
 */
export function normalizeFeedTimelineContext(value: string): string | null {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized || null
}

/**
 * 头像 URL 判定：X 的头像固定走 /profile_images/ 路径，是最明确的头像信号。
 */
export function isFeedAvatarUrl(url: string): boolean {
  return /\/profile_images\//i.test(String(url || ''))
}

/**
 * 头像语义判定：类名、id、data-testid、alt 里出现 avatar 或 profile 图片语义时算头像容器。
 *
 * 只认 "profile + 图片名词" 的组合，"profile-card" 这类容器名不算头像语义，
 * 否则整张卡片会被误判成头像。
 */
export function isFeedAvatarMarker(value: string): boolean {
  return /avatar|profile[-_ ]?(?:pic|picture|img|image|photo|headshot)/i.test(String(value || ''))
}

/**
 * 判断一张图片是否属于头像：URL 特征 → 图片自身语义 → 祖先容器语义。
 */
export function isFeedAvatarImage(image: any): boolean {
  const source = String(image?.currentSrc || image?.src || image?.getAttribute?.('src') || '')
  if (isFeedAvatarUrl(source)) {
    return true
  }

  const own = [
    image?.getAttribute?.('class'),
    image?.getAttribute?.('id'),
    image?.getAttribute?.('data-testid'),
    image?.getAttribute?.('alt'),
  ]
    .filter(Boolean)
    .join(' ')
  if (isFeedAvatarMarker(own)) {
    return true
  }

  let ancestor = image?.parentElement
  for (let depth = 0; ancestor && depth < 4; depth += 1) {
    const marker = [
      ancestor.getAttribute?.('class'),
      ancestor.getAttribute?.('id'),
      ancestor.getAttribute?.('data-testid'),
    ]
      .filter(Boolean)
      .join(' ')
    if (isFeedAvatarMarker(marker)) {
      return true
    }
    ancestor = ancestor.parentElement
  }

  return false
}

/**
 * 读取卡片里的正文媒体与头像。
 *
 * mediaUrls 只保留正文图片/视频，头像单独进 avatarUrls；没有头像语义的普通站点图片
 * 一律回退为正文媒体，不能因为识别不出头像就整张丢弃。
 */
export function readFeedItemMedia(node: any): { mediaUrls: string[]; avatarUrls: string[] } {
  const mediaUrls: string[] = []
  const avatarUrls: string[] = []

  const push = (list: string[], value: unknown): void => {
    const url = String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (url && !list.includes(url)) {
      list.push(url)
    }
  }

  const images = Array.from(node.querySelectorAll?.('img[src]') || []) as any[]
  for (const image of images) {
    const source = image.currentSrc || image.src || image.getAttribute?.('src')
    if (isFeedAvatarImage(image)) {
      push(avatarUrls, source)
      continue
    }
    push(mediaUrls, source)
  }

  const videos = Array.from(node.querySelectorAll?.('video[src]') || []) as any[]
  for (const video of videos) {
    push(mediaUrls, video.currentSrc || video.src || video.getAttribute?.('src'))
  }

  const sources = Array.from(node.querySelectorAll?.('video source[src]') || []) as any[]
  for (const source of sources) {
    push(mediaUrls, source.currentSrc || source.src || source.getAttribute?.('src'))
  }

  return { mediaUrls, avatarUrls }
}

/**
 * 读取时间线上下文（如 "Hongbo Zhang 已转帖"）。
 *
 * 优先读 X 的 [data-testid='socialContext']；没有时回退到常见 social-context / repost
 * 语义容器，但绝不读整张卡片，避免把正文当成上下文。
 */
export function readFeedItemTimelineContext(node: any): string | null {
  const explicit = node.querySelector?.("[data-testid='socialContext']")
  const explicitText = normalizeFeedTimelineContext(
    explicit?.innerText || explicit?.textContent || '',
  )
  if (explicitText) {
    return explicitText
  }

  const fallbackSelector = [
    "[data-testid*='socialContext' i]",
    "[data-testid*='social-context' i]",
    "[class*='social-context' i]",
    "[class*='socialContext' i]",
    "[class*='repost' i]",
    "[class*='retweet' i]",
  ].join(', ')

  const cardText = normalizeFeedTimelineContext(node.innerText || node.textContent || '') || ''
  const candidates = Array.from(node.querySelectorAll?.(fallbackSelector) || []) as any[]
  for (const candidate of candidates) {
    // 普通帖子的操作按钮及其包装操作区都不是时间线上下文。
    if (
      candidate.tagName === 'BUTTON' ||
      candidate.getAttribute?.('role') === 'button' ||
      candidate.closest?.('button, [role="button"]') ||
      candidate.querySelector?.('button, [role="button"]')
    ) {
      continue
    }
    const text = normalizeFeedTimelineContext(candidate.innerText || candidate.textContent || '')
    if (!text || text.length > 200) {
      continue
    }
    // 文本长度和整卡一样，说明抓到的是整张卡片而不是上下文。
    if (cardText && text.length >= cardText.length) {
      continue
    }
    return text
  }

  return null
}

/**
 * 从时间线上下文里提取转帖人。
 *
 * 支持 "Hongbo Zhang 已转帖" 与 "Hongbo Zhang reposted"；不是转帖上下文或识别不出人名时返回 null。
 * 作者字段不受影响，转帖人不会顶替作者。
 */
export function parseFeedRepostBy(context: string | null): string | null {
  const normalized = normalizeFeedTimelineContext(context || '')
  if (!normalized) {
    return null
  }

  const chineseMarkers = ['已转帖', '已转发', '转帖了', '转发了', '转帖', '转发']
  // 先排除纯标记，再按完整标记切分，兼容没有空格的单字人名。
  if (chineseMarkers.some((marker) => normalized.startsWith(marker))) {
    return null
  }

  let name: string | null = null
  for (const marker of chineseMarkers) {
    const index = normalized.indexOf(marker)
    if (index > 0) {
      name = normalized.slice(0, index)
      break
    }
  }
  if (name === null) {
    const english = normalized.match(/^(.+?)\s+(?:reposted|retweeted|shared)\b/i)
    name = english?.[1] || null
  }
  if (name === null) {
    return null
  }

  name = name.replace(/[\s·•|]+$/, '').trim()
  if (!name || /^\d+\s*次$/.test(name)) {
    return null
  }
  // "Reposted by Hongbo Zhang" 这类模板句式提取不出人名，不要把标记词当成名字。
  if (/repost|retweet|shared|转帖|转发/i.test(name)) {
    return null
  }
  return name
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

        const parseAuthorHandle = ${parseFeedAuthorHandle.toString()};
        const readTime = ${readFeedItemTime.toString()};
        const readUrl = ${readFeedItemUrl.toString()};
        const readAuthor = ${readFeedItemAuthor.toString()};
        const normalizeFeedTimelineContext = ${normalizeFeedTimelineContext.toString()};
        const isFeedAvatarUrl = ${isFeedAvatarUrl.toString()};
        const isFeedAvatarMarker = ${isFeedAvatarMarker.toString()};
        const isFeedAvatarImage = ${isFeedAvatarImage.toString()};
        const readFeedItemMedia = ${readFeedItemMedia.toString()};
        const readFeedItemTimelineContext = ${readFeedItemTimelineContext.toString()};
        const parseFeedRepostBy = ${parseFeedRepostBy.toString()};

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
            const authorInfo = parseAuthorHandle(readAuthor(node));
            const media = readFeedItemMedia(node);
            const timelineContext = readFeedItemTimelineContext(node);
            const repostBy = parseFeedRepostBy(timelineContext);
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
              mediaUrls: media.mediaUrls,
              avatarUrls: media.avatarUrls,
              timelineContext,
              repostBy,
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
