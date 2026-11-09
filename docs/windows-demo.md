# Windows 启动示例

## npm 全局安装

```powershell
npm i -g @whiter001/autobrowser
autobrowser.exe help
```

postinstall 会把预编译原生启动器放到 `<npm prefix -g>/autobrowser.exe`，删除同目录旧 `.cmd`、`.bat`、`.ps1` 和 sh shim。发布机为 Windows 时使用 Bun AOT，其他主机交叉构建 Windows 目标时使用 Go 备选。原生进程用参数数组启动 Bun + 包内 `dist/autobrowser.js`，不经过 cmd.exe，也不重写业务；仍需安装 Bun 并加入 PATH，或设置 `AUTOBROWSER_BUN_PATH`，自定义 JS 入口可设置 `AUTOBROWSER_DIST_ENTRY`。

禁用 npm 安装脚本时只会保留旧 shim，没有原生 exe。按 npm 版本放行脚本（例如 `npm config set allow-scripts=@whiter001/autobrowser --location=user`）后运行 `npm rebuild -g @whiter001/autobrowser`。缺少预编译文件/不支持平台时才回退到旧 Windows `.cmd` → `.bat` 修正；复制失败会明确报错，不静默回退。不要从 PowerShell 显式调用 `.cmd`。

卸载后需手动清理 npm 未登记的 `<prefix>/autobrowser.exe`、可能残留的 `<prefix>/autobrowser.bat`。原生启动器不会撤销调用方 shell 的展开，复杂 eval 仍推荐 `--file` / `--stdin` / `--base64`。

## 源码开发链接

Windows 链接流程只提供一个入口：

- `autobrowser.exe`：Bun AOT 原生启动器，供 cmd.exe、PowerShell 和 Git Bash 使用。

启动器通过 argv 数组把参数交给 Bun 和本地 `dist/autobrowser.js`，不经过批处理 `%*`，因此不会额外展开参数中的 `%VARIABLE%`。默认链接只需要 Bun；`bun run link:bun -- --go` 可显式使用备选 Go 实现，此时需要本机安装 Go。启动器在编译期嵌入当前 Bun 与仓库 `dist/autobrowser.js` 的路径，无需额外环境变量；旧的 `autobrowser`（无扩展名 sh 入口）和 `autobrowser.cmd` 会在重新链接时移除。

## 构建并链接

```powershell
bun run build:cli
bun run link:bun
```

`link:bun` 会用当前 Bun 的 `--compile --aot` 构建原生启动器并放到 Bun 可执行文件旁边。确认该目录已加入 PATH 后，在 cmd.exe 或 PowerShell 中运行：

```powershell
autobrowser.exe help
autobrowser.exe status
autobrowser.exe connect
autobrowser.exe tab list
```

Git Bash 中同样使用 `autobrowser.exe`（Windows 不再提供无扩展名入口）：

```bash
autobrowser.exe status
autobrowser.exe open https://example.com
autobrowser.exe snapshot
```

cmd.exe 自身会在启动程序前展开 `%VARIABLE%`，进程无法还原这类调用方替换。复杂或多行 JavaScript 优先通过 `eval --file <path>` 或 `eval --stdin` 输入。CSS 属性选择器的值要按 CSS 语法加引号，例如 `a[href*="/status/"]`；如果页面报 `not a valid selector`，说明脚本已经解析并运行，应先修正 CSS，而不是只排查 shell 引号。

PowerShell 的 `Get-ChildItem` 对符号链接可能显示 `Length = 0`，这不代表目标可执行文件损坏。用 `(Get-Item <path>).Target` 查看链接目标，再检查目标文件的大小和实际执行结果。
