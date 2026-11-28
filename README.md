# autobrowser

面向 AI 的浏览器自动化与页面数据采集 CLI：通过本地 relay 加 Chrome/Edge 扩展驱动真实浏览器，复用登录态，输出 token 友好的 JSON。

完整命令树以 `autobrowser help` 和 [`src/cli/help.ts`](src/cli/help.ts) 为准，较长的工作流见 [`docs/overview.md`](docs/overview.md)。

## 安装（从源码构建，推荐）

需要 [Bun](https://bun.sh) >= 1.4.4。在本仓库执行：

```bash
git pull --ff-only        # 已有工作副本时
bun install
bun run build:cli
bun run build:chrome
bun run link:bun
```

`link:bun` 会把原生启动器装到 Bun 旁边，并链接当前仓库的 `dist/autobrowser.js`。Windows 用 `autobrowser.exe`，其他平台用 `autobrowser`；确保 Bun 的 bin 目录在 `PATH` 中。

```bash
autobrowser version
autobrowser help
```

### 加载扩展

1. 打开 `chrome://extensions`，开启开发者模式。
2. 「加载已解压的扩展程序」选择仓库的 `chrome/` 目录。
3. 连接并确认：

```bash
autobrowser connect
autobrowser status      # 看到 extension: connected
autobrowser doctor
```

`connect` 打开扩展连接页并保存 token 与端口。页面打开不等于握手完成，以 `status` 为准。`autobrowser version` 与 `autobrowser extension info` 的 `commit` 应一致；不一致时重新 `bun run build:chrome`，再在 `chrome://extensions` 重载扩展。

### npm 安装（备选）

不想克隆仓库时：

```bash
npm i -g @whiter001/autobrowser
```

扩展目录为 `$(npm root -g)/@whiter001/autobrowser/chrome`，按上面的方式加载。本机仍需 Bun >= 1.4.4。

## 快速开始

```bash
autobrowser open https://example.com
autobrowser snapshot
```

`snapshot` 返回 `@e1` 元素、`@f1` frame 引用和页面 `pageEpoch`。后续操作优先用这些引用，而不是脆弱的 CSS。

### 页面与定位

```bash
autobrowser goto https://example.com/list
autobrowser snapshot --changed              # 只看新增/变化的元素
autobrowser find role button click --name "提交"
autobrowser find text "删除" click --within '.records' --within '#record-42'
autobrowser click @e2 --verify-delivery     # 用 trusted 事件确认点击真的送达
autobrowser fill @e5 "test@example.com"
autobrowser wait --text "完成"
autobrowser wait ".spinner" --state hidden
```

- `find` 支持 `role|text|label|placeholder|alt|title|test-id`。写操作命中多个时返回 `AMBIGUOUS_TARGET`，先用 `--candidates` 看候选，再用 `--position` 或确认后的 ref。
- `--within` 从外到内逐层收窄容器，最多 6 层，每层必须在上一层内唯一。
- `click` 打开新标签时默认只报告 `newTabId`/`newTabHandle`，加 `--follow-new-tab` 才切换目标。

### 长文与 PDF

```bash
autobrowser read_page --max-chars 20000 --output ./article.txt
autobrowser read_page --cursor rp_xxx --max-chars 20000
```

`read_page` 滚动扫描 DOM 或解析 PDF 文本层，返回 `text`、`chars`、`totalChars`、`complete`、`truncated`、`nextCursor`、`stopReason`。**`ok:true` 不等于读到全文**：只有 `complete:true` 才代表扫到底，其余看 `stopReason`（`maxScreens`/`endlessFeed`/`renderFrozen`/`stalled`/`budgetExhausted`/`documentChanged`/`captureLimit`/`noText`）。

`--cursor` 只回放已捕获缓存，不重新扫描；页面变化后返回 `STALE_READ_CURSOR`，需重新读取。`--output` 把本次捕获的完整文本落盘。PDF 返回 `strategy: "pdf"`、`pdfStatus` 与 `pages`/`pagesRead`。

### 结构化采集

```bash
# 单页列表转 JSONL
autobrowser extract ./spec.json --output items.jsonl
autobrowser feed collect 'article' --limit 50 --dedupe url

# 多页可恢复任务：追加式 JSONL + 小 checkpoint
autobrowser collect run ./spec.json
autobrowser collect resume ./spec.json

# 保存可复用脚本配方并记录验证时间
autobrowser recipe save daily-check ./check.json
autobrowser recipe run daily-check --arg user=alice
autobrowser recipe verify daily-check --arg user=alice
```

`extract` 按 JSON spec 静态读取 DOM，返回 `items` 与 `quality`。`feed` 采虚拟列表卡片，含 `author`/`handle`/`time`/`text`/`url`/`mediaUrls`/`adapter` 等字段。`collect` 每页只把新条目追加到 JSONL，checkpoint 只保留 `spec`/`status`/`nextUrl`/`nextPage`/`failures`/`itemCount`；中断后 `resume` 流式重建去重集合，不会重写已有数据。`recipe run` 只执行，`recipe verify` 真实执行并固化 `lastVerified`。

### 多标签与收尾

```bash
autobrowser tab list
autobrowser tab new https://example.com
autobrowser tab attach t2058764180
autobrowser tab mark t2058764180 deliverable   # handoff 表示交给后续调用方
autobrowser tab unmark t2058764180
autobrowser workspace finish
```

`tN` 是 `t<Chrome tabId>` 稳定句柄，不是短序号。workspace 下优先 `tab attach` 复用已有页面，保留登录、表单和筛选；被其他 workspace 持有返回 `TAB_BUSY`。

`workspace finish` 绝不自动执行：只关闭本 workspace `origin=created`、无标记、且不在前台的普通临时页；借用页、`deliverable`、`handoff` 和前台标签保留并 detach。

需要独立的 home、profile、端口和登录态时用命名会话，而不是新建 workspace：

```bash
autobrowser session create research
autobrowser session attach research
autobrowser --session research open https://example.com
autobrowser session list
```

### 网络与媒体

```bash
autobrowser network requests --limit 20
autobrowser network request r12
autobrowser network har start --include-pattern api
autobrowser network har stop ./out.har --include-urls
autobrowser media list --selector 'article' --resolve
autobrowser download https://example.com/a.png ./out/a.png
autobrowser download https://example.com/v.m3u8 ./out/v.mp4 --quality best
```

`rN` 是会话内稳定的请求短引用。HLS 的清单与分片都经浏览器获取，本地 ffmpeg/ffprobe 只负责封装；失败会保留 checkpoint，相同命令可续传。

### 诊断

```bash
autobrowser status
autobrowser doctor
autobrowser console --level error
autobrowser errors
autobrowser command list
autobrowser command status <id>
autobrowser screenshot ./shot.png --full
autobrowser tracing start && autobrowser tracing stop ./trace.json
autobrowser video start && autobrowser video stop ./out.webm
```

`doctor` 逐项检查 Bun、扩展连接、版本与浏览器目标，并给出修复命令。`screenshot` 用位置参数指定路径，`--element @e2` 只截元素。

### 脚本与批量

```bash
autobrowser eval --expr 'document.title'
autobrowser eval --file ./check.js --arg keyword=shoes
autobrowser run ./script.js               # async (page) => { ... }，独占该标签
autobrowser batch --file steps.json       # 顺序执行多条命令
autobrowser script add --file ./init.js   # 每次导航前注入
```

源码含 CSS 选择器、JSON、正则或多行语句时，`eval` 用 `--stdin`/`--file`，不要硬拼内联转义。`run` 是持有浏览器连接的本地不安全代码，不要运行不可信来源。

## Agent 约定

- **引用**：`@eN` 元素、`@fN` frame、`tN` 标签页。导航或重渲染后 `pageEpoch` 变化，旧引用失效，先重新 `snapshot`。
- **全局标志放在命令前**：`--tab`、`--frame`、`--session`、`--workspace`、`--engine`。例如 `autobrowser --tab t1 snapshot`。
- **输出**：列表与查询默认 `concise`（高信号字段 + 紧凑 JSON），需要完整字段时加 `--response-format detailed`。
- **错误**：失败时 stdout 是 `{ok:false,error:{code,message,suggestedAction,...}}`，先读 `code` 与 `suggestedAction`，按提示修，不要改换框架重写。
- **未知结果**：超时或断连后先 `autobrowser command status <id>` 和 `autobrowser status` 核对现场；副作用命令不会自动重放，也不要盲目重试。
- **`empty:true` 不是失败**：查询无匹配仍是 `ok:true`、退出码 0，按 `emptyReason` 调整条件或等待数据。

## 浏览器支持

- **Chromium（Chrome/Edge）**：完整能力，走扩展 + CDP，workspace、网络拦截、HAR、视频录制等均可用。
- **Firefox / WebKit**：走标准 WebDriver（`geckodriver`/`safaridriver`），支持导航、snapshot、点击/填写、状态、storage、cookies 与截图；Chromium 专有能力返回 `BROWSER_CAPABILITY_UNSUPPORTED`。

```bash
geckodriver --port 4444
autobrowser --engine firefox open https://example.com
```

## 其它能力

`cookies`、`storage`、`clipboard`、`pdf`、`set`（视口、UA、时区、离线等）、`state save|load`、`replay`、`skill sync`，以及实验性的 `webmcp` 页面工具调用。完整用法见 `autobrowser help <命令>`。

## 开发与验证

```bash
bun test           # 单元与集成测试，不会拉起真实浏览器
bun run check      # typecheck + lint + 格式检查
bun run build:cli
bun run build:chrome
bun run test:live  # 真实浏览器冒烟，opt-in，需要 Chrome for Testing
```

- 完整命令与标志以 `autobrowser help` 和 [`docs/overview.md`](docs/overview.md) 为准。
- Agent 操作指引在 [`.agents/skills/autobrowser/`](.agents/skills/autobrowser/)；`autobrowser skill sync` 可把技能资产同步到 `~/.agents/skills/autobrowser/`。
- 安装细节见 [`docs/install.md`](docs/install.md)，`link:bun` 行为见 [`docs/bun-link.md`](docs/bun-link.md)。
