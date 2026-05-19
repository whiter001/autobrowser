# 扩展安装

本页讲解未打包浏览器扩展的安装流程，以及 `connect` 使用的已保存连接配置。

先构建扩展：

```bash
bun run build:chrome
```

然后在基于 Chromium 的浏览器中把 `chrome/` 作为未打包扩展加载。

使用 `autobrowser connect` 可以打开扩展连接页，并自动保存中继配置。CLI 会把扩展 id 和浏览器启动器都持久化到 `~/.autobrowser/config.json`，因此首次成功运行后，后续就能在不重复指定的情况下重新连接。

你可以用 `autobrowser config` 查看已保存的路径和连接设置。

示例配置：

```json
{
  "extensionId": "bfccnpkjkbhceghimfjgnkigilidldep",
  "browserCommand": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
}
```

在 Windows 上，`browserCommand` 通常类似于 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。

如果你想在 CLI 里设置这些值，可以在 `autobrowser connect` 后面传入 `--extension-id`、`--browser-command` 以及可选的 `--browser-arg`；这些值会写回配置文件，并在下次复用。`server` 命令只负责管理本地中继和 IPC 服务。如果你是直接在仓库里运行，请改用 `bun run src/cli.ts connect`。

如果本地控制服务不存在，而你又在指向本地 IPC 端点，`connect` 会自动帮你启动它。若你希望在扩展断开连接时，CLI 主动打开扩展连接页，也可以加上 `--auto-connect`。

`options` 页面仍然是手动兜底入口，并会显示连接诊断信息。