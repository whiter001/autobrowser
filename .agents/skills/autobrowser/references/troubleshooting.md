# 故障排查、安装与维护

## connect 与页面判断

- `connect` 会打开扩展连接页，并自动保存 token、relay port，以及后续运行所需的浏览器配置。
- 操作系统都不为 `chrome-extension://` 注册协议关联，打开扩展页必须显式指定浏览器（`--browser-command`，首次传入后会写进 `~/.autobrowser/config.json` 复用）；没指定时 CLI 直接报错并改为打开 relay 的 `/connect` 页，不会交给系统弹窗。
- 如果 `connect` 传入了有效 token 且扩展已经报告 `connected`，连接页可能会自动关闭；这通常表示连接成功。
- `connect` 打开连接页后会输出确认，但这只表示页面已打开；如果连接页自动关闭，优先用 `status` 检查连接结果，不要反复等待页面。
- 如果 `connect` 没有打开或没有连上，确认浏览器命令指向已加载解包扩展的配置文件，必要时显式传 `--browser-command`。
- 如果页面看起来空白或不对，先确认是不是登录页、验证码页，或者虚拟滚动列表。

## extension info 字段

- 重载后先用 `status` 确认恢复，再用 `extension info` 确认实际加载的版本/构建；返回 `extensionId`、`version`、`buildTime`、`commit`、`userAgent`，以及 `diagnostics`（连接状态、心跳、`keepalive.alarmFires`/`lastAlarmAt`）。版本来自 manifest，构建版本与 `package.json` 同步，buildTime/commit 构建时生成；旧构建缺文件、读取失败或字段非法时对应构建字段为 `null`。`capabilities` 继续负责功能兼容协商，不用版本号代替能力判断。info 同样不绑定 tab、不进入页面队列。

## 参数形态与命令恢复

- `screenshot` 的输出路径是位置参数：`screenshot [path]`，不是 `screenshot --path <path>`；误用 `--path` 时错误会直接给出正确形式。
- 页面命令超时后先运行 `status` 和 `command list`。标签页控制走独立控制面，可继续用 `tab list`、`target clear`、`tab close <tN>` 恢复；不要连续重试并堆积命令。运行中的 `eval` 被取消或超时后会定向执行 `Runtime.terminateExecution`，其他 CDP 操作仍可能继续在浏览器侧完成。`status.lastError` 保留历史最后错误，可结合 `lastSuccessAt` 判断它是否早于最近成功。

## 启动器、PATH 与 npm 安装

- 如果命令报 `command not found` 或退出码 127，这是链接产物或 PATH 的问题，**不是 autobrowser 不可用**：先确认 `bun` 目录在当前 shell 的 PATH 里；Windows 使用 `autobrowser.exe <子命令>`（Windows 没有无扩展名入口），其他平台使用 `autobrowser <子命令>`。这是 shell 解析问题，修好之后继续用 autobrowser，不要因此换方案。
- npm 全局安装在 postinstall 中用原生入口替换 npm shim：Windows `<prefix>/autobrowser.exe`，POSIX `<prefix>/bin/autobrowser`，支持 macOS/Linux/Windows x64/arm64。启动器只用参数数组启动 Bun + `dist/autobrowser.js`，不重写业务、不经过 shell；仍需 PATH 中的 Bun >= 1.4.4 或 `AUTOBROWSER_BUN_PATH`，JS 路径可用 `AUTOBROWSER_DIST_ENTRY` 覆盖。源码 `link:bun` 默认用当前 Bun 的 `--compile --aot` 构建并嵌入当前 Bun 与仓库 dist 路径，不需要 Go。AOT 当前不能交叉编译，完整六目标构建的非本机目标自动使用 Go；`build:launcher -- --current` 只构建本机 AOT，强制 Go 备选用 `link:bun -- --go` 或 `build:launcher:go`。
- 禁用 npm 安装脚本时仍是旧 shim，**不保证存在 exe**；放行脚本后 `npm rebuild -g @whiter001/autobrowser`。缺少预编译文件/不支持平台/非全局才沿用旧修正；原生复制失败会明确报错，不静默回退。不要显式调用 `autobrowser.cmd`，PowerShell → cmd.exe 会破坏引号和 `& | ^` 参数。原生入口也不能还原调用方 shell 的展开，复杂 eval 按「eval 使用边界」走 `--stdin` 或 `--file`。
- 卸载 npm 包后清理 npm 未登记的 Windows `<prefix>/autobrowser.exe`、回退 `.bat`，POSIX 检查 `<prefix>/bin/autobrowser` 是否残留；prefix 可用 `npm prefix -g` 查询。

## 问题跟踪

- 执行中发现或复现 autobrowser 工具本身的问题时，先用 `gf issue list -R whiter001/autobrowser --platform github` 检查是否已有对应 issue，避免重复提交。
- 确认是新问题后，用 `gf issue create -R whiter001/autobrowser --platform github` 提交；没有 gf 时可使用 `gh issue create`。
- issue 应包含完整命令、实际输出、预期行为、运行环境和初步根因；区分已复现问题与代码审查推测。
- 网络超时或响应丢失时先查询是否已创建成功，不要盲目重复 POST。
- 修复后回 issue 评论验证结果并关闭；仅提出优化方向但未确认的问题，明确标注为建议。

## 更新约定

- 这个技能文件应当与当前 CLI 帮助和实现保持一致。
- 如果新增命令、改名、或调整 HAR / 网络行为，优先同步这里的说明。
