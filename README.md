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

如果你想看 Windows 原生 exe 启动示例，请参见 [`docs/windows-demo.md`](docs/windows-demo.md)。

## 安装

### 前置条件：Bun 运行时

先安装 [Bun](https://bun.sh)（>= 1.4.4）。npm 全局入口是小型 Go 原生启动器，但业务仍由 Bun 执行 `dist/autobrowser.js`，不是 Go 重写或独立打包的 CLI。启动器从 `PATH` 找 `bun` / `bun.exe`，也可用 `AUTOBROWSER_BUN_PATH` 指定 Bun；需要自定义 JS 入口时设置 `AUTOBROWSER_DIST_ENTRY`。缺少运行时或入口会给出明确错误。

### 全局安装

```bash
npm i -g @whiter001/autobrowser
```

装完后 `autobrowser` 命令就在 `PATH` 里了。本文档下面的示例都以这个命令为准；仓库开发者想直接跑源码，见文末的「从源码运行」。

#### 原生全局入口（Windows / macOS / Linux）

包的 `postinstall` 会把对应平台的 Go 启动器复制到 npm 全局入口：Windows 为 `<prefix>/autobrowser.exe`，POSIX 为 `<prefix>/bin/autobrowser`。支持 macOS、Linux、Windows 的 x64 / arm64。它用参数数组启动 Bun + 包内 `dist/autobrowser.js`，保留 cwd、环境和标准输入输出，不经过 cmd.exe、`.bat`、`.ps1` 或 sh shim。安装成功会移除旧 shim；写死 `autobrowser.cmd` 的调用方应改用 `autobrowser`（Windows 也可显式调用 `autobrowser.exe`）。

`bin` 仍指向 JS，npm 先生成 shim，再由 postinstall 替换。禁用安装脚本（例如 `--ignore-scripts` 或 npm 的 `allow-scripts` 未放行）时，**仍然只有旧 npm shim，不会凭空出现 exe**。按当前 npm 版本放行脚本后重建，例如：

```bash
npm config set allow-scripts=@whiter001/autobrowser --location=user
npm rebuild -g @whiter001/autobrowser
```

不支持的平台、缺少预编译文件或非全局安装沿用旧入口；Windows 全局缺少原生文件时仍把 `.cmd` 改名为 `.bat`，优先让 PowerShell 使用 `.ps1`。原生文件存在但复制失败会明确报错，不会静默回退。不要从 PowerShell 显式调用 `.cmd`：它可能使 `& | ^ < >` 等参数被再次解析。

原生启动器也不能撤销调用方 shell 已做的展开（如 cmd.exe 的 `%VARIABLE%`）；复杂 `eval` 仍推荐 `--file`、`--stdin` 或 `--base64`。

**卸载注意**：npm 不登记 Windows postinstall 额外生成的 `.exe`，回退产生的 `.bat` 也不登记。`npm uninstall -g @whiter001/autobrowser` 后，请手动清理 `<prefix>/autobrowser.exe` 和可能存在的 `<prefix>/autobrowser.bat`（`npm prefix -g` 可查 prefix）。POSIX 替换了 npm 原有 symlink，卸载时也请检查并清理残留的 `<prefix>/bin/autobrowser`。

源码开发的 `bun run link:bun` 同样用 Go 构建原生启动器（Windows 为 `autobrowser.exe`，其他平台为 `autobrowser`）并安装到 Bun 旁边，启动器嵌入当前 Bun 与仓库 `dist/autobrowser.js` 的绝对路径，链接后无需额外环境变量；它不再生成 sh 包装器，开发机需要安装 Go。它和 npm Go 启动器是两条独立路径，见 [`docs/bun-link.md`](docs/bun-link.md)。发布构建 `bun run build` 会自动构建六种原生文件；只构建本机可用 `bun run build:launcher -- --current`，构建机需要 Go，安装用户不需要 Go。

### 验证

```bash
autobrowser help
```

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

如果本地后台服务尚未运行，`connect` 会自动先启动它。

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
```

`--gone` 与 `--text` 搭配，等待文本从页面消失。

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

`extension info` 返回 `extensionId`、`version`、`buildTime`、`commit`、`userAgent`，用于重载后确认实际加载的版本与构建。构建输出的 manifest 版本与 `package.json` 同步；每次构建生成 ISO `buildTime` 和短 git `commit`（无 git 时为 `null`）。运行时 `version` 始终取 manifest；旧构建缺少构建信息、读取失败或字段非法时，`buildTime` / `commit` 回退 `null`。功能兼容仍通过 `capabilities` 协商，不根据版本号推断。

`extension reload` 从磁盘重载扩展代码；`extension reconnect` 只重建扩展与 relay 的连接，不加载新代码，与刷新页面的 `reload` 也不同。两者先返回成功回执（`reloading:true` / `reconnecting:true`，并带 `reconnectExpected:true`），约 50ms 后异步执行；回执表示已安排操作，不表示恢复完成。稍等后用 `status` 确认重新连接，再继续页面命令。命令仅用于已连接的 Chromium 扩展，不绑定 tab、不进入页面队列；首次升级到支持此命令的版本仍需在 chrome://extensions 手动重新加载。

加载完成后，运行 `autobrowser connect` 可以打开扩展连接页；它会自动保存 token 和中继端口，而你传入的 `--extension-id`、`--browser-command` 或 `--browser-arg` 也会保存在 `~/.autobrowser/config.json` 中供后续复用。仓库开发者如果还没跑 `bun run link:bun`，可以直接用 `bun run src/cli.ts connect` 代替；命令名其余部分完全一致。`options` 页面仍然可以作为手动兜底，并显示诊断信息。

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

未开启 HAR 时自动监控仅保存元数据，`network request <id>` 按需通过 CDP 补取 body；历史请求/失效会话可能无法补取，需查看失败信息，`--include-details` 只返回已存详情。HAR body 获取最多 4 个并发槽、单次 10 秒逻辑超时；不可中止的 CDP 工作仍占槽直到结束。`--har-max-requests` 只限制本次 capture 的导出数量，不裁剪全局历史；`--har-max-body-bytes` 只限制存储，不限制 CDP 下载/传输量。`har stop` 只等待本次 capture，大结果透明分块重组；超出传输预算明确报错，不静默截断 HAR。大采集可用 `network har stop [output.har] --timeout-ms <ms>` 延长预算；超时后先查 `network har status` 的 `checkpoint.recoverable`，再决定是否 `network har recover`。

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

导航也支持条件等待：`goto/open <url> --wait-for url <pattern>|selector <css> --timeout-ms <ms>`。导航与附加条件等待各使用该预算；URL 条件不会覆盖导航地址。`tab new <url> --wait-for selector <css> --timeout-ms <ms>` 在创建后等待返回的新 tab handle，而不是活动标签页；超时仍在错误响应的 `result.tab` 中保留新 tab 信息，便于找回或关闭。不带等待选项时输出不变。

`media list` 的溯源信息：

- 顶层返回 `observedAt`（采集时间）、`pageEpoch`（页面 epoch）、`pageUrl`（页面地址）和 `scope`（`selector` / `mode` / `matchedCount`，未指定选择器时如实表示默认作用域）。
- 顶层还返回 `complete:boolean` 和 `warnings:string[]`。作用域未匹配、空媒体、未解析源/错误或 resolve 探测数量达到上限都会标记 `complete=false` 并给可读 warning；仅正常非空、无已知缺口时为 `true`。`complete` 只表示本次发现过程无已知缺口，不证明未渲染的轮播媒体不存在。
- 每个条目带 `permalink`（最近 `article` 内首个含 `/status/` 的绝对链接，没有则为 `null`）和 `primarySource`（`dom` = 来自 DOM 属性或 CSS，`none` = 尚未解析出可信源）。顶层 `includeBackground` 回显本次背景图开关。

网络归属采用严格保守契约：默认模式与 selector 模式都不认领历史 tab-wide 候选。即使播放期间新增请求，也可能来自 scope 外并发流量；只有实际 played 的探测才将新增候选放入 `observedSources`（每条 `unverified:true`），仅供诊断，绝不进入可下载的 `sources/url`，`download --media` 不使用它。失败或元素身份不符时诊断为空。只有 observedSources 而无可信 DOM 源仍为 `complete=false` 并给 warning，宁可 unresolved，不猜测下载。

探测通过同一 document 内的稳定元素 token 找回原元素，并验证 connected 且仍属 scope；空 src、相同 src、删除、重排和替换不会让探测播放别的元素。采集开始记录 pageEpoch，采集/探测后或返回前 epoch 改变时报 `STALE_MEDIA_STATE`，必须重新采集。index 仅在相同 tab/frame/scope/epoch 内有效；`download --media` 重新 list 时须传相同 `--selector`/`--include-background`，并用 `--media-epoch <n>` 要求返回 epoch 完全一致，否则失败。epoch 不代表 DOM 不变，重排后应重新确认 index。CLI 对显式 scope、includeBackground 支持及 wait 完成要求响应明确回显，旧扩展缺少证明时拒绝成功。

下载行为：

- 输出使用显式路径或 `--output-dir` 自动命名，父目录自动创建。默认原子替换已有文件；`--no-clobber` 会在下载前拒绝覆盖，`--overwrite` 可显式选择默认行为。
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

`--full` 会截取整页，`--element` 只截取某个元素（接受选择器或 `@eN` 引用，与 `--full` 互斥），`--annotate` 会给元素添加编号标签，而 `--screenshot-format` / `--screenshot-quality` 用于控制编码后的图片输出。

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
- 输出最多 200000 UTF-8 字节，`truncated` 时用 `--target`/`--role` 收窄或 `--changed` 查看变化。只有实际交付的元素进入增量基线，不把裁掉的元素视为已读。

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

请求预算默认 30 秒；显式 eval/navigation/click `timeoutMs`、wait `timeout`/`ms` 加 5 秒传输余量且不低于默认预算。feed 按滚动次数（上限 40）× `pauseMs` + 60 秒执行余量 + 5 秒传输余量计算，不低于默认预算，超过 30 分钟则拒绝。batch 合成步骤、重试、延迟和嵌套预算，总上限 30 分钟（含余量），超大/非有限预算会拒绝。已发送后断连的结果可能未知，不自动重放；先检查 `status`、`command list` 和页面实际状态。显式 batch `retries` 可能重复失败步骤已发生的副作用，**不是幂等保证**；取消/超时阻止后续步骤，但不能撤销已发生的动作或所有在途 CDP 工作。

标签页现在会在 `tab list` 中暴露稳定句柄，CLI 也可以在不依赖原始数字 id 的情况下切换或关闭它们：

```bash
autobrowser tab list
autobrowser tab select t2
autobrowser tab close t3
```

如果页面发生了大规模重渲染或导航，请先重新运行 `snapshot` 刷新引用，再继续操作。

页面有未处理的 confirm/prompt 对话框时，`snapshot` 会返回该 modal 的描述，交互类命令会返回带 `MODAL_OPEN` 错误码和 `suggestedAction` 的错误；先用 `dialog accept` / `dialog dismiss` 处理对话框，再继续操作。

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

## 从源码运行

上面的示例都以 npm 全局安装后的 `autobrowser` 命令为准。如果你是在这个仓库里开发，用 Bun 直接跑：

```bash
bun install
bun run build:cli
bun run build:chrome
bun run link:bun
```

`link:bun` 会用 Go 构建原生启动器并安装到 Bun 旁边，把本地 CLI 链接成全局的 `autobrowser` 命令；本机需要安装 Go，Go 缺失时链接直接失败。不链接也可以用 `bun run src/cli.ts <子命令>` 直接运行源码，效果与 `autobrowser <子命令>` 等价；此时按「扩展」一节加载仓库里的 `chrome/`。