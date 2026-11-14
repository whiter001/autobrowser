# 文件与媒体下载

## 普通文件下载

- 普通文件：`download <url> [output-path]`，或用 `--output-dir <dir>` 根据响应头、URL filename、路径和 MIME 自动命名。默认原子覆盖，`--no-clobber` 拒绝覆盖。非 HLS 下载可用 `--dedupe-by-content` 按 SHA-256 跳过目录内已有的同内容 EPUB/MOBI，返回 `duplicate:true/duplicateOf`。`downloads list|clear` 只是 Chrome 下载历史，与真正落盘的 `download` 不同。
- 源站初始 fetch 对网络错误、429、5xx 默认额外重试 2 次；`--retries <0..5>` 调整，`--retries 0` 禁用，`--retry-delay-ms <ms>` 设置指数退避基础间隔（默认 250）。普通下载和 HLS 各请求都适用，重试共享原 timeout/deadline；上传开始后不重放整个文件。
- 设置默认下载目录需要独立 CDP browser endpoint；当前扩展的 tab session 和 `chrome.debugger.getTargets` 都无法提供该能力，不要反复尝试 `Page.setDownloadBehavior`。

## 页面媒体采集与下载

- 页面媒体：先 `autobrowser --tab t1 --frame top media list --selector 'article' --include-background --resolve`。确认有可信 HTTP(S) `sources/url` 后，假设返回 `pageEpoch=7`，使用 `autobrowser --tab t1 --frame top download --media 0 --selector 'article' --include-background --media-epoch 7 ./out.mp4`。index 是本次整个 scope 内按 DOM 顺序生成的编号，不是单个 article 内的编号；多容器命中时先结合 `scopeRoot`/`permalink` 和 `primarySource` 确认目标，再用于 `download --media`。index 仅在相同 tab/frame/scope/epoch 内有效，重新采集必须沿用 selector 和 include-background；epoch 不一致会失败，DOM 重排后应重新确认 index。
- 媒体作用域：`--selector <css>` 把 DOM 采集和播放探测限定到匹配容器，未命中时连背景图也返回空，不回退整页。每条媒体的 `scopeRoot` 标明所属容器的下标、标签、id、data-testid 和 permalink，多容器命中时据此筛选，不必猜测媒体归属。`--include-background` 额外采集作用域内 CSS 背景图。`media list --wait-for <css> --timeout-ms <ms>` 在扩展内对同一已解析 tab/frame 先等待再采集，失败不继续。旧扩展缺少 scope、背景支持或 wait 回显时 CLI 拒绝 scoped 成功。
- 媒体溯源：返回 `observedAt/pageEpoch/pageUrl/scope/includeBackground` 及条目 `permalink/scopeRoot/primarySource`（dom/none）。仅 DOM currentSrc/source 和图片/CSS 及其已知高分辨率变体是可信源；X 图片缩略图会派生 `name=large` 到 `highResolutionCandidates`，`url/sources` 优先使用高分辨率地址，`currentSrc` 保留原值并由 `resolutionHint` 提示。历史 tab-wide 网络候选从不认领。`--resolve` 用 document 内稳定 token 验证原元素 connected 且仍属 scope 后静音短播；只有实际 played 才可记录播放期间新增候选到 `observedSources`（`unverified:true`）。并发流量不能证明归属，observedSources 不进入 sources/url，也不可用于下载；只有诊断候选时仍 complete=false 并有 warning。失败或身份不符诊断为空。采集/探测中 epoch 改变报 `STALE_MEDIA_STATE`，重新采集，不拼接旧结果。

## MSE `blob:` 视频

- X 等站点的 MSE `blob:` 视频没有可信 DOM 源时，不要反复执行 `--resolve` 或尝试下载 blob；用 fresh HAR 获取实际播放请求：

  ```bash
  autobrowser --tab t1 network har start --include-pattern video.twimg.com
  autobrowser --tab t1 reload --wait-until domcontentloaded
  # 若刷新后没有自动播放，先播放目标视频，再停止采集
  autobrowser --tab t1 network har stop --include-urls
  # 从返回 URL 或 HAR 中选择 master m3u8，而不是某个分片
  autobrowser --tab t1 download '<master.m3u8>' out.mp4 --quality best --concurrency 4
  ```

  HLS 合并需要本机安装 `ffmpeg` 和 `ffprobe`。`observedSources` 为空只表示探测期间没有新增候选，不代表页面没有媒体请求。

## HLS 与传输边界

- HLS：`download <master.m3u8> <output.mp4> --quality best|worst|720|720p --concurrency 4`。自动下载最佳音视频轨并本地合并，FFmpeg/FFprobe 只读本地文件，不直接访问 CDN；本机需安装这两个工具。
- HLS 是一个任务：统一 `--timeout-ms`，分片有界并发，失败保留 checkpoint/已校验分片，相同命令下次续传，成功清理。上限 2048 分片、2GiB、4 层 playlist；不支持加密和 `EXT-X-BYTERANGE`。DASH 目前只能发现，不能合并下载。
- 所有媒体字节都经浏览器和本地鉴权 `/files/:transferId` 通道，不走 Base64/WebSocket。已知 Content-Length 且 >8MiB 时每次只缓冲一个 8MiB 块，relay 校验块/整文件 SHA-256；其他响应沿用缓冲传输。
- 仅 Chromium 扩展通道，不支持 WebDriver/MCP；底层单文件下载不能作为 `batch` 子步骤。单文件与并发预留上限 512MiB、最多128个上传，15秒无进度判定停滞。
