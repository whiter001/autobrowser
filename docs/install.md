# 扩展安装

本页讲解未打包浏览器扩展的安装流程，以及 `connect` 使用的已保存连接配置。

## 方式一：npm 全局安装（推荐）

```bash
npm i -g @whiter001/autobrowser
```

npm 用户必须先安装 Bun 运行时（见 https://bun.sh）：发布的命令入口是 `dist/autobrowser.js`，其 shebang 是 `#!/usr/bin/env bun`，因此 `bun` 不在 PATH 里就会报 command not found。

装好之后**不需要**自己构建扩展——随包发布的已构建扩展就在 `$(npm root -g)/@whiter001/autobrowser/chrome`（Windows 上同样用 `npm root -g` 定位）。在基于 Chromium 的浏览器里打开 `chrome://extensions`，用「加载已解压的扩展程序」加载这个目录即可。

之后所有命令都直接用全局安装得到的 `autobrowser`，例如 `autobrowser connect`。

## 方式二：仓库开发者

如果你是在克隆下来的仓库里开发，先构建扩展：

```bash
bun run build:chrome
```

然后在基于 Chromium 的浏览器中把仓库里的 `chrome/` 作为未打包扩展加载。仓库内还可以用 `bun run src/cli.ts <子命令>` 直接运行源码；这条命令对 npm 全局安装的用户不适用，请一律使用 `autobrowser`。

## 连接配置

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

如果你想在 CLI 里设置这些值，可以在 `autobrowser connect` 后面传入 `--extension-id`、`--browser-command` 以及可选的 `--browser-arg`；这些值会写回配置文件，并在下次复用。`server` 命令只负责管理本地中继和 IPC 服务。仓库开发者如果是在仓库里直接运行源码，则改用 `bun run src/cli.ts connect`；npm 全局安装的用户直接用 `autobrowser connect`。

如果本地控制服务不存在，而你又在指向本地 IPC 端点，`connect` 会自动帮你启动它。若你希望在扩展断开连接时，CLI 主动打开扩展连接页，也可以加上 `--auto-connect`。

`options` 页面仍然是手动兜底入口，并会显示连接诊断信息。

## Firefox / WebKit（WebDriver）

Firefox 和 WebKit 不使用上面的 Chromium 扩展或 CDP，而是通过标准 WebDriver 连接。先启动对应 driver，再在命令名前选择引擎：

### Firefox

安装并启动 [geckodriver](https://github.com/mozilla/geckodriver)：

```bash
geckodriver --port 4444
autobrowser --engine firefox status
autobrowser --engine firefox open https://example.com
```

默认连接 `http://127.0.0.1:4444`，可用 `--webdriver-url` 覆盖。

### WebKit / Safari

在 Safari 的「开发」菜单中允许「远程自动化」，并按 Apple 的要求初始化、启动 `safaridriver`：

```bash
safaridriver -p 4723
autobrowser --engine webkit status
autobrowser --engine webkit open https://example.com
```

WebKit 默认连接 `http://127.0.0.1:4723`。当前核心适配范围是 `goto/open/back/forward/reload`、`snapshot`、`click/fill/type/press`、`get/is`、`storage`、`cookies`、视口 PNG `screenshot` 和 `close/status`。`full`、标注截图、JPEG、显式 tab/frame 目标、network、tracing、CDP、video、WebMCP 等尚未适配的能力会返回 `BROWSER_CAPABILITY_UNSUPPORTED`，不会静默降级成模拟结果。

WebDriver sessionId 按当前 home 和引擎保存并复用；命名会话之间不会共享 sessionId。可用 `--session <name>` 与 `--engine` 组合。`close-all` 会结束对应 WebDriver 会话，之后下次命令会创建新会话。

仓库的可选真实浏览器 smoke 需要先启动 driver，再运行：

```bash
AUTOBROWSER_WEBDRIVER_LIVE=1 bun test test/webdriver-live.test.ts
```

可用 `AUTOBROWSER_FIREFOX_DRIVER_URL` 和 `AUTOBROWSER_WEBKIT_DRIVER_URL` 覆盖测试地址。未启用该环境变量时 smoke 会跳过，协议 mock 通过不代表本机真实浏览器已经验证。