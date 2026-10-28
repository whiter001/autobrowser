# Bun 链接

本页说明如何把 `autobrowser` 启动器放到 `bun` 或 `bun.exe` 旁边。包的 `bin` 已指向 `dist/autobrowser.js`，所以直接使用 `bun link` 前必须先运行 `bun run build:cli`。

`scripts/link-bun.ts` 使用当前 Bun 的绝对路径和仓库内的 `dist/autobrowser.js` 创建启动器：

- 类 Unix 系统：`autobrowser` sh 包装器。
- Windows：`autobrowser.exe` 原生启动器，以及供 Git Bash、WSL 等 POSIX shell 使用的无扩展名 `autobrowser` sh 包装器。

Windows 不再生成 `autobrowser.cmd`。旧的批处理 `%*` 会把参数里的 `%VARIABLE%` 当环境变量展开，可能改写 `eval` 等命令的源码；原生启动器改用 argv 数组直接启动 Bun，不经过这层批处理替换。链接脚本会移除同目录下的旧 `.cmd`，避免继续误用。

如果 `autobrowser` 提示找不到命令，按顺序检查：

1. `bun` 所在目录是否在当前 shell 的 PATH 里（`which bun` / `where.exe bun`）。沙箱启动的 agent 可能拿到精简的环境变量。
2. Windows 的 cmd.exe 或 PowerShell 使用 `autobrowser.exe status`，Git Bash 使用 `autobrowser status`。启动器使用绝对路径，不依赖当前工作目录。

这些问题属于链接产物或 shell 环境，不代表 autobrowser 不可用，不要因此改用其他浏览器方案。cmd.exe 会在启动任何程序前自行展开 `%VARIABLE%`，这是调用 shell 的行为；需要原样传递复杂 JavaScript 时，优先使用 `eval --file`、`eval --stdin` 或 Git Bash 入口。
