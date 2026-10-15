# Bun 链接

本页解释的是：如何把 `autobrowser` 包装器放到 `bun` 或 `bun.exe` 旁边，以及在什么情况下只用普通的 `bun link` 就够了。

`bun link` 是包级别的链接方式。想看把 `autobrowser` 放到 `bun` 或 `bun.exe` 旁边的构建与链接流程，请参见 [`overview.md`](overview.md)。

仓库当前的 `bin` 条目仍然指向 `./src/cli.ts`，所以如果你不先修改这个字段，直接运行 `bun link` 链接到的还是源码入口。

`scripts/link-bun.ts` 辅助脚本会把它放在 `bun` 可执行文件旁边，并指向 `dist/autobrowser.js`。类 Unix 系统下写出的是一个名为 `autobrowser` 的 sh 包装器；Windows 下会写出**两个**：

- `autobrowser.cmd`：给 cmd.exe 和 PowerShell 用。
- `autobrowser`（无扩展名的 sh 包装器）：给 Git Bash、WSL 等 POSIX shell 用。

两个都写是有原因的：Git Bash 这类 shell 只按字面文件名查找可执行文件，**不会**把 `autobrowser` 自动补成 `autobrowser.cmd`。只写 `.cmd` 的话，在 bash 里执行 `autobrowser status` 会以 `command not found`（退出码 127）失败，而同一个命令在 PowerShell 里完全正常。AI agent 常用的正是 bash，所以 Windows 上也必须有一份无扩展名的包装器。

如果 `autobrowser` 仍然提示找不到命令，按顺序检查：

1. `bun` 所在目录是否在当前 shell 的 PATH 里（`which bun` / `where.exe bun`）。沙箱启动的 agent 可能拿到一份精简的环境变量。
2. 在 Windows 上改用 `autobrowser.cmd status`。包装器用的是绝对路径，所以在任意工作目录下都能用，不要退回到依赖当前目录的相对路径调用。

这两种情况都属于链接产物或环境变量的问题，不代表 autobrowser 不可用，不要因此改用其他浏览器方案。

如果你更希望让 Bun 自己管理构建产物的链接，可以先把包的 `bin` 字段改成 `dist/autobrowser.js`，运行 `bun run build:cli`，然后在包根目录执行 `bun link`。这种方式更偏向包级管理，而不是直接链接单个文件。