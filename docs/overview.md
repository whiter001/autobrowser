# autobrowser 概览

`autobrowser` 是一个基于 Bun 的浏览器自动化工具，通过本地中继服务和浏览器扩展来驱动 Chrome/Edge。

## 本仓库提供了什么

- 端口 `57978` 的本地中继服务
- 端口 `57979` 的 CLI API 服务
- 带有基于 token 的连接流程的浏览器扩展骨架
- 覆盖服务与连接管理、导航、标签页和窗口控制、元素交互、对话框、等待与状态检查、cookie、存储、剪贴板、浏览器状态、网络检查与拦截、snapshot、snapshot 导出/提取、截图、初始化脚本注入（`script add/list/remove`），以及 `batch`、`status`、`config`、`replay`、`network export` 这类实用命令的核心能力

运行 `bun run src/cli.ts help` 可以查看完整命令树。`src/cli.ts` 里的命令树是标志位和语法的权威来源。`autobrowser mcp` 还会通过 stdio 暴露一个 MCP（Model Context Protocol）服务器，把核心命令包装成 MCP tools，供 Claude Desktop 等 MCP 客户端调用。

## 文档地图

`src/cli.ts` 的命令树是权威参考。这个目录里的文档则把较长的使用流程整理在一起：

- [`install.md`](install.md) 讲解未打包扩展的安装和已保存的连接配置。
- [`bun-link.md`](bun-link.md) 讲解 Bun 包装器和 `bun link` 行为。

## 核心流程

```bash
bun run src/cli.ts server
bun run src/cli.ts connect
bun run src/cli.ts open https://example.com
```

- `server` 会启动本地中继服务和 IPC 服务。
- `connect` 会打开扩展连接页，并在需要时先启动本地服务。
- `open` 会把当前标签页导航到某个 URL。

如果你要操作特定目标，根级 `--tab` 和 `--frame` 标志可以把兼容命令绑定到某个标签页句柄或 frame 引用。对于简短且确定性的流程，最好使用带 JSON 数组或对象主体的 `batch`，而不是发起多次往返。

## 面向 Agent 的工作流

在复杂页面上动手之前，先运行 `snapshot`。snapshot 现在会包含一个 `elements` 数组，里面有诸如 `@e1`、`@e2` 这样的引用，以及每个可见可交互元素的 tag、role、text 和几何信息。它还会包含一个 `frames` 数组，里面有诸如 `@f1` 这样的可见 iframe 引用。

这些引用在任何接受选择器的地方都可以直接使用，因此 agent 可以优先采用下面这种模式：

```bash
bun run src/cli.ts snapshot
bun run src/cli.ts click @e2
bun run src/cli.ts get text @e3
bun run src/cli.ts fill @e5 "hello"
bun run src/cli.ts frame @f1
```

当 CSS 选择器仍然太脆弱时，优先使用语义化查找：

```bash
bun run src/cli.ts find role button click --name "Continue"
bun run src/cli.ts find text "Pricing" click
bun run src/cli.ts find label "Email" fill "agent@example.com"
```

当你需要把 snapshot 数据导出给下游处理时，可以使用 `snapshot export` 导出完整的 JSONL 流，或者用 `snapshot extract` 搭配 `--field` 选择更窄的记录。对于网络跟踪，`network export` 会写出 JSONL 摘要，通常比完整 HAR 更方便 diff。

对于多标签页流程，优先使用 `tab list` 中的稳定标签页句柄：

```bash
bun run src/cli.ts tab list
bun run src/cli.ts tab select t2
```

如果 DOM 发生了明显变化，请再跑一次 `snapshot` 来刷新引用。

## 构建与 link 流程

```bash
bun run build:cli
bun run build:chrome
bun run link:bun
```

- `build:cli` 会生成 `dist/autobrowser.js`。
- `build:chrome` 会在 `chrome/` 下生成未打包扩展，并注入扩展 key。
- `link:bun` 会把 `autobrowser` 包装器写到 `bun` 或 `bun.exe` 的旁边。

之后，就可以在同一个能访问 `bun` 或 `bun.exe` 的环境里直接运行 `autobrowser` 了。