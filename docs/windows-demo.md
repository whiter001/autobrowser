# 使用 `autobrowser.cmd` 的 Windows 示例

本页记录的是仓库内的 `autobrowser.cmd` 启动器。

它的设计刻意保持极简：只通过示例里固定的 Bun 路径，把参数转发给本地的 `dist/autobrowser.js` 构建产物。

如果你是直接在仓库里运行，请先执行 `bun run build:cli`，这样启动器才会有可指向的构建产物。

## 这个示例覆盖什么

- 将 Windows 参数转发给构建后的 CLI
- 尽量让示例启动器保持很小
- 展示启动器使用的 Windows 批处理文件形式

## 前置条件

```powershell
bun run build:cli
```

构建完成后，根目录的 `autobrowser.cmd` 就可以运行本地 CLI 产物了。

## 示例流程

用一个明确的命令来运行启动器，例如 help：

```powershell
autobrowser.cmd help
```

按需通过启动器传递任意 CLI 命令：

```powershell
autobrowser.cmd status
autobrowser.cmd connect
autobrowser.cmd tab list
```

你也可以转发一个完整流程：

```powershell
autobrowser.cmd server
autobrowser.cmd open https://example.com
autobrowser.cmd snapshot
```

如果你想更接近已安装的 Windows 包装器行为，可以在链接完成后直接从 PATH 使用 `autobrowser.cmd`；这个示例文件之所以单独保留，是为了让它保持仓库本地化。

## 说明

- `autobrowser.cmd` 只是一个方便的启动器，不是已安装后的包包装器。
- 系统 PATH 里的安装版包装器，仍然来自 `bun link` 或直接的 Windows 链接步骤。