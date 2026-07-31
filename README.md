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

还可以使用语义化的 `find` 命令按 role、text 和 label 查找：

```bash
bun run src/cli.ts find role button click --name "Submit"
bun run src/cli.ts find text "Sign in" text --exact
bun run src/cli.ts find label "Email" fill "test@example.com"
```

标签页现在会在 `tab list` 中暴露稳定句柄，CLI 也可以在不依赖原始数字 id 的情况下切换或关闭它们：

```bash
bun run src/cli.ts tab list
bun run src/cli.ts tab select t2
bun run src/cli.ts tab close t3
```

如果页面发生了大规模重渲染或导航，请先重新运行 `snapshot` 刷新引用，再继续操作。

## 测试

运行 `bun test`。