# 诊断、等待与查询

## 诊断与自动 snapshot

- `tracing start` / `tracing stop [output.json]` 记录目标 tab 的 CDP trace，最大 32MiB；超限明确失败，不静默截断。CLI/MCP 都把 trace 落盘并返回路径，避免大段数据进入模型上下文。
- `video start` / `video stop [output.webm]` 使用 Chrome tabCapture + offscreen MediaRecorder 录制 WebM，默认最长 10 分钟、文件上限 64MiB。`video chapter <title>` 添加章节，JSON sidecar 在 `video stop` 时输出；`video show-actions` / `video hide-actions` 控制后续动作 callout 和目标高亮。浏览器不支持 tabCapture 时按错误信息诊断，不伪造视频结果。
- `actions [list|clear]` 查看或清理有界动作时间线，包含命令、目标、耗时和错误，但不保存参数值，密码、脚本、cookie 等不会进入日志。
- `set auto-snapshot on|off` 控制动作后自动 snapshot，默认关闭；只覆盖导航和输入动作，snapshot 失败通过 `snapshotError` 返回，不覆盖原动作结果。开启后会显著增加输出，排查完应关闭。
- `set focus on|off` 只对目标 tab 设置 CDP 焦点仿真，可在隐藏标签页测量依赖可见性或动画的弹窗；不会激活标签页，测量后应关闭。

## 等待语义

- `wait time 3`、`wait ms 3` 和 `wait 3` 都表示 **3 毫秒**。
- 如果要等 3 秒，请写成 `wait time 3000`。
- 超时参数单位均为毫秒，正式名统一为 `--timeout-ms <ms>`；`--timeout <ms>` 是 `wait`/`goto`/`open`/`tab new`/`eval`/`run`/`reload` 都接受的兼容别名。`goto`/`open`/`tab new`/`eval`/`run`/`reload` 发往 relay 的字段是 `timeoutMs`；`wait` 仍映射到既有的 `args.timeout`。同一条命令里混用两个名字或重复同名会按参数错误拒绝（`CLI_INVALID_ARGUMENT`，不发送请求），不要靠重复传入来覆盖前值。`tab new` 的 `--timeout-ms`/`--timeout` 必须搭配等待选项（`--wait-until`/`--settle-timeout`/`--dom-quiet-ms`/`--wait-for`）使用。
- 如果页面仍在加载，优先使用 `open <url>` 后再配合短等待，或直接用 `wait --load networkidle`。
- `goto/open/reload/tab new` 可用 `--wait-until none|commit|domcontentloaded|interactive|load|networkidle|domquiet` 选择等待阶段，并可追加 `--wait-for url <pattern>` 或 `--wait-for selector <sel>` 等最终结果。`tab new` 固定等待新建 handle；等待失败仍在 `result.tab` 保留新 tab。等待成功后 `result.tab`/`result.meta` 会刷新为最后观察到的页面状态，`wait.meta` 仍可用于核对等待时的上下文。旧扩展缺少 wait 执行证明时 CLI 返回失败，不伪造已等待。

## 搜索、引用与歧义恢复

- `search "error" --context 3 --limit 20` 只读搜索可见文本。`context` 为 0–50；`limit` 限制匹配窗口数（默认 20、最大 200；0 不返回窗口或续读游标），但每次仍最多返回 200 行、100000 UTF-8 字节，单个合并窗口也可能截断。
- 普通 query 始终按字面量匹配，`|`、`*`、`(`、`?`、`\` 等正则元字符都只是普通字符；正则必须写成 `/pattern/flags`，例如 `search "/签到|打卡|抽奖/" --context 2 --limit 20`。`g` 标志会被忽略，非法正则直接报错。`emptyReason:NO_MATCH` 只表示当前匹配模式（字面量或正则）在范围内无结果，不代表页面没有内容。
- 字面量查询含正则元字符且在有文本的页面上零命中时，结果会带 `hint`：它说明本次按字面量匹配、元字符不是操作符，并给出 `/pattern/flags` 改写示例（如 `签到|打卡|抽奖` -> `/签到|打卡|抽奖/`）。有命中、显式正则、无元字符的普通查询和 `NO_DATA` 都不会带该字段；看到 `hint` 就先按提示改用正则重试，而不是断言页面没内容。
- `--start-line <n>` 是 1 起算的正安全整数，默认 1。若 `truncated:true` 且有 `nextStartLine:201`，保持查询和 tab/frame 不变，运行 `search "error" --context 3 --limit 20 --start-line 201` 续读；MCP 对应 `search({query:"error", context:3, limit:20, startLine:201})`。页面变更后行号可能变化，应重新搜索确认。
- `snapshot`/`find` 在同一 document 内不复用已分配 ref；这不代表被删除节点仍有效。导航后 ref stale，删除/重渲染后先刷新 snapshot。
- `snapshot --changed` 包含 checked/disabled 等状态变化与 `removedRefs`；基线按 document/frame 隔离。输出有 200000 UTF-8 字节预算，`truncated` 时用 `--target`/`--role` 收窄或 `--changed` 查看后续变化；只有实际交付的元素进入基线。
- `find --name` 默认 substring，不是 exact；需要精确匹配用 `--exact`（MCP `exact:true`），`exact-name` 策略恒精确。只读 locate/text 默认取 first；写操作多匹配且未显式 position 时返回 `AMBIGUOUS_TARGET` 和候选。先检查 `--candidates 3`、收窄条件，再明确选择 `--position first|last|nth=N` 或使用确认后的 ref，不盲目重复写操作。

## 查询无匹配契约

- 查询无匹配不是失败：`empty:true` 配合 `emptyReason:NO_DATA|NO_MATCH|FILTERED_OUT|NOT_ATTACHED|EPOCH_FILTERED`，`ok:true`、退出码 0；按原因调整查询、过滤条件或先等待数据。网络结果为 `EPOCH_FILTERED` 时尝试 `--all-epochs`；`NOT_ATTACHED` 表示早期请求已错过、无法补回，应由 `tab new` 创建受管标签页或提前启动 HAR。`find ... locate` 无匹配也走这一契约，但 `find ... click/fill/type` 缺目标是 `ELEMENT_NOT_FOUND`、退出码 1。

## 总预算与重试

- 请求预算默认 30 秒；显式 eval/run/navigation/click `timeoutMs`、wait `timeout`/`ms` 加 5 秒传输余量，且不低于默认预算。feed 将 `maxScrolls` 限制为最多 40，按滚动次数 × `pauseMs` + 60 秒执行余量 + 5 秒传输余量计算，不低于默认预算，超过 30 分钟则拒绝。batch 合成逐步预算、重试、延迟和嵌套预算；总上限 30 分钟，**包含余量**，超大或非有限值会被拒绝。
- 已发送命令断连时结果可能未知。仅 `snapshot/get/tab.list/status` 等白名单只读命令会在重连后按剩余预算自动重试一次；点击、填写、导航等副作用命令不会自动重放。先检查 `status`、`command list` 与页面实际状态，确认副作用后再决定是否重试；取消/超时阻止后续 batch 步骤，但不能撤销已发生的操作或所有在途 CDP 调用。
- batch 显式 `retries` 可能重复失败步骤已发生的副作用，不是幂等保证。提交、付款、删除等动作不要仅因报错就重放。
