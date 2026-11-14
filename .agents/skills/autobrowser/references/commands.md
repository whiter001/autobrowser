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
- `workspace current` / `workspace list` / `workspace release [workspace-id]` / `workspace groups [on|off|status]`
- `target show` / `target set <tN>` / `target active` / `target clear`
- `command list` / `command status <id>` / `command cancel <id>` / `command reset`
- `window new`
- `frame <@fN|selector|top>`
- `click` / `dblclick` / `fill` / `find` / `type` / `press` / `keyboard` / `hover` / `focus` / `select` / `check` / `uncheck` / `scroll` / `scrollintoview` / `drag` / `drop` / `upload`
- `mousemove` / `mousedown` / `mouseup` / `mousewheel`
- `locator` / `highlight`
- `is`
- `get`
- `wait`
- `snapshot`
- `screenshot`
- `eval`
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
- `network route` / `network unroute` / `network requests` / `network request` / `network har start` / `network har stop` / `network har status` / `network har recover`
- `script add [--stdin|--file <path>|--base64] <source>` / `script list` / `script remove <id|--all>`

## CLI 参数与回放

- `--file`、`--stdin`、`--base64` 互斥；未知选项、冲突模式和缺参会返回非零退出码，不要把帮助文本或退出码 0 当成命令已执行。
- 命令名写错时返回 `CLI_UNKNOWN_COMMAND` 并给出最接近的命令名（不再打印整页帮助），按 `details.candidates` 改写命令即可。
- 最终标准命令响应为 `ok:false` 时进程退出码为 1，JSON `error` 仍保留；脚本可同时检查 return code 和 JSON。goto fallback 的最终成功结果、batch 的最终聚合响应决定退出状态，内部已恢复步骤不会误报。
- 需要输入与选项同名的字面量时，在 `--` 后传值，例如 `type '#field' -- '--submit'`。
- `replay` 会拒绝包含 `[redacted]` 的历史命令，防止把脱敏占位符当成真实参数执行；需要重放敏感操作时重新检查页面并显式构造命令。

## 其他调用接口

- MCP 客户端无需走 CLI：导航类可用 `navigate` / `reload` / `back` / `forward`，脚本与扩展控制用 `script` / `extension`，参数与 CLI 同名（`tab` / `frame` 由工具自动注入）。
- MCP 默认只列出 19 个核心工具：`navigate`、`reload`、`snapshot`、`search`、`find`、`click`、`fill`、`type`、`press`、`get`、`wait`、`eval`、`tab_list`、`tab_attach`、`tab_detach`、`tab_new`、`tab_select`、`tab_close`、`workspace`。`AUTOBROWSER_MCP_TOOLSET=all` 恢复完整 54 个；未列出的工具仍可直接调用，只是不出现在 `tools/list`。
- MCP 响应默认 `AUTOBROWSER_MCP_RESPONSE_MODE=text`，只写 `content` 文本；`structured` 对普通 object 只写 `structuredContent`（数组/原始值回退文本），`both` 双写兼容旧客户端。错误结果同样遵循该模式，`structured`/`both` 下读 `structuredContent.error`。`screenshot` / `video` / `tracing` 的媒体结果保持原样。
- `cookies list` 是 `cookies get` 的别名，支持同样的 `--domain` / `--path` 过滤。
