---
name: autobrowser
description: '替代WebFetch获取网站数据,需要登录,受限等情况使用、点击/填写/输入、检查标签页和窗口、管理 state/cookies/storage、截图与导出 PDF、拦截网络请求以及导出 HAR。'
---

# autobrowser Skill

## 概览

autobrowser 是一个面向 Chrome/Edge 的浏览器自动化 CLI，通过本地 relay + 扩展协作完成页面操作、状态读取和网络采集。

## 适用场景

- 启动或停止本地自动化服务
- 连接浏览器扩展并确认状态
- 打开页面、切换标签页、管理窗口和 frame
- 在页面上执行点击、双击、填写、输入、按键、悬停、聚焦、选择、勾选、拖拽和上传
- 执行页面上下文脚本、等待条件、读取元素、截图、导出 PDF
- 管理 cookies、storage、clipboard、页面状态和网络请求
- 记录与导出 HAR

## 常用命令

- `help`
- `server`
- `server stop`
- `status`
- `connect`
- `open <url>` / `goto <url>`
- `back` / `forward` / `reload [--wait-for url <pattern>|selector <sel>]`
- `tab list` / `tab new <url>` / `tab select <tN>` / `tab close [tN]`
- `target show` / `target set <tN>` / `target active` / `target clear`
- `command list` / `command cancel <id>` / `command reset`
- `window new`
- `frame <@fN|selector|top>`
- `click` / `dblclick` / `fill` / `find` / `type` / `press` / `keyboard` / `hover` / `focus` / `select` / `check` / `uncheck` / `scroll` / `scrollintoview` / `drag` / `upload`
- `is`
- `get`
- `wait`
- `snapshot`
- `screenshot`
- `eval`
- `cookies`
- `storage`
- `console`
- `errors`
- `set`
- `pdf`
- `clipboard`
- `state`
- `network route` / `network unroute` / `network requests` / `network request` / `network har start` / `network har stop` / `network har status` / `network har recover`

## 可靠流程

- `server` 会启动 relay 和 IPC 服务。
- `connect` 会打开扩展连接页，并自动保存 token、relay port，以及后续运行所需的浏览器配置。
- 如果 `connect` 传入了有效 token 且扩展已经报告 `connected`，连接页可能会自动关闭；这通常表示连接成功。
- `status` 是确认扩展是否已连接的最快方式。
- `tab list` 适合在 `connect` 或 `open` 后确认当前活动标签页。
- `network har start` 可以在采集前显式设置限额：
  - `--har-max-requests <n>`
  - `--har-max-body-bytes <n>`
  - `--har-unlimited`
- 未启动 HAR 时只自动监控网络元数据，不预取 body；`network request <id>` 按需通过 CDP 获取 body，历史请求或失效 CDP 会话可能无法补取，须查看获取失败信息。`--include-details` 只包含已存储的详情，不保证 body 完整。
- HAR body 获取使用 4 个并发槽和每次 10 秒逻辑超时；底层 CDP 不可中止时仍占槽直到结束，不会因超时无限启动新请求。`stop` 只等待本次 capture 的有界任务。
- `--har-max-body-bytes` 只限制 body 存储大小，不限制 CDP 下载或传输量。
- `network har stop [output.har]` 等大结果在 relay 支持时走“WebSocket 控制消息 + 本地鉴权 HTTP 数据通道”：扩展发送响应元数据，HTTP 按字节范围上传，relay 落盘并校验 SHA-256 后重组；中断会从已确认偏移续传，15 秒无数据进度才判定传输停滞，整体仍受原命令预算约束。旧 relay 或小响应自动沿用 WebSocket 内联/分片协议，CLI/MCP 返回格式不变；传输超限明确报错，不静默截断。CLI 只会在面对较旧扩展时回退到重新组装网络请求。
- `--har-unlimited` 不限制 autobrowser 自身保存的 body 大小，但不是绕过 CDP/传输资源上限；若浏览器 CDP 对 `Network.getResponseBody` 触发配额错误，HAR 仍会导出，并在对应 entry 的 `response.content.comment` 标明 body 获取失败原因。

## 等待语义

- `wait time 3`、`wait ms 3` 和 `wait 3` 都表示 **3 毫秒**。
- 如果要等 3 秒，请写成 `wait time 3000`。
- `--timeout <ms>` 也是毫秒。
- 如果页面仍在加载，优先使用 `open <url>` 后再配合短等待，或直接用 `wait --load networkidle`。

## 搜索、引用与歧义恢复

- `search "error" --context 3 --limit 20` 只读搜索可见文本。`context` 为 0–50；`limit` 限制匹配窗口数（默认 20、最大 200；0 不返回窗口或续读游标），但每次仍最多返回 200 行、100000 UTF-8 字节，单个合并窗口也可能截断。
- `--start-line <n>` 是 1 起算的正安全整数，默认 1。若 `truncated:true` 且有 `nextStartLine:201`，保持查询和 tab/frame 不变，运行 `search "error" --context 3 --limit 20 --start-line 201` 续读；MCP 对应 `search({query:"error", context:3, limit:20, startLine:201})`。页面变更后行号可能变化，应重新搜索确认。
- `snapshot`/`find` 在同一 document 内不复用已分配 ref；这不代表被删除节点仍有效。导航后 ref stale，删除/重渲染后先刷新 snapshot。
- `snapshot --changed` 包含 checked/disabled 等状态变化与 `removedRefs`；基线按 document/frame 隔离。输出有 200000 UTF-8 字节预算，`truncated` 时用 `--target`/`--role` 收窄或 `--changed` 查看后续变化；只有实际交付的元素进入基线。
- `find --name` 默认 substring，不是 exact；需要精确匹配用 `--exact`（MCP `exact:true`），`exact-name` 策略恒精确。只读 locate/text 默认取 first；写操作多匹配且未显式 position 时返回 `AMBIGUOUS_TARGET` 和候选。先检查 `--candidates 3`、收窄条件，再明确选择 `--position first|last|nth=N` 或使用确认后的 ref，不盲目重复写操作。

## 总预算与重试

- 请求预算默认 30 秒；显式 eval/navigation/click `timeoutMs`、wait `timeout`/`ms` 加 5 秒传输余量，且不低于默认预算。feed 将 `maxScrolls` 限制为最多 40，按滚动次数 × `pauseMs` + 60 秒执行余量 + 5 秒传输余量计算，不低于默认预算，超过 30 分钟则拒绝。batch 合成逐步预算、重试、延迟和嵌套预算；总上限 30 分钟，**包含余量**，超大或非有限值会被拒绝。
- 已发送命令断连时结果可能未知，不会自动重放。先检查 `status`、`command list` 与页面实际状态，确认副作用后再决定是否重试；取消/超时阻止后续 batch 步骤，但不能撤销已发生的操作或所有在途 CDP 调用。
- batch 显式 `retries` 可能重复失败步骤已发生的副作用，不是幂等保证。提交、付款、删除等动作不要仅因报错就重放。

## CLI 参数与回放

- `--file`、`--stdin`、`--base64` 互斥；未知选项、冲突模式和缺参会返回非零退出码，不要把帮助文本或退出码 0 当成命令已执行。
- 需要输入与选项同名的字面量时，在 `--` 后传值，例如 `type '#field' -- '--submit'`。
- `replay` 会拒绝包含 `[redacted]` 的历史命令，防止把脱敏占位符当成真实参数执行；需要重放敏感操作时重新检查页面并显式构造命令。

## eval 使用边界

- `eval` 适合执行小段页面上下文 JS，用于只读提取、状态检查或轻量验证。
- 单行源码可用 `eval --expr '<script>'` 显式传值，也继续支持位置参数。
- 复杂或多行源码优先通过 `eval --file <path>` 或 `eval --stdin` 传入，避免命令行转义干扰判断；脚本可直接包含顶层 `return`，无需手工包装 IIFE。
- `--timeout-ms <ms>` 只在确认脚本本身是长任务时使用；不要把它作为复杂流程失败后的默认处理。
- 复杂交互优先拆成更小的 autobrowser 命令或脚本步骤，保留原任务目标逐步推进。

## 常见回退策略

- `connect` 之后如果连接页自动关闭，优先用 `status` 检查连接结果，不要反复等待页面。
- 如果 `connect` 没有打开或没有连上，确认浏览器命令指向已加载解包扩展的配置文件，必要时显式传 `--browser-command`。
- `snapshot` 返回的 `@eN` / `@fN` 引用比脆弱的 CSS 选择器更适合后续操作。
- `find role`、`find text`、`find label` 适合先语义定位，再点击、读取或填写。
- `tab list` 返回稳定句柄如 `t1`、`t2`，优先用 `tab select tN`，不要依赖原始 tab id。
- 页面命令超时后先运行 `status` 和 `command list`。标签页控制走独立控制面，可继续用 `tab list`、`target clear`、`tab close <tN>` 恢复；不要连续重试并堆积命令。
- `goto/open/reload` 可用 `--wait-until none|commit|domcontentloaded|interactive|load|networkidle|domquiet` 选择等待阶段；`reload` 还可追加 `--wait-for url <pattern>` 或 `--wait-for selector <sel>` 等待最终页面结果，适合 hash 路由 SPA 和验证后重定向页面。
- `cookies list` 是 `cookies get` 的别名，支持同样的 `--domain` / `--path` 过滤。
- `network requests` 默认只看目标 tab 的当前页面 epoch；跨 tab 或跨页面历史必须显式使用 `--all-tabs` / `--all-epochs`，headers/body 用 `network request <id>` 或 `--include-details` 获取。
- HAR 中断后先用 `network har status` 检查 checkpoint，再用 `network har recover [output.har]` 导出。
- 在旧扩展上，`network har stop` 可能只返回元数据；CLI 会自动兜底重建 HAR。
- 如果页面看起来空白或不对，先确认是不是登录页、验证码页，或者虚拟滚动列表。
- 如果命令报 `command not found` 或退出码 127，这是链接产物或 PATH 的问题，**不是 autobrowser 不可用**：先确认 `bun` 目录在当前 shell 的 PATH 里；Windows 的 cmd.exe / PowerShell 改用 `autobrowser.exe <子命令>`，Git Bash 使用 `autobrowser <子命令>`。这是 shell 解析问题，修好之后继续用 autobrowser，不要因此换方案。
- 对于类似 x.com 的 SPA 列表页，优先从 `article` 等可见节点读取内容，不要直接相信 `get text body`。
- `eval` 超时或页面内异常时保持原任务目标，不要换方案；先用 `status`、`snapshot`、`console`、`errors` 诊断页面状态和脚本问题，再围绕原任务重试。

## AI 专属原则 (AI-Agent Exclusives)

- ❗ **当 autobrowser 命令失败（如超时、找不到元素、被弹窗拦截、引用过期）时，明确禁止去尝试编写 Python/Selenium/Puppeteer 等其他框架脚本作为替代方案。**
- ❗ **同样地，`command not found` / 退出码 127 也不算 autobrowser 不可用**，它只是 shell 找不到包装器。按回退策略里的排查顺序换一种调用方式（Windows 上用 `autobrowser.exe`，Git Bash 用 `autobrowser`）后继续使用 autobrowser。
- 失败通常意味着当前持有的页面状态已陈旧、网络缓慢或存在未处理的各类弹窗。应该仔细阅读报错和执行建议。
- 遇到错误时，先通过 `status` 获取控制面状态；页面仍可响应时再运行 `snapshot`。页面卡死时用 `command list`、`tab list` 和 `target clear` 恢复目标后继续使用 autobrowser。

## 问题跟踪

- 执行中发现或复现 autobrowser 工具本身的问题时，先用 `gf issue list -R whiter001/autobrowser --platform github` 检查是否已有对应 issue，避免重复提交。
- 确认是新问题后，用 `gf issue create -R whiter001/autobrowser --platform github` 提交；没有 gf 时可使用 `gh issue create`。
- issue 应包含完整命令、实际输出、预期行为、运行环境和初步根因；区分已复现问题与代码审查推测。
- 网络超时或响应丢失时先查询是否已创建成功，不要盲目重复 POST。
- 修复后回 issue 评论验证结果并关闭；仅提出优化方向但未确认的问题，明确标注为建议。

## 更新约定

- 这个技能文件应当与当前 CLI 帮助和实现保持一致。
- 如果新增命令、改名、或调整 HAR / 网络行为，优先同步这里的说明。
