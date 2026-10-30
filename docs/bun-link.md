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

## npm 全局安装的 Windows 启动器

npm 全局安装走的是另一条路径：`npm i -g @whiter001/autobrowser` 会按 `bin` 字段在全局可执行文件目录生成三个 shim（`autobrowser`、`autobrowser.cmd`、`autobrowser.ps1`），不经过 `scripts/link-bun.ts`。

npm 生成的 `autobrowser.cmd` 用 `%*` 转发参数，参数在 PowerShell → cmd.exe 这一层就已经被破坏：PowerShell 调用 `.cmd` 时会先剥掉参数里的双引号，cmd.exe 再把裸露的 `& | ^ < >` 当成命令分隔符，于是 URL 查询串和 `eval` 源码会被拆成多条命令。这不是 `.cmd` 内容能补救的，参数在批处理脚本体执行之前就已经被切碎了。

包的 `postinstall`（`scripts/npm-postinstall.mjs`）会在 Windows 全局安装时把这个 `.cmd` 改名成 `autobrowser.bat`：

- PowerShell 解析同名命令时优先命中 `autobrowser.ps1`；
- cmd.exe 按 PATHEXT（`.COM;.EXE;.BAT;.CMD`）优先命中 `autobrowser.bat`，cmd.exe 自己的解析会保护引号里的 `&`；
- `autobrowser.cmd` 不再存在，显式调用会直接报找不到命令，而不是静默改写参数。

npm 12 默认不执行 install 脚本（`allow-scripts` 默认不放行），这种安装下 `.cmd` 不会被改名，放行后重建一次即可：

```bash
npm config set allow-scripts=@whiter001/autobrowser --location=user
npm rebuild -g @whiter001/autobrowser
```

**卸载残留**：npm 的 bin-links 只登记无扩展名、`.cmd`、`.ps1` 三种 shim，不登记 `.bat`。`npm uninstall -g` 不会删除改名产生的 `autobrowser.bat`，卸载后需手动清理 `$(npm prefix -g)/autobrowser.bat`。npm 7+ 也不为依赖卸载运行 `preuninstall`，所以这个残留无法靠 lifecycle 钩子自动清理。

只想用原生 exe 的话，在仓库里跑 `bun run link:bun` 即可，它会把 `autobrowser.exe` 放到 bun 目录并清掉同目录的旧 `.cmd`。
