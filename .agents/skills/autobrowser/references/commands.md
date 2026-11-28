# 命令清单与 CLI 调用约定

## 常用命令

- `help`
- `server`
- `server stop`
- `status`
- `version` / `--version`
- `connect`
- `extension info` / `extension reload` / `extension reconnect`
- `open <url>` / `goto <url>`（均可加 `--wait-for url <pattern>|selector <css>`）
- `back` / `forward` / `reload [--wait-for url <pattern>|selector <sel>]`
- `tab list` / `tab new <url> [--wait-until <mode>] [--wait-for url <pattern>|selector <css>]` / `tab select <tN>` / `tab close [tN]`
- `tab attach <tN> [--readonly]` / `tab detach [tN]` — 在 workspace 里复用 / 解除已有页面归属
- `tab mark <tN> deliverable|handoff` / `tab unmark <tN>` — 标记交付或交接页面（收尾时保留），只对本 workspace 的 owned 标签生效
- `workspace current` / `workspace list` / `workspace release [workspace-id]` / `workspace groups [on|off|status]` / `workspace finish`
- `workspace finish` — 显式收尾：只关闭本 workspace 创建（origin=created）且无交付/交接标记、非当前活动/前台标签的普通临时页；借用页与保留页 detach 并恢复标签组，关闭失败保留绑定并返回 success=false
- `target show` / `target set <tN>` / `target active` / `target clear`
- `command list` / `command status <id>` / `command cancel <id>` / `command reset`
- `window new`
- `frame <@fN|selector|top>` — 选择持续有效，直到下一次 `frame` 或页面导航/重载；`snapshot`/`find` 返回的元素 ref 会记录来源 frame，后续省略 `--frame` 的操作按来源路由，显式 `--frame` 仍优先。跨 iframe 连续操作建议显式 `--frame top` / `--frame <selector>` 或重新 `snapshot`。
- `click` / `dblclick` / `fill` / `find` / `type` / `press` / `keyboard` / `hover` / `focus` / `select` / `check` / `uncheck` / `scroll` / `scrollintoview` / `drag` / `drop` / `upload`
- `find <strategy> <query> [action] [value] [--within <css|@eN>]...` — --within 可重复、最多 6 层，从外到内嵌套容器（CSS 或 @eN），每层必须在上一层内唯一；0 命中 WITHIN_SCOPE_NOT_FOUND、多命中 WITHIN_SCOPE_AMBIGUOUS、目标只在容器外 WITHIN_SCOPE_ESCAPE，details.layer/selector/candidates 指明要收窄的层。MCP/batch 用 within: string|string[]。只保证容器内的语义定位，不保证业务提交成功
- `click [--verify-delivery|--timeout-ms <ms>]` — 先等可见/启用/视口内/未遮挡/几何稳定的 ready，再装捕获探针确认 trusted pointerdown/mousedown 落在目标上；成功多出 delivery:{status:"delivered",trusted:true,events:[...]}，失败为 CLICK_NOT_READY / CLICK_NOT_DELIVERED / CLICK_DELIVERY_UNKNOWN（details.delivery 带证据）。--timeout-ms 调整总预算（默认 10000，上限 1800000），ready 阶段取它与 5000ms 较小值。只证明输入送达，不证明业务提交成功；验证路径不做 DOM 回退，默认关闭时 click 行为不变
- `press <key>` 只接受一个键名（例如 Enter），不接受 selector 位置参数；先 `click` / `focus <selector>` 聚焦目标，否则按键发给当前焦点元素
- `mousemove` / `mousedown` / `mouseup` / `mousewheel`
- `locator` / `highlight`
- `is`
- `get`
- `wait`
- `snapshot`
- `read_page [--cursor <id>] [--max-chars <1..60000>] [--max-screens <1..60>] [--timeout-ms <100..120000>] [--output <path>]` — 滚动扫描 DOM 或解析 PDF 文本层并分片返回长正文。ok:true 不等于全文，只有 complete:true 才是扫到底，其余看 stopReason（maxScreens/endlessFeed/renderFrozen/stalled/budgetExhausted/documentChanged/captureLimit/noText）。--cursor 只回放捕获缓存、不重新扫描，不能与 --max-screens/--timeout-ms 同用，失效时报 STALE_READ_CURSOR；--output 把本次捕获的完整文本以 UTF-8 落盘、stdout 只回 path 与 bytes。PDF 额外返回 pdfStatus 与 pages/pagesRead；顶层原生 PDF 的视图器不可达时按原 URL 带登录态下载原始字节（上限 20MiB）并用内置 pdf.js 本地解析，字节不外传。
- `screenshot [path] [--element <selector|@eN>] [--full]` — `--element` 会先把目标滚到视口中心并短暂等待懒加载图片 decode，不修改视口尺寸；超时后先用 `command status` 核验，不要重放
- `eval` — 用 --arg <key=value>（可重复）或 --args-json '<json-object>'（二者互斥）向脚本注入局部变量 args；用 --offset/--limit 对字符串或数组结果分页，返回 { value, pagination }。目标停在 chrome-error:// 时返回 NAVIGATION_FAILED，不会执行脚本。
- `run <file.js>`
- `cdp`
- `cookies`
- `storage`
- `console`
- `errors`
- `actions`
- `tracing`
- `video`
- `set`
- `pdf`
- `clipboard`
- `state`
- `downloads list` / `downloads clear`
- `download <url|--media <index>> [output-path]`
- `media list [--resolve] [--selector <css>] [--include-background]`
- `network route` / `network unroute` / `network requests` / `network request` / `network har start` / `network har stop` / `network har status` / `network har recover`（合法 action 仅 route|unroute|requests|request|export|har；network list 不存在，列请求用 `network requests`）
- `script add [--stdin|--file <path>|--base64] <source>` / `script list` / `script remove <id|--all>`

## CLI 参数与回放

- batch 的 `args` 键是**协议字段名**，与 CLI 选项名不总是同名：eval 用 `script`（CLI 是 `--expr`）、type 与 fill 用 `value`、get 用 `attr`、run 用 `source`、cdp 用 `method`、wait 用 `ms`/`type`/`selector`/`url`/`text`/`fn`。按 CLI 习惯猜键名会报错，参数名写错时错误消息会直接给出正确键名与等价 CLI 写法。
- `--file`、`--stdin`、`--base64` 互斥；未知选项、冲突模式和缺参会返回非零退出码，不要把帮助文本或退出码 0 当成命令已执行。
- 命令名写错时返回 `CLI_UNKNOWN_COMMAND` 并给出最接近的命令名（不再打印整页帮助），按 `details.candidates` 改写命令即可。
- 最终标准命令响应为 `ok:false` 时进程退出码为 1，JSON `error` 仍保留；脚本可同时检查 return code 和 JSON。goto fallback 的最终成功结果、batch 的最终聚合响应决定退出状态，内部已恢复步骤不会误报。
- 需要输入与选项同名的字面量时，在 `--` 后传值，例如 `type '#field' -- '--submit'`。
- `replay` 会拒绝包含 `[redacted]` 的历史命令，防止把脱敏占位符当成真实参数执行；需要重放敏感操作时重新检查页面并显式构造命令。

## 其他调用接口

- MCP 客户端无需走 CLI：导航类可用 `navigate` / `reload` / `back` / `forward`，脚本与扩展控制用 `script` / `extension`，参数与 CLI 同名（`tab` / `frame` 由工具自动注入）。
- MCP 默认只列出 22 个核心工具：`navigate`、`reload`、`snapshot`、`search`、`read_page`、`find`、`click`、`fill`、`type`、`press`、`get`、`wait`、`eval`、`tab_list`、`tab_attach`、`tab_detach`、`tab_mark`、`tab_unmark`、`tab_new`、`tab_select`、`tab_close`、`workspace`（序列化约 19.8KB，守住 20KB 上限）。`AUTOBROWSER_MCP_TOOLSET=all` 恢复完整 57 个；未列出的工具仍可直接调用，只是不出现在 `tools/list`。`workspace` 工具含 `finish` 动作，`tab_mark` 只接受 `deliverable|handoff`。
- MCP 响应默认 `AUTOBROWSER_MCP_RESPONSE_MODE=text`，只写 `content` 文本；`structured` 对普通 object 只写 `structuredContent`（数组/原始值回退文本），`both` 双写兼容旧客户端。错误结果同样遵循该模式，`structured`/`both` 下读 `structuredContent.error`。`screenshot` / `video` / `tracing` 的媒体结果保持原样。
- `cookies list` 是 `cookies get` 的别名，支持同样的 `--domain` / `--path` 过滤。
