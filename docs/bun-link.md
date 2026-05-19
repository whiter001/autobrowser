# Bun 链接

本页解释的是：如何把 `autobrowser` 包装器放到 `bun` 或 `bun.exe` 旁边，以及在什么情况下只用普通的 `bun link` 就够了。

`bun link` 是包级别的链接方式。想看把 `autobrowser` 放到 `bun` 或 `bun.exe` 旁边的构建与链接流程，请参见 [`overview.md`](overview.md)。

仓库当前的 `bin` 条目仍然指向 `./src/cli.ts`，所以如果你不先修改这个字段，直接运行 `bun link` 链接到的还是源码入口。

`scripts/link-bun.ts` 辅助脚本会在类 Unix 系统下写出一个名为 `autobrowser` 的小包装器，在 Windows 下写出 `autobrowser.cmd`，然后把它放在 `bun` 可执行文件旁边，并指向 `dist/autobrowser.js`。

如果你更希望让 Bun 自己管理构建产物的链接，可以先把包的 `bin` 字段改成 `dist/autobrowser.js`，运行 `bun run build:cli`，然后在包根目录执行 `bun link`。这种方式更偏向包级管理，而不是直接链接单个文件。