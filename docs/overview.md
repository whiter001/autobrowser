# autobrowser 概览

`autobrowser` 是一个基于 Bun 的浏览器自动化工具，通过本地中继服务和浏览器扩展来驱动 Chrome/Edge。

## 本仓库提供了什么

- 端口 `57978` 的本地中继服务
- 端口 `57979` 的 CLI API 服务
- 带有基于 token 的连接流程的浏览器扩展
- 覆盖服务与连接管理、导航、标签页和窗口控制、元素交互、对话框、等待与状态检查、cookie、存储、剪贴板、浏览器状态、网络检查与拦截、snapshot、snapshot 导出/提取、长文读取（read_page，支持 DOM 与 PDF）、截图、初始化脚本注入（`script add/list/remove`），以及 `batch`、`status`、`config`、`replay`、`network export` 这类实用命令的核心能力

以上能力同样通过 npm 全局安装的 `autobrowser` 命令提供，npm 用户不需要克隆本仓库；安装步骤见 [`install.md`](install.md)。

运行 `autobrowser help` 可以查看完整命令树。`src/cli/help.ts` 里的命令树是标志位和语法的权威来源。`autobrowser mcp` 还会通过 stdio 暴露一个 MCP（Model Context Protocol）服务器，把核心命令包装成 MCP tools，供 Claude Desktop 等 MCP 客户端调用。

## CLI 输出与退出码

命令最终写出的标准响应若为 `ok: false`，CLI 以非零退出码（通常为 `1`）结束；成功响应通常退出 `0`。脚本可同时依赖退出码判断成败，以及默认 JSON 输出中的 `error` 获取错误详情，失败 JSON 仍写入 stdout，内容与格式不变。`--raw` / `--brief` 的错误文本仍写入 stderr。

退出码以最终写出的顶层响应为准：导航 fallback 恢复成功不会因早期失败而退出非零；`batch` 的 JSON 输入设置 `continueOnError: true` 时，只按最终聚合响应的 `ok` 判定，不因内部步骤的 `ok: false` 自动失败。handler 显式返回的非零退出码优先；help 与本地成功输出不受影响。

## 文档地图

`src/cli/help.ts` 的命令树是权威参考。这个目录里的文档则把较长的使用流程整理在一起：

- [`install.md`](install.md) 讲解未打包扩展的安装和已保存的连接配置。
- [`bun-link.md`](bun-link.md) 讲解 `link:bun` 开发链接行为。
- [`windows-demo.md`](windows-demo.md) 讲解 Windows 原生 exe 启动示例。
- [`agent-design.md`](agent-design.md) 是面向 agent 的历史设计草稿；其中的缺口和建议不代表当前实现状态。
- [`usage-issues.md`](usage-issues.md) 是 2026-08-20 的历史使用体验问题及处理状态。
- [`usage-issues-2026-10-31.md`](usage-issues-2026-10-31.md) 是 2026-10-31 抓取 HLS 视频流场景下的历史使用体验问题及处理状态。

README 只保留高层概览和命令速查；本页承接那些需要连贯叙事的较长工作流。

npm 用户的安装方式是 `npm i -g @whiter001/autobrowser`（需要先安装 Bun >= 1.4.4），装完即可直接使用 `autobrowser` 命令。

## 核心流程

```bash
autobrowser server
autobrowser connect
autobrowser open https://example.com
```

- `server` 会启动本地中继服务和 IPC 服务。
- `connect` 会打开扩展连接页，并在需要时先启动本地服务。
- `open` 会把当前标签页导航到某个 URL。

### 导航附加等待协议

`goto` / `open --wait-for url|selector <value>` 在导航成功后再等待，附加等待默认超时为 30000ms（与 `reload` / `tab new` 相同）。协议中 `url` 始终是 goto/open 的导航目的地，URL 等待条件另用 `waitUrl`；`reload` 没有导航目的地，因历史兼容继续用 `url` 作为 URL 等待条件，不应互换这两个字段。成功响应的 `result.wait` 包含 `type`、`value`、`completed: true` 执行证明；CLI 会拒绝缺少匹配证明的旧扩展响应。等待失败仍返回 `ok: false`，在 `result`（以及 `error.details.result`）保留成功的导航结果和最终 URL。`tab new` 等待失败也保留已创建的 tab，不会自动关闭。

MCP `navigate` 当前不暴露 `waitFor`，所以仍不提供 `frame` 参数；CLI / batch 的 goto/open 可用 frame 定位附加 selector 等待。

带 `--capture-id` 的 HAR stop 会先在同一 tab 目标下查询 status 确认 captureId，再校验 stop 返回的 id；旧扩展未提供身份信息时不会发送 stop。`--include-urls` 若在 stop 后发现旧扩展不支持，capture 可能已停止，可用 `network har recover` 恢复。

如果你要操作特定目标，根级 `--tab` 和 `--frame` 标志可以把兼容命令绑定到某个标签页句柄或 frame 引用。对于简短且确定性的流程，最好使用带 JSON 数组或对象主体的 `batch`，而不是发起多次往返。

需要并行隔离多个浏览器任务时，用 `session create <name>` 创建命名会话，再用 `session attach <name>` 连接；后续命令写成 `autobrowser --session <name> <command>`。命名会话的 home、profile、端口、token 和 tab target 都相互独立。`session detach` 只断开 relay，`session close-all` 关闭标签页，`kill-all` 停止登记的 relay，`session delete-data <name>` 幂等删除指定命名会话的数据；默认会话不会被删除。

## Playwright Page 脚本

需要完整 Playwright 页面编程接口时，用 `run <file.js>` 执行 `async (page) => { ... }`。它通过现有扩展的 CDP 桥接提供真实 Page，支持根级 `--tab` 和 `--timeout-ms`，返回 `result.value`。同一 tab 在脚本等待或运行期间由 run 独占，普通命令返回 `PAGE_SCRIPT_ACTIVE`；脚本结束或断连后释放。

该入口是本地不安全代码，仅用于可信脚本。桥接只暴露一个已有 tab，不支持 `context.newPage()`；frame 用 Page 自己的 API。run 不支持 WebDriver、MCP 或 batch 嵌套。`page.route()` 随本次桥接结束而失效，网络域会按 tab 恢复 autobrowser 原有路由。

## 面向 Agent 的工作流

在复杂页面上动手之前，先运行 `snapshot`。snapshot 现在会包含一个 `elements` 数组，里面有诸如 `@e1`、`@e2` 这样的引用，以及每个可见可交互元素的 tag、role、text 和几何信息。它还会包含一个 `frames` 数组，里面有诸如 `@f1` 这样的可见 iframe 引用。

这些引用在任何接受选择器的地方都可以直接使用，因此 agent 可以优先采用下面这种模式：

```bash
autobrowser snapshot
autobrowser click @e2
autobrowser get text @e3
autobrowser fill @e5 "hello"
autobrowser frame @f1
```

当 CSS 选择器仍然太脆弱时，优先使用语义化查找：

```bash
autobrowser find role button click --name "Continue"
autobrowser find text "Pricing" click
autobrowser find label "Email" fill "agent@example.com"
```

同名目标很多时用可重复的 `--within` 从外到内嵌套容器（CSS 或 `@eN`，最多 6 层，每层在上一层内唯一）；容器层失败会报 `WITHIN_SCOPE_NOT_FOUND` / `WITHIN_SCOPE_AMBIGUOUS` / `WITHIN_SCOPE_ESCAPE`，`details.layer`/`selector` 指明要收窄的那一层。它只保证容器内的定位，不保证业务提交成功。

```bash
autobrowser find role button click --name "删除" --within '.records' --within '#record-42'
```

对依赖 trusted 事件、或经常被浮层/骨架屏挡住的目标，用 `click --verify-delivery`（MCP `verify_delivery`、batch `args.verifyDelivery`）：它先等目标可见、启用、在视口内、未被遮挡且几何稳定，再在按下前安装捕获阶段探针，确认 `isTrusted` 的 `pointerdown`/`mousedown` 确实落在目标上。成功结果多出 `delivery:{status:"delivered",trusted:true,events:[...]}`；失败按阶段报 `CLICK_NOT_READY` / `CLICK_NOT_DELIVERED` / `CLICK_DELIVERY_UNKNOWN`，且不会在发出输入后回退 DOM 点击或盲目重放。`delivery` 只证明输入到达目标，不证明业务提交成功；默认不开启时 click 行为与耗时保持原样。`--timeout-ms <ms>`（MCP `timeout_ms`）可调整总预算（默认 10000，上限 1800000），ready 阶段取它与 5000ms 的较小值。

```bash
autobrowser click '#submit' --verify-delivery
```

当你需要把 snapshot 数据导出给下游处理时，可以使用 `snapshot export` 导出完整的 JSONL 流，或者用 `snapshot extract` 搭配 `--field` 选择更窄的记录。对于网络跟踪，`network export` 会写出 JSONL 摘要，通常比完整 HAR 更方便 diff。

要读长页面正文（文章、报告、PDF），用 `read_page`：

```bash
autobrowser read_page --max-chars 20000
autobrowser read_page --output ./article.txt
autobrowser read_page --cursor rp_xxx --max-chars 20000
```

它会滚动扫描 DOM（或解析 PDF 文本层）并把全文分片返回。**`ok:true` 不等于读到了全文**：只有真正扫到底时 `complete` 才为 `true`，其余情况由 `stopReason` 说明（`maxScreens`、`endlessFeed`、`renderFrozen`、`stalled`、`budgetExhausted`、`documentChanged`、`captureLimit`、`noText`）。扫描总是从页首开始，读完恢复原滚动位置；途中跳转会立即停止并报告 `documentChanged`，不会混入新页面正文，也不会滚动新页面。`--cursor` 只回放已捕获的缓存、不会重新扫描，页面变了会返回 `STALE_READ_CURSOR`；`--output` 把本次捕获的完整文本以 UTF-8 落盘，stdout 只回 `{path, bytes}`，但 `complete`/`stopReason`/`truncated` 仍按真实语义返回（写了文件不等于读完）。PDF 页面会返回 `pdfStatus`（`ok`/`loading`/`no_text`/`password`/`too_large`/`unavailable`）与 `pages`/`pagesRead`；视图器不可达的顶层原生 PDF 会按原 URL 带登录态下载原始字节（上限 20MiB），用扩展内置 pdf.js 本地解析，字节不外传。没有文本层时只提示外部 OCR，autobrowser 不自动 OCR、不绕过密码。该命令只读：不点击、不提交、不激活标签页。

对于多标签页流程，优先使用 `tab list` 中的稳定标签页句柄：

```bash
autobrowser tab list
autobrowser tab select t2
```

Chromium 的 workspace 还区分页面来源与交付意图：`tab list` 的 `origin` 中只有 `tab new`/`open` 在 workspace 内新建的页面是 `created`，`tab attach`、自动认领、`click --follow-new-tab`、`window new` 都是 `attached`；`keep` 由 `tab mark <tN> deliverable|handoff` 设置，`tab unmark <tN>` 清除，两者只接受本 workspace 的 owned 标签（跨 workspace 返回 `TAB_BUSY`，`--readonly` 返回 `WORKSPACE_READONLY`）。收尾必须显式执行 `workspace finish`，它只关闭 `origin=created`、没有标记、且不是当前活动/前台标签的普通临时页，借用页与交付/交接页面一律保留并 detach；关闭失败的页面保持绑定并令 `success=false`，不会假装已经收尾。`workspace release` 与租约过期仍然只解除归属，不关闭任何页面。

如果 DOM 发生了明显变化，请再跑一次 `snapshot` 来刷新引用。

## 浏览器状态模拟

`set` 命令族调整浏览器侧的模拟状态（视口、UA、时区、媒体特性等），按标签页生效：

```bash
autobrowser set viewport 390 844 3 mobile
autobrowser set device iphone-15
autobrowser set device --reset
autobrowser set media dark
autobrowser set media-type print
autobrowser set reduced-motion reduce
autobrowser set forced-colors active
autobrowser set contrast more
autobrowser set timezone Asia/Shanghai
autobrowser set locale zh-CN
autobrowser set ua "Mozilla/5.0 ..."
autobrowser set geo 39.9 116.4 100
autobrowser set headers "X-Token:abc"
autobrowser set offline
autobrowser set permission notifications --reset
autobrowser set auto-snapshot on
```

几条容易踩的约定：

- 省略值或传 `--reset` 只重置当前这一项，不会连带清掉其他媒体覆盖；`set device --reset` 是例外，它同时清除设备尺寸和 UA。
- 设备预设目前只有 `desktop-chrome`、`iphone-15`、`pixel-10`，非法名字返回 `INVALID_DEVICE_PRESET`，不要改用未经验证的参数组合去凑。
- `set auto-snapshot on` 会显著增加每次导航和输入后的输出量，排查完记得关掉。
- WebDriver 引擎不支持这些 CDP 仿真能力，会返回 `BROWSER_CAPABILITY_UNSUPPORTED`。

## 诊断与录制

页面出问题或需要留证时，按「先看状态，再看页面，最后才录制」的顺序：

```bash
autobrowser status
autobrowser console --level error
autobrowser errors
autobrowser actions list
```

- `console` 和 `errors` 支持 `--page`、`--page-size`、`--since <timestamp>` 和 `--all-epochs`；`--level` 会连带包含更严重级别的消息，`console clear` / `errors clear` 清空缓冲。
- `actions` 是有界动作时间线，记录命令、目标、耗时和错误，但**不保存参数值**，密码、脚本、cookie 不会进入日志。
- 命令超时或页面无响应时，先用 `status` 看控制面，再配合 `command list` 判断是命令还在跑还是已经卡死。恢复顺序是 `tab list` → `target clear` → 重新 `snapshot`，不要连续重试堆积命令。

录制类命令会把大块数据落盘，避免整段进模型上下文：

```bash
autobrowser tracing start
autobrowser tracing stop ./trace.json     # 最大 32MiB，超限直接失败而非截断

autobrowser video start
autobrowser video chapter "第一步" --duration 3000
autobrowser video show-actions
autobrowser video stop ./out.webm          # 最大 64MiB，章节写成 JSON sidecar
```

`video` 依赖 Chrome tabCapture，浏览器不支持时按错误信息诊断，不要把失败当成录制成功。

## 可恢复的长任务采集

单页的虚拟列表用 `feed`：

```bash
autobrowser feed collect 'article' --limit 50 --dedupe url --max-scrolls 20
```

`dedupe` 默认按 URL 去重，卡片没有链接时回退到 author/handle/text；采集期间不要导航或刷新，page epoch 变化会返回 `STALE_FEED_STATE` 并丢弃旧结果。

需要跨页、带断点续传的任务用 `collect`，spec 是 JSON：

```json
{
  "name": "articles",
  "mode": "feed",
  "startUrl": "https://example.com/list",
  "output": "articles.jsonl",
  "maxPages": 10,
  "feed": { "selector": "article", "limit": 30, "nextSelector": ".next" }
}
```

- `mode` 为 `feed` 时用 `feed.selector/limit/dedupe/maxScrolls/pauseMs/stallRounds/nextSelector/waitTimeoutMs`；为 `network` 时用 `network.urlPattern/itemsPath` 和可选的 `nextPath`（跟随真实响应里的游标）。
- `collect run ./spec.json` 开始跑，`collect resume ./spec.json` 从失败页继续并按内容去重，完成态 resume 是 no-op。
- 落盘协议是 version 2：输出是追加式 JSONL，每页只追加新条目；checkpoint 只保留 `spec`/`status`/`nextUrl`/`nextPage`/`failures`/`itemCount`，不含条目数组。
- `resume` 用 node stream 流式扫描一遍输出 JSONL 来重建去重集合与 `itemCount`，不会把整个文件读进内存，也不重写输出。
- 崩溃窗口（条目已落盘、checkpoint 未推进）会重抓该页并跳过重复条目；末尾半行残片会被截掉并给出 warning，合法但缺换行的末行会先补换行再追加。
- 中间损坏的记录报 `COLLECT_OUTPUT_CORRUPT` 且不推进 checkpoint；输出缺失且 `itemCount>0` 报 `COLLECT_OUTPUT_MISSING`；输出的有效记录少于 checkpoint 记录的条目数（文件被截短或丢记录）报 `COLLECT_OUTPUT_TRUNCATED`；checkpoint 自身字段非法（如 version 2 缺 `itemCount`）报 `INVALID_COLLECT_CHECKPOINT`。
- 旧的 version 1 checkpoint 在 resume 时一次性迁移成 version 2（以 `checkpoint.items` 为准重写输出），之后只追加。
- 失败会带上失败页和原因，结果里带 `suggestedAction`；checkpoint 不保存 cookie 或 token，但输出文件可能包含页面敏感数据，妥善保管。
- 没有匹配到数据时返回 `NETWORK_DATA_NOT_FOUND`，先检查请求链、`urlPattern` 和 `itemsPath`，不要伪造 DOM 结果；`collect` 当前只支持 Chromium 扩展通道。

## 结构化字段提取（extract）

列表页需要稳定的一维记录时，用根级 `extract` 配合 JSON spec：

```json
{
  "itemSelector": "li.item",
  "fields": {
    "title": { "selector": "h3", "required": true },
    "price": { "selector": ".price", "type": "number" },
    "detail": { "selector": "a.more", "attr": "href", "type": "url" }
  },
  "limit": 50
}
```

```bash
autobrowser extract ./spec.json --dry-run      # 默认只取前 5 条，--limit 覆盖
autobrowser extract ./spec.json --output items.jsonl
```

- 只读取 DOM：selector、attr 等以数据形式经 eval 的 `args` 注入，spec 内容不会拼进脚本，也不会执行。
- `type` 取 `text|string|number|boolean|url|html`，默认 `text`；`selector` 省略时在 item 根元素上取值，`attr` 读属性，`html` 读 `outerHTML`，`url` 基于 `document.baseURI` 转绝对地址。
- 可选字段缺失写 `null` 并计入 `missingFields`；`required` 字段缺失或类型非法（`number/boolean/url`）会让整行作废，可选字段类型非法只写 `null`。
- 无 `--output` 时返回 `items` 与 `quality`；有 `--output` 时只写有效 items 的 JSONL，stdout 只含 `path`、`itemCount` 与 `quality`。
- `quality` 含 `matchedCount`、`scannedCount`、`itemCount`、`invalidCount`、`missingFields`、有界 `errors`（最多 20 条，含 `rowIndex/field/code/message`）、`totalErrorCount` 和 `errorsTruncated`。
- 空匹配是成功（`items: []`、`matchedCount: 0`）；`--dry-run` 不能与 `--output` 同用，相对路径按调用方 cwd 解析。

## 可执行的命名配方（recipe）

把反复使用的页面脚本保存成命名配方，之后运行并记录验证时间。该命令族目前只提供 CLI（不宣称 MCP 支持）：

```bash
autobrowser recipe save daily-check ./check.json          # 已存在时加 --force
autobrowser recipe list                                   # 只回元数据
autobrowser recipe show daily-check                       # 完整 spec（含脚本）
autobrowser recipe run daily-check --arg user=alice       # 执行，不改 lastVerified
autobrowser recipe verify daily-check --arg user=alice    # 执行成功才固化 lastVerified
```

```json
{
  "name": "daily-check",
  "description": "读取当前账号的未读消息数",
  "entryUrl": "https://example.com/messages",
  "params": [{ "name": "user", "description": "account name", "required": true }],
  "script": "return document.title",
  "lastVerified": null
}
```

- 配方存在当前 session 的 `homeDir/recipes/<name>.json`，命名 session 天然隔离。`name` 是安全 slug 且必须与 `spec.name` 一致；`entryUrl` 仅 HTTP(S)；`params` 最多 50 个且不重名；`script` 非空且 ≤256KiB；spec 文件 ≤1MiB。
- 目录权限尽量 700，JSON 用 `writeJsonFile` 原子写入并采用 600；损坏文件或文件名与内容不一致报 `INVALID_RECIPE_SPEC`。
- `run`/`verify` 都经现有 `eval` 执行脚本：当前标签页与 `entryUrl` 同源就复用页面状态，跨源才 `goto`；`--timeout-ms`（100..1800000）映射为 eval 超时。
- `--arg key=value` 可重复、值恒为字符串；`--args-json` 传对象，字符串原样、非字符串 `JSON.stringify`；两者互斥、重复 key 报错。`required` 缺失或空字符串报 `RECIPE_ARGUMENTS_INVALID`；未声明参数会透传并在 `warnings` 说明。
- `run` 返回 `{recipe:{name,entryUrl,lastVerified}, value, warnings}` 且不更新时间；`verify` 成功才写入当前 ISO 时间（`{verified:true,...}`），失败保留原错误码与 recipe 上下文、不写时间，并建议修复后重新 verify。推荐：保存 → run 验证 → verify 固化。
- `script` 是受信任的 async function body（支持顶层 `return`/`await`），与 `run` 一样不做沙箱或静态安全检查；只运行自己保存的脚本。

## 构建与 link 流程（仓库开发者）

以下命令只面向本仓库的开发者。使用 npm 全局安装的用户**不需要**执行其中任何一步：`npm i -g @whiter001/autobrowser` 之后，PATH 里就已经有 `autobrowser` 命令，随包发布的已构建扩展位于 `$(npm root -g)/@whiter001/autobrowser/chrome`（Windows 上同样用 `npm root -g` 定位），把它作为未打包扩展加载即可。

```bash
bun run build:cli
bun run build:chrome
bun run link:bun
```

- `build:cli` 会生成 `dist/autobrowser.js`。
- `build:chrome` 会在 `chrome/` 下生成未打包扩展，并注入扩展 key。
- `link:bun` 默认用当前 Bun 的 `--compile --aot` 构建原生启动器并写到 `bun` 或 `bun.exe` 的旁边：Windows 为 `autobrowser.exe`，其他平台为 `autobrowser`，本机不需要 Go。启动器嵌入当前 Bun 与仓库 `dist/autobrowser.js` 的绝对路径，链接后无需额外环境变量；备选 Go 实现通过 `bun run link:bun -- --go` 启用。

之后，就可以在同一个能访问 `bun` 或 `bun.exe` 的环境里直接运行 `autobrowser` 了。仓库内还可以用 `bun run src/cli.ts <子命令>` 直接运行源码，无需构建。