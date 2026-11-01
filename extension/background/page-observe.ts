import type { PageObserveDependencies } from './page-observe-context.js'
import { createFeedFeature } from './page-observe-feed.js'
import { createSemanticFindFeature } from './page-observe-find.js'
import { createScreenshotFeature } from './page-observe-screenshot.js'
import { createSearchFeature } from './page-observe-search.js'
import { createSnapshotFeature } from './page-observe-snapshot.js'
import { createWaitFeature } from './page-observe-wait.js'

export type { PageObserveDependencies } from './page-observe-context.js'
export type {
  CollectFeedOptions,
  FeedCollectionItem,
  FeedCollectionResult,
  FeedDedupeStrategy,
} from './page-observe-feed.js'
export type {
  FindSemanticTargetOptions,
  SemanticTargetMatch,
  SemanticTargetResult,
} from './page-observe-find.js'
export type {
  SearchMatchLine,
  SearchPageTextOptions,
  SearchPageTextResult,
  SearchWindow,
} from './page-observe-search.js'
export type { SnapshotTabOptions } from './page-observe-snapshot.js'

/**
 * 组合各观察子域（screenshot/snapshot/find/search/feed/wait）。
 * 各子域实现位于 page-observe-*.ts，这里只负责依赖注入与对外暴露的稳定接口。
 */
export function createPageObserveDomain(dependencies: PageObserveDependencies) {
  const { captureScreenshot } = createScreenshotFeature(dependencies)
  const { snapshotTab } = createSnapshotFeature(dependencies)
  const { findSemanticTarget } = createSemanticFindFeature(dependencies)
  const { searchPageText } = createSearchFeature(dependencies)
  const { collectFeed } = createFeedFeature(dependencies)
  const {
    waitForExpression,
    waitForLoadEvent,
    waitForNetworkIdle,
    waitForSelectorState,
    waitForText,
    waitForUrl,
    waitWithTimeout,
  } = createWaitFeature(dependencies)

  return {
    collectFeed,
    captureScreenshot,
    findSemanticTarget,
    searchPageText,
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
