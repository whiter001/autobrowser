# autobrowser

`autobrowser` 是一个受 `v-browser` 启发、基于 Bun 的浏览器自动化工具。

更详细的使用文档请见 [`docs/README.md`](docs/README.md)。

## 当前状态

这个仓库目前已经具备 Bun 实现的主要自动化流程：

- 本地中继服务，端口 `57978`
- CLI API 服务，端口 `57979`
- 带有基于 token 的连接流程的浏览器扩展骨架
- 覆盖服务与连接管理、导航、标签页和窗口控制、元素交互、对话框、等待与状态检查、cookie、存储、剪贴板、浏览器状态、网络检查与拦截、snapshot、snapshot 导出/提取、截图、初始化脚本注入，以及 `batch`、`status`、`config`、`replay` 这类实用命令的核心能力

运行 `bun run src/cli.ts help` 可以查看完整命令树。`src/cli.ts` 里的 help 输出是权威来源，也会说明根级标志位，例如 `--tab`、`--frame` 和 `--auto-connect`。

如果你想看一个使用最小 `autobrowser.cmd` 转发器的 Windows 启动示例，请参见 [`docs/windows-demo.md`](docs/windows-demo.md)。

## 运行

```bash
bun run src/cli.ts server
```

这会在后台启动中继服务和 IPC 服务。之后如果要停止它们：

```bash
bun run src/cli.ts server stop
```

然后在另一个终端打开连接页：

```bash
bun run src/cli.ts connect
```

如果本地后台服务尚未运行，`connect` 会自动先启动它。

## 状态检查

使用 `is` 查看元素状态：

```bash
bun run src/cli.ts is visible <sel>
bun run src/cli.ts is enabled <sel>
bun run src/cli.ts is checked <sel>
```

该命令还支持 `disabled` 和 `focused`。

## 对话框

对话框命令支持接受、关闭和状态查询：

```bash
bun run src/cli.ts dialog accept [text]
bun run src/cli.ts dialog dismiss
bun run src/cli.ts dialog status
```

`alert` 和 `beforeunload` 对话框会自动接受，因此不会阻塞自动化流程。`confirm` 和 `prompt` 仍然需要显式处理。

## 等待

等待元素状态、文本、URL、加载状态、JS 条件或固定时间：

```bash
bun run src/cli.ts wait <selector>
bun run src/cli.ts wait <ms>
bun run src/cli.ts wait --text "Welcome"
bun run src/cli.ts wait --text "Loading" --gone
bun run src/cli.ts wait --url "**/dash"
bun run src/cli.ts wait --load networkidle
bun run src/cli.ts wait --fn "window.ready === true"
bun run src/cli.ts wait "#spinner" --state hidden
```

`--gone` 与 `--text` 搭配，等待文本从页面消失。

## 扩展

先构建未打包的扩展：

```bash
pnpm run build:chrome
```

然后在基于 Chromium 的浏览器中将 `chrome/` 文件夹作为未打包扩展加载。如果 CLI 二进制已经全局安装，运行 `autobrowser connect` 可以打开扩展连接页；它会自动保存 token 和中继端口，而你传入的 `--extension-id`、`--browser-command` 或 `--browser-arg` 也会保存在 `~/.autobrowser/config.json` 中供后续复用。如果你是直接在仓库里运行，请改用 `bun run src/cli.ts connect`。`options` 页面仍然可以作为手动兜底，并显示诊断信息。

## 网络

CLI 也提供了网络检查与拦截命令：

```bash
bun run src/cli.ts network route <url> [--abort] [--body <json>] [--status <n>] [--content-type <mime>] [--header "Name: Value"] [--remove-headers <a,b>]
bun run src/cli.ts network route list
bun run src/cli.ts network unroute [url]
bun run src/cli.ts network requests [--filter api] [--type xhr,fetch] [--method POST] [--status 2xx]
bun run src/cli.ts network request <requestId>
bun run src/cli.ts network har start
bun run src/cli.ts network har stop [output.har]
```

`route` 既可以 `--abort` 拦截请求，也可以用 `--body` mock 响应（默认 200 + `application/json`，可用 `--status`、`--content-type`、`--header` 调整），还可以用 `--remove-headers` 在放行前删除请求头。不带 url 的 `unroute` 会清空所有路由。

## 截图

截取屏幕并保存为文件。如果没有提供路径，CLI 会写入临时目录并打印文件路径。

```bash
bun run src/cli.ts screenshot
bun run src/cli.ts screenshot ./shots/page.png --full
bun run src/cli.ts screenshot --element @e2
bun run src/cli.ts screenshot --annotate
bun run src/cli.ts screenshot --screenshot-dir ./shots --screenshot-format jpeg --screenshot-quality 80
```

`--full` 会截取整页，`--element` 只截取某个元素（接受选择器或 `@eN` 引用，与 `--full` 互斥），`--annotate` 会给元素添加编号标签，而 `--screenshot-format` / `--screenshot-quality` 用于控制编码后的图片输出。

## 初始化脚本

`script` 命令管理在每次导航后、页面自身脚本执行前注入的初始化脚本（对应 CDP `Page.addScriptToEvaluateOnNewDocument`，与 Playwright 的 `--init-script` 对齐）：

```bash
bun run src/cli.ts script add 'Object.defineProperty(navigator, "webdriver", { get: () => undefined })'
bun run src/cli.ts script add --file ./init.js
bun run src/cli.ts script list
bun run src/cli.ts script remove <id>
bun run src/cli.ts script remove --all
```

脚本对所有标签页全局生效：新打开或新 attach 的标签页会自动补注册，无需重复 add。源码输入方式与 `eval` 一致，支持位置参数、`--file`、`--stdin` 和 `--base64`。

## 面向 Agent 的引用

每个成功的命令响应（JSON 模式下）都会附带一个 `meta` 字段，回显该命令实际操作的标签页上下文：`tabHandle`（Tab Handle）、`tabId`、`frame`（Frame 引用，若为 `top`/`main`/`default` 则归一化为 `null`）、`pageEpoch`、`url` 与 `title`。取不到的字段为 `null`；无页面上下文的命令（如 `status`、`tab.list`、`script`、`batch`）的 `meta` 所有字段均为 `null`。

`snapshot` 现在会输出一个 `elements` 列表，里面包含诸如 `@e1`、`@e2`、`@e3` 这样的稳定引用；同时还会输出一个 `frames` 列表，包含当前页面视图中的 `@f1` 之类的 frame 引用。基于选择器的命令在需要选择器的地方也可以直接接受元素引用，而 `frame` 可以直接接受 frame 引用，因此 agent 可以先 snapshot，再基于这些句柄执行操作，而不是去猜 CSS 选择器。

```bash
bun run src/cli.ts snapshot
bun run src/cli.ts click @e2
bun run src/cli.ts fill @e5 "test@example.com"
bun run src/cli.ts get text @e3
bun run src/cli.ts wait @e7 --state hidden
bun run src/cli.ts frame @f1
```

`snapshot` 也接受一个可选的选择器或 `@eN` 引用（`snapshot @e4` 或 `snapshot --target @e4`），只输出该元素子树的结构。

为降低大页面快照的 token 消耗，`snapshot` 支持两种模式：

- `--role <button,link,...>`：只返回匹配这些 role 的元素（作为现有可见性过滤之上的附加过滤）。`ref` 按过滤后的集合重新编号，因此不同 role 过滤之间同一 `@eN` 可能对应不同元素。
- `--changed`：增量模式，只返回相对上一次快照新增或变化的元素，并带 `unchangedCount`（本次未变的元素数）。每个元素的轻量签名是 `ref + role + text/name`；首次运行或页面导航（epoch 变化）后缓存失效，会退化为全量快照并带 `full: true` 标记。

页面被未处理的对话框阻塞时，`--changed` 仍返回 modal 描述，且不更新增量缓存。

还可以使用语义化的 `find` 命令按 role、text、label 等属性查找，并支持位置/次序选择与 Top-N 候选列表：

```bash
bun run src/cli.ts find role button click --name "Submit"
bun run src/cli.ts find text "Sign in" text --exact
bun run src/cli.ts find label "Email" fill "test@example.com"
bun run src/cli.ts find placeholder "Search" fill "autobrowser"
bun run src/cli.ts find test-id "submit-btn" click
bun run src/cli.ts find role button --position last
bun run src/cli.ts find role button --position nth=2
bun run src/cli.ts find text "Delete" --candidates 3
```

策略包括 `role`、`text`、`label`、`placeholder`、`alt`、`title`、`test-id`（匹配 `data-testid`）和 `exact-name`（精确匹配 accessible name/文本，恒精确）。`--position <first|last|nth=N>` 选择第 1 个/最后一个/第 N 个匹配（1 起算，越界会报错）；`--candidates <n>` 返回按质量排序（精确匹配优先、可交互元素优先，再按 DOM 顺序）的 Top-N 候选列表而非单个目标，且只能与 `locate` 动作搭配。

`search` 命令对页面可见文本做全文检索：按行匹配并返回命中行及上下文窗口，适合“抓取页面数据”而不是定位元素：

```bash
bun run src/cli.ts search "Sign in"
bun run src/cli.ts search /^Log\s+in/i --context 5
bun run src/cli.ts search "error" --limit 10
```

查询默认按大小写不敏感的子串匹配；以 `/pattern/flags` 形式书写则按正则匹配（`g` 标志会被忽略）。`--context <n>` 控制每个命中窗口前后的上下文行数（默认 3），`--limit <n>` 限制返回的窗口数量（默认 20）。该命令只读、不定位元素也不执行动作，与 `find` 的定位语义互补。

`batch` 命令把多条命令编码成一个 JSON 序列一次提交，按顺序执行，适合“先快照、再按条件交互”的多步流程。每条命令是一个对象：`command`（命令名）、`args`（参数对象）、可选的 `label`（步骤说明）、可选的 `id`（供后续步骤引用的稳定标识）、可选的 `when`（条件分支）、可选的 `skipRemainingOnFailure`（失败即终止剩余步骤）。`when` 引用前面某个步骤的结果做分支：`step` 是被引用步骤的序号（1 起算）或 `id`，`path` 是结果上的点路径（支持数组下标，如 `elements.0.ref`），`equals` / `truthy` / `exists` 三选一作为判定谓词：

```json
{ "command": "snapshot" }
{ "command": "click", "args": { "selector": "#btn" }, "when": { "step": 1, "path": "found", "truthy": true } }
{ "command": "snapshot", "id": "snap" }
{ "command": "fill", "args": { "selector": "#x", "value": "y" }, "when": { "step": "snap", "path": "elements.0.ref", "exists": true } }
{ "command": "goto", "args": { "url": "https://a.com" }, "skipRemainingOnFailure": true }
```

条件不满足，或引用的步骤失败/被跳过时，该步骤被跳过（结果带 `skipped: true` 与 `reason`），后续步骤照常执行；`skipRemainingOnFailure: true` 只在 `continueOnError: true` 时生效——失败后剩余步骤会被显式标记跳过（summary 带 `terminated: true`），否则（默认）batch 在首个失败步骤处报 `BATCH_STEP_FAILED` 并中止。

标签页现在会在 `tab list` 中暴露稳定句柄，CLI 也可以在不依赖原始数字 id 的情况下切换或关闭它们：

```bash
bun run src/cli.ts tab list
bun run src/cli.ts tab select t2
bun run src/cli.ts tab close t3
```

如果页面发生了大规模重渲染或导航，请先重新运行 `snapshot` 刷新引用，再继续操作。

页面有未处理的 confirm/prompt 对话框时，`snapshot` 会返回该 modal 的描述，交互类命令会返回带 `MODAL_OPEN` 错误码和 `suggestedAction` 的错误；先用 `dialog accept` / `dialog dismiss` 处理对话框，再继续操作。

## MCP 服务器（Model Context Protocol）

`autobrowser mcp` 通过 stdio 暴露一个 MCP（Model Context Protocol）服务器，把核心命令包装成 MCP tools，供 Claude Desktop 等 MCP 客户端直接调用：

```bash
autobrowser mcp
```

暴露的工具：`navigate`、`snapshot`、`search`、`find`、`click`、`dblclick`、`hover`、`fill`、`type`、`press`、`scroll`、`get`、`wait`、`screenshot`、`tab_list`、`tab_new`、`tab_select`、`tab_close`、`eval`。

行为约定与上文的「面向 Agent 的引用」保持一致：

- 先运行 `snapshot` 获取 `@eN` / `@fN` 稳定引用，再用 `click`、`fill`、`get`、`wait` 等工具基于这些句柄操作，而不是去猜 CSS 选择器。
- 多标签页流程优先用 `tab_list` 获取 `tN` 句柄，再通过 `tab_select` / `tab_close` 操作。
- 支持目标定位的工具可以传入 `tab`（`tN` 句柄）和 `frame`（`@fN` 引用）参数，把命令绑定到特定标签页或 frame。
- 页面大规模重渲染或导航后（epoch 变化），先重新运行 `snapshot` 刷新引用，再继续操作。
- 工具失败会返回 MCP 的 isError 结果，错误文本带有 `[AI SUGGESTION]` 修复建议；结构化错误见 `structuredContent.error`（`code` / `message` / `suggestedAction`）。

## 测试

运行 `bun test`。

真实浏览器冒烟测试（opt-in，默认跳过）：需要 Chrome for Testing（或能加载 `--load-extension` 的 Chrome，Chrome 137+ 品牌版已屏蔽该开关），跑：

```bash
bun run test:live
```

等价于先 `bun run build:chrome` 再 `AUTOBROWSER_LIVE=1 bun test test/live-smoke.test.ts`。二进制按 `CHROME_BIN` 环境变量 → Playwright 缓存里的 Chrome for Testing → 系统 Chrome 的顺序尝试；前置条件不满足时自动跳过，不会让默认 `bun test` 失败。