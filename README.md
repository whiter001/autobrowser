# autobrowser

`autobrowser` 是一个受 `v-browser` 启发、基于 Bun 的浏览器自动化工具。

更详细的使用文档请见 [`docs/README.md`](docs/README.md)。

## 当前状态

这个仓库目前已经具备 Bun 实现的主要自动化流程：

- 本地中继服务，端口 `57978`
- CLI API 服务，端口 `57979`
- 带有基于 token 的连接流程的浏览器扩展
- 覆盖服务与连接管理、导航、标签页和窗口控制、元素交互、对话框、等待与状态检查、cookie、存储、剪贴板、浏览器状态、网络检查与拦截、snapshot、snapshot 导出/提取、截图、初始化脚本注入，以及 `batch`、`status`、`config`、`replay` 这类实用命令的核心能力

运行 `autobrowser help` 可以查看完整命令树。`src/cli/help.ts` 里的 help 输出是权威来源，也会说明根级标志位，例如 `--tab`、`--frame` 和 `--auto-connect`。

根级标志位放在命令名前。除了 `--tab`/`--frame`/`--session`/`--engine` 这类目标选择标志，服务连接相关的三个也常被用到：

- `--server <url>`：直接指定 CLI API 服务地址，默认 `http://127.0.0.1:57979`。指向远端或已改端口的服务时用它。
- `--ipc-port <port>`：覆盖 CLI API 服务端口（默认 `57979`）。除非同时显式给了 `--server`，否则它会同步改写 `--server` 的地址。
- `--relay-port <port>`：覆盖中继服务端口（默认 `57978`）。扩展连接的是这个端口，不是 `--ipc-port`。

`--session <name>` 会自动改用该命名会话登记的 relay/IPC 端口和地址；只有显式传 `--relay-port`/`--ipc-port`/`--server` 才会覆盖会话自带的端口。`session create` 也可以用 `--relay-port`/`--ipc-port` 指定新会话的端口。

如果你想看 Windows 原生 exe 启动示例，请参见 [`docs/windows-demo.md`](docs/windows-demo.md)。

## 安装

### 前置条件：Bun 运行时

先安装 [Bun](https://bun.sh)（>= 1.4.4）。npm 全局入口默认是 Bun `--compile --aot` 生成的原生启动器，业务仍由 Bun 执行包内 `dist/autobrowser.js`，不是把业务改写到其他语言。启动器从 `PATH` 找 `bun` / `bun.exe`，也可用 `AUTOBROWSER_BUN_PATH` 指定 Bun；需要自定义 JS 入口时设置 `AUTOBROWSER_DIST_ENTRY`。缺少运行时或入口会给出明确错误。Go 启动器仅保留为备选构建。

### 全局安装

```bash
npm i -g @whiter001/autobrowser
```

装完后 `autobrowser` 命令就在 `PATH` 里了。本文档下面的示例都以这个命令为准；仓库开发者想直接跑源码，见文末的「从源码运行」。

#### 原生全局入口（Windows / macOS / Linux）

包的 `postinstall` 会把对应平台的 Bun AOT 启动器复制到 npm 全局入口：Windows 为 `<prefix>/autobrowser.exe`，POSIX 为 `<prefix>/bin/autobrowser`。支持 macOS、Linux、Windows 的 x64 / arm64。它用参数数组启动 Bun + 包内 `dist/autobrowser.js`，保留 cwd、环境和标准输入输出，不经过 cmd.exe、`.bat`、`.ps1` 或 sh shim。安装成功会移除旧 shim；写死 `autobrowser.cmd` 的调用方应改用 `autobrowser`（Windows 也可显式调用 `autobrowser.exe`）。

`bin` 仍指向 JS，npm 先生成 shim，再由 postinstall 替换。禁用安装脚本（例如 `--ignore-scripts` 或 npm 的 `allow-scripts` 未放行）时，**仍然只有旧 npm shim，不会凭空出现 exe**。按当前 npm 版本放行脚本后重建，例如：

```bash
npm config set allow-scripts=@whiter001/autobrowser --location=user
npm rebuild -g @whiter001/autobrowser
```

不支持的平台、缺少预编译文件或非全局安装沿用旧入口；Windows 全局缺少原生文件时仍把 `.cmd` 改名为 `.bat`，优先让 PowerShell 使用 `.ps1`。原生文件存在但复制失败会明确报错，不会静默回退。不要从 PowerShell 显式调用 `.cmd`：它可能使 `& | ^ < >` 等参数被再次解析。

原生启动器也不能撤销调用方 shell 已做的展开（如 cmd.exe 的 `%VARIABLE%`）；复杂 `eval` 仍推荐 `--file`、`--stdin` 或 `--base64`。

**卸载注意**：npm 不登记 Windows postinstall 额外生成的 `.exe`，回退产生的 `.bat` 也不登记。`npm uninstall -g @whiter001/autobrowser` 后，请手动清理 `<prefix>/autobrowser.exe` 和可能存在的 `<prefix>/autobrowser.bat`（`npm prefix -g` 可查 prefix）。POSIX 替换了 npm 原有 symlink，卸载时也请检查并清理残留的 `<prefix>/bin/autobrowser`。

源码开发的 `bun run link:bun` 默认用 Bun AOT 构建原生启动器（Windows 为 `autobrowser.exe`，其他平台为 `autobrowser`）并安装到 Bun 旁边，启动器嵌入当前 Bun 与仓库 `dist/autobrowser.js` 的绝对路径，链接后无需额外环境变量；默认不需要 Go，也不生成 sh 包装器。它和 npm 启动器是两条独立路径，见 [`docs/bun-link.md`](docs/bun-link.md)。Bun AOT 当前不能交叉编译，因此发布构建 `bun run build` 对本机目标使用 Bun AOT，其余五个目标自动使用 Go 备选；只构建本机可用 `bun run build:launcher -- --current`，不需要 Go。强制全部使用备选 Go 构建可运行 `bun run build:launcher:go`，源码链接的 Go 备选则加 `-- --go`。

### 验证

```bash
autobrowser help
autobrowser doctor
```

`doctor` 会逐项检查 Bun 运行时、扩展连接、CLI/扩展版本和当前浏览器目标，并为失败项给出修复命令；显式传 `--json` 可获取结构化检查结果。

### 加载浏览器扩展

npm 包里已经包含构建好的未打包扩展，不需要再执行 `bun run build:chrome`。在 chrome://extensions 打开开发者模式，把下面的目录按「加载已解压的扩展程序」加载：

```bash
$(npm root -g)/@whiter001/autobrowser/chrome
```

Windows 上同样用 `npm root -g` 获取该路径。

## 运行

```bash
autobrowser server
```

这会在后台启动中继服务和 IPC 服务。之后如果要停止它们：

```bash
autobrowser server stop
```

然后在另一个终端打开连接页：

```bash
autobrowser connect
```

如果本地后台服务尚未运行，`connect` 会自动先启动它。连接页打开后 CLI 会输出确认；这表示页面已打开，不代表扩展握手已完成，再运行 `autobrowser status` 确认 `extension: connected`。

## 命名会话与生命周期

默认会话仍使用原来的 `~/.autobrowser` 配置和浏览器登录态。需要隔离任务时，可以创建命名会话：

```bash
autobrowser session create research
autobrowser session attach research
autobrowser --session research open https://example.com
autobrowser session list
```

每个命名会话都有独立的 home、浏览器 profile、relay/IPC 端口、token 和 tab target。`--session` 放在命令名前；`session attach <name>` 等价于启动并连接该会话，`session detach <name>` 只停止 relay，不删除登录数据。

```bash
autobrowser session close-all research   # 关闭该会话当前窗口的标签页
autobrowser kill-all                     # 停止已登记的 autobrowser relay
autobrowser session delete-data research # 停止 relay 并删除该会话数据
```

`delete-data` 只接受命名会话，重复执行会返回已清理，不会删除默认会话。如果返回 `SESSION_DATA_LOCKED`，先关闭仍占用该 profile 的浏览器，再重试清理；不要强制删除正在使用的 profile。

## 多 AI Workspace 与标签复用

Workspace 用于多个 AI 共享同一个浏览器、profile 和登录态，同时隔离默认目标与标签归属；它不同于会创建独立浏览器环境的 `--session`。Chromium 下默认启用 auto workspace，不需要先显式声明或设置环境变量。

```bash
# 默认即为 auto：按调用方身份隔离，命令无需重复携带 workspace
autobrowser snapshot

# 需要固定身份时显式指定，优先级高于环境变量和默认 auto
autobrowser --workspace ai-a tab list
autobrowser --workspace ai-a tab attach t2058764180
```

解析优先级为 `--workspace` > 非 `off` 的 `AUTOBROWSER_WORKSPACE` > 默认 `auto`；空环境变量等同于未设置。`AUTOBROWSER_WORKSPACE=off`（大小写不敏感）或全局 `--no-workspace` 关闭 workspace，恢复无 workspace 的共享目标模式；显式 `--workspace` 仍覆盖 `off`，但 `--no-workspace` 与 `--workspace` 同用会在发出请求前报 `CLI_INVALID_ARGUMENT`。

`auto` 根据可信祖先进程、进程启动时间和终端标识生成稳定 workspace；AI 宿主可用 `AUTOBROWSER_CALLER_ID` 注入更可靠的调用方身份。`workspace current` 可确认实际身份；`workspace list` 查看归属，`workspace release [id]` 只解除绑定，不关闭或刷新页面。

默认 `auto` 只适用于 Chromium。`--engine firefox|webkit` 且没有显式 workspace 配置时保持无 workspace，不会因为新默认值报 "only supported by Chromium"；显式 `--workspace` 或非 `off` 的 `AUTOBROWSER_WORKSPACE` 在 WebDriver 下仍按原行为报错。`--no-workspace` 和 `off` 在 WebDriver 下都不报错。

- `tab list` 显示 `workspace`、`attachment` 和 `attachable`；`--response-format detailed` 还显示租约时间。
- `tab attach <tN>` 原子复用已有页面，保留当前登录、表单和筛选状态；其他 workspace 已持有时返回 `TAB_BUSY`。`--readonly` 只允许观察命令，click/eval/run 等会被拒绝。
- `tab detach [tN]` 解除归属但不改变页面。每个 workspace 可拥有多个 tab，并只保存自己的默认目标。
- Workspace 没有目标时，页面命令默认原子认领一个未绑定标签页：优先当前活动页，其余按 tabId 稳定排序；遇到 `TAB_BUSY` 会尝试下一空闲页，不抢占其他 workspace。localhost 等可调试页面均可使用，结果 meta 在首次认领带 `autoAttached:true`。没有空闲页时 `open <url>` 创建并绑定新 tab，其他命令返回 `WORKSPACE_TARGET_REQUIRED`。使用全局 `--no-auto-attach` 可恢复只接受显式目标的行为；它只关闭自动认领，不等于 `--no-workspace`。
- 标签归属默认租约 1 小时，命令执行会续约，并保存到 `chrome.storage.local` 供扩展重载后恢复。过期或异常回收只解除归属，不重置页面。
- Workspace 模式下 `close all` 只关闭当前 workspace 的 owned 标签；`extension reload/reconnect`、`server stop` 等全局管理操作仍会影响所有调用方。

每个 MCP 服务实例自动使用独立 workspace，并提供 `workspace`、`tab_attach`、`tab_detach` 工具。Workspace 用于本机误操作隔离，不是跨用户安全认证机制。

## Firefox / WebKit

默认 `--engine chromium` 保持扩展 + CDP 工作流。Firefox 和 WebKit 改用标准 WebDriver，启动 driver 后可在命令名前选择引擎：

```bash
geckodriver --port 4444
autobrowser --engine firefox open https://example.com

safaridriver -p 4723
autobrowser --engine webkit open https://example.com
```

核心适配包括导航、snapshot（不支持 `--changed`）、元素点击/填写/输入、状态读取、storage、cookies，以及视口或单元素 PNG 截图。`get` 的 `count`/`box`/`styles` 没有 WebDriver 专用实现，不能按 Chromium 语义使用。network、tracing、CDP、video、WebMCP 等 Chromium 能力会返回 `BROWSER_CAPABILITY_UNSUPPORTED`，不会用模拟结果冒充支持。

能力拒绝目前不是全量参数校验：`goto/open` 的 `waitUntil`、`settleTimeoutMs`、`domQuietMs`、`timeoutMs` 会被接受但不会生效；需要这些等待或超时语义时请使用 Chromium，不要把成功回执当成选项已执行。安装、driver 配置和分引擎 smoke 见 [`docs/install.md`](docs/install.md#firefox--webkitwebdriver)。

## Token 友好的输出

列表与查询默认使用 `concise`，只保留高信号字段并输出紧凑 JSON；需要完整字段时加 `--response-format detailed`。MCP 工具对应参数为 `response_format: "concise" | "detailed"`。

```bash
autobrowser network requests --limit 20
autobrowser network requests --limit 20 --cursor '<nextCursor>'
autobrowser network request r12
autobrowser snapshot --response-format detailed
```

- `network/console/errors/actions/downloads/command` 默认最多 20 条，`--limit` 最大 100；`tab list` 和 route list 默认 50 条。使用响应里的 `pagination.nextCursor` 续页，并保持过滤条件不变；旧 `--page/--page-idx/--page-size` 仍兼容。
- network 列表的 `rN` 是会话内稳定短引用，可直接传给 `network request`；旧 CDP ID 仍可使用。concise 详情去掉重复的 summary/HAR 结构，单个 body 最多 16KiB 并显式标记截断。
- concise snapshot 默认最多 50 个元素、32KiB，`--limit <1..200>` 可调整元素上限但不提高字节预算；search 默认 10 个窗口、100 行、32KiB；eval 默认结果上限 32KiB。`detailed` 保留原有更高预算。
- `--raw` 仍表示原始文本输出，不与显式 `--response-format` 混用。大截图、视频、trace 和 HAR 继续落盘后只返回路径与摘要。

## 状态检查

使用 `is` 查看元素状态：

```bash
autobrowser is visible <sel>
autobrowser is enabled <sel>
autobrowser is checked <sel>
```

该命令还支持 `disabled` 和 `focused`。

## 对话框

对话框命令支持接受、关闭和状态查询：

```bash
autobrowser dialog accept [text]
autobrowser dialog dismiss
autobrowser dialog status
```

`alert` 和 `beforeunload` 对话框会自动接受，因此不会阻塞自动化流程。`confirm` 和 `prompt` 仍然需要显式处理。

## 等待

等待元素状态、文本、URL、加载状态、JS 条件或固定时间：

```bash
autobrowser wait <selector>
autobrowser wait <ms>
autobrowser wait --text "Welcome"
autobrowser wait --text "Loading" --gone
autobrowser wait --url "**/dash"
autobrowser wait --load networkidle
autobrowser wait --fn "window.ready === true"
autobrowser wait "#spinner" --state hidden
autobrowser wait "#spinner" --state hidden --timeout-ms 10000
```

`--gone` 与 `--text` 搭配，等待文本从页面消失。超时预算统一使用 `--timeout-ms <ms>`；`--timeout` 作为兼容别名保留，`goto`/`open`/`tab new`/`eval`/`run`/`reload` 也同样接受该别名（单位毫秒；这些命令发往 relay 的字段是 `timeoutMs`，`wait` 仍映射到既有的 `args.timeout`）。同一条命令里两个名字混用或同名重复会按参数错误拒绝，不会静默采用后一个值。

## 扩展

npm 全局安装的用户不需要再构建扩展：构建好的未打包扩展随包发布，在 chrome://extensions 打开开发者模式，把 `$(npm root -g)/@whiter001/autobrowser/chrome` 作为未打包扩展加载即可。

仓库开发者才需要先构建扩展，再把仓库里的 `chrome/` 文件夹作为未打包扩展加载：

```bash
bun run build:chrome
```

已加载且在线的扩展在后续构建完成后，可以受控重载代码：

```bash
autobrowser extension reload
# 稍等后确认恢复与实际加载的版本/构建
autobrowser status
autobrowser extension info
```

`extension info` 返回 `extensionId`、`version`、`buildTime`、`commit`、`userAgent`，用于重载后确认实际加载的版本与构建；同时带出 `diagnostics`，其中的 `keepalive.alarmFires` / `lastAlarmAt` 可以用来确认扩展的保活 alarm 是否在按时触发。构建输出的 manifest 版本与 `package.json` 同步；每次构建生成 ISO `buildTime` 和短 git `commit`（无 git 时为 `null`）。运行时 `version` 始终取 manifest；旧构建缺少构建信息、读取失败或字段非法时，`buildTime` / `commit` 回退 `null`。功能兼容仍通过 `capabilities` 协商，不根据版本号推断。

`extension reload` 从磁盘重载扩展代码；`extension reconnect` 只重建扩展与 relay 的连接，不加载新代码，与刷新页面的 `reload` 也不同。两者先返回成功回执（`reloading:true` / `reconnecting:true`，并带 `reconnectExpected:true`），约 50ms 后异步执行；回执表示已安排操作，不表示恢复完成。稍等后用 `status` 确认重新连接，再继续页面命令。命令仅用于已连接的 Chromium 扩展，不绑定 tab、不进入页面队列；首次升级到支持此命令的版本仍需在 chrome://extensions 手动重新加载。

扩展注册了 30 秒周期的 keepalive alarm：service worker 被浏览器回收后会在一个周期内自行重连，不用再手动打开扩展页。如果 `status` 持续显示 `waiting for extension` 超过 1 分钟，再回到上面的重载步骤，或确认 relay 是否还在运行。该机制随扩展代码生效，首次升级仍需要先手动重载一次。

操作系统都不为 `chrome-extension://` 注册协议关联，所以打开扩展页必须显式指定浏览器：首次调用时传 `--browser-command "<msedge.exe 或 chrome.exe 路径>"`，之后该值会从 `~/.autobrowser/config.json` 复用。没有指定时 CLI 会直接报错并改为打开 relay 的 `/connect` 页，而不是把链接交给系统弹出"没有可打开此链接的应用"。

加载完成后，运行 `autobrowser connect` 可以打开扩展连接页；它会自动保存 token 和中继端口，而你传入的 `--extension-id`、`--browser-command` 或 `--browser-arg` 也会保存在 `~/.autobrowser/config.json` 中供后续复用。仓库开发者如果还没跑 `bun run link:bun`，可以直接用 `bun run src/cli.ts connect` 代替；命令名其余部分完全一致。`options` 页面仍然可以作为手动兜底，并显示诊断信息。

`autobrowser version`（或 `autobrowser --version`）报告 CLI 自身的构建：`version` / `commit` / `buildTime` 来自随 `dist/` 安装的 `build-info.json`（`bun src/cli.ts` 这类开发直跑没有该文件，字段为 `null`）。relay 已在运行时还会带上扩展的 manifest 版本，并在两者不一致时给出 `versionSkew.consistent: false` 和处理建议；`status` 同样携带 `versionSkew`，用来判断"命令行为和预期不符"是不是版本错配导致的。扩展侧的 commit/buildTime 仍以 `extension info` 为准。

## 网络

CLI 也提供了网络检查与拦截命令：

```bash
autobrowser network route <url> [--abort] [--body <json>] [--status <n>] [--content-type <mime>] [--header "Name: Value"] [--remove-headers <a,b>]
autobrowser network route list
autobrowser network unroute [url]
autobrowser network requests [--filter api] [--type xhr,fetch] [--method POST] [--status 2xx] [--sort newest]
autobrowser network request <requestId> [--timeout-ms <ms>]
autobrowser network har start [--include-pattern <text>] [--exclude-pattern <text>]
autobrowser network har stop [output.har] [--timeout-ms <ms>] [--capture-id <id>] [--include-urls]
```

`har start`、`status`、`stop`、`recover` 的扩展结果都携带 `captureId`（未知时为 `null`）；checkpoint 保留原 capture 的 ID。并发任务应保存 `har start` 返回的 `captureId`，并在停止时传入 `--capture-id <id>`：ID 不匹配或已经停止时命令失败，不会停止或导出其他任务的 capture。CLI stop/recover 默认仍以文件路径作为 `result`，ID 位于 `meta.har.captureId`；stop 加 `--include-urls` 时 `result` 为 `{ path, captureId, urls }`，其中 URL 来自本次保留的请求，按捕获顺序去重，HAR 文件照常写入。不传该选项不会返回 URL 大字段。

`route` 既可以 `--abort` 拦截请求，也可以用 `--body` mock 响应（默认 200 + `application/json`，可用 `--status`、`--content-type`、`--header` 调整），还可以用 `--remove-headers` 在放行前删除请求头。不带 url 的 `unroute` 会清空所有路由。

未开启 HAR 时自动监控仅保存元数据，`network request <id>` 按需通过 CDP 补取 body；历史请求/失效会话可能无法补取，需查看失败信息，`--include-details` 只返回已存详情。HAR body 获取最多 4 个并发槽、单次 10 秒逻辑超时；不可中止的 CDP 工作仍占槽直到结束。`--har-max-requests` 只限制本次 capture 的导出数量，不裁剪全局历史；`--har-max-body-bytes` 只限制存储，不限制 CDP 下载/传输量。`har stop` 只等待本次 capture，大结果透明分块重组；超出传输预算明确报错，不静默截断 HAR。大采集可用 `network har stop [output.har] --timeout-ms <ms>` 延长预算，输出路径也可放在选项之后；超时后先查 `network har status` 的 `checkpoint.recoverable`，再决定是否 `network har recover`。

## 下载与页面媒体

`downloads list` 查看 Chrome 下载记录，`downloads clear` 清空记录；它们不会把 URL 保存成新文件。实际下载使用 `download`：

```bash
autobrowser download https://example.com/image.png ./out/image.png
autobrowser download https://example.com/image.png --output-dir ./out
autobrowser download https://example.com/video.m3u8 ./out/video.mp4 --quality best
autobrowser download https://example.com/video.m3u8 ./out/video-720.mp4 --quality 720p --concurrency 4
```

也可以先发现当前页面里的图片和视频，再按返回的 `index` 下载：

```bash
autobrowser --tab t1 --frame top media list --selector 'article[data-role="tweet"]' --include-background --resolve
# 确认目标条目有可信 HTTP(S) sources/url；假设返回 pageEpoch=7
# 下载重新采集时必须使用相同 tab/frame/selector/include-background
autobrowser --tab t1 --frame top download --media 0 --selector 'article[data-role="tweet"]' --include-background --media-epoch 7 ./out/video.mp4 --quality best
```

`media list` 读取当前 frame 的 DOM 媒体源；`--resolve` 允许对没有真实源的视频静音短播以记录未验证网络诊断，不承诺解析出可下载流。后台播放可能受浏览器限制。`download --media` 会以相同 scope 重新采集，只下载可信 HTTP(S) `sources/url`，不会使用 `observedSources`。

`media list` 的作用域：

- `--selector <css>` 把所有 DOM 媒体采集以及 `--resolve` 的播放探测限定到匹配到的容器内（容器自身是 `img`/`video` 时也算在内）。列表页/推荐流这类一个页面里有多组推文时，用它只取目标那条，避免回复区和推荐区的媒体串进来。
- 不带 `--selector` 时沿用默认作用域：优先页面 `article` 容器内的可见媒体，其次 `article` 内的媒体，最后整页可见媒体。
- `--include-background` 额外采集作用域内元素的 CSS `background-image`（优先 computed style，其次内联 style），同样以 `image` 条目返回。只返回 URL 和元数据，不读取也不执行页面内容。

采集前可用 `media list --wait-for 'article[data-role="tweet"]' --selector 'article[data-role="tweet"]' --timeout-ms 15000` 等待目标选择器可见。等待与采集在扩展同一次 media 请求中对同一已解析 tab/frame 执行，不会因 ambient target 切换而漂移；等待失败不继续采集。`--wait-for` 与 `--selector` 独立，`--timeout-ms` 仅设置等待阶段预算（默认 30 秒），不限制后续发现/播放探测。

导航也支持条件等待：`goto/open <url> --wait-for url <pattern>|selector <css> --timeout-ms <ms>`。超时预算也可写成 `--timeout <ms>`（`--timeout-ms` 的兼容别名，二者不可同时或重复出现）。导航与附加条件等待各使用该预算；URL 条件不会覆盖导航地址。只改变 hash 时是同文档导航，提交后回执带 `navigationType:"same-document"` 和 `documentReloaded:false`；`outcome:"completed"` 不代表 SPA 目标路由已经渲染，应使用 `--wait-for selector` 等待目标路由独有元素，应用需要整页初始化时再显式 `reload`。`tab new <url> --wait-until domcontentloaded` 支持与导航一致的等待阶段，也可用 `--wait-for selector <css> --timeout-ms <ms>` 等待最终条件；始终等待返回的新 tab handle，而不是活动标签页，超时仍在错误响应的 `result.tab` 中保留新 tab 信息。受管标签页会在初始导航前 attach，以保留早期网络请求。不带等待选项时输出不变。

`media list` 的溯源信息：

- 顶层返回 `observedAt`（采集时间）、`pageEpoch`（页面 epoch）、`pageUrl`（页面地址）和 `scope`（`selector` / `mode` / `matchedCount`，未指定选择器时如实表示默认作用域）。
- 顶层还返回 `complete:boolean` 和 `warnings:string[]`。作用域未匹配、空媒体、未解析源/错误或 resolve 探测数量达到上限都会标记 `complete=false` 并给可读 warning；仅正常非空、无已知缺口时为 `true`。`complete` 只表示本次发现过程无已知缺口，不证明未渲染的轮播媒体不存在。
- 每个条目带 `permalink`（最近 `article` 内首个含 `/status/` 的绝对链接，没有则为 `null`）和 `primarySource`（`dom` = 来自 DOM 属性或 CSS，`none` = 尚未解析出可信源）。顶层 `includeBackground` 回显本次背景图开关。

网络归属采用严格保守契约：默认模式与 selector 模式都不认领历史 tab-wide 候选。即使播放期间新增请求，也可能来自 scope 外并发流量；只有实际 played 的探测才将新增候选放入 `observedSources`（每条 `unverified:true`），仅供诊断，绝不进入可下载的 `sources/url`，`download --media` 不使用它。失败或元素身份不符时诊断为空。只有 observedSources 而无可信 DOM 源仍为 `complete=false` 并给 warning，宁可 unresolved，不猜测下载。

X 等站点的 MSE `blob:` 视频没有可信 DOM 源时，先执行 `network har start --include-pattern video.twimg.com`，刷新或重新播放目标视频后用 `network har stop --include-urls` 获取播放请求，再选择 master m3u8 执行 `download '<master.m3u8>' out.mp4 --quality best --concurrency 4`。HLS 合并需要本机安装 FFmpeg/FFprobe；`observedSources` 为空不代表 HAR 中也没有媒体请求。

探测通过同一 document 内的稳定元素 token 找回原元素，并验证 connected 且仍属 scope；空 src、相同 src、删除、重排和替换不会让探测播放别的元素。采集开始记录 pageEpoch，采集/探测后或返回前 epoch 改变时报 `STALE_MEDIA_STATE`，必须重新采集。index 是本次整个 scope 内按 DOM 顺序生成的编号，不是单个 article 内的编号；多容器命中时先结合 `scopeRoot`/`permalink` 和 `primarySource` 确认目标。index 仅在相同 tab/frame/scope/epoch 内有效；`download --media` 重新 list 时须传相同 `--selector`/`--include-background`，并用 `--media-epoch <n>` 要求返回 epoch 完全一致，否则失败。epoch 不代表 DOM 不变，重排后应重新确认 index。CLI 对显式 scope、includeBackground 支持及 wait 完成要求响应明确回显，旧扩展缺少证明时拒绝成功。

下载行为：

- 输出使用显式路径或 `--output-dir` 自动命名（响应头、URL `filename`、路径和 MIME 扩展名），父目录自动创建。默认原子替换已有文件；`--no-clobber` 会在下载前拒绝覆盖，`--overwrite` 可显式选择默认行为。非 HLS 下载可加 `--dedupe-by-content`，按 SHA-256 检查输出目录内已有 EPUB/MOBI；重复时删除临时文件并返回 `duplicate:true`、`duplicateOf`，不新增或覆盖文件。
- 普通文件只接受 HTTP/HTTPS，扩展携带当前浏览器登录态获取，二进制经本地鉴权 `/files/:transferId` 通道直传 relay，不经过 Base64 或 WebSocket。
- 每个浏览器下载请求（包括 HLS 播放列表、初始化文件和分片）的初始 fetch 对网络错误、HTTP 429 和 5xx 默认额外重试 2 次；其他 4xx 立即失败。`--retries <0..5>` 调整次数，`--retries 0` 禁用源站重试；`--retry-delay-ms <0..60000>` 设置指数退避基础间隔（默认 250ms）。重试及等待共用原始 `--timeout-ms` 总预算，并服从取消；响应体读取失败不会重新下载，上传开始后也不会重放整个文件，原有上传断点恢复不变。
- 已知 Content-Length 且超过 8MiB 的文件使用流式传输，每次只保留一个 8MiB 块；小文件和未知长度响应使用原来的缓冲路径。relay 校验分块及整文件 SHA-256 后原子落盘。
- HLS 自动选择视频和音频轨，所有播放列表、初始化文件及分片都通过浏览器下载，FFmpeg/FFprobe 只处理本地文件。`--quality best|worst|720|720p` 选画质，`--concurrency 1..16` 控制分片并发，`--timeout-ms` 限制整个任务。
- HLS 失败会保留 checkpoint 和已校验分片，相同命令下次自动续传；成功后清理中间文件。需要本机安装 `ffmpeg` 和 `ffprobe`，合并后返回分辨率、时长、分片数、字节数和摘要。
- HLS 当前不支持加密或 `EXT-X-BYTERANGE`，最多 2048 个分片、2GiB 总字节和 4 层播放列表。DASH 目前仅能在 `media list` 中发现，尚不支持合并下载。
- 单文件及并发上传预留上限为 512MiB，最多 128 个上传；15 秒无数据进度判定停滞。该能力仅支持 Chromium 扩展通道，不支持 WebDriver/MCP，底层单文件 `download` 也不能作为 `batch` 子步骤。

## 截图

截取屏幕并保存为文件。如果没有提供路径，CLI 会写入临时目录并打印文件路径。

```bash
autobrowser screenshot
autobrowser screenshot ./shots/page.png --full
autobrowser screenshot --element @e2
autobrowser screenshot --annotate
autobrowser screenshot --screenshot-dir ./shots --screenshot-format jpeg --screenshot-quality 80
```

输出路径是位置参数，写法为 `autobrowser screenshot ./shot.png`，不支持 `--path`；误用时会直接提示正确形式。`--full` 会截取整页，`--element` 只截取某个元素（接受选择器或 `@eN` 引用，与 `--full` 互斥），`--annotate` 会给元素添加编号标签，而 `--screenshot-format` / `--screenshot-quality` 用于控制编码后的图片输出。

## 视觉差异比对

仓库开发期脚本 `scripts/visual-diff.ts` 会把 Figma 导出图与页面截图对齐后逐像素比较，输出差异报告。它面向「实现结果是否和设计稿一致」这类问题，不属于 CLI 的公开命令面。

```bash
# 一条命令跑完：对齐视口 → 截图 → 缩放设计稿 → 比对 → 出报告
bun scripts/visual-diff.ts run --design ./figma/hero.png --tab t1 --out visual-diff-out

# 已有截图时只做比对
bun scripts/visual-diff.ts compare --design ./figma/hero.png --screenshot ./shot.png
```

产物在输出目录：`design-scaled.png`（缩放后的设计稿）、`screenshot.png`（页面截图）、`diff.png`（红色为超容差像素）、`report.md`（差异率与热区坐标）。

两个容易踩的点：

- **缩放系数不写死**。浏览器渲染出的物理像素受系统显示缩放影响（本机 Windows 125% 缩放下，1440 CSS 像素的视口只产出 1152 像素宽的截图），脚本按截图实际像素反推设计稿缩放系数，本机即 0.8。视口对齐也据此迭代收敛，必要时报告里会提示视口宽度与设计稿的偏差。
- **容差要考虑重采样噪声**。设计稿缩放后与浏览器渲染不完全一致，文字边缘天然有差异，默认容差 8/255 偏紧，纯文字页面建议用 16~24。

## 初始化脚本

`script` 命令管理在每次导航后、页面自身脚本执行前注入的初始化脚本（对应 CDP `Page.addScriptToEvaluateOnNewDocument`，与 Playwright 的 `--init-script` 对齐）：

```bash
autobrowser script add 'Object.defineProperty(navigator, "webdriver", { get: () => undefined })'
autobrowser script add --file ./init.js
autobrowser script list
autobrowser script remove <id>
autobrowser script remove --all
```

脚本对所有标签页全局生效：新打开或新 attach 的标签页会自动补注册，无需重复 add。源码输入方式与 `eval` 一致，支持位置参数、`--file`、`--stdin` 和 `--base64`。

## Playwright Page 脚本

`run` 在当前 Chromium 扩展通道上启动真实 Playwright `Page`，文件内容必须是 `async (page) => { ... }` 函数：

```bash
autobrowser run ./script.js --timeout-ms 60000
autobrowser --tab t2 run ./script.js
```

```js
async (page) => {
  await page.getByRole('button', { name: '订阅' }).click()
  return await page.locator('article').allTextContents()
}
```

也支持全局 `--file`、`--stdin`、`--base64` 输入。返回值位于 `result.value`，并带 `tabId`、`handle` 和 `durationMs`。脚本是在持有浏览器连接的 relay 进程中执行的本地不安全代码，可访问 Node.js/Bun 能力，不要运行不可信来源。

`run` 对目标 tab 使用独占锁：先等待已在执行的同 tab 命令，随后同 tab 普通命令返回 `PAGE_SCRIPT_ACTIVE`；其他 tab 仍可执行。脚本结束、失败、超时或扩展断开后释放锁。超时和断连不能撤销已经发生的浏览器副作用，重试前先检查页面。

桥接只暴露选中的已有 tab，不支持通过 `context.newPage()` 创建新 target；frame 直接使用 `page.frames()` / `page.frameLocator()`，不使用根级 `--frame`。`run` 不能作为 batch 子步骤，目前也不支持 WebDriver/MCP。`page.route()` 在脚本结束后失效，扩展会仅对当前 tab 恢复 autobrowser 自己的网络路由，避免留下无人处理的暂停请求。

## 面向 Agent 的引用

扩展命令返回对象结果时，会在 `result.meta` 中回显该命令实际操作的标签页上下文：`tabHandle`（Tab Handle）、`tabId`、`frame`（Frame 引用，若为 `top`/`main`/`default` 则归一化为 `null`）、`pageEpoch`、`url` 与 `title`。取不到的字段为 `null`；无页面上下文的对象命令（如 `tab.list`、`script`、`batch`）的 `result.meta` 所有字段均为 `null`。

原始值或数组结果不会附加该字段，CLI 本地生成的响应（包括 Chromium `status`）也不保证存在。因此不要把 `meta` 当作所有成功响应的统一顶层契约；HAR stop/recover 的顶层 `meta.har` 是独立约定，见上文「网络」。

`snapshot` 现在会输出一个 `elements` 列表，里面包含诸如 `@e1`、`@e2`、`@e3` 这样的稳定引用；同时还会输出一个 `frames` 列表，包含当前页面视图中的 `@f1` 之类的 frame 引用。基于选择器的命令在需要选择器的地方也可以直接接受元素引用，而 `frame` 可以直接接受 frame 引用，因此 agent 可以先 snapshot，再基于这些句柄执行操作，而不是去猜 CSS 选择器。

```bash
autobrowser snapshot
autobrowser click @e2
autobrowser fill @e5 "test@example.com"
autobrowser get text @e3
autobrowser wait @e7 --state hidden
autobrowser frame @f1
```

`snapshot` 也接受一个可选的选择器或 `@eN` 引用（`snapshot @e4` 或 `snapshot --target @e4`），只输出该元素子树的结构。

为降低大页面快照的 token 消耗，`snapshot` 支持两种模式：

- `--role <button,link,...>`：只返回匹配这些 role 的元素（作为现有可见性过滤之上的附加过滤）。同一 document 内 snapshot/find 共用稳定 ref，过滤或删除节点后不复用已分配编号；这不表示被删除节点仍可操作，导航后引用会 stale，应重新 snapshot。
- `--changed`：增量模式，返回相对上一次快照新增或变化的元素（包含 checked、disabled、href 等状态/语义字段变化）、`removedRefs` 与 `unchangedCount`。基线按 document/frame 隔离；首次运行或导航后退化为全量快照并带 `full: true`。
- `--limit <1..200>` 覆盖默认元素数量上限，但不提高输出字节预算。输出最多 200000 UTF-8 字节，`truncated` 时用 `--target`/`--role` 收窄或 `--changed` 查看变化。只有实际交付的元素进入增量基线，不把裁掉的元素视为已读。

页面被未处理的对话框阻塞时，`--changed` 仍返回 modal 描述，且不更新增量缓存。

还可以使用语义化的 `find` 命令按 role、text、label 等属性查找，并支持位置/次序选择与 Top-N 候选列表：

```bash
autobrowser find role button click --name "Submit"
autobrowser find text "Sign in" text --exact
autobrowser find label "Email" fill "test@example.com"
autobrowser find placeholder "Search" fill "autobrowser"
autobrowser find test-id "submit-btn" click
autobrowser find role button --position last
autobrowser find role button --position nth=2
autobrowser find text "Delete" --candidates 3
```

策略包括 `role`、`text`、`label`、`placeholder`、`alt`、`title`、`test-id`（匹配 `data-testid`）和 `exact-name`（精确匹配 accessible name/文本，恒精确）。`--name` 默认子串匹配，`--exact`（MCP `exact:true`）才要求精确匹配。只读 `locate`/`text` 默认取 first；写操作有多个匹配且未显式 position 时返回 `AMBIGUOUS_TARGET` 与候选。先收窄条件或用 `--candidates <n>` 查看按质量排序的 Top-N 候选（仅支持 locate），再明确选择 `--position <first|last|nth=N>`（1 起算，越界报错）或确认后的 ref，避免盲目重试。

`search` 命令对页面可见文本做全文检索：按行匹配并返回命中行及上下文窗口，适合“抓取页面数据”而不是定位元素：

```bash
autobrowser search "Sign in"
autobrowser search /^Log\s+in/i --context 5
autobrowser search "error" --limit 10
```

查询默认按大小写不敏感的子串匹配；以 `/pattern/flags` 形式书写则按正则匹配（`g` 标志会被忽略）。`--context <n>` 控制上下文行数（默认 3，范围 0–50）；`--limit <n>` 限制窗口数（默认 20、最大 200，0 不返回窗口或游标）。每次还受 200 返回行/100000 UTF-8 字节预算约束，单个合并窗口也可能截断。`--start-line <n>` 为 1 起算的正安全整数，默认 1；若 `truncated:true` 且 `nextStartLine:201`，保持查询/目标不变运行 `search "error" --limit 10 --start-line 201` 续读，MCP 对应 `search` 的 `startLine:201`。页面内容变化可能改变行号，应重新确认。该命令只读、不定位元素也不执行动作，与 `find` 互补。

`batch` 命令把多条命令编码成一个 JSON 序列一次提交，按顺序执行，适合“先快照、再按条件交互”的多步流程。每条命令是一个对象：`command`（命令名）、`args`（参数对象）、可选的 `label`（步骤说明）、可选的 `id`（供后续步骤引用的稳定标识）、可选的 `when`（条件分支）、可选的 `skipRemainingOnFailure`（失败即终止剩余步骤）。`when` 引用前面某个步骤的结果做分支：`step` 是被引用步骤的序号（1 起算）或 `id`，`path` 是结果上的点路径（支持数组下标，如 `elements.0.ref`），`equals` / `truthy` / `exists` 三选一作为判定谓词：

```json
{ "command": "snapshot" }
{ "command": "click", "args": { "selector": "#btn" }, "when": { "step": 1, "path": "found", "truthy": true } }
{ "command": "snapshot", "id": "snap" }
{ "command": "fill", "args": { "selector": "#x", "value": "y" }, "when": { "step": "snap", "path": "elements.0.ref", "exists": true } }
{ "command": "goto", "args": { "url": "https://a.com" }, "skipRemainingOnFailure": true }
```

条件不满足，或引用的步骤失败/被跳过时，该步骤被跳过（结果带 `skipped: true` 与 `reason`），后续步骤照常执行；`skipRemainingOnFailure: true` 只在 `continueOnError: true` 时生效——失败后剩余步骤会被显式标记跳过（summary 带 `terminated: true`），否则（默认）batch 在首个失败步骤处报 `BATCH_STEP_FAILED` 并中止。

请求预算默认 30 秒；显式 eval/navigation/click `timeoutMs`、wait `timeout`/`ms` 加 5 秒传输余量且不低于默认预算。feed 按滚动次数（上限 40）× `pauseMs` + 60 秒执行余量 + 5 秒传输余量计算，不低于默认预算，超过 30 分钟则拒绝。batch 合成步骤、重试、延迟和嵌套预算，总上限 30 分钟（含余量），超大/非有限预算会拒绝。已发送后断连的结果可能未知；仅白名单只读命令会在重连后按剩余预算重试一次，副作用命令不自动重放。先检查 `status`、`command list` 和页面实际状态。显式 batch `retries` 可能重复失败步骤已发生的副作用，**不是幂等保证**；取消/超时阻止后续步骤，但不能撤销已发生的动作或所有在途 CDP 工作。

标签页会在 `tab list` 中暴露形如 `t<Chrome tabId>` 的稳定句柄（例如 `t2058764132`），CLI 可以直接使用返回的句柄切换或关闭标签页；不要猜测从 1 开始的短序号：

```bash
autobrowser tab list
autobrowser tab select t2058764132
autobrowser tab close t2058764137
```

如果页面发生了大规模重渲染或导航，请先重新运行 `snapshot` 刷新引用，再继续操作。

页面有未处理的 confirm/prompt 对话框时，`snapshot` 会返回该 modal 的描述，交互类命令会返回带 `MODAL_OPEN` 错误码和 `suggestedAction` 的错误；先用 `dialog accept` / `dialog dismiss` 处理对话框，再继续操作。

## 其他命令速查

上面几节覆盖的是主要工作流。下面是其余命令族的最小用法示例；每个命令的完整标志位以 `autobrowser help <命令>` 为准。

### 浏览器状态模拟

`set` 命令调整浏览器侧的模拟设置，按当前标签页生效：

```bash
autobrowser set viewport 390 844 3 mobile   # 宽 高 设备像素比 mobile
autobrowser set device iphone-15            # 一次性设置视口、DPR、mobile 和 UA
autobrowser set device --reset              # 同时清除设备尺寸和 UA 覆盖
autobrowser set media dark                  # 配色方案，light / 省略则重置
autobrowser set media-type print            # 打印或屏幕媒体，--reset 重置
autobrowser set reduced-motion reduce       # 也支持 no-preference / --reset
autobrowser set forced-colors active        # 也支持 none / --reset
autobrowser set contrast more               # 也支持 less / custom / no-preference / --reset
autobrowser set timezone Asia/Shanghai      # IANA 时区名，--reset 重置
autobrowser set locale zh-CN                # BCP 47 标签，--reset 重置
autobrowser set ua "Mozilla/5.0 ..."       # 覆盖 UA，--reset 或空值重置
autobrowser set geo 39.9 116.4 100          # 纬度 经度 精度(米)
autobrowser set headers "X-Token:abc,Demo:1"
autobrowser set offline                     # 切到离线；set offline false 恢复
autobrowser set permission notifications --reset   # 授权当前源，--reset 撤销
autobrowser set auto-snapshot on            # 导航和输入后自动附带 snapshot，默认 off
autobrowser set focus on                    # 隐藏标签页焦点仿真；测量后用 off 关闭
```

设备预设目前是 `desktop-chrome`、`iphone-15`、`pixel-10`，非法名字返回 `INVALID_DEVICE_PRESET`。

### 目标与命令队列

`target` 管理持久化的目标标签页，`command` 查看和干预扩展侧的命令队列：

```bash
autobrowser target show                    # 查看当前持久化目标
autobrowser target set t2                  # 绑定到稳定句柄
autobrowser target active                  # 改用浏览器活动标签页
autobrowser target clear                   # 清除持久化目标

autobrowser command list                   # 排队中与执行中的命令
autobrowser command status <id>            # 查看单个命令
autobrowser command cancel <id>            # 按 id 取消
autobrowser command reset --tab t2         # 重置目标队列
```

命令超时或页面卡死时，先用 `status` 和 `command list` 判断现场，再决定重试还是恢复，不要连续重放。

### 诊断与录制

```bash
autobrowser console --level error          # 读控制台输出，还支持 warning/info/debug
autobrowser errors                         # 读页面错误
autobrowser console clear                  # 清空控制台缓冲
autobrowser errors clear
autobrowser actions list                   # 有界动作时间线，不记录参数值
autobrowser actions clear
autobrowser tracing start
autobrowser tracing stop ./trace.json      # 落盘并返回路径，最大 32MiB
autobrowser video start
autobrowser video chapter "第一步" --duration 3000
autobrowser video stop ./out.webm          # 落盘并返回路径，最大 64MiB
```

`console` 和 `errors` 支持 `--page`、`--page-size`、`--since <timestamp>` 和 `--all-epochs`；`--level` 会连带包含更严重级别的消息。

### 可恢复的长任务采集

`feed` 采集单页虚拟列表，`collect` 把多页流程跑成可断点续传的 JSONL 任务：

```bash
autobrowser feed collect 'article' --limit 50 --dedupe url
autobrowser collect run ./spec.json
autobrowser collect resume ./spec.json     # 从失败页继续，按内容去重
```

`collect` 的 spec 是 JSON：`{name, mode: "feed"|"network", startUrl?, output, maxPages?, feed?, network?}`。`feed` 模式用 `feed.selector/limit/dedupe/maxScrolls/pauseMs/stallRounds/nextSelector/waitTimeoutMs`；`network` 模式用 `network.urlPattern/itemsPath` 和可选的 `nextPath` 跟随真实响应游标。每完成一页就原子更新输出 JSONL 和 checkpoint，失败时按提示 `collect resume`；checkpoint 不含 cookie 或 token。该命令当前只支持 Chromium 扩展通道。

### 数据导出

```bash
autobrowser network export ./requests.jsonl     # 请求摘要 JSONL，比完整 HAR 更好 diff
autobrowser snapshot export ./snapshot.jsonl    # 完整快照 JSONL
autobrowser snapshot extract ./fields.jsonl --field 'elements.*.text'
```

`snapshot extract` 的 `--field` 支持逗号分隔的多项和 `*` 前缀通配，只导出匹配的字段路径。

### 页面读写与其他

```bash
autobrowser state save my-profile            # 保存浏览器状态
autobrowser state load my-profile            # 按名字恢复
autobrowser clipboard read
autobrowser clipboard write "hello"
autobrowser pdf                              # 导出当前页为 PDF
autobrowser config                           # 查看已保存的连接配置
autobrowser replay                           # 重放上一条记录的命令
autobrowser skill sync                       # 同步包内 SKILL.md 到 ~/.agents/skills/autobrowser/
autobrowser skill status                     # 只检查是否与包内一致，不写入
```

`replay` 会拒绝含 `[redacted]` 的历史命令，不会拿脱敏占位符当真实参数执行。`skill sync` 是更新 agent 提示词的官方途径，包内 SKILL.md 位于 `.agents/skills/autobrowser/SKILL.md`，可用 `AUTOBROWSER_SKILL_DIR` 覆盖安装位置。

低层输入与拖拽：

```bash
autobrowser keyboard type "hello"            # type / inserttext / keydown / keyup
autobrowser mousemove 400 300
autobrowser mousedown left
autobrowser mouseup left
autobrowser mousewheel 0 500
autobrowser drag "#a" "#b"
autobrowser scrollintoview "#result"
autobrowser upload "input[type=file]" ./a.png ./b.png
autobrowser fillform '[{"selector":"#u","value":"a"},{"selector":"#p","value":"b"}]'
autobrowser window new
autobrowser close all                        # 关闭当前窗口全部标签页
```

`fillform` 一次填多个字段，单个字段失败不会中断其余字段，输入是 JSON 数组或 `{"fields":[...]}`，也支持 `--stdin`/`--file`/`--base64`。

`dialog auto` 控制运行时是否自动接受 alert/beforeunload（默认开启，仅运行时生效）：

```bash
autobrowser dialog auto --off
autobrowser dialog auto --on
```

## 错误输出契约

命令失败时 stdout 上永远是同一套 JSON，退出码为 1：

```json
{
  "ok": false,
  "error": {
    "message": "missing value for click",
    "code": "CLI_INVALID_ARGUMENT",
    "retryable": false,
    "details": { "path": "click", "command": "click" },
    "suggestedAction": "Run 'autobrowser help click' to see the accepted arguments, then run the command again with a corrected value."
  }
}
```

- 参数类错误（缺参、多参、取值非法、未知选项）用 `CLI_INVALID_ARGUMENT`，未知命令用 `CLI_UNKNOWN_COMMAND`，其余 CLI 层失败用 `CLI_ERROR`；运行期错误仍用扩展/relay 自己的错误码。
- `suggestedAction` 是每个错误码的默认下一步（见 `src/core/error-actions.ts`），扩展给出的更具体建议优先；`retryable` 表示检查当前状态后是否可以重试，结果未知时仍禁止盲目重放。
- 查询无匹配仍是成功：`ok:true`、退出码 0，并带 `empty:true` 和 `emptyReason:NO_DATA|NO_MATCH|FILTERED_OUT`。`find ... locate` 无匹配也按此返回；动作命令无目标则返回 `ELEMENT_NOT_FOUND`、退出码 1。
- 命令名写错时不会打印整页帮助，而是直接报出未知命令，并在 `details.candidates` 里给出最接近的命令名（例如 `autobrowser snap` → `snapshot`）；未知选项也会按当前命令的 help 给出最近邻建议。
- 裸 CSS 选择器未匹配返回 `ELEMENT_NOT_FOUND`，`@eN` 快照引用无法解析返回 `STALE_REFERENCE`，两者的修复建议不再混用。
- `--raw` / `--brief` 会退回纯文本：错误写在 stderr，并附一行 `[AI SUGGESTION]` 建议。

## MCP 服务器（Model Context Protocol）

`autobrowser mcp` 通过 stdio 暴露一个 MCP（Model Context Protocol）服务器，把核心命令包装成 MCP tools，供 Claude Desktop 等 MCP 客户端直接调用：

```bash
autobrowser mcp
```

当前暴露 46 个工具，按用途分组如下：

- 页面与导航：`navigate`、`snapshot`、`search`、`feed`、`find`、`click`、`dblclick`、`hover`、`fill`、`type`、`press`、`scroll`、`get`、`wait`、`screenshot`、`eval`。
- 标签页与控制：`tab_list`、`target`、`command_control`、`tab_new`、`tab_select`、`tab_close`。
- 浏览器、网络与状态：`cdp`、`webmcp_list`、`webmcp_call`、`console`、`errors`、`network_requests`、`network_har`、`dialog`、`cookies`、`storage`。
- 其他交互与诊断：`locator`、`highlight`、`drop`、`mouse_move`、`mouse_down`、`mouse_up`、`mouse_wheel`、`video`、`tracing`、`actions`、`auto_snapshot`、`media_emulation`、`device`、`fill_form`。

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

`bun test` 不会真的拉起浏览器：`NODE_ENV=test` 时 `openUrl` 直接返回，`connect` / `session attach` 之类要开页面的命令只记录 URL，不会把标签页开在开发者机器的真实浏览器里（子进程型 CLI 测试没法注入替身，这道闸门是唯一保证）。确实需要真实浏览器时用 `AUTOBROWSER_DISABLE_BROWSER=0` 显式放开。

## 从源码运行

上面的示例都以 npm 全局安装后的 `autobrowser` 命令为准。如果你是在这个仓库里开发，用 Bun 直接跑：

```bash
bun install
bun run build:cli
bun run build:chrome
bun run link:bun
```

`link:bun` 默认用 Bun AOT 构建原生启动器并安装到 Bun 旁边，把本地 CLI 链接成全局的 `autobrowser` 命令；本机只需 Bun。需要备选 Go 实现时运行 `bun run link:bun -- --go`。不链接也可以用 `bun run src/cli.ts <子命令>` 直接运行源码，效果与 `autobrowser <子命令>` 等价；此时按「扩展」一节加载仓库里的 `chrome/`。
