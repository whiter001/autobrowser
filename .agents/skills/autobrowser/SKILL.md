---
name: autobrowser
description: '替代WebFetch获取网站数据,需要登录,受限等情况使用、点击/填写/输入、检查标签页和窗口、管理 state/cookies/storage、截图与导出 PDF、拦截网络请求以及导出 HAR。'
---

# autobrowser Skill

## 定位与不可替代原则

autobrowser 是面向 Chrome/Edge 的浏览器自动化 CLI，通过本地 relay + 扩展完成页面操作、状态读取与网络采集。用于启停服务、连接扩展、开关标签页/窗口/frame、点击填写拖拽上传、执行页面脚本、等待与截图/PDF、cookies/storage/clipboard、网络与 HAR。全量命令见 [commands.md](references/commands.md)。

- 命令失败（超时、找不到元素、弹窗、ref 过期）时按本文件恢复路径排查，**禁止**改用 Python/Selenium/Puppeteer 等其他框架脚本。
- `command not found` / 退出码 127 只是 shell 找不到启动器：Windows 用 `autobrowser.exe`，其他平台用 `autobrowser`，修好 PATH 后继续。
- 错误先读 `code`、`message`、`suggestedAction`（默认来自 `src/core/error-actions.ts`）；扩展给出的更具体建议优先。`retryable:true` 只表示检查状态后可重试。
- 解析期（缺参/多参/取值非法/未知选项）与运行期错误同一 JSON 契约：stdout 为 `{ok:false,error:{...}}`、退出码 1；参数错误 `CLI_INVALID_ARGUMENT`，未知命令 `CLI_UNKNOWN_COMMAND`（含 `details.candidates`），其余 CLI 层失败为 `CLI_ERROR`。stdout 始终是 JSON，不要从 stderr 猜。
- `empty:true` 不是失败（`ok:true`、退出码 0）：按 `emptyReason` 调整查询或等待数据。详见 [diagnostics-and-waiting.md](references/diagnostics-and-waiting.md)。

## 状态与版本确认

- `status` 最快确认扩展连接；`status --json` 的 `snapshot.connectionGeneration`/`snapshot.lastDisconnect` 区分重连代次并给出断开原因、心跳和 close code。`lastError` 是历史错误，结合 `lastSuccessAt` 判断是否已恢复。
- `version` 给出 CLI version/commit/buildTime；relay 运行时带扩展 manifest 版本与 `versionSkew`。`consistent:false` 说明扩展未重载或 CLI 过旧：先 `bun run build:chrome` + `extension reload`（或升级 CLI）。扩展自身版本/commit 用 `extension info`（含 `diagnostics`、`keepalive`）；`capabilities` 负责能力协商，不要用版本号代替。
- 扩展在线时 `extension reload` 加载磁盘新代码，`extension reconnect` 只重建 relay 连接。二者均不绑 tab、不进入页面队列，与页面 `reload` 不同，仅用于 Chromium 扩展。
- reload/reconnect 回执（`reloading:true` 等）只表示约 50ms 后异步开始，不是恢复完成：稍等后用 `status` 确认，再 `tab list`、`snapshot` 刷新目标和 ref，不要重放原动作。离线时先修复连接；首次升级需手动在 chrome://extensions 重载。
- 扩展 30 秒 keepalive alarm 会在 service worker 被回收后自愈；`status` 持续 `waiting for extension` 超过 1 分钟再重载扩展或查 relay。
- `server` 启动 relay 与 IPC；`connect` 打开扩展连接页并保存 token/端口/浏览器配置。平台不注册 `chrome-extension://`，打开扩展页必须显式 `--browser-command`，否则 CLI 报错并改开 `/connect`；连接页自动关闭通常表示成功，用 `status` 确认。

## 目标与 workspace（最小必要）

- 未指定 `--tab` 使用当前 workspace 目标。Chromium 下 workspace 默认开启：共享 profile/登录态，隔离默认 tab 与操作权限；需要独立 home/profile/端口/token 用 `--session`。
- 解析优先级：显式 `--workspace` > 非 `off` 的 `AUTOBROWSER_WORKSPACE` > 默认 auto。`--no-workspace` 或 `AUTOBROWSER_WORKSPACE=off` 关闭隔离；`--no-workspace` 与 `--workspace` 同用报 `CLI_INVALID_ARGUMENT`。`--engine firefox|webkit` 且无显式配置时无 workspace。
- 先 `tab list` 看 `workspace`/`attachment`/`attachable`，再 `tab attach <tN>` 原子复用未占用页面（保留登录/表单/筛选）。被占用是 `TAB_BUSY`，不要强接管；`--readonly` 写操作返回 `WORKSPACE_READONLY`。
- 无目标时自动认领空闲 tab（active 优先，其余按 tabId 升序，`TAB_BUSY` 换下一个）；无空闲页时 `open` 创建并绑定，其他命令报 `WORKSPACE_TARGET_REQUIRED`。严格指定页面用 `--no-auto-attach`（batch 继承，不等于 `--no-workspace`）。
- `tab detach`/`workspace release`/租约过期只解除归属，不关闭或重置页面；默认租约 1 小时并随命令续约。
- 兜底目标跳过 `chrome-extension://`、`chrome://`、`edge://`、`devtools://`、`about:`。`tN` 由 Chrome tabId 派生（如 `t2058764132`），不是短序号；扩展重连、句柄表未重建时仍可用，已关闭 tab 报 `STALE_TAB_HANDLE`，先 `tab list`。
- 会话清理、标签组、多 MCP workspace、完整租约边界见 [sessions-workspaces.md](references/sessions-workspaces.md)。

## 常用操作路由

- 观察：`snapshot`（concise 默认 50 元素/32KiB，`--limit 1..200` 只调元素上限、不提高字节预算；`--changed` 看状态变化与 `removedRefs`）。同一 document 内 ref 不复用；导航或重渲染后先刷新 snapshot。`@eN`/`@fN` 优先于脆弱 CSS。
- 定位：`find role|text|label|name`；只读 locate/text 默认 first，`find ... locate` 无匹配走 `empty:true`，写操作缺目标为 `ELEMENT_NOT_FOUND`。`--name` 默认 substring，精确匹配用 `--exact`。多匹配写操作未给 position 返回 `AMBIGUOUS_TARGET`，先看 `--candidates 3`，再选 `--position first|last|nth=N` 或确认后的 ref。
- 交互：`click`/`dblclick`/`fill`/`type`/`press`/`hover`/`focus`/`select`/`check`/`uncheck`/`scroll`/`scrollintoview`/`upload`，目标用 ref 或 CSS。受控 `fill` 可能回滚；toggle 控件先查状态，不要在 eval 里 `el.click()` 后又无条件 `click`。
- 等待：`wait time 3`、`wait ms 3`、`wait 3` 都是 **3 毫秒**，等 3 秒写 `wait time 3000`。条件等待用 `wait <selector> [--state new|stable]`、`wait --fn`、`wait --text`、`wait --load networkidle`；不要固定 sleep 后断言更新完成。
- 读取：`get`、`is`、`console`、`errors`、`search`。`search` 普通 query 按字面量，正则写 `/pattern/flags`；`truncated` 时用 `nextStartLine`/`--start-line` 续读。
- 脚本：单行表达式用 `eval --expr`；源码含 CSS 选择器、JSON、正则、模板字符串或多行语句时直接用 `--stdin`/`--file`，不要先试内联转义；`--base64` 只用于机器生成。支持顶层 `return`/`await`，大结果先分页/聚合。完整边界见 [eval-and-scripting.md](references/eval-and-scripting.md)。
- 导航：`open`/`goto` 可加 `--wait-for url <pattern>|selector <css>`；`back`/`forward`/`reload`；`tab new/select/close`；`frame <@fN|selector|top>`；等待阶段 `--wait-until none|commit|domcontentloaded|interactive|load|networkidle|domquiet`。

## 输出体积控制

- 列表/查询默认 `concise`，需要完整字段才 `--response-format detailed`（MCP `response_format`）；不要为一次拿全量而省略分页。
- MCP 默认 `AUTOBROWSER_MCP_RESPONSE_MODE=text`：结果只写 `content` 文本，不再重复 `structuredContent`。需要结构化字段用 `structured`（普通 object 只写 `structuredContent`，数组/原始值回退文本），需要同时保留两份才用 `both`。截图/视频/tracing 的媒体结果不受影响。
- MCP 默认 `AUTOBROWSER_MCP_TOOLSET=core`，`tools/list` 只返回 19 个核心工具（navigate/reload/snapshot/search/find/click/fill/type/press/get/wait/eval/tab_*/workspace），schema 约 16KB。需要让客户端看到全部 54 个工具时设 `all`；未列出的工具仍可直接调用，不要因为列表里没有就断定不可用。
- network/console/errors/actions/downloads/command 默认 20 条，`--limit` 最大 100；tab/route 默认 50。更多结果用 `pagination.nextCursor` + `--cursor`，过滤/排序不变。旧 `--page/--page-size` 仅兼容。
- network 列表优先 `rN` 短引用再 `network request rN`，不要首选长 CDP ID；concise 详情已去掉重复 summary/HAR，body >16KiB 会标记截断。
- `snapshot` 32KiB、`search` 默认 10 窗口/100 行/32KiB、`eval` 默认 32KiB。截断时用 `nextCursor`、`nextStartLine`、`--target/--role`、`--changed` 续读/收窄，不要改用无界输出。

## 导航、断连与结果未知（核心恢复）

- `goto`/`open` 返回 `outcome`（dispatched|completed|partial）、`phase`（dispatch|commit|settle）、`settled`/`settleReason`；`reload` 另带 `committed`、`dispatchTimedOut`、`observedUrl`/`observedTitle`/`observedEpoch` 和回显 `waitUntil`；`back`/`forward` 返回 `navigated`/`settled`。
- 只改 hash 是同文档导航，不整页刷新（`navigationType:"same-document"`、`documentReloaded:false`）。`completed` 不代表 SPA 已渲染目标路由，用 `--wait-for selector <目标路由独有元素>` 验证；确实需要整页初始化才 `reload`。
- `partial` 先看字段：`phase:"commit"` + `committed:false` 是没提交；`phase:"settle"` + `committed:true` 是已提交但未稳定（长轮询常见，不等于失败）。先 `get url`、必要时 `eval document.readyState` 核实，**不要因为 partial 重发 `reload`**。
- `COMMAND_TIMEOUT`（`error.details.commandId`）时导航往往已发生：用 `command status <id>` 查最终状态并核对页面。`completed_late` 的 `result` 是迟到结果，不要重复执行；`failed_late` 看 `error` 再检查页面。
- `COMMAND_EXECUTION_UNKNOWN` 始终先查 `command status` 和页面。已发送命令断连时结果可能未知；仅 `snapshot/get/tab.list/status` 等白名单只读命令会按剩余预算自动重试一次，点击/填写/导航等副作用不会重放。batch 的 `retries` 不是幂等保证，提交/付款/删除不要仅因报错重放。
- `pageEpoch` 在重连/重载后从 1 重计，旧 `@eN#pX`/`@fN#pX` 会过期：先 `snapshot` 再操作。页面卡死时用 `command list`、`tab list`、`target clear`、`tab close <tN>` 恢复；页面仍可响应时再运行 `snapshot`，不要连续重试堆积命令。
- 请求预算默认 30 秒，显式超时加 5 秒传输余量；完整预算、feed/batch 上限见 [diagnostics-and-waiting.md](references/diagnostics-and-waiting.md)。

## 按需参考文档

只有任务涉及对应专题时才读取：

- [commands.md](references/commands.md) — 全量命令、参数互斥/`--`、`replay`、MCP 映射。
- [sessions-workspaces.md](references/sessions-workspaces.md) — 命名会话清理、workspace 优先级/标签组/租约、`TAB_BUSY`。
- [network-and-har.md](references/network-and-har.md) — 请求 epoch/分页、HAR 限额/body/传输/recover。
- [media-download.md](references/media-download.md) — download/HLS、媒体作用域与溯源、MSE `blob:` 流程、传输上限。
- [engines-and-webmcp.md](references/engines-and-webmcp.md) — WebDriver 能力边界、媒体仿真/设备预设、WebMCP。
- [eval-and-scripting.md](references/eval-and-scripting.md) — eval 分流/PowerShell、`--element`、CDP、DOM 探测。
- [advanced-automation.md](references/advanced-automation.md) — feed/collect、Playwright `run`、组件交互、拖放、SPA 采集。
- [diagnostics-and-waiting.md](references/diagnostics-and-waiting.md) — tracing/video/actions、等待语义、search 正则、预算。
- [troubleshooting.md](references/troubleshooting.md) — connect/空白页、启动器/PATH/npm、问题跟踪、更新约定。
