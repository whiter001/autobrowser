# Bun 链接

本页说明如何把 `autobrowser` 启动器放到 `bun` 或 `bun.exe` 旁边。包的 `bin` 已指向 `dist/autobrowser.js`，所以直接使用 `bun link` 前必须先运行 `bun run build:cli`。

`scripts/link-bun.ts` 使用 Go 构建原生启动器，并把它安装到当前 Bun 旁边：

- Windows：`autobrowser.exe`。
- 其他平台：`autobrowser`。

开发链接需要本机装有 Go；Go 缺失时链接直接失败，不再回退生成 sh 包装器。启动器在编译期嵌入当前 Bun 的绝对路径和仓库内的 `dist/autobrowser.js`，因此链接后的入口无需任何环境变量就能工作；`AUTOBROWSER_BUN_PATH` / `AUTOBROWSER_DIST_ENTRY` 仍然可以覆盖这两个默认值。

Windows 不再生成 `autobrowser.cmd`，也不再生成供 Git Bash、WSL 等 POSIX shell 使用的无扩展名 sh 入口；链接脚本会清理同目录下遗留的这两个文件。旧的批处理 `%*` 会把参数里的 `%VARIABLE%` 当环境变量展开，可能改写 `eval` 等命令的源码；原生启动器改用 argv 数组直接启动 Bun，不经过这层批处理替换。

如果 `autobrowser` 提示找不到命令，按顺序检查：

1. `bun` 所在目录是否在当前 shell 的 PATH 里（`which bun` / `where.exe bun`）。沙箱启动的 agent 可能拿到精简的环境变量。
2. Windows 的 cmd.exe、PowerShell 或 Git Bash 使用 `autobrowser.exe status`，其他平台使用 `autobrowser status`。启动器使用绝对路径，不依赖当前工作目录。

这些问题属于链接产物或 shell 环境，不代表 autobrowser 不可用，不要因此改用其他浏览器方案。cmd.exe 会在启动任何程序前自行展开 `%VARIABLE%`，这是调用 shell 的行为；需要原样传递复杂 JavaScript 时，优先使用 `eval --file`、`eval --stdin` 或 `--base64`。

## npm 全局安装的 Go 启动器

`npm i -g @whiter001/autobrowser` 不经过 `scripts/link-bun.ts`。npm 按 `bin: dist/autobrowser.js` 生成 shim 后，`scripts/npm-postinstall.mjs` 优先复制包内 `launchers/` 的 Go 原生文件：Windows 到 `<prefix>/autobrowser.exe`，POSIX 到 `<prefix>/bin/autobrowser`，并清理旧 `.cmd`、`.bat`、`.ps1`、sh 入口。支持 darwin/linux/windows 的 x64/arm64，不通过 shell 转发参数。

Go 仅以 `[distEntry, ...args]` 启动 Bun，不包含浏览器业务。Bun 从 `AUTOBROWSER_BUN_PATH` 或 PATH 查找；dist 从 `AUTOBROWSER_DIST_ENTRY` 或相对启动器的全局/局部 npm 布局查找。cwd、env、stdio 和退出码保留。安装用户不需要 Go，构建机需要；`bun run build:launcher` 构建六个目标，`bun run build:launcher -- --current` 只构建本机。

禁用安装脚本（`--ignore-scripts` 或 npm 的 `allow-scripts` 未放行）时仍是旧 npm shim，不会安装原生 exe。按 npm 版本放行后可重建：

```bash
npm config set allow-scripts=@whiter001/autobrowser --location=user
npm rebuild -g @whiter001/autobrowser
```

非全局、不支持平台或缺少预编译文件才沿用旧修正：Windows 全局把 `.cmd` 改名成 `.bat`，让 PowerShell 优先选 `.ps1`。原生文件存在但写入失败会明确记录错误，不静默回退。不要显式调用旧 `.cmd`，它会引入 PowerShell → cmd.exe 的引号与 `& | ^ < >` 风险。即使使用原生入口，复杂 eval 仍建议 `--file`、`--stdin` 或 `--base64`，因为调用方 shell 的展开无法还原。

**卸载残留**：npm 没有登记额外生成的 Windows `.exe` 或回退 `.bat`，卸载后手动删除 `<prefix>/autobrowser.exe` 和可能存在的 `<prefix>/autobrowser.bat`。POSIX 也检查 `<prefix>/bin/autobrowser` 是否残留；`npm prefix -g` 可查 prefix。npm 7+ 不为依赖卸载运行 `preuninstall`，不能依赖该钩子清理。

上述 npm 行为与本页前半部分的 `link:bun` 开发链接相互独立。
