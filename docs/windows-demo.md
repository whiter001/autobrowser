# Windows 启动示例

Windows 链接流程提供两个入口：

- `autobrowser.exe`：原生启动器，供 cmd.exe 和 PowerShell 使用。
- `autobrowser`：sh 包装器，供 Git Bash、WSL 等 POSIX shell 使用。

原生启动器通过 argv 数组把参数交给 Bun 和本地 `dist/autobrowser.js`，不经过批处理 `%*`，因此不会额外展开参数中的 `%VARIABLE%`。旧的 `autobrowser.cmd` 会在重新链接时移除。

## 构建并链接

```powershell
bun run build:cli
bun run link:bun
```

`link:bun` 会把启动器放到 Bun 可执行文件旁边。确认该目录已加入 PATH 后，在 cmd.exe 或 PowerShell 中运行：

```powershell
autobrowser.exe help
autobrowser.exe status
autobrowser.exe connect
autobrowser.exe tab list
```

Git Bash 中使用无扩展名入口：

```bash
autobrowser status
autobrowser open https://example.com
autobrowser snapshot
```

cmd.exe 自身会在启动程序前展开 `%VARIABLE%`，进程无法还原这类调用方替换。复杂或多行 JavaScript 优先通过 `eval --file <path>` 或 `eval --stdin` 输入。
