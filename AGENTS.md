# AGENTS

autobrowser 主要方向是用 AI操作浏览器和抓取页面里的数据

生成代码时，只在非显而易见的地方添加注释，重点解释业务意图、为什么选择这种实现、边缘case处理和任何权衡。避免逐行解释简单语句。使用中文注释

编辑代码后，优先补跑相关校验：类型改动后运行 `bun run typecheck`，格式相关改动后运行 `bun run fmt`，必要时补 `bun run lint`；如果改动面较小，只修复本次编辑引入的问题，不扩散到无关文件。

autobrowser的提示宗旨,为了让AI更好的了解和使用autobrowser的操作逻辑,而不是让AI执行失败之后觉得不行改换别的方案

## 本仓库安装与升级约定

在本仓库安装或升级本机 autobrowser 时，默认使用当前源码构建并全局链接，不使用 `npm i -g @whiter001/autobrowser`、`npm rebuild -g` 等 npm 发布包安装方式，也不要把 `bun run src/cli.ts` 当成安装后的日常入口。

标准流程：

```bash
git pull --ff-only
bun install
bun run build:cli
bun run build:chrome
bun run link:bun
```

`link:bun` 会把原生启动器放到全局 PATH 可访问的位置，并链接当前仓库的 `dist/autobrowser.js`；Windows 任意目录使用 `autobrowser.exe`，其他平台使用 `autobrowser`。安装或升级后重启 relay、重载扩展，并用 `version` 与 `extension info` 核对 CLI、扩展和仓库 HEAD 的 commit 一致。