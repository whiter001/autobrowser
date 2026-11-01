/**
 * 媒体发现的页面内 DOM 逻辑。
 *
 * 这些函数既会被序列化后注入页面执行，也会被单元测试直接调用，因此必须自包含：
 * 只依赖入参和页面内建对象（document / window / URL），不引用模块级常量。
 */

/** 播放探测脚本的标记，测试用它识别"是否触发了播放" */
export const MEDIA_PLAY_PROBE_MARKER = 'autobrowser:media-resolve-play'

/** 播放探测里每个视频的最长播放时长（毫秒），总计不超过约 1 秒 */
export const MEDIA_PLAY_PROBE_MS = 600

/** 采集作用域的描述：既能表达用户限定的容器，也能如实表达默认作用域 */
export interface MediaScope {
  /** 用户指定的 CSS 选择器；未指定时为 null */
  selector: string | null
  /** 作用域来源：selector=用户限定的容器，default=内置默认作用域 */
  mode: 'selector' | 'default'
  /** 命中的作用域容器数量；默认作用域下为页面内 article 数量（0 表示回退整页） */
  matchedCount: number
}

export function mediaToAbsolute(value: unknown, baseURI: string): string {
  if (!value) return ''
  try {
    return new URL(String(value), baseURI).href
  } catch {
    return ''
  }
}

export function mediaIsVisible(node: Element, view: Window): boolean {
  try {
    const rect = node.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return false
    const style = view.getComputedStyle(node)
    if (style) {
      if (style.display === 'none') return false
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
      if (Number(style.opacity) === 0) return false
    }
    return true
  } catch {
    return false
  }
}

export function mediaParseSrcset(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
}

/**
 * 解析采集作用域。
 * 指定选择器时只保留匹配到的容器；未指定时沿用默认作用域（页面内的 article 容器）。
 */
export function mediaResolveScope(doc: Document, selector: string | null) {
  const trimmed = typeof selector === 'string' ? selector.trim() : ''
  if (trimmed) {
    const roots = Array.from(doc.querySelectorAll(trimmed))
    return {
      scope: { selector: trimmed, mode: 'selector', matchedCount: roots.length } as MediaScope,
      roots,
    }
  }
  const articles = Array.from(doc.querySelectorAll('article'))
  return {
    scope: { selector: null, mode: 'default', matchedCount: articles.length } as MediaScope,
    roots: articles,
  }
}

/**
 * 收集作用域内的媒体元素。
 * 选择器模式只保留容器内的媒体（容器自身是 img/video 时也包含），并优先可见元素；
 * 默认模式保留原有行为：优先 article 内的可见媒体，退回 article 内媒体，再退回整页可见媒体。
 */
export function mediaCollectMediaElements(
  doc: Document,
  view: Window,
  roots: Element[],
  mode: 'selector' | 'default',
): Element[] {
  const all = Array.from(doc.querySelectorAll('img, video'))
  if (mode === 'selector') {
    const scoped: Element[] = []
    const seen = new Set<Element>()
    for (const root of roots) {
      const candidates: Element[] = []
      if (root.tagName === 'IMG' || root.tagName === 'VIDEO') candidates.push(root)
      for (const node of Array.from(root.querySelectorAll('img, video'))) candidates.push(node)
      for (const node of candidates) {
        if (seen.has(node)) continue
        seen.add(node)
        scoped.push(node)
      }
    }
    const visible = scoped.filter((node) => mediaIsVisible(node, view))
    return visible.length > 0 ? visible : scoped
  }

  const scoped = all.filter((node) => roots.some((root) => root.contains(node)))
  if (roots.length > 0) {
    const visibleScoped = scoped.filter((node) => mediaIsVisible(node, view))
    if (visibleScoped.length > 0) return visibleScoped
    if (scoped.length > 0) return scoped
    return all.filter((node) => mediaIsVisible(node, view))
  }
  const visible = all.filter((node) => mediaIsVisible(node, view))
  return visible.length > 0 ? visible : all
}

/** 作用域内的视频元素，顺序与采集到的媒体顺序一致 */
export function mediaScopedVideos(
  doc: Document,
  view: Window,
  roots: Element[],
  mode: 'selector' | 'default',
): HTMLVideoElement[] {
  return mediaCollectMediaElements(doc, view, roots, mode).filter(
    (node): node is HTMLVideoElement => node.tagName === 'VIDEO',
  )
}

/**
 * 视频是否已经能从 DOM 直接拿到可下载的源。
 * 相对地址先按 baseURI 解析再判断，保证与采集脚本里的判定口径一致。
 */
export function mediaHasFetchableSource(video: Element, baseURI: string): boolean {
  const currentSrc = (video as HTMLVideoElement).currentSrc || ''
  if (/^https?:/i.test(mediaToAbsolute(currentSrc, baseURI))) return true
  for (const source of Array.from(video.querySelectorAll('source'))) {
    const src = mediaToAbsolute(source.getAttribute('src'), baseURI)
    if (/^https?:/i.test(src)) return true
  }
  return false
}

/**
 * 作用域内没有直接 DOM 源的视频（blob: 或无 src）。
 * 探测只对这个集合验证成员资格；元素定位使用稳定 token，不使用下标。
 */
export function mediaProbeTargets(
  doc: Document,
  view: Window,
  roots: Element[],
  mode: 'selector' | 'default',
): HTMLVideoElement[] {
  const baseURI = doc.baseURI
  return mediaScopedVideos(doc, view, roots, mode).filter(
    (video) => !mediaHasFetchableSource(video, baseURI),
  )
}

/** 收集作用域内的全部元素，用于读取 CSS background-image */
export function mediaCollectBackgroundElements(
  doc: Document,
  roots: Element[],
  mode: 'selector' | 'default',
): Element[] {
  const scopeRoots =
    roots.length > 0 || mode === 'selector'
      ? roots
      : doc.documentElement
        ? [doc.documentElement]
        : []
  const result: Element[] = []
  const visit = (node: Element) => {
    result.push(node)
    for (const child of Array.from(node.children)) visit(child)
  }
  for (const root of scopeRoots) visit(root)
  return result
}

/**
 * 读取元素的 CSS background-image。
 * 优先 computed style，其次内联 style；多背景只取第一层，避免把装饰层当成内容图。
 */
export function mediaReadBackgroundUrl(
  element: Element,
  view: Window,
  baseURI: string,
): string | null {
  let value = ''
  try {
    const style = view.getComputedStyle(element)
    if (style) value = style.backgroundImage || ''
  } catch {
    value = ''
  }
  if (!value || value === 'none') {
    const inline = element.getAttribute('style') || ''
    const match = inline.match(/background(?:-image)?\s*:\s*([^;]+)/i)
    value = match ? match[1] : ''
  }
  if (!value || value === 'none') return null
  const match = value.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)/)
  if (!match) return null
  return mediaToAbsolute(match[2], baseURI) || null
}

/** 最近的祖先 article 容器 */
export function mediaNearestArticle(node: Element): Element | null {
  let current: Element | null = node
  while (current) {
    if (current.tagName === 'ARTICLE') return current
    current = current.parentElement
  }
  return null
}

/**
 * 条目的来源链接：最近 article 内首个指向 /status/ 的绝对链接。
 * 没有 article 或没有这类链接时返回 null。
 */
export function mediaReadPermalink(node: Element, baseURI: string): string | null {
  const article = mediaNearestArticle(node)
  if (!article) return null
  for (const link of Array.from(article.querySelectorAll('a[href]'))) {
    const absolute = mediaToAbsolute(link.getAttribute('href'), baseURI)
    if (absolute && absolute.includes('/status/')) return absolute
  }
  return null
}

/**
 * 视频的身份标识：用来确认探测时定位到的仍是采集时那一个视频。
 * 采集与探测是两次页面求值，中间 DOM 可能变化（下标会漂移），
 * 靠身份标识比对可以避免把请求算到别的视频头上。
 */
export function mediaVideoIdentity(video: Element): string {
  const registry = mediaElementRegistry(video.ownerDocument)
  let token = registry.tokens.get(video)
  if (!token) {
    token = registry.prefix + ':' + String(++registry.next)
    registry.tokens.set(video, token)
    registry.elements.set(token, video)
  }
  return token
}

/** 保存在同一 document 的 isolated world 中，不依赖 DOM 顺序或 URL。 */
export function mediaElementRegistry(doc: Document) {
  const target = doc as Document & {
    __autobrowserMediaRegistry?: {
      next: number
      prefix: string
      tokens: WeakMap<Element, string>
      elements: Map<string, Element>
    }
  }
  return (target.__autobrowserMediaRegistry ??= {
    next: 0,
    prefix: Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'),
    tokens: new WeakMap<Element, string>(),
    elements: new Map<string, Element>(),
  })
}

/**
 * 播放探测脚本：静音短播 → 等待 → pause → 还原 muted/播放状态。
 * 只调用 play/pause，不做任何导航、跳转或刷新；只播放 token 验证的作用域内原元素。
 */
export function buildMediaPlayProbeScript(options: {
  selector: string | null
  probeKey?: string
}): string {
  return `/* ${MEDIA_PLAY_PROBE_MARKER} */
(async () => {
${buildMediaDomHelpersSource()}

  const scope = mediaResolveScope(document, ${JSON.stringify(options.selector)});
  const targets = mediaProbeTargets(document, window, scope.roots, scope.scope.mode);
  const expectedIdentity = ${JSON.stringify(options.probeKey ?? '')};
  const video = mediaElementRegistry(document).elements.get(expectedIdentity);
  if (!expectedIdentity || !video || !video.isConnected || video.ownerDocument !== document || !targets.includes(video)) {
    return {
      attempted: false,
      played: false,
      error: 'the probe target video changed since the media list was collected'
    };
  }
  const errors = [];
  let played = false;
  const previousMuted = video.muted;
  const wasPlaying = !video.paused;
  let started = false;
  try {
    video.muted = true;
    const promise = video.play();
    if (promise && typeof promise.then === 'function') await promise;
    started = true;
    played = true;
  } catch (error) {
    errors.push(error && error.message ? String(error.message) : String(error));
  }
  if (started) {
    try {
      await new Promise((resolve) => setTimeout(resolve, ${MEDIA_PLAY_PROBE_MS}));
    } catch (error) { /* ignore */ }
    try { video.pause(); } catch (error) { /* ignore */ }
  }
  try { video.muted = previousMuted; } catch (error) { /* ignore */ }
  if (wasPlaying) {
    try { await video.play(); } catch (error) { /* ignore */ }
  }
  return {
    attempted: true,
    played: played,
    error: played
      ? null
      : errors.length > 0
        ? errors.join('; ')
        : 'the browser refused to start playback'
  };
})()`
}

/** 页面内采集脚本：只读 DOM 属性，不读 body 文本 */
export function buildMediaCollectScript(options: {
  selector: string | null
  includeBackground: boolean
}): string {
  return `(() => {
${buildMediaDomHelpersSource()}

  const scope = mediaResolveScope(document, ${JSON.stringify(options.selector)});
  const roots = scope.roots;
  const nodes = mediaCollectMediaElements(document, window, roots, scope.scope.mode);
  const probeTargets = mediaProbeTargets(document, window, roots, scope.scope.mode);
  const probeIndex = new Map();
  probeTargets.forEach((video, index) => probeIndex.set(video, index));
  const baseURI = document.baseURI;
  const items = nodes.map((node, index) => {
    const permalink = mediaReadPermalink(node, baseURI);
    if (node.tagName === 'IMG') {
      const candidates = [];
      const push = (value) => {
        const url = mediaToAbsolute(value, baseURI);
        if (url && candidates.indexOf(url) === -1) candidates.push(url);
      };
      push(node.currentSrc);
      push(node.getAttribute('src'));
      for (const candidate of mediaParseSrcset(node.getAttribute('srcset'))) push(candidate);
      return {
        index: index,
        type: 'image',
        url: candidates.length > 0 ? candidates[0] : null,
        currentSrc: node.currentSrc ? mediaToAbsolute(node.currentSrc, baseURI) : null,
        candidates: candidates,
        poster: null,
        duration: null,
        sources: [],
        permalink: permalink,
        background: false,
        probeIndex: null
      };
    }
    const sources = [];
    for (const source of Array.from(node.querySelectorAll('source'))) {
      const src = source.getAttribute('src');
      if (!src) continue;
      sources.push({ url: mediaToAbsolute(src, baseURI), contentType: source.getAttribute('type') || null });
    }
    const currentSrc = node.currentSrc ? mediaToAbsolute(node.currentSrc, baseURI) : null;
    const posterAttribute = node.getAttribute('poster');
    const duration = typeof node.duration === 'number' && isFinite(node.duration) ? node.duration : null;
    return {
      index: index,
      type: 'video',
      url: currentSrc || (sources.length > 0 ? sources[0].url : null),
      currentSrc: currentSrc,
      candidates: currentSrc ? [currentSrc] : [],
      poster: posterAttribute ? mediaToAbsolute(posterAttribute, baseURI) : null,
      duration: duration,
      sources: sources,
      permalink: permalink,
      background: false,
      probeIndex: probeIndex.has(node) ? probeIndex.get(node) : null,
      probeKey: mediaVideoIdentity(node)
    };
  });

  if (${options.includeBackground ? 'true' : 'false'}) {
    const seen = new Set(items.map((item) => item.url).filter(Boolean));
    for (const element of mediaCollectBackgroundElements(document, roots, scope.scope.mode)) {
      const url = mediaReadBackgroundUrl(element, window, baseURI);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      items.push({
        index: items.length,
        type: 'image',
        url: url,
        currentSrc: null,
        candidates: [url],
        poster: null,
        duration: null,
        sources: [],
        permalink: mediaReadPermalink(element, baseURI),
        background: true,
        probeIndex: null
      });
    }
  }

  return { items: items, scope: scope.scope, pageUrl: location.href };
})()`
}

/** 注入页面所需的辅助函数源码（自包含，按依赖顺序拼接） */
export function buildMediaDomHelpersSource(): string {
  return [
    mediaToAbsolute,
    mediaIsVisible,
    mediaParseSrcset,
    mediaResolveScope,
    mediaCollectMediaElements,
    mediaScopedVideos,
    mediaHasFetchableSource,
    mediaProbeTargets,
    mediaElementRegistry,
    mediaVideoIdentity,
    mediaCollectBackgroundElements,
    mediaReadBackgroundUrl,
    mediaNearestArticle,
    mediaReadPermalink,
  ]
    .map((helper) => helper.toString())
    .join('\n\n')
}
