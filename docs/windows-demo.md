# Windows 启动示例

## npm 全局安装

```powershell
npm i -g @whiter001/autobrowser
autobrowser.exe help
```

postinstall 会把预编译 Go 启动器放到 `<npm prefix -g>/autobrowser.exe`，删除同目录旧 `.cmd`、`.bat`、`.ps1` 和 sh shim。原生进程用参数数组启动 Bun + 包内 `dist/autobrowser.js`，不经过 cmd.exe，也不重写业务；仍需安装 Bun 并加入 PATH，或设置 `AUTOBROWSER_BUN_PATH`，自定义 JS 入口可设置 `AUTOBROWSER_DIST_ENTRY`。

禁用 npm 安装脚本时只会保留旧 shim，没有原生 exe。按 npm 版本放行脚本（例如 `npm config set allow-scripts=@whiter001/autobrowser --location=user`）后运行 `npm rebuild -g @whiter001/autobrowser`。缺少预编译文件/不支持平台时才回退到旧 Windows `.cmd` → `.bat` 修正；复制失败会明确报错，不静默回退。不要从 PowerShell 显式调用 `.cmd`。

卸载后需手动清理 npm 未登记的 `<prefix>/autobrowser.exe`、可能残留的 `<prefix>/autobrowser.bat`。Go 不会撤销调用方 shell 的展开，复杂 eval 仍推荐 `--file` / `--stdin` / `--base64`。

## 源码开发链接（行为不变）

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
